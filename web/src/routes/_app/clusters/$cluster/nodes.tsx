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
import {
  fleetStatsQuery,
  machinesQuery,
  resizeCluster,
  scaleKeepers,
  versionsQuery,
  type DockerConf,
} from "@/api/fleet"
import { keeperStatusQuery } from "@/api/observability"
import { machineLabel, MachineSelect } from "@/components/app/fleet-placement"
import { AddNodesDialog } from "@/components/app/add-nodes-dialog"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { NodeLogSheet } from "@/components/app/node-log-sheet"
import { NodeOverrideSheet } from "@/components/app/node-override-sheet"
import { PageBody, Section } from "@/components/app/page-header"
import { useSshGate } from "@/components/app/ssh-gate"
import { NodeStatus, StatusPill, UsageBar } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
  const machines = useQuery({
    ...machinesQuery(),
    enabled: config.data?.docker !== undefined,
  })
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
          docker={config.data.docker !== undefined}
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

      {canManage && config.data?.docker && (
        <ResizeSection cluster={cluster} docker={config.data.docker} />
      )}

      {canManage &&
        config.data?.docker &&
        config.data.keeper === "clickhouse-keeper" &&
        config.data.KeeperConf?.runtime === "standalone" && (
          <KeepersSection
            cluster={cluster}
            nodes={config.data.KeeperConf.keeperNodes ?? []}
            ids={config.data.KeeperConf.serverIds ?? []}
            onTask={(taskId) =>
              void navigate({ to: "/tasks/$taskId", params: { taskId } })
            }
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
          fleetMachines={
            config.data.docker
              ? (machines.data ?? [])
                  .filter(
                    (m) =>
                      m.status === "ready" &&
                      !(status.data?.nodes ?? []).some((n) => n.ip === m.ip)
                  )
                  .map((m) => ({
                    ip: m.ip,
                    label: `${m.name}${m.zone ? ` · ${m.zone}` : ""} (${m.ip})`,
                  }))
              : undefined
          }
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
  docker,
  usesKeeper,
  onUpgrade,
}: {
  cluster: string
  currentVersion: string
  pkgType: string
  docker: boolean
  usesKeeper: boolean
  onUpgrade: (body: {
    packageVersion: string
    policy: "Full" | "Rolling"
    skip: boolean
    skipKeeper: boolean
  }) => Promise<void>
}) {
  const packages = useQuery({ ...packagesQuery(pkgType), enabled: !docker })
  const hub = useQuery({ ...versionsQuery(), enabled: docker })
  const versions = (
    docker ? (hub.data ?? []) : (packages.data ?? []).map((p) => p.version)
  ).filter((v) => v !== currentVersion)
  const [version, setVersion] = useState<string | null>(null)
  const [policy, setPolicy] = useState<"Full" | "Rolling">("Rolling")
  const [skipKeeper, setSkipKeeper] = useState(false)
  const [confirm, setConfirm] = useState(false)

  return (
    <Section
      title="Upgrade"
      description={
        docker
          ? `${cluster} runs ClickHouse ${currentVersion} in containers. Versions come from Docker Hub; upgrading swaps the image and keeps the data.`
          : `${cluster} runs ClickHouse ${currentVersion}. Upload newer versions on the Packages page.`
      }
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

// Docker clusters: change every container's limits live.
function ResizeSection({
  cluster,
  docker,
}: {
  cluster: string
  docker: DockerConf
}) {
  const queryClient = useQueryClient()
  const stats = useQuery(fleetStatsQuery())
  const [form, setForm] = useState(() => toForm(docker))
  const [last, setLast] = useState(docker)
  const [overcommit, setOvercommit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (docker !== last) {
    setLast(docker)
    setForm(toForm(docker))
  }
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }))
  const changed = JSON.stringify(form) !== JSON.stringify(toForm(docker))

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const n = (v: string) => Number(v) || 0
      await resizeCluster(cluster, {
        cpu: n(form.cpu),
        memory_mb: n(form.memory_mb),
        disk_gb: n(form.disk_gb),
        keeper_cpu: n(form.keeper_cpu),
        keeper_memory_mb: n(form.keeper_memory_mb),
        keeper_disk_gb: n(form.keeper_disk_gb),
        allow_overcommit: overcommit,
      })
      toast.success(`Resized ${cluster}`)
      await queryClient.invalidateQueries({ queryKey: ["cluster", cluster] })
      await queryClient.invalidateQueries({ queryKey: ["machines"] })
      void stats.refetch()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const input = (k: keyof typeof form, label: string) => (
    <Field className="w-28">
      <FieldLabel>{label}</FieldLabel>
      <Input
        inputMode="decimal"
        value={form[k]}
        onChange={(e) => set(k, e.target.value)}
        aria-label={label}
      />
    </Field>
  )

  return (
    <Section
      title="Resources"
      description={`Limits of each container. CPU and memory change live, without a restart; disk is a soft limit. Ports: ${docker.ports.tcp} native, ${docker.ports.http} HTTP, ${docker.ports.interserver} replication, Keeper ${docker.ports.keeper_tcp}.`}
    >
      <div className="flex flex-col gap-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <span className="w-32 pb-2 text-sm font-medium">ClickHouse</span>
          {input("cpu", "CPU cores")}
          {input("memory_mb", "Memory MiB")}
          {input("disk_gb", "Disk GiB")}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <span className="w-32 pb-2 text-sm font-medium">Keeper</span>
          {input("keeper_cpu", "Keeper CPU")}
          {input("keeper_memory_mb", "Keeper MiB")}
          {input("keeper_disk_gb", "Keeper disk GiB")}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={overcommit}
              onCheckedChange={(v) => setOvercommit(v === true)}
            />
            Allow overcommit
          </Label>
          <Button disabled={!changed || busy} onClick={() => void apply()}>
            {busy ? "Applying…" : "Apply"}
          </Button>
          {error && <FieldError>{error}</FieldError>}
        </div>
      </div>
    </Section>
  )
}

const toForm = (d: DockerConf) => ({
  cpu: String(d.cpu),
  memory_mb: String(d.memory_mb),
  disk_gb: String(d.disk_gb),
  keeper_cpu: String(d.keeper_cpu),
  keeper_memory_mb: String(d.keeper_memory_mb),
  keeper_disk_gb: String(d.keeper_disk_gb),
})

// KeepersSection adds Keepers on machines the user picks and removes others.
// ckman changes one Keeper at a time and waits for it to join or leave.
function KeepersSection({
  cluster,
  nodes,
  ids,
  onTask,
}: {
  cluster: string
  nodes: string[]
  ids: number[]
  onTask: (taskId: string) => void
}) {
  const machines = useQuery(machinesQuery())
  const stats = useQuery(fleetStatsQuery())
  const keeper = useQuery(keeperStatusQuery(cluster))
  const [remove, setRemove] = useState<Set<string>>(new Set())
  const [add, setAdd] = useState<string[]>([])
  const [overcommit, setOvercommit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const byIP = new Map((machines.data ?? []).map((m) => [m.ip, m]))
  const statsById = new Map((stats.data ?? []).map((s) => [s.machine_id, s]))
  const roleOf = new Map((keeper.data ?? []).map((k) => [k.host, k]))
  const candidates = (machines.data ?? []).filter(
    (m) => m.status === "ready" && !nodes.includes(m.ip)
  )
  const items = Object.fromEntries(
    candidates.map((m) => [m.id, machineLabel(m, statsById.get(m.id))])
  )
  const adding = add.filter(Boolean)
  const total = nodes.length - remove.size + adding.length
  const changed = remove.size > 0 || adding.length > 0
  const problem =
    total < 1
      ? "A cluster needs at least one Keeper."
      : total % 2 === 0
        ? `That leaves ${total} Keepers: use an odd number (1, 3 or 5) so a majority survives a failure.`
        : new Set(adding).size !== adding.length
          ? "A machine is chosen twice."
          : null

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const res = await scaleKeepers(cluster, {
        add: adding,
        remove: [...remove],
        allow_overcommit: overcommit,
      })
      toast.success("Changing Keepers")
      onTask(res.task_id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Keepers"
      description="Coordination nodes for replication and ON CLUSTER changes. Run 3 (or 5) on different machines so the cluster keeps taking writes if one fails. ckman adds and removes one Keeper at a time and waits for each to join or leave."
    >
      <div className="flex flex-col gap-4 rounded-lg border p-4">
        <ul className="flex flex-col divide-y">
          {nodes.map((ip, i) => {
            const m = byIP.get(ip)
            const k = roleOf.get(ip)
            return (
              <li key={ip} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-mono text-sm">{ip}</span>
                <span className="text-xs text-muted-foreground">
                  {m ? `${m.name}${m.zone ? ` · ${m.zone}` : ""}` : ""} · server{" "}
                  {ids[i] ?? i + 1}
                </span>
                {k &&
                  (k.peer_state === "offline" ? (
                    <StatusPill tone="bad" label="Offline" />
                  ) : (
                    <StatusPill
                      tone={k.server_state === "leader" ? "ok" : "info"}
                      label={k.server_state}
                    />
                  ))}
                <Label className="ml-auto flex items-center gap-2 font-normal">
                  <Checkbox
                    checked={remove.has(ip)}
                    onCheckedChange={(v) =>
                      setRemove((s) => {
                        const n = new Set(s)
                        if (v === true) n.add(ip)
                        else n.delete(ip)
                        return n
                      })
                    }
                  />
                  Remove
                </Label>
              </li>
            )
          })}
        </ul>
        {add.map((id, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-full max-w-md">
              <MachineSelect
                label={`New Keeper ${i + 1} machine`}
                items={items}
                candidates={candidates}
                value={id}
                onChange={(v) =>
                  setAdd((a) => a.map((x, j) => (j === i ? v : x)))
                }
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdd((a) => a.filter((_, j) => j !== i))}
            >
              Cancel
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={candidates.length === 0}
            onClick={() => setAdd((a) => [...a, ""])}
          >
            <PlusIcon /> Add a Keeper
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-sm">
            {changed
              ? `${nodes.length} → ${total} Keepers`
              : `${nodes.length} Keeper${nodes.length === 1 ? "" : "s"}`}
          </span>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={overcommit}
              onCheckedChange={(v) => setOvercommit(v === true)}
            />
            Allow overcommit
          </Label>
          <Button
            disabled={!changed || !!problem || busy || add.some((x) => !x)}
            onClick={() => void apply()}
          >
            {busy ? "Checking…" : "Apply"}
          </Button>
        </div>
        {changed && problem && <FieldDescription>{problem}</FieldDescription>}
        {error && <FieldError>{error}</FieldError>}
      </div>
    </Section>
  )
}
