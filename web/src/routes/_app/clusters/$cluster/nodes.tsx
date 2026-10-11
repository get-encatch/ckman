import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  addNodes,
  clusterQuery,
  clusterStatusQuery,
  deleteNode,
  packagesQuery,
  restartNode,
  startNode,
  stopNode,
  upgradeCluster,
  type NodeInfo,
} from "@/api/queries"
import { AddNodesDialog } from "@/components/app/add-nodes-dialog"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { NodeLogSheet } from "@/components/app/node-log-sheet"
import { NodeOverrideSheet } from "@/components/app/node-override-sheet"
import { PageBody, Section } from "@/components/app/page-header"
import { useSshGate } from "@/components/app/ssh-gate"
import { NodeStatus, UsageBar } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { usedFraction } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/$cluster/nodes")({
  component: NodesPage,
})

const col = columnHelper<NodeInfo>()

function NodesPage() {
  const { cluster } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const config = useQuery(clusterQuery(cluster))
  const status = useQuery(clusterStatusQuery(cluster))
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const ssh = useSshGate(status.data?.needPassword)
  const deployed = config.data?.mode !== "import"
  const canManage = isAdmin && deployed

  const [pending, setPending] = useState<
    Record<string, "start" | "stop" | "restart">
  >({})
  const [logNode, setLogNode] = useState<string | null>(null)
  const [overrideNode, setOverrideNode] = useState<string | null>(null)
  const [removeNode, setRemoveNode] = useState<NodeInfo | null>(null)
  const [forceRemove, setForceRemove] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["cluster", cluster] })

  async function toggle(node: NodeInfo, action: "start" | "stop" | "restart") {
    setPending((p) => ({ ...p, [node.ip]: action }))
    try {
      const done = await ssh.withSsh((p) =>
        action === "start"
          ? startNode(cluster, node.ip, p)
          : action === "stop"
            ? stopNode(cluster, node.ip, p)
            : restartNode(cluster, node.ip, p)
      )
      if (done !== undefined)
        toast.success(
          `${{ start: "Started", stop: "Stopped", restart: "Restarted" }[action]} ${node.ip}`
        )
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setPending((p) =>
        Object.fromEntries(Object.entries(p).filter(([ip]) => ip !== node.ip))
      )
      await refresh()
    }
  }

  const columns = useMemo(
    () => [
      col.accessor("ip", {
        header: "Node",
        cell: (c) => (
          <div className="flex flex-col">
            <span className="font-mono">{c.getValue()}</span>
            <span className="text-xs text-muted-foreground">
              {c.row.original.hostname}
            </span>
          </div>
        ),
      }),
      col.accessor("shardNumber", {
        header: "Shard",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.accessor("replicaNumber", {
        header: "Replica",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.accessor("status", {
        header: "Status",
        cell: (c) =>
          pending[c.row.original.ip] ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              {
                {
                  start: "Starting…",
                  stop: "Stopping…",
                  restart: "Restarting…",
                }[pending[c.row.original.ip]]
              }
            </span>
          ) : (
            <div className="flex flex-col gap-0.5">
              <NodeStatus status={c.getValue()} />
              {c.row.original.uptime && (
                <span className="text-xs text-muted-foreground">
                  up {c.row.original.uptime}
                </span>
              )}
            </div>
          ),
      }),
      col.accessor("cpu", {
        header: "CPU",
        enableSorting: false,
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.accessor("memory", {
        header: "Memory",
        enableSorting: false,
        cell: (c) => (
          <UsageBar
            fraction={usedFraction(c.getValue())}
            label={c.getValue()}
          />
        ),
      }),
      col.accessor("data", {
        header: "Data",
        enableSorting: false,
        cell: (c) => (
          <span className="tabular-nums">{c.getValue() ?? "—"}</span>
        ),
      }),
      col.accessor("disk", {
        header: "Disk (volume)",
        enableSorting: false,
        cell: (c) => (
          <UsageBar
            fraction={usedFraction(c.getValue())}
            label={c.getValue()}
          />
        ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) => {
          const n = c.row.original
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${n.ip}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem onClick={() => setLogNode(n.ip)}>
                    View logs
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setOverrideNode(n.ip)}>
                    Node config override
                  </DropdownMenuItem>
                  {status.data?.httpPort && (
                    <DropdownMenuItem
                      render={
                        <a
                          href={`http://${n.ip}:${status.data.httpPort}/play`}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      Open ClickHouse Play ↗
                    </DropdownMenuItem>
                  )}
                  {canManage && (
                    <>
                      <DropdownMenuSeparator />
                      {n.status === "green" ? (
                        <>
                          <DropdownMenuItem
                            onClick={() => void toggle(n, "restart")}
                          >
                            Restart node
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void toggle(n, "stop")}
                          >
                            Stop node
                          </DropdownMenuItem>
                        </>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => void toggle(n, "start")}
                        >
                          Start node
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setRemoveNode(n)}
                      >
                        Remove from cluster…
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, canManage, status.data?.httpPort]
  )

  const shardCount = config.data?.shards?.length ?? 0
  const removingLastShardReplica =
    removeNode !== null &&
    (config.data?.shards?.[removeNode.shardNumber - 1]?.replicas?.length ??
      0) <= 1

  return (
    <PageBody>
      <Section
        title="Nodes"
        description="ClickHouse servers in this cluster, grouped as shards and replicas. Data is what ClickHouse stores on each node; Disk is the whole volume, so servers sharing a disk show the same figure."
        actions={
          canManage && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <PlusIcon /> Add nodes
            </Button>
          )
        }
      >
        <DataTable
          columns={columns}
          data={status.data?.nodes ?? undefined}
          loading={status.isPending}
          getRowId={(n) => n.ip}
          initialSorting={[{ id: "shardNumber", desc: false }]}
        />
      </Section>

      {canManage && config.data && (
        <UpgradeSection
          cluster={cluster}
          currentVersion={status.data?.version ?? config.data.version}
          pkgType={config.data.pkgType}
          usesKeeper={config.data.keeper === "clickhouse-keeper"}
          onUpgrade={async (body) => {
            const taskId = await ssh.withSsh((p) =>
              upgradeCluster(cluster, body, p)
            )
            if (taskId)
              await navigate({ to: "/tasks/$taskId", params: { taskId } })
          }}
        />
      )}

      {ssh.dialog}
      <NodeLogSheet
        cluster={cluster}
        ip={logNode}
        onClose={() => setLogNode(null)}
        withSsh={ssh.withSsh}
      />
      <NodeOverrideSheet
        cluster={cluster}
        ip={overrideNode}
        canEdit={canManage}
        onClose={() => setOverrideNode(null)}
      />
      {config.data && status.data && (
        <AddNodesDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          cluster={cluster}
          shardCount={shardCount}
          isReplica={config.data.isReplica}
          nodes={status.data.nodes ?? []}
          onSubmit={async (body, force) => {
            const taskId = await ssh.withSsh((p) =>
              addNodes(cluster, body, { ...p, force })
            )
            if (taskId)
              await navigate({ to: "/tasks/$taskId", params: { taskId } })
          }}
        />
      )}
      <ConfirmDialog
        open={removeNode !== null}
        onOpenChange={(o) => {
          if (!o) {
            setRemoveNode(null)
            setForceRemove(false)
          }
        }}
        title={`Remove ${removeNode?.ip} from ${cluster}?`}
        description={
          <div className="flex flex-col gap-3">
            <p>
              ClickHouse is uninstalled from this node and it leaves the
              cluster.
              {removingLastShardReplica
                ? removeNode?.shardNumber === shardCount
                  ? " It is the only replica of the last shard, so the shard goes away too. Move its data with Rebalance first, or its rows are lost."
                  : " It is the only replica of its shard; only the last shard can be removed this way."
                : " Its shard keeps its other replicas, so no data is lost."}
            </p>
            {removingLastShardReplica && (
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={forceRemove}
                  onCheckedChange={(v) => setForceRemove(v === true)}
                />
                Remove even if the node still holds data
              </Label>
            )}
          </div>
        }
        confirmLabel="Remove node"
        destructive
        onConfirm={async () => {
          if (!removeNode) return
          const taskId = await ssh.withSsh((p) =>
            deleteNode(cluster, removeNode.ip, { ...p, force: forceRemove })
          )
          if (taskId)
            await navigate({ to: "/tasks/$taskId", params: { taskId } })
        }}
      />
    </PageBody>
  )
}

function UpgradeSection({
  cluster,
  currentVersion,
  pkgType,
  usesKeeper,
  onUpgrade,
}: {
  cluster: string
  currentVersion: string
  pkgType: string
  usesKeeper: boolean
  onUpgrade: (body: {
    packageVersion: string
    policy: "Full" | "Rolling"
    skip: boolean
    skipKeeper: boolean
  }) => Promise<void>
}) {
  const packages = useQuery(packagesQuery(pkgType))
  const versions = (packages.data ?? [])
    .map((p) => p.version)
    .filter((v) => v !== currentVersion)
  const [version, setVersion] = useState<string | null>(null)
  const [policy, setPolicy] = useState<"Full" | "Rolling">("Rolling")
  const [skipKeeper, setSkipKeeper] = useState(false)
  const [confirm, setConfirm] = useState(false)

  return (
    <Section
      title="Upgrade"
      description={`${cluster} runs ClickHouse ${currentVersion}. Upload newer versions on the Packages page.`}
    >
      <div className="flex flex-wrap items-end gap-4 rounded-lg border p-4">
        <Field className="w-56">
          <FieldLabel>Upgrade to</FieldLabel>
          <Select
            value={version}
            onValueChange={(v) => setVersion(v as string)}
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={
                  versions.length ? "Choose a version" : "No other versions"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-56">
          <FieldLabel>Restart</FieldLabel>
          <Select
            items={{
              Rolling: "Rolling (one node at a time)",
              Full: "Full (all nodes at once)",
            }}
            value={policy}
            onValueChange={(v) => setPolicy(v as "Full" | "Rolling")}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Rolling">
                Rolling (one node at a time)
              </SelectItem>
              <SelectItem value="Full">Full (all nodes at once)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {usesKeeper && (
          <Label className="flex h-9 items-center gap-2 font-normal">
            <Checkbox
              checked={skipKeeper}
              onCheckedChange={(v) => setSkipKeeper(v === true)}
            />
            Leave Keeper on its current version
          </Label>
        )}
        <Button disabled={!version} onClick={() => setConfirm(true)}>
          Upgrade…
        </Button>
        <FieldDescription className="basis-full">
          Rolling keeps the cluster serving queries while each node restarts.
        </FieldDescription>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Upgrade ${cluster} to ${version}?`}
        description={
          policy === "Rolling"
            ? "Nodes are upgraded and restarted one at a time."
            : "All nodes restart together; the cluster is briefly unavailable."
        }
        confirmLabel="Start upgrade"
        onConfirm={() =>
          version
            ? onUpgrade({
                packageVersion: version,
                policy,
                skip: true,
                skipKeeper,
              })
            : undefined
        }
      />
    </Section>
  )
}
