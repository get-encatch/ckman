import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import {
  MoreHorizontalIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  clusterQuery,
  clusterStatusQuery,
  destroyCluster,
  startCluster,
  stopCluster,
} from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { ErrorState } from "@/components/app/misc"
import { useSshGate } from "@/components/app/ssh-gate"
import { ClusterHealth } from "@/components/app/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/clusters/$cluster")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(clusterQuery(params.cluster)),
  errorComponent: ({ error }) => (
    <div className="p-6">
      <ErrorState error={error} />
    </div>
  ),
  component: ClusterLayout,
})

const TABS = [
  { to: "/clusters/$cluster", label: "Overview", exact: true },
  { to: "/clusters/$cluster/nodes", label: "Nodes" },
  { to: "/clusters/$cluster/tables", label: "Tables" },
  { to: "/clusters/$cluster/sessions", label: "Sessions" },
  { to: "/clusters/$cluster/query", label: "Query" },
  { to: "/clusters/$cluster/backups", label: "Backups" },
  { to: "/clusters/$cluster/rebalance", label: "Rebalance" },
  { to: "/clusters/$cluster/settings", label: "Settings", deployOnly: true },
] as const

function ClusterLayout() {
  const { cluster } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const config = useQuery(clusterQuery(cluster))
  const status = useQuery({
    ...clusterStatusQuery(cluster),
    refetchInterval: 30_000,
  })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const ssh = useSshGate(status.data?.needPassword)
  const [confirm, setConfirm] = useState<"stop" | "destroy" | null>(null)
  const [busy, setBusy] = useState<"start" | "stop" | null>(null)

  const c = config.data
  const deployed = c?.mode !== "import"
  const shards = c?.shards ?? []
  const replicas = Math.max(0, ...shards.map((s) => s.replicas?.length ?? 0))
  const allDown = status.data?.nodes?.every((n) => n.status !== "green")

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["cluster", cluster] })

  async function start() {
    setBusy("start")
    try {
      const done = await ssh.withSsh((p) => startCluster(cluster, p))
      if (done !== undefined) toast.success(`Started ${cluster}`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4 border-b px-4 pt-5 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {cluster}
              </h1>
              <ClusterHealth status={status.data?.status} />
              {!deployed && <Badge variant="secondary">Imported</Badge>}
              {c?.docker && (
                <Badge variant="secondary">
                  Containers · port {c.docker.ports.tcp}
                </Badge>
              )}
            </div>
            {c ? (
              <p className="text-sm text-muted-foreground">
                ClickHouse {c.version || "?"} · {shards.length} shard
                {shards.length === 1 ? "" : "s"} × {replicas} replica
                {replicas === 1 ? "" : "s"} ·{" "}
                {c.keeper === "clickhouse-keeper"
                  ? "ClickHouse Keeper"
                  : "ZooKeeper"}
                {c.comment ? ` · ${c.comment}` : ""}
              </p>
            ) : (
              <Skeleton className="h-4 w-72" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              onClick={() => void refresh()}
            >
              <RefreshCwIcon
                className={cn(status.isFetching && "animate-spin")}
              />
            </Button>
            {isAdmin && deployed && (
              <>
                {allDown ? (
                  <Button onClick={start} disabled={busy !== null}>
                    <PlayIcon /> {busy === "start" ? "Starting…" : "Start"}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => setConfirm("stop")}
                    disabled={busy !== null}
                  >
                    <SquareIcon /> {busy === "stop" ? "Stopping…" : "Stop"}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="More actions"
                      />
                    }
                  >
                    <MoreHorizontalIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!allDown && (
                      <DropdownMenuItem onClick={start}>
                        Start stopped nodes
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setConfirm("destroy")}
                    >
                      Destroy cluster…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
        <nav
          className="-mb-px flex gap-1 overflow-x-auto"
          aria-label="Cluster sections"
        >
          {TABS.filter((t) => !("deployOnly" in t) || deployed).map((t) => (
            <Link
              key={t.to}
              to={t.to}
              params={{ cluster }}
              activeOptions={{ exact: "exact" in t }}
              className="border-b-2 border-transparent px-3 pb-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{
                className: "border-primary! text-foreground! font-medium",
              }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      {status.error && (
        <div className="px-4 pt-4 md:px-6">
          <ErrorState error={status.error} />
        </div>
      )}
      <Outlet />
      {ssh.dialog}
      <ConfirmDialog
        open={confirm === "stop"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Stop ${cluster}?`}
        description="ClickHouse stops on every node. Queries and inserts fail until you start it again. Keeper keeps running."
        confirmLabel="Stop cluster"
        destructive
        onConfirm={async () => {
          setBusy("stop")
          try {
            const done = await ssh.withSsh((p) => stopCluster(cluster, p))
            if (done !== undefined) toast.success(`Stopped ${cluster}`)
          } finally {
            setBusy(null)
            await refresh()
          }
        }}
      />
      <ConfirmDialog
        open={confirm === "destroy"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Destroy ${cluster}?`}
        description={
          <>
            This uninstalls ClickHouse
            {c?.keeper === "clickhouse-keeper" ? " and Keeper" : ""} from every
            node and <strong>deletes all data</strong>. It can't be undone.
          </>
        }
        typeToConfirm={cluster}
        confirmLabel="Destroy"
        destructive
        onConfirm={async () => {
          const taskId = await ssh.withSsh((p) => destroyCluster(cluster, p))
          if (taskId) {
            await queryClient.invalidateQueries({ queryKey: ["clusters"] })
            await navigate({ to: "/tasks/$taskId", params: { taskId } })
          }
        }}
      />
    </>
  )
}
