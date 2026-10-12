import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import { MoreHorizontalIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"

import {
  backgroundPoolQuery,
  dropTable,
  materializedViewsQuery,
  mergesQuery,
  replicationQuery,
  replicationQueueQuery,
  restoreReadonlyTable,
  tableMetricsQuery,
  tableSchemaQuery,
  type MaterializedView,
  type Merge,
  type ReplicatedTable,
  type ReplicationQueueEntry,
  type TableMetricRow,
} from "@/api/observability"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { CodeBlock, ErrorState } from "@/components/app/misc"
import { PageBody } from "@/components/app/page-header"
import { PartitionsSheet } from "@/components/app/partitions-sheet"
import { StatusPill } from "@/components/app/status"
import { UnreplicatedSection } from "@/components/app/unreplicated-tables"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format"
import { cn } from "@/lib/utils"

const VIEWS = ["tables", "views", "merges", "replication", "pools"] as const
type View = (typeof VIEWS)[number]

export const Route = createFileRoute("/_app/clusters/$cluster/tables")({
  validateSearch: z.object({ view: z.enum(VIEWS).optional() }),
  component: TablesPage,
})

function TablesPage() {
  const { cluster } = Route.useParams()
  const { view = "tables" } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()

  return (
    <PageBody>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={view}
          onValueChange={(v) => void navigate({ search: { view: v as View } })}
        >
          <TabsList>
            <TabsTrigger value="tables">Tables</TabsTrigger>
            <TabsTrigger value="views">Materialized views</TabsTrigger>
            <TabsTrigger value="merges">Merges</TabsTrigger>
            <TabsTrigger value="replication">Replication</TabsTrigger>
            <TabsTrigger value="pools">Background pools</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void queryClient.invalidateQueries({
              queryKey: ["cluster", cluster],
            })
          }
        >
          <RefreshCwIcon /> Refresh
        </Button>
      </div>
      {view === "tables" && <TablesView cluster={cluster} />}
      {view === "views" && <ViewsView cluster={cluster} />}
      {view === "merges" && <MergesView cluster={cluster} />}
      {view === "replication" && (
        <>
          <UnreplicatedSection cluster={cluster} />
          <ReplicationView cluster={cluster} />
        </>
      )}
      {view === "pools" && <PoolsView cluster={cluster} />}
    </PageBody>
  )
}

function splitName(name: string) {
  const i = name.indexOf(".")
  return { database: name.slice(0, i), table: name.slice(i + 1) }
}

const tableCol = columnHelper<TableMetricRow>()

function TablesView({ cluster }: { cluster: string }) {
  const { session } = useRouteContext({ from: "/_app" })
  const canWrite = session.policy !== "guest"
  const tables = useQuery(tableMetricsQuery(cluster))
  const queryClient = useQueryClient()
  const [schemaOf, setSchemaOf] = useState<string | null>(null)
  const [partitionsOf, setPartitionsOf] = useState<string | null>(null)
  const [dropping, setDropping] = useState<string | null>(null)

  const columns = useMemo(
    () => [
      tableCol.accessor("name", {
        header: "Table",
        cell: (c) => (
          <button
            type="button"
            className="text-left font-medium hover:underline"
            onClick={() => setPartitionsOf(c.getValue())}
          >
            {c.getValue()}
          </button>
        ),
      }),
      tableCol.accessor("rows", {
        header: "Rows",
        cell: (c) => (
          <span className="tabular-nums">{formatNumber(c.getValue())}</span>
        ),
      }),
      tableCol.accessor("compressed", {
        header: "On disk",
        cell: (c) => (
          <span className="tabular-nums">{formatBytes(c.getValue())}</span>
        ),
      }),
      tableCol.accessor(
        (t) => (t.compressed ? t.uncompressed / t.compressed : 0),
        {
          id: "ratio",
          header: "Compression",
          cell: (c) => (
            <span className="tabular-nums">
              {c.getValue() ? `${c.getValue().toFixed(1)}×` : "—"}
            </span>
          ),
        }
      ),
      tableCol.accessor("partitions", {
        header: "Partitions",
        cell: (c) => (
          <span className="tabular-nums">{formatNumber(c.getValue())}</span>
        ),
      }),
      tableCol.accessor("parts", {
        header: "Parts",
        cell: (c) => (
          <span
            className={cn(
              "tabular-nums",
              c.getValue() > 300 && "font-medium text-amber-600"
            )}
          >
            {formatNumber(c.getValue())}
          </span>
        ),
      }),
      tableCol.accessor("readwrite_status", {
        header: "State",
        cell: (c) =>
          c.getValue() ? (
            <StatusPill tone="ok" label="Writable" />
          ) : (
            <StatusPill tone="bad" label="Read-only" />
          ),
      }),
      tableCol.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) => {
          const t = c.row.original
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${t.name}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onClick={() => setPartitionsOf(t.name)}>
                    Partitions
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSchemaOf(t.name)}>
                    Show CREATE statement
                  </DropdownMenuItem>
                  {canWrite && !t.readwrite_status && (
                    <DropdownMenuItem
                      onClick={async () => {
                        try {
                          await restoreReadonlyTable(cluster, t.name)
                          toast.success(`Restored replicas of ${t.name}`)
                          await queryClient.invalidateQueries({
                            queryKey: ["cluster", cluster, "table-metric"],
                          })
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : String(err)
                          )
                        }
                      }}
                    >
                      Restore read-only replicas
                    </DropdownMenuItem>
                  )}
                  {canWrite && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDropping(t.name)}
                      >
                        Drop table…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      }),
    ],
    [canWrite, cluster, queryClient]
  )

  return (
    <>
      <p className="text-sm text-muted-foreground">
        MergeTree tables, totalled over all shards (one replica of each). Click
        a table for its partitions.
      </p>
      {tables.error && <ErrorState error={tables.error} />}
      <DataTable
        columns={columns}
        data={tables.data}
        loading={tables.isPending}
        searchable
        searchPlaceholder="Search tables…"
        emptyText="No MergeTree tables yet."
        getRowId={(t) => t.name}
        initialSorting={[{ id: "compressed", desc: true }]}
      />
      <SchemaDialog
        cluster={cluster}
        name={schemaOf}
        onClose={() => setSchemaOf(null)}
      />
      <PartitionsSheet
        cluster={cluster}
        table={partitionsOf}
        canWrite={canWrite}
        onClose={() => setPartitionsOf(null)}
      />
      <ConfirmDialog
        open={dropping !== null}
        onOpenChange={(o) => !o && setDropping(null)}
        title={`Drop ${dropping}?`}
        description="Drops the table on every node, together with its Distributed table. All its data is deleted."
        typeToConfirm={dropping ?? undefined}
        confirmLabel="Drop table"
        destructive
        onConfirm={async () => {
          if (!dropping) return
          const { database, table } = splitName(dropping)
          await dropTable(cluster, database, table)
          toast.success(`Dropped ${dropping}`)
          await queryClient.invalidateQueries({
            queryKey: ["cluster", cluster],
          })
        }}
      />
    </>
  )
}

function SchemaDialog({
  cluster,
  name,
  onClose,
}: {
  cluster: string
  name: string | null
  onClose: () => void
}) {
  const parts = name ? splitName(name) : { database: "", table: "" }
  const schema = useQuery({
    ...tableSchemaQuery(cluster, parts.database, parts.table),
    enabled: name !== null,
  })
  return (
    <Dialog open={name !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>
            CREATE statement as ClickHouse stores it.
          </DialogDescription>
        </DialogHeader>
        {schema.error ? (
          <ErrorState error={schema.error} />
        ) : schema.data ? (
          <CodeBlock code={schema.data} />
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </DialogContent>
    </Dialog>
  )
}

const mvCol = columnHelper<MaterializedView>()

function ViewsView({ cluster }: { cluster: string }) {
  const views = useQuery(materializedViewsQuery(cluster))
  const [schemaOf, setSchemaOf] = useState<string | null>(null)
  const columns = useMemo(
    () => [
      mvCol.accessor("name", {
        header: "View",
        cell: (c) => (
          <button
            type="button"
            className="font-medium hover:underline"
            onClick={() => setSchemaOf(c.getValue())}
          >
            {c.getValue()}
          </button>
        ),
      }),
      mvCol.accessor("source_table", {
        header: "Reads from",
        cell: (c) => c.getValue() || "—",
      }),
      mvCol.accessor("rows", {
        header: "Rows",
        cell: (c) => (
          <span className="tabular-nums">{formatNumber(c.getValue())}</span>
        ),
      }),
      mvCol.accessor("compressed", {
        header: "On disk",
        cell: (c) => (
          <span className="tabular-nums">{formatBytes(c.getValue())}</span>
        ),
      }),
      mvCol.accessor("as_select", {
        header: "Query",
        enableSorting: false,
        cell: (c) => (
          <span className="line-clamp-1 max-w-lg font-mono text-xs text-muted-foreground">
            {c.getValue()}
          </span>
        ),
      }),
    ],
    []
  )
  return (
    <>
      {views.error && <ErrorState error={views.error} />}
      <DataTable
        columns={columns}
        data={views.data}
        loading={views.isPending}
        searchable
        emptyText="No materialized views."
        getRowId={(v) => v.name}
      />
      <SchemaDialog
        cluster={cluster}
        name={schemaOf}
        onClose={() => setSchemaOf(null)}
      />
    </>
  )
}

const mergeCol = columnHelper<Merge>()

function MergesView({ cluster }: { cluster: string }) {
  const merges = useQuery({ ...mergesQuery(cluster), refetchInterval: 5000 })
  const columns = useMemo(
    () => [
      mergeCol.accessor("table", {
        header: "Table",
        cell: (c) => <span className="font-medium">{c.getValue()}</span>,
      }),
      mergeCol.accessor("host", {
        header: "Node",
        cell: (c) => <span className="font-mono">{c.getValue()}</span>,
      }),
      mergeCol.accessor("progress", {
        header: "Progress",
        cell: (c) => (
          <span className="tabular-nums">
            {Math.round(c.getValue() * 100)}%
          </span>
        ),
      }),
      mergeCol.accessor("elapsed", {
        header: "Running for",
        cell: (c) => (
          <span className="tabular-nums">{c.getValue().toFixed(1)} s</span>
        ),
      }),
      mergeCol.accessor("num_parts", {
        header: "Parts",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      mergeCol.accessor("rows", {
        header: "Rows",
        cell: (c) => (
          <span className="tabular-nums">{formatNumber(c.getValue())}</span>
        ),
      }),
      mergeCol.accessor("memory_usage", {
        header: "Memory",
        cell: (c) => (
          <span className="tabular-nums">{formatBytes(c.getValue())}</span>
        ),
      }),
      mergeCol.accessor("result_part_name", {
        header: "Result part",
        enableSorting: false,
        cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
      }),
    ],
    []
  )
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Merges running right now. Refreshes every 5 seconds.
      </p>
      {merges.error && <ErrorState error={merges.error} />}
      <DataTable
        columns={columns}
        data={merges.data}
        loading={merges.isPending}
        emptyText="No merges running."
        dense
      />
    </>
  )
}

const replCol = columnHelper<ReplicatedTable>()

function ReplicationView({ cluster }: { cluster: string }) {
  const replication = useQuery(replicationQuery(cluster))
  const [queueOf, setQueueOf] = useState<ReplicatedTable | null>(null)
  const columns = useMemo(
    () => [
      replCol.accessor("table", {
        header: "Table",
        cell: (c) => <span className="font-medium">{c.getValue()}</span>,
      }),
      replCol.accessor("node", {
        header: "Replica",
        cell: (c) => <span className="font-mono">{c.getValue()}</span>,
      }),
      replCol.accessor("shard_replica", { header: "Shard-replica" }),
      replCol.accessor("queue_size", {
        header: "Queue",
        cell: (c) =>
          c.getValue() > 0 ? (
            <button
              type="button"
              className="font-medium text-amber-600 tabular-nums hover:underline"
              onClick={() => setQueueOf(c.row.original)}
            >
              {c.getValue()}
            </button>
          ) : (
            <span className="tabular-nums">0</span>
          ),
      }),
      replCol.accessor("inserts", {
        header: "Inserts",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      replCol.accessor("merges", {
        header: "Merges",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      replCol.accessor("progress", {
        header: "In sync",
        cell: (c) => {
          const v = c.getValue()
          return (
            <StatusPill
              tone={v >= 90 ? "ok" : v >= 60 ? "warn" : "bad"}
              label={`${Math.round(v)}%`}
            />
          )
        },
      }),
      replCol.accessor("last_exception", {
        header: "Last error",
        enableSorting: false,
        cell: (c) => (
          <span
            className="line-clamp-1 max-w-sm text-xs text-destructive"
            title={c.getValue()}
          >
            {c.getValue()}
          </span>
        ),
      }),
    ],
    []
  )
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Each replica's replication queue. A growing queue or a low "in sync"
        value means a replica is falling behind.
      </p>
      {replication.error && <ErrorState error={replication.error} />}
      <DataTable
        columns={columns}
        data={replication.data}
        loading={replication.isPending}
        searchable
        emptyText="No replicated tables."
        initialSorting={[{ id: "queue_size", desc: true }]}
        dense
      />
      <QueueDialog
        cluster={cluster}
        row={queueOf}
        onClose={() => setQueueOf(null)}
      />
    </>
  )
}

const queueCol = columnHelper<ReplicationQueueEntry>()

function QueueDialog({
  cluster,
  row,
  onClose,
}: {
  cluster: string
  row: ReplicatedTable | null
  onClose: () => void
}) {
  const queue = useQuery({
    ...replicationQueueQuery(cluster, row?.table ?? "", row?.node ?? ""),
    enabled: row !== null,
  })
  const columns = useMemo(
    () => [
      queueCol.accessor("create_time", {
        header: "Created",
        cell: (c) => formatDateTime(c.getValue()),
      }),
      queueCol.accessor("type", { header: "Type" }),
      queueCol.accessor("num_tries", {
        header: "Tries",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      queueCol.accessor("postpone_reason", {
        header: "Postponed because",
        enableSorting: false,
      }),
      queueCol.accessor("last_exception", {
        header: "Last error",
        enableSorting: false,
        cell: (c) => (
          <span className="text-xs text-destructive">{c.getValue()}</span>
        ),
      }),
    ],
    []
  )
  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Replication queue · {row?.table}</DialogTitle>
          <DialogDescription>On replica {row?.node}</DialogDescription>
        </DialogHeader>
        {queue.error && <ErrorState error={queue.error} />}
        <DataTable
          columns={columns}
          data={queue.data}
          loading={queue.isPending}
          emptyText="Queue is empty."
          pageSize={10}
          dense
        />
      </DialogContent>
    </Dialog>
  )
}

const POOL_ORDER = [
  "MergesAndMutations",
  "Fetches",
  "Schedule",
  "Move",
  "Common",
]

function PoolsView({ cluster }: { cluster: string }) {
  const pools = useQuery(backgroundPoolQuery(cluster))
  if (pools.error) return <ErrorState error={pools.error} />
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Busy background threads on each node. A pool that stays near full means
        merges, fetches or moves are queuing up.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {pools.isPending
          ? Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-48" />
            ))
          : pools.data?.map((node) => {
              const names = [
                ...POOL_ORDER.filter((n) => n in node.background_pool),
                ...Object.keys(node.background_pool).filter(
                  (n) => !POOL_ORDER.includes(n)
                ),
              ]
              return (
                <div
                  key={node.host}
                  className="flex flex-col gap-3 rounded-lg border p-4"
                >
                  <span className="font-mono text-sm">{node.host}</span>
                  {names.map((name) => {
                    const p = node.background_pool[name]
                    const pct = Math.round(p.usage * 100)
                    return (
                      <div key={name} className="flex flex-col gap-1">
                        <div className="flex justify-between text-xs">
                          <span>
                            {name.replace(/([a-z])([A-Z])/g, "$1 $2")}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {p.task} / {p.size}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              pct > 85
                                ? "bg-red-500"
                                : pct > 50
                                  ? "bg-amber-500"
                                  : "bg-emerald-500"
                            )}
                            style={{
                              width: `${Math.max(pct, p.task > 0 ? 2 : 0)}%`,
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
      </div>
    </>
  )
}
