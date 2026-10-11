import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import { RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"

import {
  ddlQueueQuery,
  killSession,
  openSessionsQuery,
  slowSessionsQuery,
  type Session,
} from "@/api/observability"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { CopyButton, ErrorState } from "@/components/app/misc"
import { PageBody } from "@/components/app/page-header"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatDateTime, formatMs } from "@/lib/format"

const VIEWS = ["running", "slow", "ddl"] as const
type View = (typeof VIEWS)[number]

export const Route = createFileRoute("/_app/clusters/$cluster/sessions")({
  validateSearch: z.object({ view: z.enum(VIEWS).optional() }),
  component: SessionsPage,
})

const SLOW_RANGES: Record<string, string> = {
  "3600": "Last hour",
  "86400": "Last 24 hours",
  "604800": "Last 7 days",
  "2592000": "Last 30 days",
}

const col = columnHelper<Session>()

function SessionsPage() {
  const { cluster } = Route.useParams()
  const { view = "running" } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { session } = useRouteContext({ from: "/_app" })
  const canKill = session.policy !== "guest"
  const queryClient = useQueryClient()
  const [slowRange, setSlowRange] = useState("86400")
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [killing, setKilling] = useState<Session | null>(null)

  const running = useQuery({
    ...openSessionsQuery(cluster, 100),
    enabled: view === "running",
    refetchInterval: 5000,
  })
  const slow = useQuery({
    ...slowSessionsQuery(cluster, 50, now - Number(slowRange), now),
    enabled: view === "slow",
  })
  const ddl = useQuery({
    ...ddlQueueQuery(cluster),
    enabled: view === "ddl",
    refetchInterval: 10_000,
  })
  const current = view === "running" ? running : view === "slow" ? slow : ddl

  const columns = useMemo(
    () => [
      col.accessor("query", {
        header: "Query",
        enableSorting: false,
        cell: (c) => (
          <div className="flex max-w-xl items-start gap-1">
            <code
              className="line-clamp-2 font-mono text-xs break-all"
              title={c.getValue()}
            >
              {c.getValue()}
            </code>
            <CopyButton text={c.getValue()} className="shrink-0" />
          </div>
        ),
      }),
      col.accessor("queryDuration", {
        header: view === "ddl" ? "Waiting" : "Duration",
        cell: (c) => (
          <span className="whitespace-nowrap tabular-nums">
            {formatMs(c.getValue())}
          </span>
        ),
      }),
      col.accessor("startTime", {
        header: "Started",
        cell: (c) => (
          <span className="whitespace-nowrap">
            {formatDateTime(c.getValue())}
          </span>
        ),
      }),
      col.accessor("user", {
        header: "User",
        cell: (c) => c.getValue() || "—",
      }),
      col.accessor("host", {
        header: "Node",
        cell: (c) => <span className="font-mono">{c.getValue()}</span>,
      }),
      col.accessor("address", {
        header: "From",
        cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
      }),
      ...(view !== "slow" && canKill
        ? [
            col.display({
              id: "kill",
              header: () => <span className="sr-only">Kill</span>,
              cell: (c) => (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-destructive"
                  onClick={() => setKilling(c.row.original)}
                >
                  Kill
                </Button>
              ),
            }),
          ]
        : []),
    ],
    [view, canKill]
  )

  return (
    <PageBody>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={view}
          onValueChange={(v) => void navigate({ search: { view: v as View } })}
        >
          <TabsList>
            <TabsTrigger value="running">Running queries</TabsTrigger>
            <TabsTrigger value="slow">Slowest queries</TabsTrigger>
            <TabsTrigger value="ddl">Pending DDL</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {view === "slow" && (
            <Select
              items={SLOW_RANGES}
              value={slowRange}
              onValueChange={(v) => {
                setSlowRange(v as string)
                setNow(Math.floor(Date.now() / 1000))
              }}
            >
              <SelectTrigger size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SLOW_RANGES).map(([v, label]) => (
                  <SelectItem key={v} value={v}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNow(Math.floor(Date.now() / 1000))
              void queryClient.invalidateQueries({
                queryKey: ["cluster", cluster],
              })
            }}
          >
            <RefreshCwIcon /> Refresh
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {view === "running" &&
          "Queries running now on any node (SELECTs that read a table; inserts aren't listed). Refreshes every 5 seconds."}
        {view === "slow" &&
          "The 50 slowest finished queries in the chosen period, from each node's query log."}
        {view === "ddl" &&
          "ON CLUSTER statements still waiting on some node. Killing one stops it, or cancels pending mutations on its table."}
      </p>
      {current.error && <ErrorState error={current.error} />}
      <DataTable
        key={view}
        columns={columns}
        data={current.data}
        loading={current.isPending}
        searchable
        emptyText={
          view === "running"
            ? "Nothing running right now."
            : view === "ddl"
              ? "No pending DDL."
              : "No queries in this period."
        }
        initialSorting={[{ id: "queryDuration", desc: true }]}
      />
      <ConfirmDialog
        open={killing !== null}
        onOpenChange={(o) => !o && setKilling(null)}
        title="Kill this query?"
        description={
          view === "ddl"
            ? "If the statement isn't running, all pending mutations on its table are cancelled too."
            : "The client that sent it gets an error."
        }
        confirmLabel="Kill"
        destructive
        onConfirm={async () => {
          if (!killing) return
          await killSession(
            cluster,
            killing.host,
            killing.queryId,
            view === "ddl" ? "queue" : "open"
          )
          toast.success("Kill sent")
          await queryClient.invalidateQueries({
            queryKey: ["cluster", cluster],
          })
        }}
      />
    </PageBody>
  )
}
