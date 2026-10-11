// Backup / restore and rebalance.
import { queryOptions } from "@tanstack/react-query"

import { api } from "./client"

const enc = encodeURIComponent

// ---- Backup -----------------------------------------------------------------

export type S3Target = {
  Endpoint: string
  AccessKeyID: string
  SecretAccessKey: string
  Region: string
  Bucket: string
  UseSSL?: boolean
  CAFile?: string
  InsecureSkipVerify?: boolean
}

export type BackupPolicy = {
  policy_id: string
  task_id: string
  task_name: string
  cluster_name: string
  database: string
  table: string
  schedule_type: "immediate" | "scheduled"
  crontab: string
  instance: string
  backup_style: "full" | "incremental"
  backup_type: "partition" | "daily"
  days_before: number
  start_date: string
  range_start_date: string
  range_end_date: string
  partitions: string[] | null
  target_type: "s3" | "local"
  s3: S3Target
  local: { path: string }
  compression: string
  checksum: boolean
  max_bandwidth_mb: number
  clean: boolean
  enabled: boolean
  create_time: string
  update_time: string
}

export type RunStatus =
  "queued" | "running" | "success" | "failed" | "skipped" | "interrupted"

export type BackupRun = {
  run_id: string
  policy_id: string
  cluster_name: string
  database: string
  table: string
  operation: "backup" | "restore"
  trigger_type: string
  instance: string
  status: RunStatus
  status_reason: string
  partitions:
    | {
        partition: string
        status: string
        size: number
        rows: number
        file_num: number
        elapsed: number
        msg: string
      }[]
    | null
  started_at: string
  finished_at: string
  elapsed: number
  error_msg: string
  create_time: string
}

export const isZeroTime = (t: string | undefined) =>
  !t || t.startsWith("0001-01-01")
export const runTime = (r: BackupRun) =>
  isZeroTime(r.started_at) ? r.create_time : r.started_at

export const backupPoliciesQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "backup-policies"],
    queryFn: async () =>
      (await api.get<BackupPolicy[] | null>(
        `/api/v1/data_manage/backup/${enc(cluster)}`
      )) ?? [],
  })

export const backupQueueQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "backup-queue"],
    queryFn: () =>
      api.get<{ running: number; queued: number }>(
        `/api/v1/data_manage/backup/${enc(cluster)}/queue`
      ),
  })

export const policyRunsQuery = (policyId: string, limit = 30) =>
  queryOptions({
    queryKey: ["backup-policy-runs", policyId, limit],
    queryFn: async () =>
      (await api.get<BackupRun[] | null>(
        `/api/v1/data_manage/backup/policy/${enc(policyId)}/runs`,
        { limit }
      )) ?? [],
  })

export const tableRunsQuery = (
  cluster: string,
  database: string,
  table: string
) =>
  queryOptions({
    queryKey: ["cluster", cluster, "table-runs", database, table],
    queryFn: async () =>
      (await api.get<BackupRun[] | null>(
        `/api/v1/data_manage/backup/table/${enc(cluster)}/${enc(database)}/${enc(table)}/runs`,
        { days: 0 }
      )) ?? [],
  })

export const backupRunQuery = (runId: string) =>
  queryOptions({
    queryKey: ["backup-run", runId],
    queryFn: () =>
      api.get<BackupRun>(`/api/v1/data_manage/backup/run/${enc(runId)}`),
    refetchInterval: (q) =>
      q.state.data &&
      (q.state.data.status === "queued" || q.state.data.status === "running")
        ? 2000
        : false,
  })

export const nextRunQuery = (policyId: string) =>
  queryOptions({
    queryKey: ["backup-next-run", policyId],
    queryFn: () =>
      api.get<{ next_run_at: string }>(
        `/api/v1/data_manage/backup/policy/${enc(policyId)}/next_run`
      ),
  })

export type TableSummary = {
  name: string
  partition_key: string
  partition_format: "day" | "month" | "hour" | "custom" | "none"
  daily_compatible: boolean
  total_bytes: number
}

export const tableSummaryQuery = (cluster: string, database: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "table-summary", database],
    queryFn: async () =>
      (await api.get<TableSummary[] | null>(
        `/api/v1/data_manage/tables/${enc(cluster)}/${enc(database)}/summary`
      )) ?? [],
    enabled: database !== "",
  })

export const backupDisksQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "backup-disks"],
    queryFn: async () =>
      (await api.get<
        | {
            name: string
            type: string
            path: string
            allowed_backup: boolean
          }[]
        | null
      >(`/api/v1/data_manage/disks/${enc(cluster)}`)) ?? [],
  })

export const instancesQuery = () =>
  queryOptions({
    queryKey: ["instances"],
    queryFn: async () =>
      (await api.get<string[] | null>("/api/v1/instances")) ?? [],
  })

export type BackupRequest = {
  schedule_type: "immediate" | "scheduled"
  task_name?: string
  crontab?: string
  instance?: string
  database: string
  tables: string[]
  backup_style: "full" | "incremental"
  backup_type: "partition" | "daily"
  partitions?: string[]
  days_before?: number
  start_date?: string
  range_start_date?: string
  range_end_date?: string
  target: "s3" | "local"
  s3?: S3Target
  local?: { path: string }
  Compression: string
  clean: boolean
  checksum: boolean
  max_bandwidth_mb?: number
}

export function createBackup(cluster: string, body: BackupRequest) {
  return api.post<{ run_ids: string[] | null }>(
    `/api/v1/data_manage/backup/${enc(cluster)}`,
    body
  )
}

// The update must carry the whole policy (missing fields become zero values).
export function updatePolicy(policy: BackupPolicy) {
  return api.put(
    `/api/v1/data_manage/backup/policy/${enc(policy.policy_id)}`,
    policy
  )
}

export function deletePolicy(policyId: string) {
  return api.delete(`/api/v1/data_manage/backup/policy/${enc(policyId)}`)
}

export function triggerPolicy(policyId: string) {
  return api.post<{ run_id: string }>(
    `/api/v1/data_manage/backup/policy/${enc(policyId)}/trigger`
  )
}

export function restoreFromRun(
  cluster: string,
  sourceRunId: string,
  partitions: string[]
) {
  return api.post<{ run_id: string }>(
    `/api/v1/data_manage/restore/${enc(cluster)}`,
    {
      source_run_id: sourceRunId,
      partitions,
    }
  )
}

// Group per-table policies into the "task" the user created.
export type BackupTask = {
  id: string
  name: string
  policies: BackupPolicy[]
}

export function groupPolicies(policies: BackupPolicy[]): BackupTask[] {
  const byTask = new Map<string, BackupTask>()
  for (const p of policies) {
    const id = p.task_id || p.policy_id
    const task = byTask.get(id) ?? {
      id,
      name: p.task_name || `${p.database}.${p.table}`,
      policies: [],
    }
    task.policies.push(p)
    byTask.set(id, task)
  }
  return [...byTask.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// robfig/cron with seconds: exactly 6 fields, at least an hour apart.
export function cronProblem(spec: string): string | null {
  const fields = spec.trim().split(/\s+/)
  if (fields.length !== 6)
    return "Use 6 fields: second minute hour day month weekday."
  return null
}

// ---- Rebalance --------------------------------------------------------------

export type RebalanceRequest = {
  tables: {
    database: string
    table: string // regex on the local table name
    policy?: "partition" | "shardingkey"
    shardingKey?: string
  }[]
  except_max_shard?: boolean
}

type I18n = { ZH: string; EN: string }

export type RebalanceInfo = {
  database: string
  table: string
  dist_table?: string
  engine: string
  imbalance_ratio: number
  warnings?: I18n[]
  shards: {
    host: string
    shard_num: number
    rows: number
    bytes: number
    compressed_bytes: number
    partition_count: number
  }[]
}

export type RebalancePlan = {
  except_shard_drain?: { src_host: string; dst_host: string }
  tables:
    | {
        database: string
        table: string
        strategy: "partition" | "shardingkey"
        engine: string
        moves?: {
          partition: string
          src_host: string
          dst_host: string
          bytes: number
        }[]
        reshuffle?: {
          total_rows: number
          total_bytes: number
          compressed_bytes: number
          shards: number
          sharding_key: string
        }
        warnings?: I18n[]
      }[]
    | null
}

export function rebalanceInfo(cluster: string, body: RebalanceRequest) {
  return api.post<RebalanceInfo[] | null>(
    `/api/v1/ck/rebalance_info/${enc(cluster)}`,
    body
  )
}

export function rebalancePlan(cluster: string, body: RebalanceRequest) {
  return api.post<RebalancePlan>(
    `/api/v1/ck/rebalance_plan/${enc(cluster)}`,
    body
  )
}

export function rebalanceExecute(cluster: string, body: RebalanceRequest) {
  return api.put<string | null>(`/api/v1/ck/rebalance/${enc(cluster)}`, body)
}
