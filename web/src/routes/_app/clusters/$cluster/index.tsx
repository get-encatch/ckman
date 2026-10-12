import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { InfoIcon } from "lucide-react"

import {
  keeperHostStatsQuery,
  keeperStatusQuery,
  METRIC_GROUPS,
  type KeeperHostStats,
  type MetricGroup,
} from "@/api/observability"
import { clusterQuery, clusterStatusQuery, type Cluster } from "@/api/queries"
import { MetricChart } from "@/components/app/metric-chart"
import { ErrorState, Stat } from "@/components/app/misc"
import { PageBody, Section } from "@/components/app/page-header"
import { UnreplicatedBanner } from "@/components/app/unreplicated-tables"
import { NodeStatus, StatusPill, UsageBar } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatBytes, formatNumber, usedFraction } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/$cluster/")({
  component: OverviewPage,
})

const RANGES = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
} as const

function OverviewPage() {
  const { cluster } = Route.useParams()
  const config = useQuery(clusterQuery(cluster))
  const status = useQuery(clusterStatusQuery(cluster))
  const keeper = useQuery(keeperStatusQuery(cluster))
  const keeperHosts = useQuery({
    ...keeperHostStatsQuery(cluster),
    enabled: config.data?.keeper === "clickhouse-keeper",
  })
  const hostStats = new Map((keeperHosts.data ?? []).map((h) => [h.host, h]))
  const [group, setGroup] = useState<MetricGroup>("queries")
  const [range, setRange] = useState<keyof typeof RANGES>("1h")
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  const nodes = useMemo(() => status.data?.nodes ?? [], [status.data])
  const up = nodes.filter((n) => n.status === "green").length
  const shards = config.data?.shards ?? []
  const keeperUp =
    keeper.data?.filter((k) => k.peer_state !== "offline").length ?? 0
  const leader = keeper.data?.find((k) => k.server_state === "leader")?.host

  const byShard = useMemo(() => {
    const out = new Map<number, typeof nodes>()
    for (const n of nodes)
      out.set(n.shardNumber, [...(out.get(n.shardNumber) ?? []), n])
    return [...out.entries()].sort((a, b) => a[0] - b[0])
  }, [nodes])

  return (
    <PageBody>
      <UnreplicatedBanner cluster={cluster} />
      <RedundancyNote cluster={cluster} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="ClickHouse nodes up"
          value={
            status.data ? (
              `${up} / ${nodes.length}`
            ) : (
              <Skeleton className="h-8 w-16" />
            )
          }
          hint={
            up === nodes.length
              ? "All nodes answering"
              : `${nodes.length - up} not answering`
          }
        />
        <Stat
          label="Layout"
          value={`${shards.length} × ${Math.max(0, ...shards.map((s) => s.replicas?.length ?? 0))}`}
          hint="shards × replicas"
        />
        <Stat
          label="Keeper"
          value={
            keeper.data ? (
              `${keeperUp} / ${keeper.data.length}`
            ) : (
              <Skeleton className="h-8 w-16" />
            )
          }
          hint={
            leader
              ? `Leader ${leader}`
              : keeper.data?.length
                ? "No leader"
                : "—"
          }
        />
        <Stat
          label="Version"
          value={status.data?.version || config.data?.version || "—"}
          hint={config.data?.pkgType}
        />
      </div>

      <Section
        title="Nodes"
        description="Live status from each ClickHouse server."
        actions={
          <Button
            nativeButton={false}
            variant="outline"
            size="sm"
            render={<Link to="/clusters/$cluster/nodes" params={{ cluster }} />}
          >
            Manage nodes
          </Button>
        }
      >
        {status.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {byShard.map(([shard, replicas]) => (
              <div key={shard} className="rounded-lg border">
                <div className="border-b px-4 py-2 text-sm font-medium">
                  Shard {shard}
                </div>
                <ul className="divide-y">
                  {replicas
                    .sort((a, b) => a.replicaNumber - b.replicaNumber)
                    .map((n) => (
                      <li
                        key={n.ip}
                        className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm"
                      >
                        <div className="flex min-w-36 flex-col">
                          <span className="font-mono">{n.ip}</span>
                          <span className="text-xs text-muted-foreground">
                            replica {n.replicaNumber}
                            {n.hostname ? ` · ${n.hostname}` : ""}
                            {n.uptime ? ` · up ${n.uptime}` : ""}
                          </span>
                        </div>
                        <NodeStatus status={n.status} />
                        <div className="ml-auto flex items-end gap-4">
                          {n.data && (
                            <span
                              className="text-xs text-muted-foreground tabular-nums"
                              title="ClickHouse data on this node"
                            >
                              Data {n.data}
                            </span>
                          )}
                          <UsageBar
                            fraction={usedFraction(n.memory)}
                            label={`Mem ${n.memory}`}
                          />
                          <UsageBar
                            fraction={usedFraction(n.disk)}
                            label={`Disk ${n.disk}`}
                            title="Whole volume: servers sharing a disk show the same figure"
                          />
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Keeper"
        description="Health of the coordination nodes that keep replicas in sync. CPU, memory and disk come from each Keeper server over SSH; disk is the whole volume holding Keeper's data."
      >
        {keeper.error ? (
          <ErrorState error={keeper.error} />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Host</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Avg latency</TableHead>
                  <TableHead className="text-right">Znodes</TableHead>
                  <TableHead className="text-right">Data size</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">CPU load</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead>Disk (volume)</TableHead>
                  <TableHead className="text-right">Keeper memory</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(keeper.data ?? []).map((k) => (
                  <TableRow key={k.host}>
                    <TableCell className="font-mono">{k.host}</TableCell>
                    <TableCell>
                      {k.peer_state === "offline" ? (
                        <StatusPill tone="bad" label="Offline" />
                      ) : k.server_state === "leader" ? (
                        <StatusPill tone="ok" label="Leader" />
                      ) : (
                        <StatusPill tone="info" label={k.server_state} />
                      )}
                    </TableCell>
                    <TableCell>{k.version}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {k.avg_latency} ms
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(k.znode_count)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(k.approximate_data_size)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {k.outstanding_requests}
                    </TableCell>
                    <KeeperHostCells stats={hostStats.get(k.host)} />
                  </TableRow>
                ))}
                {keeper.isPending && (
                  <TableRow>
                    <TableCell colSpan={11}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section
        title="Metrics"
        description="From ClickHouse's own metric logs on each node."
        actions={
          <>
            <Select
              items={{
                "1h": "Last hour",
                "6h": "Last 6 hours",
                "24h": "Last 24 hours",
                "7d": "Last 7 days",
              }}
              value={range}
              onValueChange={(v) => {
                setRange(v as keyof typeof RANGES)
                setNow(Math.floor(Date.now() / 1000))
              }}
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">Last hour</SelectItem>
                <SelectItem value="6h">Last 6 hours</SelectItem>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNow(Math.floor(Date.now() / 1000))}
            >
              Refresh
            </Button>
          </>
        }
      >
        <Tabs value={group} onValueChange={(v) => setGroup(v as MetricGroup)}>
          <TabsList>
            {(Object.keys(METRIC_GROUPS) as MetricGroup[]).map((g) => (
              <TabsTrigger key={g} value={g}>
                {METRIC_GROUPS[g].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {METRIC_GROUPS[group].metrics.map((m) => (
            <MetricChart
              key={m}
              cluster={cluster}
              metric={m}
              start={now - RANGES[range]}
              end={now}
            />
          ))}
        </div>
      </Section>
    </PageBody>
  )
}

function KeeperHostCells({ stats }: { stats: KeeperHostStats | undefined }) {
  if (!stats)
    return (
      <TableCell colSpan={4} className="text-muted-foreground">
        —
      </TableCell>
    )
  if (stats.error)
    return (
      <TableCell
        colSpan={4}
        className="text-muted-foreground"
        title={stats.error}
      >
        No SSH access
      </TableCell>
    )
  return (
    <>
      <TableCell
        className="text-right tabular-nums"
        title="1-minute load average / cores"
      >
        {stats.load1.toFixed(2)} / {stats.cores}
      </TableCell>
      <TableCell>
        <UsageBar
          fraction={stats.mem_total ? stats.mem_used / stats.mem_total : null}
          label={`${formatBytes(stats.mem_used)} / ${formatBytes(stats.mem_total)}`}
        />
      </TableCell>
      <TableCell>
        <UsageBar
          fraction={
            stats.disk_total ? stats.disk_used / stats.disk_total : null
          }
          label={`${formatBytes(stats.disk_used)} / ${formatBytes(stats.disk_total)}`}
          title={`Keeper's own data: ${formatBytes(stats.data_bytes)}`}
        />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {stats.proc_rss ? formatBytes(stats.proc_rss) : "—"}
      </TableCell>
    </>
  )
}

// RedundancyNote says what a cluster can't survive yet. Information only:
// starting with one server and one Keeper is a normal first step.
function RedundancyNote({ cluster }: { cluster: string }) {
  const config = useQuery(clusterQuery(cluster))
  const c: Cluster | undefined = config.data
  if (!c) return null
  const single = (c.shards ?? []).some((s) => (s.replicas?.length ?? 0) < 2)
  const keepers =
    c.keeper === "clickhouse-keeper"
      ? (c.KeeperConf?.keeperNodes?.length ?? 0)
      : (c.zkNodes?.length ?? 0)
  const notes = [
    single &&
      "a shard has a single server, so losing it loses that shard's data access",
    keepers > 0 &&
      keepers < 3 &&
      `with ${keepers} Keeper${keepers === 1 ? "" : "s"}, losing one stops replicated tables from taking writes`,
  ].filter(Boolean)
  if (notes.length === 0) return null
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-sky-500/40 bg-sky-500/10 p-4 text-sm">
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium">Not redundant yet</span>
        <span className="text-muted-foreground">
          {notes.join("; ")}. Add replicas and Keepers on the Nodes page when
          you need it.
        </span>
      </div>
    </div>
  )
}
