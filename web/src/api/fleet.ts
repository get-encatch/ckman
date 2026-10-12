// Machines that host ClickHouse and Keeper containers.
import { queryOptions } from "@tanstack/react-query"

import { api, CkmanError } from "./client"

const enc = encodeURIComponent

export type MachineStatus = "ready" | "no_docker" | "unreachable"

export type Machine = {
  id: string
  name: string
  ip: string
  zone: string
  labels: Record<string, string> | null
  ssh_user: string
  ssh_port: number
  authenticate_type: number // 0 saved password, 2 ckman's SSH key
  data_dir: string
  facts: {
    hostname: string
    os: string
    arch: string
    cores: number
    mem_total: number
    disk_total: number
    docker_version: string
    checked_at: string
  }
  status: MachineStatus
  status_message?: string
  create_time: string
  update_time: string
}

export type MachineInput = {
  name: string
  ip: string
  zone: string
  labels: Record<string, string>
  ssh_user: string
  ssh_port: number
  authenticate_type: number
  ssh_password: string // empty on edit = keep the stored one
  data_dir: string
}

export type ContainerStats = {
  name: string
  cluster: string
  role: "clickhouse" | "keeper" | ""
  image: string
  state: string
  cpu_percent: number // of one core
  cpu_limit: number // cores, 0 = unlimited
  mem_used: number
  mem_limit: number
  disk_used: number
  disk_limit: number // soft limit
  dir: string
}

export type MachineStats = {
  machine_id: string
  cores: number
  load1: number
  cpu_used: number // busy cores
  mem_used: number
  mem_total: number
  disk_used: number
  disk_total: number
  reserved_cpu: number
  reserved_mem: number
  reserved_disk: number
  containers: ContainerStats[] | null
  collected_at: string
  error?: string
}

export const AUTH_PASSWORD = 0
export const AUTH_KEY = 2

export const machinesQuery = () =>
  queryOptions({
    queryKey: ["machines"],
    queryFn: async () =>
      (await api.get<Machine[] | null>("/api/v1/fleet/machines")) ?? [],
  })

export const machineQuery = (id: string) =>
  queryOptions({
    queryKey: ["machines", id],
    queryFn: () => api.get<Machine>(`/api/v1/fleet/machine/${enc(id)}`),
  })

export const fleetStatsQuery = () =>
  queryOptions({
    queryKey: ["machines", "stats"],
    queryFn: async () =>
      (await api.get<MachineStats[] | null>("/api/v1/fleet/stats")) ?? [],
    refetchInterval: 15_000,
  })

export const machineStatsQuery = (id: string) =>
  queryOptions({
    queryKey: ["machines", id, "stats"],
    queryFn: () =>
      api.get<MachineStats>(`/api/v1/fleet/machine/${enc(id)}/stats`),
    refetchInterval: 15_000,
  })

export function createMachine(body: MachineInput) {
  return api.post<Machine>("/api/v1/fleet/machines", body)
}

export function updateMachine(id: string, body: MachineInput) {
  return api.put<Machine>(`/api/v1/fleet/machine/${enc(id)}`, body)
}

export function deleteMachine(id: string) {
  return api.delete(`/api/v1/fleet/machine/${enc(id)}`)
}

export function checkMachine(id: string) {
  return api.post<Machine>(`/api/v1/fleet/machine/${enc(id)}/check`)
}

// "role=keeper\nzone=dc1" <-> {role: "keeper", zone: "dc1"}
export function parseLabels(text: string): {
  labels: Record<string, string>
  error: string | null
} {
  const labels: Record<string, string> = {}
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.trim()
    if (!line) continue
    const [k, ...rest] = line.split("=")
    const key = k.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/.test(key))
      return { labels, error: `"${line}" isn't key=value` }
    labels[key] = rest.join("=").trim()
  }
  return { labels, error: null }
}

export const formatLabels = (labels: Record<string, string> | null) =>
  Object.entries(labels ?? {})
    .map(([k, v]) => (v ? `${k}=${v}` : k))
    .join("\n")

// ---- Clusters on the fleet (Docker) ----------------------------------------

export type DockerPorts = {
  tcp: number
  http: number
  interserver: number
  prometheus: number
  keeper_tcp: number
  keeper_raft: number
}

export type DockerConf = {
  image: string
  keeper_image: string
  cpu: number
  memory_mb: number
  disk_gb: number
  keeper_cpu: number
  keeper_memory_mb: number
  keeper_disk_gb: number
  port_slot: number
  ports: DockerPorts
  // per-instance sizes by host IP; empty fields use the defaults above
  server_sizes?: Record<string, Size> | null
  keeper_sizes?: Record<string, Size> | null
}

// Size is one container's limits; 0 = the cluster default (or no limit).
export type Size = { cpu: number; memory_mb: number; disk_gb: number }

export const serverSize = (d: DockerConf, ip: string): Size =>
  withDefault(d.server_sizes?.[ip], {
    cpu: d.cpu,
    memory_mb: d.memory_mb,
    disk_gb: d.disk_gb,
  })

export const keeperSize = (d: DockerConf, ip: string): Size =>
  withDefault(d.keeper_sizes?.[ip], {
    cpu: d.keeper_cpu,
    memory_mb: d.keeper_memory_mb,
    disk_gb: d.keeper_disk_gb,
  })

function withDefault(s: Size | undefined, def: Size): Size {
  return {
    cpu: s?.cpu || def.cpu,
    memory_mb: s?.memory_mb || def.memory_mb,
    disk_gb: s?.disk_gb || def.disk_gb,
  }
}

export type Resources = {
  cpu: number
  memory_mb: number
  disk_gb: number
  keeper_cpu: number
  keeper_memory_mb: number
  keeper_disk_gb: number
}

export type FleetClusterRequest = Resources & {
  cluster: string
  comment: string
  version: string
  shards: string[][] // machine IDs: shards[i][j] = replica j of shard i
  keepers: string[] // machine IDs
  password: string
  allow_overcommit: boolean
  server_sizes?: Size[][] // shaped like shards; 0 fields = the defaults
  keeper_sizes?: Size[]
  draft?: string // the draft this create comes from
}

export type PlanMachine = {
  id: string
  name: string
  zone: string
  roles: string[]
  cpu: number
  cpu_total: number
  mem: number
  mem_total: number
  disk: number
  disk_total: number
}

export type FleetPlan = {
  errors: string[]
  warnings: string[]
  port_slot: number
  ports: DockerPorts
  machines: PlanMachine[]
}

export const versionsQuery = (image: "server" | "keeper" = "server") =>
  queryOptions({
    queryKey: ["fleet-versions", image],
    queryFn: async () =>
      (await api.get<string[] | null>("/api/v1/fleet/versions", { image })) ??
      [],
    staleTime: 60 * 60_000,
  })

export function planCluster(body: FleetClusterRequest) {
  return api.post<FleetPlan>("/api/v1/fleet/clusters/plan", body)
}

export function createFleetCluster(body: FleetClusterRequest) {
  return api.post<{ task_id: string; plan: FleetPlan }>(
    "/api/v1/fleet/clusters",
    body
  )
}

// scaleKeepers adds Keepers on the given machines and removes the given
// Keeper IPs; an odd number must remain. Returns the task.
export function scaleKeepers(
  cluster: string,
  body: {
    add: string[]
    remove: string[]
    allow_overcommit: boolean
    sizes?: Record<string, Size> // by machine ID
  }
) {
  return api.post<{ task_id: string }>(
    `/api/v1/fleet/cluster/${enc(cluster)}/keepers`,
    body
  )
}

export function resizeCluster(
  cluster: string,
  body: Resources & {
    allow_overcommit: boolean
    server_sizes?: Record<string, Size> // by host IP; others get the defaults
    keeper_sizes?: Record<string, Size>
  }
) {
  return api.put<{ resized: string[] }>(
    `/api/v1/fleet/cluster/${enc(cluster)}/resources`,
    body
  )
}

// label filter "role=keeper" / "zone=zone-a" / "disk"; empty matches all
export function matchesFilter(m: Machine, filter: string) {
  const terms = filter
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  return terms.every((t) => {
    const [k, v] = t.split("=")
    const value = k === "zone" ? m.zone : m.labels?.[k]
    if (value === undefined) return false
    return v === undefined || value === v
  })
}

// ---- Fleet settings and standbys --------------------------------------------

export type FleetSettings = { standby_interval_min: number }

export const fleetSettingsQuery = () =>
  queryOptions({
    queryKey: ["fleet-settings"],
    queryFn: () => api.get<FleetSettings>("/api/v1/fleet/settings"),
  })

export function saveFleetSettings(s: FleetSettings) {
  return api.put<FleetSettings>("/api/v1/fleet/settings", s)
}

export type StandbyTable = {
  primary_rows: number
  standby_rows: number
}

export type Standby = {
  primary: string
  mode: "storage" | "replica"
  zone: string
  cluster?: string
  connection_id?: string
  bucket?: string
  interval_min: number
  databases?: string[] | null
  replica_ips?: string[] | null
  paused: boolean
  promoted_at?: string
  create_time: string
  state: "creating" | "ready" | "syncing" | "failed" | "promoted"
  state_message?: string
  last_start?: string
  last_end?: string
  last_success?: string
  last_error?: string
  last_synced: number
  syncs: number
  tables?: Record<string, StandbyTable> | null
  schema_notes?: string[] | null
  // lifecycle
  fenced: boolean // promoted: the old primary is read-only
  fence_error?: string
  fence_tried?: string
  previous?: string // after a rejoin or switchover: the cluster that was primary
  reversed_at?: string
  snapshot?: string // rejoin: the old primary's safety backup in the bucket
  // computed
  role: "primary" | "standby" // which side the asked cluster is
  effective_interval_min: number
  next_sync?: string
  lag_seconds: number
  overdue: boolean
  replica_delay_seconds: number
  replica_queue: number
  replica_error?: string
}

export const standbyQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "standby"],
    queryFn: async () => {
      try {
        return await api.get<Standby>(`/api/v1/fleet/standby/${enc(cluster)}`)
      } catch (err) {
        if (err instanceof CkmanError && err.code === "5800") return null // none yet
        throw err
      }
    },
    refetchInterval: 10_000,
  })

export type StandbyRequest = {
  primary: string
  mode: "storage" | "replica"
  zone: string
  interval_min: number
  connection_id?: string
  bucket?: string
  databases?: string[]
  cluster?: FleetClusterRequest
  replicas?: string[]
  allow_overcommit?: boolean
}

export function createStandby(body: StandbyRequest) {
  return api.post<{ task_id: string }>("/api/v1/fleet/standby", body)
}

export function standbyAction(
  cluster: string,
  action: "sync" | "pause" | "resume" | "promote" | "rejoin" | "switchover",
  opts: { final_sync?: boolean } = {}
) {
  return api.post<{ note: string }>(
    `/api/v1/fleet/standby/${enc(cluster)}/${action}`,
    undefined,
    opts.final_sync ? { final_sync: true } : undefined
  )
}

export function removeStandby(cluster: string, purge: boolean) {
  return api.delete(
    `/api/v1/fleet/standby/${enc(cluster)}`,
    purge ? { purge: true } : undefined
  )
}

// ---- Create-cluster drafts ---------------------------------------------------

// A create-cluster form saved half-way; it reserves its cluster name. The
// password is never saved in a draft.
export type ClusterDraft = {
  name: string
  step: number
  form: Record<string, unknown>
  task_id?: string
  updated_at: string
}

export const draftsQuery = () =>
  queryOptions({
    queryKey: ["cluster-drafts"],
    queryFn: async () =>
      (await api.get<ClusterDraft[] | null>("/api/v1/fleet/drafts")) ?? [],
  })

export const draftQuery = (name: string) =>
  queryOptions({
    queryKey: ["cluster-drafts", name],
    queryFn: () => api.get<ClusterDraft>(`/api/v1/fleet/drafts/${enc(name)}`),
    staleTime: Infinity,
  })

// saveDraft creates a draft (no current name) or updates and possibly renames one.
export function saveDraft(
  current: string | null,
  d: Pick<ClusterDraft, "name" | "step" | "form" | "task_id">
) {
  return current
    ? api.put<ClusterDraft>(`/api/v1/fleet/drafts/${enc(current)}`, d)
    : api.post<ClusterDraft>("/api/v1/fleet/drafts", d)
}

export function deleteDraft(name: string) {
  return api.delete(`/api/v1/fleet/drafts/${enc(name)}`)
}
