import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router"
import { RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  createStandby,
  fleetSettingsQuery,
  fleetStatsQuery,
  machinesQuery,
  planCluster,
  removeStandby,
  standbyAction,
  standbyQuery,
  versionsQuery,
  type FleetClusterRequest,
  type FleetPlan,
  type Machine,
  type Standby,
} from "@/api/fleet"
import { clusterQuery } from "@/api/queries"
import { connectionsQuery } from "@/api/storage"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import {
  machineLabel,
  MachineSelect,
  PlanReview,
  SizeGroup,
} from "@/components/app/fleet-placement"
import { ErrorState, KeyValue } from "@/components/app/misc"
import { PageBody, Section } from "@/components/app/page-header"
import { StatusPill } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { formatAgo, formatDateTime, formatNumber } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/$cluster/standby")({
  component: StandbyPage,
})

function StandbyPage() {
  const { cluster } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const standby = useQuery(standbyQuery(cluster))

  if (standby.error)
    return (
      <PageBody>
        <ErrorState error={standby.error} />
      </PageBody>
    )
  if (standby.isPending)
    return (
      <PageBody>
        <Skeleton className="h-40 w-full" />
      </PageBody>
    )
  return (
    <PageBody className="max-w-4xl">
      {standby.data ? (
        <StandbyStatus cluster={cluster} sb={standby.data} isAdmin={isAdmin} />
      ) : isAdmin ? (
        <StandbySetup cluster={cluster} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {cluster} has no standby.
        </p>
      )}
    </PageBody>
  )
}

// ─── status ──────────────────────────────────────────────────────────────────

function lagText(seconds: number) {
  if (seconds < 0) return "not synced yet"
  if (seconds < 90) return `${seconds} s behind`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min behind`
  return `${(seconds / 3600).toFixed(1)} h behind`
}

function StandbyStatus({
  cluster,
  sb,
  isAdmin,
}: {
  cluster: string
  sb: Standby
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const target = useQuery({
    ...clusterQuery(sb.cluster ?? ""),
    enabled: sb.mode === "storage" && !!sb.cluster,
  })
  const connections = useQuery(connectionsQuery())
  const [promote, setPromote] = useState(false)
  const [finalSync, setFinalSync] = useState(true)
  const [remove, setRemove] = useState(false)
  const [purge, setPurge] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["cluster", cluster, "standby"] })

  async function act(action: "sync" | "pause" | "resume") {
    setBusy(true)
    try {
      await standbyAction(cluster, action)
      toast.success(
        action === "sync"
          ? "Sync started"
          : action === "pause"
            ? "Syncing paused"
            : "Syncing resumed"
      )
      await refresh()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const storage = sb.mode === "storage"
  const promoted = !!sb.promoted_at && !sb.promoted_at.startsWith("0001")
  const connection = connections.data?.find(
    (c) => c.connection_id === sb.connection_id
  )
  const tables = Object.entries(sb.tables ?? {}).sort((a, b) =>
    a[0].localeCompare(b[0])
  )
  const tone = promoted
    ? "info"
    : sb.state === "failed" || sb.overdue
      ? "bad"
      : sb.state === "ready"
        ? "ok"
        : "warn"

  return (
    <>
      <Section
        title="Standby"
        description={
          storage
            ? `A separate cluster in ${sb.zone}, fed from ${connection?.type === "azure" ? "Azure Blob" : "S3"} storage. Only changed partitions are copied each sync.`
            : `Extra replicas of ${cluster} in ${sb.zone}, kept current by ClickHouse replication.`
        }
        actions={
          isAdmin &&
          !promoted && (
            <>
              {storage && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || sb.state === "syncing"}
                  onClick={() => void act("sync")}
                >
                  <RefreshCwIcon /> Sync now
                </Button>
              )}
              {storage && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act(sb.paused ? "resume" : "pause")}
                >
                  {sb.paused ? "Resume" : "Pause"}
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setPromote(true)}
              >
                Fail over…
              </Button>
            </>
          )
        }
      >
        {promoted && (
          <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-4 text-sm">
            <p className="font-medium">
              Failed over {formatAgo(sb.promoted_at)}.
            </p>
            <p className="text-muted-foreground">
              {storage && sb.cluster ? (
                <>
                  Point your apps at{" "}
                  <Link
                    to="/clusters/$cluster"
                    params={{ cluster: sb.cluster }}
                    className="underline"
                  >
                    {sb.cluster}
                  </Link>
                  {target.data?.docker &&
                    ` (native port ${target.data.docker.ports.tcp}, HTTP ${target.data.docker.ports.http})`}
                  . Resize it or add replicas there for full production
                  capacity. Syncing has stopped.
                </>
              ) : (
                "The standby replicas are already part of the cluster; nothing else changes."
              )}
              {sb.state_message ? ` ${sb.state_message}.` : ""}
            </p>
          </div>
        )}
        {sb.overdue && !promoted && (
          <FieldError>
            The standby is {lagText(sb.lag_seconds)}: more than twice the{" "}
            {sb.effective_interval_min}-minute interval.
          </FieldError>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="State"
            value={
              <StatusPill
                tone={tone}
                busy={sb.state === "syncing" || sb.state === "creating"}
                label={
                  promoted
                    ? "Promoted"
                    : sb.paused
                      ? "Paused"
                      : sb.state === "ready"
                        ? "In sync"
                        : sb.state === "failed"
                          ? "Sync failed"
                          : sb.state === "creating"
                            ? "Creating"
                            : "Syncing"
                }
              />
            }
            hint={sb.state === "creating" ? sb.state_message : undefined}
          />
          {storage ? (
            <>
              <StatCard
                label="Data as of"
                value={
                  sb.last_success && !sb.last_success.startsWith("0001")
                    ? formatDateTime(sb.last_success)
                    : "—"
                }
                hint={lagText(sb.lag_seconds)}
              />
              <StatCard
                label="Next sync"
                value={
                  sb.next_sync && !sb.next_sync.startsWith("0001")
                    ? formatDateTime(sb.next_sync)
                    : "—"
                }
                hint={`every ${sb.effective_interval_min} min · last copied ${sb.last_synced} partition${sb.last_synced === 1 ? "" : "s"}`}
              />
            </>
          ) : (
            <>
              <StatCard
                label="Replication delay"
                value={`${sb.replica_delay_seconds} s`}
                hint={`${sb.replica_queue} task(s) queued`}
              />
              <StatCard
                label="Standby replicas"
                value={(sb.replica_ips ?? []).length}
                hint={(sb.replica_ips ?? []).join(", ")}
              />
            </>
          )}
        </div>
        {sb.last_error && !promoted && (
          <ErrorState error={new Error(`Last sync: ${sb.last_error}`)} />
        )}
        {sb.replica_error && <ErrorState error={new Error(sb.replica_error)} />}
        <KeyValue
          items={[
            ["Zone", sb.zone],
            ...(storage
              ? ([
                  [
                    "Standby cluster",
                    sb.cluster ? (
                      <Link
                        key="c"
                        to="/clusters/$cluster"
                        params={{ cluster: sb.cluster }}
                        className="underline"
                      >
                        {sb.cluster}
                      </Link>
                    ) : (
                      "—"
                    ),
                  ],
                  [
                    "Storage",
                    `${connection?.name ?? sb.connection_id} · ${connection?.type === "azure" ? "container" : "bucket"} ${sb.bucket}`,
                  ],
                  [
                    "Databases",
                    sb.databases?.length ? sb.databases.join(", ") : "All",
                  ],
                  ["Syncs", formatNumber(sb.syncs)],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
      </Section>

      {storage && tables.length > 0 && (
        <Section
          title="Tables"
          description="Rows on the primary and the standby at the last sync."
        >
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Table</th>
                  <th className="px-3 py-2 text-right font-medium">Primary</th>
                  <th className="px-3 py-2 text-right font-medium">Standby</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {tables.map(([name, t]) => (
                  <tr key={name} className="border-t">
                    <td className="px-3 py-2 font-mono">{name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(t.primary_rows)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(t.standby_rows)}
                    </td>
                    <td className="px-3 py-2">
                      {t.primary_rows === t.standby_rows ? (
                        <StatusPill tone="ok" label="Match" />
                      ) : (
                        <StatusPill tone="warn" label="Differs" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {isAdmin && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setRemove(true)}>
            Remove standby…
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={promote}
        onOpenChange={setPromote}
        title={`Fail over ${cluster}?`}
        description={
          <div className="flex flex-col gap-3">
            <p>
              {storage
                ? `${sb.cluster} becomes the cluster to use and syncing stops for good. Point your apps at it.`
                : "The standby replicas already serve the cluster; this records the failover."}
            </p>
            {storage && (
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={finalSync}
                  onCheckedChange={(v) => setFinalSync(v === true)}
                />
                Run a last sync first if {cluster} still answers
              </Label>
            )}
          </div>
        }
        typeToConfirm={cluster}
        confirmLabel="Fail over"
        destructive
        onConfirm={async () => {
          const res = await standbyAction(cluster, "promote", {
            final_sync: storage && finalSync,
          })
          toast.success(res.note || "Failed over")
          await refresh()
        }}
      />
      <ConfirmDialog
        open={remove}
        onOpenChange={setRemove}
        title={`Remove the standby of ${cluster}?`}
        description={
          <div className="flex flex-col gap-3">
            <p>
              ckman stops syncing and forgets the standby.{" "}
              {storage
                ? `${sb.cluster} keeps running; destroy it from its page if you no longer need it.`
                : "The standby replicas stay in the cluster; remove them on the Nodes page."}
            </p>
            {storage && (
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={purge}
                  onCheckedChange={(v) => setPurge(v === true)}
                />
                Also delete the standby&apos;s backups from the bucket
              </Label>
            )}
          </div>
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          await removeStandby(cluster, purge)
          toast.success("Standby removed")
          await refresh()
        }}
      />
    </>
  )
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

// ─── setup ───────────────────────────────────────────────────────────────────

function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

const cmpVersion = (a: string, b: string) => {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function StandbySetup({ cluster }: { cluster: string }) {
  const queryClient = useQueryClient()
  const config = useQuery(clusterQuery(cluster))
  const machines = useQuery(machinesQuery())
  const stats = useQuery(fleetStatsQuery())
  const versions = useQuery(versionsQuery())
  const connections = useQuery(connectionsQuery())
  const settings = useQuery(fleetSettingsQuery())

  const c = config.data
  const shardCount = c?.shards?.length ?? 1
  const docker = !!c?.docker
  const primaryIPs = useMemo(
    () =>
      new Set((c?.shards ?? []).flatMap((s) => s.replicas.map((r) => r.ip))),
    [c]
  )
  const ready = useMemo(
    () => (machines.data ?? []).filter((m) => m.status === "ready"),
    [machines.data]
  )
  const zones = useMemo(() => {
    const z = new Map<string, boolean>()
    for (const m of machines.data ?? [])
      if (m.zone)
        z.set(m.zone, (z.get(m.zone) ?? false) || primaryIPs.has(m.ip))
    return [...z.entries()].sort(
      (a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0])
    )
  }, [machines.data, primaryIPs])
  const statsById = useMemo(
    () => new Map((stats.data ?? []).map((s) => [s.machine_id, s])),
    [stats.data]
  )

  const [mode, setMode] = useState<"storage" | "replica">("storage")
  const [zone, setZone] = useState<string | null>(null)
  const chosenZone = zone ?? zones[0]?.[0] ?? ""
  const [name, setName] = useState(`${cluster}_dr`)
  const [version, setVersion] = useState<string | null>(null)
  const [replicas, setReplicas] = useState(1)
  const [placement, setPlacement] = useState<string[][]>([])
  const [keeperCount, setKeeperCount] = useState(1)
  const [keepers, setKeepers] = useState<string[]>([""])
  const [sizes, setSizes] = useState({
    cpu: "",
    memory_mb: "",
    disk_gb: "",
    keeper_cpu: "0.5",
    keeper_memory_mb: "512",
    keeper_disk_gb: "10",
  })
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [bucket, setBucket] = useState(
    `standby-${cluster.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 63)
  )
  const [databases, setDatabases] = useState("")
  const [interval, setIntervalMin] = useState("")
  const [password, setPassword] = useState(randomPassword)
  const [overcommit, setOvercommit] = useState(false)
  const [plan, setPlan] = useState<FleetPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const zoneMachines = ready.filter((m) => m.zone === chosenZone)
  const items = Object.fromEntries(
    zoneMachines.map((m) => [m.id, machineLabel(m, statsById.get(m.id))])
  )
  const grid = Array.from({ length: shardCount }, (_, i) =>
    Array.from({ length: replicas }, (_, j) => placement[i]?.[j] ?? "")
  )
  const okVersions = (versions.data ?? []).filter(
    (v) => !c?.version || cmpVersion(v, c.version) >= 0
  )
  const chosenVersion =
    version ??
    (c && okVersions.includes(c.version) ? c.version : okVersions[0]) ??
    ""
  const size = (k: keyof typeof sizes, fallback: number) =>
    sizes[k] === "" ? fallback : Number(sizes[k]) || 0
  const touch = () => {
    setPlan(null)
    setError(null)
  }

  function clusterRequest(): FleetClusterRequest {
    return {
      cluster: name.trim(),
      comment: `standby of ${cluster}`,
      version: chosenVersion,
      shards: grid,
      keepers: keepers.slice(0, keeperCount),
      password,
      allow_overcommit: overcommit,
      cpu: size("cpu", c?.docker?.cpu ?? 2),
      memory_mb: size("memory_mb", c?.docker?.memory_mb ?? 4096),
      disk_gb: size("disk_gb", c?.docker?.disk_gb ?? 100),
      keeper_cpu: size("keeper_cpu", 0.5),
      keeper_memory_mb: size("keeper_memory_mb", 512),
      keeper_disk_gb: size("keeper_disk_gb", 10),
    }
  }

  async function check() {
    setBusy(true)
    setError(null)
    try {
      setPlan(await planCluster(clusterRequest()))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const minutes = interval.trim() === "" ? 0 : Number(interval)
      await createStandby({
        primary: cluster,
        mode,
        zone: chosenZone,
        interval_min: minutes,
        allow_overcommit: overcommit,
        ...(mode === "storage"
          ? {
              connection_id: connectionId ?? "",
              bucket: bucket.trim(),
              databases: databases
                .split(/[\s,]+/)
                .map((d) => d.trim())
                .filter(Boolean),
              cluster: clusterRequest(),
            }
          : { replicas: grid.map((row) => row[0]) }),
      })
      toast.success(
        mode === "storage"
          ? `Creating ${name}; the first sync starts when it's up`
          : "Adding standby replicas"
      )
      await queryClient.invalidateQueries({
        queryKey: ["cluster", cluster, "standby"],
      })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!c) return <Skeleton className="h-40 w-full" />

  return (
    <>
      <Section
        title="Set up a standby"
        description="Keep a copy of this cluster in another zone, on machines you choose, to fail over to if this zone goes down."
      >
        <FieldGroup>
          <RadioGroup
            value={mode}
            onValueChange={(v) => {
              touch()
              setMode(v as "storage" | "replica")
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <Label className="flex items-start gap-3 rounded-lg border p-4 font-normal">
              <RadioGroupItem value="storage" className="mt-0.5" />
              <span>
                <span className="block font-medium">Storage sync</span>
                <span className="text-xs text-muted-foreground">
                  A separate cluster with its own Keeper, fed from S3 or Azure
                  Blob every few minutes. No traffic between zones: best on AWS.
                  Can lose up to one interval of data.
                </span>
              </span>
            </Label>
            <Label
              className={`flex items-start gap-3 rounded-lg border p-4 font-normal ${docker ? "" : "opacity-50"}`}
            >
              <RadioGroupItem
                value="replica"
                disabled={!docker}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">Live replica</span>
                <span className="text-xs text-muted-foreground">
                  One more replica per shard in the other zone, kept current
                  within seconds. Uses cross-zone traffic (free within an Azure
                  region).{" "}
                  {!docker && "Needs a cluster running on fleet machines."}
                </span>
              </span>
            </Label>
          </RadioGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Standby zone</FieldLabel>
              <Select
                items={Object.fromEntries(
                  zones.map(([z, used]) => [
                    z,
                    used ? `${z} (this cluster runs here)` : z,
                  ])
                )}
                value={chosenZone || null}
                onValueChange={(v) => {
                  touch()
                  setZone(v as string)
                  setPlacement([])
                  setKeepers(Array.from({ length: keeperCount }, () => ""))
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No zones: set zones on machines" />
                </SelectTrigger>
                <SelectContent>
                  {zones.map(([z, used]) => (
                    <SelectItem key={z} value={z}>
                      {used ? `${z} (this cluster runs here)` : z}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {zoneMachines.length} ready machine
                {zoneMachines.length === 1 ? "" : "s"} in this zone.
              </FieldDescription>
            </Field>
            {mode === "storage" && (
              <Field>
                <FieldLabel htmlFor="sb-interval">
                  Sync every (minutes)
                </FieldLabel>
                <Input
                  id="sb-interval"
                  inputMode="numeric"
                  value={interval}
                  placeholder={`${settings.data?.standby_interval_min ?? 15} (fleet default)`}
                  onChange={(e) => setIntervalMin(e.target.value)}
                />
                <FieldDescription>
                  At least 5. The standby can lose up to this much data.
                </FieldDescription>
              </Field>
            )}
          </div>
        </FieldGroup>
      </Section>

      {mode === "storage" ? (
        <>
          <Section
            title="Standby cluster"
            description={`Its own machines, size and replicas; it needs ${shardCount} shard${shardCount === 1 ? "" : "s"} like ${cluster}, and the same or a newer version.`}
          >
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="sb-name">Name</FieldLabel>
                  <Input
                    id="sb-name"
                    value={name}
                    onChange={(e) => {
                      touch()
                      setName(e.target.value)
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel>Version</FieldLabel>
                  <Select
                    items={Object.fromEntries(okVersions.map((v) => [v, v]))}
                    value={chosenVersion || null}
                    onValueChange={(v) => {
                      touch()
                      setVersion(v as string)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Loading…" />
                    </SelectTrigger>
                    <SelectContent>
                      {okVersions.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="sb-replicas">Replicas each</FieldLabel>
                  <Input
                    id="sb-replicas"
                    type="number"
                    min={1}
                    max={5}
                    value={replicas}
                    onChange={(e) => {
                      touch()
                      setReplicas(
                        Math.max(1, Math.min(5, Number(e.target.value) || 1))
                      )
                    }}
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <SizeGroup
                  title="Each ClickHouse server"
                  cpu={
                    sizes.cpu === "" ? String(c.docker?.cpu ?? 2) : sizes.cpu
                  }
                  mem={
                    sizes.memory_mb === ""
                      ? String(c.docker?.memory_mb ?? 4096)
                      : sizes.memory_mb
                  }
                  disk={
                    sizes.disk_gb === ""
                      ? String(c.docker?.disk_gb ?? 100)
                      : sizes.disk_gb
                  }
                  onCpu={(v) => {
                    touch()
                    setSizes((s) => ({ ...s, cpu: v }))
                  }}
                  onMem={(v) => {
                    touch()
                    setSizes((s) => ({ ...s, memory_mb: v }))
                  }}
                  onDisk={(v) => {
                    touch()
                    setSizes((s) => ({ ...s, disk_gb: v }))
                  }}
                />
                <SizeGroup
                  title="Each Keeper"
                  cpu={sizes.keeper_cpu}
                  mem={sizes.keeper_memory_mb}
                  disk={sizes.keeper_disk_gb}
                  onCpu={(v) => {
                    touch()
                    setSizes((s) => ({ ...s, keeper_cpu: v }))
                  }}
                  onMem={(v) => {
                    touch()
                    setSizes((s) => ({ ...s, keeper_memory_mb: v }))
                  }}
                  onDisk={(v) => {
                    touch()
                    setSizes((s) => ({ ...s, keeper_disk_gb: v }))
                  }}
                />
              </div>
              <PlacementGrid
                grid={grid}
                items={items}
                candidates={zoneMachines}
                onChange={(i, j, id) => {
                  touch()
                  setPlacement(() =>
                    grid.map((row, a) =>
                      row.map((v, b) => (a === i && b === j ? id : v))
                    )
                  )
                }}
              />
              <div className="grid items-end gap-4 sm:grid-cols-[8rem_1fr]">
                <Field>
                  <FieldLabel>Keepers</FieldLabel>
                  <Select
                    items={{ "1": "1", "3": "3" }}
                    value={String(keeperCount)}
                    onValueChange={(v) => {
                      touch()
                      const n = Number(v)
                      setKeeperCount(n)
                      setKeepers((k) =>
                        Array.from({ length: n }, (_, i) => k[i] ?? "")
                      )
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1</SelectItem>
                      <SelectItem value="3">3</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid gap-2 sm:grid-cols-3">
                  {keepers.slice(0, keeperCount).map((id, i) => (
                    <MachineSelect
                      key={i}
                      label={`Standby keeper ${i + 1} machine`}
                      items={items}
                      candidates={zoneMachines}
                      value={id}
                      onChange={(v) => {
                        touch()
                        setKeepers((k) => k.map((x, j) => (j === i ? v : x)))
                      }}
                    />
                  ))}
                </div>
              </div>
              <FieldDescription>
                One Keeper is enough for a standby; add two more before you fail
                over for full safety.
              </FieldDescription>
            </FieldGroup>
          </Section>

          <Section
            title="Storage"
            description="Where the primary ships its changes."
          >
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Connection</FieldLabel>
                  <Select
                    items={Object.fromEntries(
                      (connections.data ?? []).map((x) => [
                        x.connection_id,
                        `${x.name} (${x.type === "azure" ? "Azure Blob" : "S3"})`,
                      ])
                    )}
                    value={connectionId}
                    onValueChange={(v) => setConnectionId(v as string)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a connection" />
                    </SelectTrigger>
                    <SelectContent>
                      {(connections.data ?? []).map((x) => (
                        <SelectItem
                          key={x.connection_id}
                          value={x.connection_id}
                        >
                          {x.name} ({x.type === "azure" ? "Azure Blob" : "S3"})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Add one on the{" "}
                    <Link to="/storage" className="underline">
                      Storage
                    </Link>{" "}
                    page.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="sb-bucket">
                    Bucket or container
                  </FieldLabel>
                  <Input
                    id="sb-bucket"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    className="font-mono"
                  />
                  <FieldDescription>
                    Created if it doesn&apos;t exist.
                  </FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="sb-dbs">Databases (optional)</FieldLabel>
                <Input
                  id="sb-dbs"
                  value={databases}
                  placeholder="All user databases"
                  onChange={(e) => setDatabases(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sb-pass">
                  Password for the standby&apos;s &quot;default&quot; user
                </FieldLabel>
                <Input
                  id="sb-pass"
                  className="font-mono"
                  value={password}
                  onChange={(e) => {
                    touch()
                    setPassword(e.target.value)
                  }}
                />
              </Field>
            </FieldGroup>
          </Section>
        </>
      ) : (
        <Section
          title="Standby replicas"
          description={`One machine in ${chosenZone || "the standby zone"} per shard. Each joins its shard and copies the data from the others.`}
        >
          <PlacementGrid
            grid={grid.map((row) => row.slice(0, 1))}
            items={items}
            candidates={zoneMachines}
            onChange={(i, _j, id) => {
              touch()
              setPlacement(() =>
                grid.map((row, a) => (a === i ? [id] : row.slice(0, 1)))
              )
            }}
          />
        </Section>
      )}

      <Label className="flex items-center gap-2 font-normal">
        <Checkbox
          checked={overcommit}
          onCheckedChange={(v) => {
            touch()
            setOvercommit(v === true)
          }}
        />
        Allow overcommit (reserve more than a machine has)
      </Label>
      {plan && <PlanReview plan={plan} />}
      {error && <FieldError>{error}</FieldError>}
      <div className="flex flex-wrap items-center gap-2">
        {mode === "storage" && (
          <Button
            variant={plan ? "outline" : "default"}
            disabled={busy}
            onClick={() => void check()}
          >
            Check placement
          </Button>
        )}
        <Button
          disabled={
            busy ||
            (mode === "storage" &&
              (!plan || plan.errors.length > 0 || !connectionId))
          }
          onClick={() => void create()}
        >
          {busy ? "Starting…" : "Create standby"}
        </Button>
        {mode === "storage" && !connectionId && (
          <span className="text-xs text-muted-foreground">
            Choose a storage connection.
          </span>
        )}
      </div>
    </>
  )
}

function PlacementGrid({
  grid,
  items,
  candidates,
  onChange,
}: {
  grid: string[][]
  items: Record<string, string>
  candidates: Machine[]
  onChange: (shard: number, replica: number, id: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Shard</th>
            {grid[0]?.map((_, j) => (
              <th key={j} className="px-3 py-2 font-medium">
                Replica {j + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-2 tabular-nums">{i + 1}</td>
              {row.map((id, j) => (
                <td key={j} className="min-w-52 px-3 py-2">
                  <MachineSelect
                    label={`Standby shard ${i + 1} replica ${j + 1} machine`}
                    items={items}
                    candidates={candidates}
                    value={id}
                    onChange={(v) => onChange(i, j, v)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
