import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { RefreshCwIcon, WandSparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  createFleetCluster,
  fleetStatsQuery,
  machinesQuery,
  matchesFilter,
  planCluster,
  versionsQuery,
  type FleetClusterRequest,
  type FleetPlan,
  type Machine,
  type MachineStats,
} from "@/api/fleet"
import { CapacityBar, formatCores } from "@/components/app/fleet-usage"
import { PageBody, PageHeader, Section } from "@/components/app/page-header"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatBytes } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/new")({
  beforeLoad: ({ context }) => {
    if (context.session.policy !== "admin") throw redirect({ to: "/clusters" })
  },
  component: CreateFleetClusterPage,
})

function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

type Sizes = {
  cpu: string
  memory_mb: string
  disk_gb: string
  keeper_cpu: string
  keeper_memory_mb: string
  keeper_disk_gb: string
}

const resize = <T,>(arr: T[], n: number, fill: () => T) =>
  Array.from({ length: n }, (_, i) => arr[i] ?? fill())

function CreateFleetClusterPage() {
  const navigate = useNavigate()
  const machines = useQuery(machinesQuery())
  const stats = useQuery(fleetStatsQuery())
  const versions = useQuery(versionsQuery())

  const [name, setName] = useState("")
  const [comment, setComment] = useState("")
  const [version, setVersion] = useState<string | null>(null)
  const [password, setPassword] = useState(randomPassword)
  const [sizes, setSizes] = useState<Sizes>({
    cpu: "2",
    memory_mb: "4096",
    disk_gb: "100",
    keeper_cpu: "0.5",
    keeper_memory_mb: "512",
    keeper_disk_gb: "10",
  })
  const [shardCount, setShardCount] = useState(1)
  const [replicaCount, setReplicaCount] = useState(2)
  const [keeperCount, setKeeperCount] = useState(3)
  const [chFilter, setChFilter] = useState("")
  const [keeperFilter, setKeeperFilter] = useState("")
  const [placement, setPlacement] = useState<string[][]>([["", ""]])
  const [keepers, setKeepers] = useState<string[]>(["", "", ""])
  const [overcommit, setOvercommit] = useState(false)
  const [plan, setPlan] = useState<FleetPlan | null>(null)
  const [busy, setBusy] = useState<"plan" | "create" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const chosenVersion = version ?? versions.data?.[0] ?? ""
  const ready = useMemo(
    () => (machines.data ?? []).filter((m) => m.status === "ready"),
    [machines.data]
  )
  const statsById = useMemo(
    () => new Map((stats.data ?? []).map((s) => [s.machine_id, s])),
    [stats.data]
  )
  const chCandidates = ready.filter((m) => matchesFilter(m, chFilter))
  const keeperCandidates = ready.filter((m) => matchesFilter(m, keeperFilter))

  // any change invalidates the last plan check
  const touch = () => {
    setPlan(null)
    setError(null)
  }
  const setSize = (k: keyof Sizes, v: string) => {
    touch()
    setSizes((s) => ({ ...s, [k]: v }))
  }
  function setLayout(shards: number, replicas: number) {
    touch()
    setShardCount(shards)
    setReplicaCount(replicas)
    setPlacement((p) =>
      resize(p, shards, () => []).map((row) => resize(row, replicas, () => ""))
    )
  }
  function setKeeperN(n: number) {
    touch()
    setKeeperCount(n)
    setKeepers((k) => resize(k, n, () => ""))
  }
  function setSlot(shard: number, replica: number, id: string) {
    touch()
    setPlacement((p) =>
      p.map((row, i) =>
        i === shard ? row.map((v, j) => (j === replica ? id : v)) : row
      )
    )
  }
  function setKeeperSlot(i: number, id: string) {
    touch()
    setKeepers((k) => k.map((v, j) => (j === i ? id : v)))
  }

  // Fill every slot: most free memory first, one ClickHouse per machine,
  // replicas of a shard (and Keepers) spread over zones.
  function autoFill() {
    touch()
    const free = (m: Machine) => {
      const s = statsById.get(m.id)
      return s ? s.mem_total - s.reserved_mem : 0
    }
    const pool = [...chCandidates].sort((a, b) => free(b) - free(a))
    const used = new Set<string>()
    const next: string[][] = []
    for (let i = 0; i < shardCount; i++) {
      const zones = new Set<string>()
      const row: string[] = []
      for (let j = 0; j < replicaCount; j++) {
        const pick =
          pool.find((m) => !used.has(m.id) && !zones.has(m.zone)) ??
          pool.find((m) => !used.has(m.id))
        row.push(pick?.id ?? "")
        if (pick) {
          used.add(pick.id)
          zones.add(pick.zone)
        }
      }
      next.push(row)
    }
    setPlacement(next)
    const kpool = [...keeperCandidates].sort(
      (a, b) =>
        Number(used.has(a.id)) - Number(used.has(b.id)) || free(b) - free(a)
    )
    const kused = new Set<string>()
    const kzones = new Map<string, number>()
    const kn: string[] = []
    for (let i = 0; i < keeperCount; i++) {
      const least = (m: Machine) => kzones.get(m.zone) ?? 0
      const pick = kpool
        .filter((m) => !kused.has(m.id))
        .sort((a, b) => least(a) - least(b))[0]
      kn.push(pick?.id ?? "")
      if (pick) {
        kused.add(pick.id)
        kzones.set(pick.zone, least(pick) + 1)
      }
    }
    setKeepers(kn)
  }

  function request(): FleetClusterRequest {
    const num = (v: string) => Number(v) || 0
    return {
      cluster: name.trim(),
      comment: comment.trim(),
      version: chosenVersion,
      shards: placement,
      keepers,
      password,
      allow_overcommit: overcommit,
      cpu: num(sizes.cpu),
      memory_mb: num(sizes.memory_mb),
      disk_gb: num(sizes.disk_gb),
      keeper_cpu: num(sizes.keeper_cpu),
      keeper_memory_mb: num(sizes.keeper_memory_mb),
      keeper_disk_gb: num(sizes.keeper_disk_gb),
    }
  }

  async function check() {
    setBusy("plan")
    setError(null)
    try {
      setPlan(await planCluster(request()))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function create() {
    setBusy("create")
    setError(null)
    try {
      const res = await createFleetCluster(request())
      toast.success(`Creating ${name}`)
      await navigate({ to: "/tasks/$taskId", params: { taskId: res.task_id } })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const machineItems = (candidates: Machine[]) =>
    Object.fromEntries(
      candidates.map((m) => [m.id, machineLabel(m, statsById.get(m.id))])
    )

  return (
    <>
      <PageHeader
        title="Create cluster"
        description="ClickHouse and Keeper run as containers on machines you choose. Each instance gets its own CPU, memory and disk limits."
        actions={
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/clusters/new-packages" />}
          >
            Install packages over SSH instead
          </Button>
        }
      />
      <PageBody className="max-w-4xl">
        {ready.length === 0 && !machines.isPending && (
          <FieldError>
            No ready machines.{" "}
            <Link to="/machines" className="underline">
              Add machines with Docker
            </Link>{" "}
            first.
          </FieldError>
        )}
        <Section title="Basics">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="f-name">Cluster name</FieldLabel>
                <Input
                  id="f-name"
                  value={name}
                  placeholder="analytics"
                  onChange={(e) => {
                    touch()
                    setName(e.target.value)
                  }}
                />
                <FieldDescription>
                  Letters, digits and _. Used in ON CLUSTER.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>ClickHouse version</FieldLabel>
                <Select
                  items={Object.fromEntries(
                    (versions.data ?? []).map((v, i) => [
                      v,
                      i === 0 ? `${v} (latest)` : v,
                    ])
                  )}
                  value={chosenVersion}
                  onValueChange={(v) => {
                    touch()
                    setVersion(v as string)
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        versions.isPending
                          ? "Loading from Docker Hub…"
                          : "No versions"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(versions.data ?? []).map((v, i) => (
                      <SelectItem key={v} value={v}>
                        {i === 0 ? `${v} (latest)` : v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Official clickhouse/clickhouse-server and -keeper images from
                  Docker Hub.
                </FieldDescription>
                {versions.error && (
                  <FieldError>{errorMessage(versions.error)}</FieldError>
                )}
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="f-comment">
                Description (optional)
              </FieldLabel>
              <Input
                id="f-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>
          </FieldGroup>
        </Section>

        <Section
          title="Instance size"
          description="Limits for each container. Disk is a soft limit: shown and warned about, not enforced."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SizeGroup
              title="Each ClickHouse server"
              cpu={sizes.cpu}
              mem={sizes.memory_mb}
              disk={sizes.disk_gb}
              onCpu={(v) => setSize("cpu", v)}
              onMem={(v) => setSize("memory_mb", v)}
              onDisk={(v) => setSize("disk_gb", v)}
            />
            <SizeGroup
              title="Each Keeper"
              cpu={sizes.keeper_cpu}
              mem={sizes.keeper_memory_mb}
              disk={sizes.keeper_disk_gb}
              onCpu={(v) => setSize("keeper_cpu", v)}
              onMem={(v) => setSize("keeper_memory_mb", v)}
              onDisk={(v) => setSize("keeper_disk_gb", v)}
            />
          </div>
        </Section>

        <Section
          title="Placement"
          description="Choose the machine for every ClickHouse replica and every Keeper. A machine runs at most one ClickHouse server of this cluster."
          actions={
            <Button variant="outline" size="sm" onClick={autoFill}>
              <WandSparklesIcon /> Fill automatically
            </Button>
          }
        >
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-4">
              <Field>
                <FieldLabel htmlFor="f-shards">Shards</FieldLabel>
                <Input
                  id="f-shards"
                  type="number"
                  min={1}
                  max={32}
                  value={shardCount}
                  onChange={(e) =>
                    setLayout(
                      Math.max(1, Math.min(32, Number(e.target.value) || 1)),
                      replicaCount
                    )
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="f-replicas">Replicas each</FieldLabel>
                <Input
                  id="f-replicas"
                  type="number"
                  min={1}
                  max={8}
                  value={replicaCount}
                  onChange={(e) =>
                    setLayout(
                      shardCount,
                      Math.max(1, Math.min(8, Number(e.target.value) || 1))
                    )
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="f-chfilter">ClickHouse on</FieldLabel>
                <Input
                  id="f-chfilter"
                  value={chFilter}
                  placeholder="role=clickhouse"
                  onChange={(e) => setChFilter(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="f-kfilter">Keeper on</FieldLabel>
                <Input
                  id="f-kfilter"
                  value={keeperFilter}
                  placeholder="role=keeper"
                  onChange={(e) => setKeeperFilter(e.target.value)}
                />
              </Field>
            </div>
            <FieldDescription>
              Filters narrow the machine lists by label or zone, e.g.
              &quot;role=clickhouse zone=zone-a&quot;. Leave empty for all ready
              machines.
            </FieldDescription>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Shard</th>
                    {Array.from({ length: replicaCount }, (_, j) => (
                      <th key={j} className="px-3 py-2 font-medium">
                        Replica {j + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {placement.map((row, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 tabular-nums">{i + 1}</td>
                      {row.map((id, j) => (
                        <td key={j} className="min-w-52 px-3 py-2">
                          <MachineSelect
                            label={`Shard ${i + 1} replica ${j + 1} machine`}
                            items={machineItems(chCandidates)}
                            candidates={chCandidates}
                            value={id}
                            onChange={(v) => setSlot(i, j, v)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid items-end gap-4 sm:grid-cols-[8rem_1fr]">
              <Field>
                <FieldLabel>Keepers</FieldLabel>
                <Select
                  items={{ "1": "1", "3": "3", "5": "5" }}
                  value={String(keeperCount)}
                  onValueChange={(v) => setKeeperN(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["1", "3", "5"].map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid gap-2 sm:grid-cols-3">
                {keepers.map((id, i) => (
                  <MachineSelect
                    key={i}
                    label={`Keeper ${i + 1} machine`}
                    items={machineItems(keeperCandidates)}
                    candidates={keeperCandidates}
                    value={id}
                    onChange={(v) => setKeeperSlot(i, v)}
                  />
                ))}
              </div>
            </div>
            <FieldDescription>
              3 Keepers survive one failure. Spread them over machines (and
              zones); production prefers machines without ClickHouse.
            </FieldDescription>
          </FieldGroup>
        </Section>

        <Section title="Access">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="f-pass">
                Password for ClickHouse&apos;s &quot;default&quot; user
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="f-pass"
                  className="font-mono"
                  value={password}
                  onChange={(e) => {
                    touch()
                    setPassword(e.target.value)
                  }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Generate a new password"
                  onClick={() => {
                    touch()
                    setPassword(randomPassword())
                  }}
                >
                  <RefreshCwIcon />
                </Button>
              </div>
              <FieldDescription>
                Save it somewhere safe; your apps connect with it.
              </FieldDescription>
            </Field>
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
          </FieldGroup>
        </Section>

        {plan && <PlanReview plan={plan} />}
        {error && <FieldError>{error}</FieldError>}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={plan ? "outline" : "default"}
            disabled={busy !== null}
            onClick={() => void check()}
          >
            {busy === "plan" ? "Checking…" : "Check placement"}
          </Button>
          <Button
            disabled={busy !== null || !plan || plan.errors.length > 0}
            onClick={() => void create()}
          >
            {busy === "create" ? "Starting…" : "Create cluster"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {plan
              ? plan.errors.length > 0
                ? "Fix the problems above, then check again."
                : "Placement checked. Changing anything needs a new check."
              : "Check the placement first: ckman verifies machines, ports and capacity."}
          </span>
        </div>
      </PageBody>
    </>
  )
}

function machineLabel(m: Machine, s: MachineStats | undefined) {
  const free = s ? formatBytes(Math.max(0, s.mem_total - s.reserved_mem)) : "?"
  return `${m.name}${m.zone ? ` · ${m.zone}` : ""} · ${free} free`
}

function MachineSelect({
  label,
  items,
  candidates,
  value,
  onChange,
}: {
  label: string
  items: Record<string, string>
  candidates: Machine[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <Select
      items={items}
      value={value || null}
      onValueChange={(v) => onChange((v as string) ?? "")}
    >
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue placeholder="Choose a machine" />
      </SelectTrigger>
      <SelectContent>
        {candidates.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {items[m.id]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SizeGroup({
  title,
  cpu,
  mem,
  disk,
  onCpu,
  onMem,
  onDisk,
}: {
  title: string
  cpu: string
  mem: string
  disk: string
  onCpu: (v: string) => void
  onMem: (v: string) => void
  onDisk: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <span className="text-sm font-medium">{title}</span>
      <div className="grid grid-cols-3 gap-2">
        <Field>
          <FieldLabel>CPU cores</FieldLabel>
          <Input
            inputMode="decimal"
            value={cpu}
            onChange={(e) => onCpu(e.target.value)}
            aria-label={`${title} CPU cores`}
          />
        </Field>
        <Field>
          <FieldLabel>Memory MiB</FieldLabel>
          <Input
            inputMode="numeric"
            value={mem}
            onChange={(e) => onMem(e.target.value)}
            aria-label={`${title} memory MiB`}
          />
        </Field>
        <Field>
          <FieldLabel>Disk GiB</FieldLabel>
          <Input
            inputMode="numeric"
            value={disk}
            onChange={(e) => onDisk(e.target.value)}
            aria-label={`${title} disk GiB`}
          />
        </Field>
      </div>
    </div>
  )
}

function PlanReview({ plan }: { plan: FleetPlan }) {
  return (
    <Section
      title="Placement check"
      description={`Ports: ClickHouse ${plan.ports.tcp} (native), ${plan.ports.http} (HTTP), ${plan.ports.interserver} (replication); Keeper ${plan.ports.keeper_tcp} and ${plan.ports.keeper_raft}.`}
    >
      {plan.errors.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {plan.errors.map((e) => (
            <li key={e}>✕ {e}</li>
          ))}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {plan.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {plan.errors.length === 0 && plan.warnings.length === 0 && (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          ✓ No problems found.
        </p>
      )}
      {plan.machines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Machine</th>
                <th className="px-3 py-2 font-medium">Runs</th>
                <th className="px-3 py-2 font-medium">CPU reserved</th>
                <th className="px-3 py-2 font-medium">Memory reserved</th>
                <th className="px-3 py-2 font-medium">Disk reserved</th>
              </tr>
            </thead>
            <tbody>
              {plan.machines.map((m) => (
                <tr key={m.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {m.zone || "no zone"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">{m.roles.join(", ")}</td>
                  <td className="px-3 py-2">
                    <CapacityBar
                      usedLabel="reserved"
                      used={m.cpu}
                      total={m.cpu_total}
                      format={formatCores}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <CapacityBar
                      usedLabel="reserved"
                      used={m.mem}
                      total={m.mem_total}
                      format={formatBytes}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <CapacityBar
                      usedLabel="reserved"
                      used={m.disk}
                      total={m.disk_total}
                      format={formatBytes}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
