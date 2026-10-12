// Clusters, nodes, deploy, tasks, packages and users.
import { queryOptions } from "@tanstack/react-query"

import { api, request } from "./client"

const enc = encodeURIComponent

// ---- Clusters ---------------------------------------------------------------

export type Replica = { ip: string; hostname: string; watch: boolean }

export type Cluster = {
  cluster: string
  comment: string
  pkgType: string
  pkgName: string
  version: string
  cwd: string
  logic_cluster: string | null
  shards: { replicas: Replica[] }[]
  protocol: "native" | "http"
  port: number
  httpPort: number
  secure: boolean
  isReplica: boolean
  hosts: string[] | null
  keeper: "zookeeper" | "clickhouse-keeper"
  KeeperConf: {
    runtime: "standalone" | "internal"
    keeperNodes: string[] | null
    serverIds?: number[] | null
    tcpPort: number
    raftPort: number
    Path: string
  } | null
  zkNodes: string[] | null
  zkPort: number
  user: string
  path: string
  sshUser: string
  authenticateType: number
  sshPort: number
  mode: "deploy" | "import"
  docker?: import("./fleet").DockerConf // runs as containers on fleet machines
  access?: { readOnly: boolean; syncUser?: string } | null // standby: apps read-only
}

export const clusterListQuery = () =>
  queryOptions({
    queryKey: ["clusters"],
    queryFn: async () => {
      const byName = await api.get<Record<string, Cluster> | null>(
        "/api/v1/ck/cluster"
      )
      return Object.values(byName ?? {}).sort((a, b) =>
        a.cluster.localeCompare(b.cluster)
      )
    },
  })

export const clusterQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "config"],
    queryFn: () => api.get<Cluster>(`/api/v1/ck/cluster/${enc(cluster)}`),
  })

export type NodeInfo = {
  ip: string
  hostname: string
  status: "green" | "red"
  shardNumber: number
  replicaNumber: number
  disk: string // "used / total" of the whole volume (shared disks show the same)
  data?: string // ClickHouse's own parts on this node
  uptime: string
  cpu: string
  memory: string
}

export type ClusterStatus = {
  pkgType: string
  status: "green" | "yellow" | "red"
  version: string
  mode: "deploy" | "import"
  needPassword: boolean
  httpPort: number
  nodes: NodeInfo[] | null
}

export const clusterStatusQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "status"],
    queryFn: () => api.get<ClusterStatus>(`/api/v1/ck/get/${enc(cluster)}`),
  })

export type ImportClusterRequest = {
  cluster: string
  logic_cluster: string
  hosts: string[]
  protocol: "native" | "http"
  port: number
  httpPort: number
  secure: boolean
  user: string
  password: string
  zkNodes: string[]
  zkPort: number
}

export function importCluster(body: ImportClusterRequest) {
  return api.post("/api/v1/ck/cluster", body)
}

// Forget a cluster in ckman only; nodes and data are untouched.
export function forgetCluster(cluster: string) {
  return api.delete(`/api/v1/ck/cluster/${enc(cluster)}`)
}

// The SSH password is only needed (and asked for) when the cluster was set up
// with "password, not saved" (status.needPassword).
type Ssh = { password?: string }

export function startCluster(cluster: string, ssh: Ssh = {}) {
  return api.put(`/api/v1/ck/start/${enc(cluster)}`, undefined, ssh)
}

export function stopCluster(cluster: string, ssh: Ssh = {}) {
  return api.put(`/api/v1/ck/stop/${enc(cluster)}`, undefined, ssh)
}

export function destroyCluster(cluster: string, ssh: Ssh = {}) {
  return api.put<string>(`/api/v1/ck/destroy/${enc(cluster)}`, undefined, ssh)
}

export type UpgradeRequest = {
  packageVersion: string
  policy: "Full" | "Rolling"
  skip: boolean
  skipKeeper: boolean
}

export function upgradeCluster(
  cluster: string,
  body: UpgradeRequest,
  ssh: Ssh = {}
) {
  return api.put<string>(`/api/v1/ck/upgrade/${enc(cluster)}`, body, ssh)
}

// ---- Nodes ------------------------------------------------------------------

export function addNodes(
  cluster: string,
  body: {
    ips: string[]
    shard: number
    sourceSchemaHost: string
    size?: import("./fleet").Size // fleet clusters: the new servers' size
  },
  opts: Ssh & { force?: boolean } = {}
) {
  return api.post<string>(`/api/v1/ck/node/${enc(cluster)}`, body, opts)
}

export function deleteNode(
  cluster: string,
  ip: string,
  opts: Ssh & { force?: boolean } = {}
) {
  return api.delete<string>(`/api/v1/ck/node/${enc(cluster)}`, { ip, ...opts })
}

export function startNode(cluster: string, ip: string, ssh: Ssh = {}) {
  return api.put(`/api/v1/ck/node/start/${enc(cluster)}`, undefined, {
    ip,
    ...ssh,
  })
}

export function stopNode(cluster: string, ip: string, ssh: Ssh = {}) {
  return api.put(`/api/v1/ck/node/stop/${enc(cluster)}`, undefined, {
    ip,
    ...ssh,
  })
}

export function restartNode(cluster: string, ip: string, ssh: Ssh = {}) {
  return api.put(`/api/v1/ck/node/restart/${enc(cluster)}`, undefined, {
    ip,
    ...ssh,
  })
}

// MergeTree tables that aren't replicated: their rows live on one server.
export type UnreplicatedTable = {
  database: string
  table: string
  engine: string
  hosts: { host: string; shard: number; rows: number }[]
}

export const unreplicatedTablesQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "unreplicated"],
    queryFn: async () =>
      (await api.get<UnreplicatedTable[] | null>(
        `/api/v1/ck/table/unreplicated/${enc(cluster)}`
      )) ?? [],
  })

// ATTACH TABLE ... AS REPLICATED on every server, no restart.
export const nodeOverrideQuery = (cluster: string, ip: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "override", ip],
    queryFn: () =>
      api.get<{ ip: string; xml: string }>(
        `/api/v1/ck/node/override/${enc(cluster)}`,
        { ip }
      ),
  })

export type OverrideResult = { reloaded: boolean; warning?: string }

export function saveNodeOverride(cluster: string, ip: string, xml: string) {
  return api.put<OverrideResult>(
    `/api/v1/ck/node/override/${enc(cluster)}`,
    { xml },
    { ip }
  )
}

export function clearNodeOverride(cluster: string, ip: string) {
  return api.delete<OverrideResult>(
    `/api/v1/ck/node/override/${enc(cluster)}`,
    { ip }
  )
}

export function nodeLog(
  cluster: string,
  ip: string,
  body: { logType: "normal" | "error"; lines: number; tail: boolean },
  ssh: Ssh = {}
) {
  return api.post<string>(`/api/v1/ck/node/log/${enc(cluster)}`, body, {
    ip,
    ...ssh,
  })
}

// ---- Deploy -----------------------------------------------------------------

// The deploy and settings endpoints decode Go struct field names
// (PascalCase, case-sensitive), unlike every other endpoint.
export type DeployRequest = {
  Cluster: string
  Comment?: string
  PkgType: string
  PkgName: string
  Cwd?: string
  LogicCluster?: string
  Shards: { Replicas: { Ip: string }[] }[]
  Protocol: "native" | "http"
  Port: number
  HttpPort: number
  Secure: boolean
  Keeper: "zookeeper" | "clickhouse-keeper"
  KeeperConf?: {
    Runtime: "standalone" | "internal"
    KeeperNodes?: string[]
    TcpPort: number
    RaftPort: number
    Path: string
    Coordination: {
      OperationTimeoutMs: number
      SessionTimeoutMs: number
      ForceSync: boolean
    }
  }
  ZkNodes?: string[]
  ZkPort: number
  Password: string
  EncryptType: number
  Path: string
  SshUser: string
  AuthenticateType: number
  SshPassword?: string
  SshPort: number
}

export function deployCluster(body: DeployRequest, force = false) {
  return api.post<string>("/api/v1/deploy/ck", body, { force })
}

// ---- Settings ---------------------------------------------------------------

export type ClusterConfig = Record<string, unknown> & {
  Cluster: string
  Comment: string
  Protocol: string
  Port: number
  HttpPort: number
  Secure: boolean
  Password: string
  SshUser: string
  AuthenticateType: number
  SshPassword: string
  SshPort: number
  Expert: Record<string, string> | null
}

export const clusterConfigQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "settings"],
    queryFn: async () => {
      const res = await api.get<{ mode: string; config: string }>(
        `/api/v1/ck/config/${enc(cluster)}`
      )
      return { mode: res.mode, config: JSON.parse(res.config) as ClusterConfig }
    },
  })

// Send the whole object from clusterConfigQuery with edits applied: keys that
// are missing reset those settings. Masked "****" secrets are kept server-side.
export function saveClusterConfig(
  cluster: string,
  config: ClusterConfig,
  opts: Ssh & { force?: boolean; policy?: "Full" | "Rolling" } = {}
) {
  return api.post<string>(`/api/v1/ck/config/${enc(cluster)}`, config, opts)
}

// ---- Tasks ------------------------------------------------------------------

export type TaskStatus =
  "Waiting" | "Running" | "Success" | "Failed" | "Stopped"
type I18n = { ZH: string; EN: string }

export type TaskSummary = {
  TaskId: string
  ClusterName: string
  Type: string
  Option: I18n
  Status: TaskStatus
  Message: string
  Warning?: string // succeeded, but something needs a look
  CreateTime: string
  UpdateTime: string
  Duration: string
}

export type TaskDetail = Omit<TaskSummary, "Message"> & {
  Step: I18n
  NodeStatus: { Host: string; Status: I18n }[] | null
}

export const isTaskActive = (status: TaskStatus) =>
  status === "Waiting" || status === "Running"

export const taskListQuery = () =>
  queryOptions({
    queryKey: ["tasks"],
    queryFn: async () =>
      (await api.get<TaskSummary[] | null>("/api/v1/task/lists")) ?? [],
    refetchInterval: (q) =>
      q.state.data?.some((t) => isTaskActive(t.Status)) ? 3000 : 15_000,
  })

export const taskQuery = (taskId: string) =>
  queryOptions({
    queryKey: ["task", taskId],
    queryFn: () => api.get<TaskDetail>(`/api/v1/task/${enc(taskId)}`),
    // stop on the task-level status: NodeStatus switches hosts mid-deploy
    refetchInterval: (q) =>
      q.state.data && !isTaskActive(q.state.data.Status) ? false : 2000,
  })

export function stopTask(taskId: string) {
  return api.put(`/api/v1/task/${enc(taskId)}`)
}

export function deleteTask(taskId: string) {
  return api.delete(`/api/v1/task/${enc(taskId)}`)
}

// ---- Packages ---------------------------------------------------------------

export type PackageInfo = { version: string; pkgType: string; pkgName: string }

export const packagesQuery = (pkgType = "all") =>
  queryOptions({
    queryKey: ["packages", pkgType],
    queryFn: async () =>
      (await api.get<PackageInfo[] | null>("/api/v1/package", { pkgType })) ??
      [],
  })

// One file per request (field name "package").
export function uploadPackage(file: File) {
  const form = new FormData()
  form.append("package", file)
  return request("POST", "/api/v1/package", { form })
}

export function deletePackage(packageVersion: string, pkgType: string) {
  return api.delete("/api/v1/package", { packageVersion, pkgType })
}

// ---- Users ------------------------------------------------------------------

export type Policy = "admin" | "ordinary" | "guest"

export type User = {
  username: string
  policy: Policy
  enabled: boolean
  created_at: number // unix seconds
  updated_at: number
}

export const BUILTIN_USERS = new Set(["ckman", "ordinary"])

export const usersQuery = () =>
  queryOptions({
    queryKey: ["users"],
    queryFn: async () => (await api.get<User[] | null>("/api/v1/users")) ?? [],
  })

// Passwords for user management are sent in plain text (the server hashes
// them); only login sends an MD5.
export function createUser(body: {
  username: string
  password: string
  policy: Policy
  enabled: boolean
}) {
  return api.post("/api/v1/users", body)
}

export function updateUser(
  username: string,
  body: { policy?: Policy; enabled?: boolean }
) {
  return api.put(`/api/v1/users/${enc(username)}`, body)
}

export function deleteUser(username: string) {
  return api.delete(`/api/v1/users/${enc(username)}`)
}

export function resetUserPassword(username: string, newPassword: string) {
  return api.put(`/api/v1/users/${enc(username)}/password`, {
    new_password: newPassword,
  })
}

export function changeOwnPassword(oldPassword: string, newPassword: string) {
  return api.put("/api/v1/user/password", {
    old_password: oldPassword,
    new_password: newPassword,
  })
}

// Mirrors the server rule: 8+ characters from at least 3 of 4 categories.
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Use at least 8 characters."
  const categories = [/[0-9]/, /[a-z]/, /[A-Z]/, /[^0-9a-zA-Z]/].filter((re) =>
    re.test(password)
  ).length
  if (categories < 3)
    return "Mix at least 3 of: digits, lowercase, uppercase, symbols."
  return null
}

export const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,31}$/
