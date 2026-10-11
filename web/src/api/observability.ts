// Tables, sessions, query console, metrics and Keeper status for one cluster.
// Shapes follow ckman's controllers; see FORK.md for the envelope conventions.
import { queryOptions } from "@tanstack/react-query"

import { api } from "./client"

const enc = encodeURIComponent

// ---- Tables -----------------------------------------------------------------

export type TableMetric = {
  columns: number
  rows: number
  partitions: number
  parts: number
  compressed: number
  uncompressed: number
  index_uncompressed: number
  index_compressed: number
  readwrite_status: boolean
}

export type TableMetricRow = TableMetric & { name: string }

export const tableMetricsQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "table-metric"],
    queryFn: async () => {
      const byName = await api.get<Record<string, TableMetric> | null>(
        `/api/v1/ck/table_metric/${enc(cluster)}`
      )
      return Object.entries(byName ?? {}).map(([name, m]) => ({ name, ...m }))
    },
  })

export type MaterializedView = {
  name: string
  parts: number
  rows: number
  compressed: number
  uncompressed: number
  source_table: string
  as_select: string
}

export const materializedViewsQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "mv"],
    queryFn: async () => {
      const byName = await api.get<Record<
        string,
        Omit<MaterializedView, "name">
      > | null>(`/api/v1/ck/vm/${enc(cluster)}`)
      return Object.entries(byName ?? {}).map(([name, v]) => ({ name, ...v }))
    },
  })

export type Merge = {
  table: string
  host: string
  elapsed: number
  merge_start: string
  progress: number
  num_parts: number
  rows: number
  compressed: number
  uncompressed: number
  result_part_name: string
  source_part_names: string
  memory_usage: number
  merge_algorithm: string
}

export const mergesQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "merges"],
    queryFn: async () =>
      (await api.get<Merge[] | null>(
        `/api/v1/ck/table_merges/${enc(cluster)}`
      )) ?? [],
  })

export type Partition = {
  database: string
  table: string
  parts: number
  rows: number
  compressed: number
  uncompressed: number
  min_time: string
  max_time: string
  disk_name: string
  partition_id: string
  status: boolean
}

export type PartitionRow = Partition & { partition: string }

export const partitionsQuery = (cluster: string, table: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "partitions", table],
    queryFn: async () => {
      const byPartition = await api.get<Record<string, Partition> | null>(
        `/api/v1/ck/partition/${enc(cluster)}`,
        { table }
      )
      return Object.entries(byPartition ?? {})
        .map(([partition, p]) => ({ partition, ...p }))
        .sort((a, b) => b.partition.localeCompare(a.partition))
    },
    enabled: table.includes("."),
  })

export const PARTITION_OP = { detach: 1, attach: 2, drop: 3 } as const

export function operatePartition(
  cluster: string,
  p: PartitionRow,
  op: keyof typeof PARTITION_OP
) {
  return api.put(`/api/v1/ck/partition/${enc(cluster)}`, {
    op: PARTITION_OP[op],
    database: p.database,
    table: p.table,
    partitionId: p.partition_id,
    status: p.status,
  })
}

export type ReplicatedTable = {
  table: string
  node: string
  shard_replica: string
  queue_size: number
  inserts: number
  merges: number
  log_pointer: number
  progress: number
  last_exception: string
}

export const replicationQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "replication"],
    queryFn: async () =>
      (await api.get<ReplicatedTable[] | null>(
        `/api/v1/zk/replicated_table/${enc(cluster)}`
      )) ?? [],
  })

export type ReplicationQueueEntry = {
  node_name: string
  type: string
  create_time: string
  num_tries: number
  postpone_reason: string
  last_exception: string
}

export const replicationQueueQuery = (
  cluster: string,
  table: string,
  node: string
) =>
  queryOptions({
    queryKey: ["cluster", cluster, "replication-queue", table, node],
    queryFn: async () =>
      (await api.get<ReplicationQueueEntry[] | null>(
        `/api/v1/zk/replicated_queue/${enc(cluster)}`,
        { table, node }
      )) ?? [],
    // the backend panics on a table without a dot and needs a node
    enabled: table.includes(".") && node !== "",
  })

export type PoolUsage = { task: number; size: number; usage: number }
export type BackgroundPool = {
  host: string
  background_pool: Record<string, PoolUsage>
}

export const backgroundPoolQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "background-pool"],
    queryFn: async () =>
      (await api.get<BackgroundPool[] | null>(
        `/api/v1/ck/backgroundpool/${enc(cluster)}`
      )) ?? [],
  })

export type KeeperNodeStatus = {
  host: string
  version: string
  server_state: string
  peer_state?: string
  avg_latency: number
  approximate_data_size: number
  znode_count: number
  outstanding_requests: number
  watch_count: number
}

// Machine health of each ClickHouse Keeper server, read over SSH (cached 15 s).
export type KeeperHostStats = {
  host: string
  cores: number
  load1: number
  mem_used: number
  mem_total: number
  disk_used: number // whole volume holding Keeper's data
  disk_total: number
  data_bytes: number // Keeper's logs and snapshots
  proc_rss: number // Keeper process memory
  error?: string
}

export const keeperHostStatsQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "keeper-host-stats"],
    queryFn: async () =>
      (await api.get<KeeperHostStats[] | null>(
        `/api/v1/zk/host_stats/${enc(cluster)}`
      )) ?? [],
    refetchInterval: 30_000,
  })

export const keeperStatusQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "keeper-status"],
    queryFn: async () =>
      (await api.get<KeeperNodeStatus[] | null>(
        `/api/v1/zk/status/${enc(cluster)}`
      )) ?? [],
  })

export const tableSchemaQuery = (
  cluster: string,
  database: string,
  tableName: string
) =>
  queryOptions({
    queryKey: ["cluster", cluster, "table-schema", database, tableName],
    queryFn: async () =>
      (
        await api.get<{ create_table_query: string }>(
          `/api/v1/ck/table_schema/${enc(cluster)}`,
          { database, tableName }
        )
      ).create_table_query,
  })

export type ColumnInfo = {
  name: string
  type: string
  defaultType: string
  defaultExpression: string
  comment: string
  codecExpression: string
  ttlExpression: string
}

export const tableColumnsQuery = (
  cluster: string,
  database: string,
  tableName: string
) =>
  queryOptions({
    queryKey: ["cluster", cluster, "table-columns", database, tableName],
    queryFn: () =>
      api.get<ColumnInfo[]>(`/api/v1/ck/table/${enc(cluster)}`, {
        database,
        tableName,
      }),
  })

export function dropTable(
  cluster: string,
  database: string,
  tableName: string
) {
  return api.delete(`/api/v1/ck/table/${enc(cluster)}`, { database, tableName })
}

export function restoreReadonlyTable(cluster: string, table: string) {
  return api.put(`/api/v1/ck/table/readonly/${enc(cluster)}`, undefined, {
    table,
  })
}

// ---- Sessions ---------------------------------------------------------------

export type Session = {
  startTime: number // unix seconds
  queryDuration: number // ms
  query: string
  user: string
  queryId: string
  address: string
  host: string
}

export const openSessionsQuery = (cluster: string, limit: number) =>
  queryOptions({
    queryKey: ["cluster", cluster, "open-sessions", limit],
    queryFn: async () =>
      (await api.get<Session[] | null>(
        `/api/v1/ck/open_sessions/${enc(cluster)}`,
        {
          limit,
        }
      )) ?? [],
  })

export const slowSessionsQuery = (
  cluster: string,
  limit: number,
  start: number,
  end: number
) =>
  queryOptions({
    queryKey: ["cluster", cluster, "slow-sessions", limit, start, end],
    queryFn: async () =>
      (await api.get<Session[] | null>(
        `/api/v1/ck/slow_sessions/${enc(cluster)}`,
        {
          limit,
          start,
          end,
        }
      )) ?? [],
  })

export const ddlQueueQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "ddl-queue"],
    queryFn: async () =>
      (await api.get<Session[] | null>(
        `/api/v1/ck/ddl_queue/${enc(cluster)}`
      )) ?? [],
  })

export function killSession(
  cluster: string,
  host: string,
  queryId: string,
  type: "open" | "queue"
) {
  return api.put(`/api/v1/ck/open_sessions/${enc(cluster)}`, undefined, {
    host,
    queryId,
    type,
  })
}

// ---- Query console ----------------------------------------------------------

// Row 0 holds the column names; values beyond 2^53 arrive as strings.
export type QueryResult = unknown[][]

export function runQuery(cluster: string, query: string, host?: string) {
  return api.get<QueryResult>(
    `/api/v1/ck/query/${enc(cluster)}`,
    { query, host },
    true
  )
}

export function explainQuery(cluster: string, query: string) {
  return api.get<QueryResult>(`/api/v1/ck/query_explain/${enc(cluster)}`, {
    query,
  })
}

export const tableTreeQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "table-tree"],
    queryFn: async () =>
      (await api.get<Record<string, Record<string, string[]>> | null>(
        `/api/v1/ck/table_lists/${enc(cluster)}`
      )) ?? {},
  })

export type QueryHistoryEntry = {
  Cluster: string
  CreateTime: string
  QuerySql: string
  CheckSum: string
}

export const queryHistoryQuery = (cluster: string) =>
  queryOptions({
    queryKey: ["cluster", cluster, "query-history"],
    queryFn: async () =>
      (await api.get<QueryHistoryEntry[] | null>(
        `/api/v1/ck/query_history/${enc(cluster)}`
      )) ?? [],
  })

export function deleteQueryHistory(cluster: string, checksum: string) {
  return api.delete(`/api/v1/ck/query_history/${enc(cluster)}`, { checksum })
}

// ---- Metrics ----------------------------------------------------------------

export const METRIC_GROUPS = {
  queries: {
    label: "Queries & inserts",
    metrics: [
      "Queries/second",
      "Selected Rows/second",
      "Selected Bytes/second",
      "Inserted/second",
      "Inserted Rows/second",
      "Inserted Bytes/second",
    ],
  },
  merges: {
    label: "Merges & parts",
    metrics: [
      "Merged",
      "Merged Rows/second",
      "Replicated Part Fetches",
      "Replicated Part Merges",
      "Total MergeTree Parts",
      "Max Parts For Partition",
    ],
  },
  node: {
    label: "Nodes",
    metrics: [
      "CPU Usage (cores)",
      "Load Average (15 minutes)",
      "Memory (tracked)",
      "Network Recive",
      "Network Send",
      "IO Wait",
      "Read From Disk",
      "File Open",
      "DiskUsed(default)",
    ],
  },
  keeper: {
    label: "Keeper",
    metrics: [
      "Zookeeper Session",
      "Zookeeper Create",
      "Zookeeper Remove",
      "Zookeeper Wait",
      "Zookeeper Bytes Received",
      "Zookeeper Bytes Sent",
    ],
  },
} as const

export type MetricGroup = keyof typeof METRIC_GROUPS

// Display names for metrics whose ckman key is misspelled or terse.
export const METRIC_LABELS: Record<string, string> = {
  "Network Recive": "Network received (MiB/s)",
  "Network Send": "Network sent (MiB/s)",
  "Inserted Bytes/second": "Inserted MiB/second",
  "Selected Bytes/second": "Selected MiB/second",
  "Memory (tracked)": "Memory tracked (MiB)",
  "IO Wait": "IO wait (s)",
  "Read From Disk": "Read from disk (MiB/s)",
  "DiskUsed(default)": "Disk used, default (GiB)",
  "Zookeeper Session": "Keeper sessions",
  "Zookeeper Create": "Keeper creates",
  "Zookeeper Remove": "Keeper removes",
  "Zookeeper Wait": "Keeper wait (s)",
  "Zookeeper Bytes Received": "Keeper received (MiB)",
  "Zookeeper Bytes Sent": "Keeper sent (MiB)",
}

export type MetricSeries = {
  metric: { __name__: string; instance: string }
  values: [number, number][]
}

export const metricQuery = (
  cluster: string,
  metric: string,
  start: number,
  end: number,
  step: number
) =>
  queryOptions({
    queryKey: ["cluster", cluster, "metric", metric, start, end, step],
    queryFn: async () =>
      (await api.get<MetricSeries[] | null>(
        `/api/v1/metric/query_metric/${enc(cluster)}`,
        {
          metric,
          start,
          end,
          step,
        }
      )) ?? [],
  })
