// Machines that host ClickHouse and Keeper containers.
import { queryOptions } from "@tanstack/react-query"

import { api } from "./client"

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
