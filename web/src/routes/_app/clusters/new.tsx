import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { CheckIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"

import { errorMessage } from "@/api/client"
import {
  createFleetCluster,
  deleteDraft,
  draftQuery,
  fleetStatsQuery,
  machinesQuery,
  planCluster,
  saveDraft,
  versionsQuery,
  type FleetClusterRequest,
  type FleetPlan,
} from "@/api/fleet"
import {
  MachineSelect,
  machineLabel,
  PlanReview,
  SizeGroup,
} from "@/components/app/fleet-placement"
import { ErrorState, KeyValue } from "@/components/app/misc"
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
import { Skeleton } from "@/components/ui/skeleton"
import { formatAgo } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/new")({
  beforeLoad: ({ context }) => {
    if (context.session.policy !== "admin") throw redirect({ to: "/clusters" })
  },
  validateSearch: z.object({ draft: z.string().optional() }),
  component: CreateFleetClusterPage,
})

function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

// A new cluster starts as one ClickHouse server and one Keeper; replicas,
// shards and Keepers are added later on the Nodes page.
const STEPS = ["Basics", "ClickHouse server", "Keeper", "Access", "Review"]

type SizeForm = { cpu: string; memory_mb: string; disk_gb: string }

// Form is what a draft keeps; the password never leaves the browser.
type Form = {
  name: string
  comment: string
  version: string
  server: string // machine ID
  serverSize: SizeForm
  keeperOnServer: boolean
  keeper: string // machine ID when not on the server's machine
  keeperSize: SizeForm
  overcommit: boolean
}

const EMPTY: Form = {
  name: "",
  comment: "",
  version: "",
  server: "",
  serverSize: { cpu: "2", memory_mb: "4096", disk_gb: "100" },
  keeperOnServer: true,
  keeper: "",
  keeperSize: { cpu: "0.5", memory_mb: "512", disk_gb: "10" },
  overcommit: false,
}

const nameRe = /^[A-Za-z][A-Za-z0-9_]{0,62}$/
const num = (v: string) => Number(v) || 0

function CreateFleetClusterPage() {
  // the draft in the URL when the page opened: saving a draft rewrites the
  // URL, which must not reload the form
  const [draftParam] = useState(Route.useSearch().draft)
  const draft = useQuery({
    ...draftQuery(draftParam ?? ""),
    enabled: !!draftParam,
  })
  if (draftParam && draft.isPending)
    return (
      <PageBody className="max-w-3xl">
        <Skeleton className="h-64 w-full" />
      </PageBody>
    )
  if (draftParam && draft.error)
    return (
      <PageBody className="max-w-3xl">
        <ErrorState error={draft.error} />
      </PageBody>
    )
  return (
    <CreateWizard
      draftName={draftParam ?? null}
      initial={
        draft.data ? { ...EMPTY, ...(draft.data.form as Partial<Form>) } : EMPTY
      }
      initialStep={draft.data?.step ?? 0}
      savedAt={draft.data?.updated_at}
    />
  )
}

function CreateWizard({
  draftName: initialDraft,
  initial,
  initialStep,
  savedAt: initialSavedAt,
}: {
  draftName: string | null
  initial: Form
  initialStep: number
  savedAt?: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const machines = useQuery(machinesQuery())
  const stats = useQuery(fleetStatsQuery())
  const versions = useQuery(versionsQuery())

  const [form, setForm] = useState<Form>(initial)
  const [step, setStep] = useState(Math.min(initialStep, STEPS.length - 1))
  const [password, setPassword] = useState(randomPassword)
  const [draftName, setDraftName] = useState(initialDraft)
  const [savedAt, setSavedAt] = useState(initialSavedAt)
  const [plan, setPlan] = useState<FleetPlan | null>(null)
  const [busy, setBusy] = useState<"save" | "plan" | "create" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const version = form.version || versions.data?.[0] || ""
  const ready = useMemo(
    () => (machines.data ?? []).filter((m) => m.status === "ready"),
    [machines.data]
  )
  const statsById = useMemo(
    () => new Map((stats.data ?? []).map((s) => [s.machine_id, s])),
    [stats.data]
  )
  const items = Object.fromEntries(
    ready.map((m) => [m.id, machineLabel(m, statsById.get(m.id))])
  )
  const machineName = (id: string) =>
    machines.data?.find((m) => m.id === id)?.name ?? "—"
  const keeperMachine = form.keeperOnServer ? form.server : form.keeper

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setPlan(null)
    setError(null)
    setForm((f) => ({ ...f, [k]: v }))
  }

  // what blocks leaving each step
  const problem = (s: number): string | null => {
    switch (s) {
      case 0:
        if (!nameRe.test(form.name.trim()))
          return "Name: start with a letter; letters, digits and _ only."
        if (!version) return "Choose a ClickHouse version."
        return null
      case 1:
        if (!form.server) return "Choose the machine for the ClickHouse server."
        if (num(form.serverSize.memory_mb) <= 0)
          return "Set the memory for the ClickHouse server."
        return null
      case 2:
        if (!keeperMachine) return "Choose the machine for the Keeper."
        if (num(form.keeperSize.memory_mb) <= 0)
          return "Set the memory for the Keeper."
        return null
      case 3:
        return password.trim() ? null : "Set a password."
      default:
        return null
    }
  }
  const firstOpen = STEPS.findIndex((_, i) => problem(i) !== null)
  const reachable = (s: number) => firstOpen === -1 || s <= firstOpen

  // save the draft, then move; a failed save keeps the user on the step
  async function persist(nextStep: number, taskId?: string) {
    setBusy("save")
    try {
      const name = nameRe.test(form.name.trim()) ? form.name.trim() : ""
      const saved = await saveDraft(draftName, {
        name,
        step: nextStep,
        form: { ...form, version },
        task_id: taskId,
      })
      setSavedAt(saved.updated_at)
      queryClient.setQueryData(["cluster-drafts", saved.name], saved)
      if (saved.name !== draftName) {
        setDraftName(saved.name)
        void navigate({
          to: "/clusters/new",
          search: { draft: saved.name },
          replace: true,
        })
      }
      void queryClient.invalidateQueries({
        queryKey: ["cluster-drafts"],
        exact: true,
      })
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  async function go(next: number) {
    if (next > step && problem(step)) {
      setError(problem(step))
      return
    }
    setError(null)
    if (await persist(next)) setStep(next)
  }

  function request(): FleetClusterRequest {
    return {
      cluster: form.name.trim(),
      comment: form.comment.trim(),
      version,
      shards: [[form.server]],
      keepers: [keeperMachine],
      password,
      allow_overcommit: form.overcommit,
      cpu: num(form.serverSize.cpu),
      memory_mb: num(form.serverSize.memory_mb),
      disk_gb: num(form.serverSize.disk_gb),
      keeper_cpu: num(form.keeperSize.cpu),
      keeper_memory_mb: num(form.keeperSize.memory_mb),
      keeper_disk_gb: num(form.keeperSize.disk_gb),
      draft: draftName ?? undefined,
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
      // the draft stays until the cluster exists, so a failed create resumes
      await persist(step, res.task_id)
      toast.success(`Creating ${form.name}`)
      await navigate({ to: "/tasks/$taskId", params: { taskId: res.task_id } })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  async function discard() {
    if (draftName) {
      await deleteDraft(draftName)
      await queryClient.invalidateQueries({ queryKey: ["cluster-drafts"] })
    }
    toast.success("Draft deleted")
    await navigate({ to: "/clusters" })
  }

  const sizeInputs = (
    title: string,
    k: "serverSize" | "keeperSize",
    v: SizeForm
  ) => (
    <SizeGroup
      title={title}
      cpu={v.cpu}
      mem={v.memory_mb}
      disk={v.disk_gb}
      onCpu={(x) => set(k, { ...v, cpu: x })}
      onMem={(x) => set(k, { ...v, memory_mb: x })}
      onDisk={(x) => set(k, { ...v, disk_gb: x })}
    />
  )

  return (
    <>
      <PageHeader
        title="Create cluster"
        description="Start with one ClickHouse server and one Keeper. Add replicas, shards and Keepers later on the Nodes page."
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
      <PageBody className="max-w-3xl">
        <ol className="flex flex-wrap gap-x-1 gap-y-2">
          {STEPS.map((title, i) => {
            const done = i < step && problem(i) === null
            return (
              <li key={title}>
                <button
                  type="button"
                  disabled={!reachable(i) || busy !== null}
                  onClick={() => void go(i)}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm disabled:opacity-50 ${i === step ? "bg-muted font-medium" : "hover:bg-muted/60"}`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full text-xs ${done ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : i === step ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}
                  >
                    {done ? <CheckIcon className="size-3.5" /> : i + 1}
                  </span>
                  {title}
                </button>
              </li>
            )
          })}
        </ol>

        {ready.length === 0 && !machines.isPending && (
          <FieldError>
            No ready machines.{" "}
            <Link to="/machines" className="underline">
              Add machines with Docker
            </Link>{" "}
            first.
          </FieldError>
        )}

        {step === 0 && (
          <Section title="Basics">
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="f-name">Cluster name</FieldLabel>
                  <Input
                    id="f-name"
                    value={form.name}
                    placeholder="analytics"
                    onChange={(e) => set("name", e.target.value)}
                  />
                  <FieldDescription>
                    Letters, digits and _. Used in ON CLUSTER; reserved while
                    this draft exists.
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
                    value={version || null}
                    onValueChange={(v) => set("version", v as string)}
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
                    Official clickhouse/clickhouse-server and -keeper images
                    from Docker Hub.
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
                  value={form.comment}
                  onChange={(e) => set("comment", e.target.value)}
                />
              </Field>
            </FieldGroup>
          </Section>
        )}

        {step === 1 && (
          <Section
            title="ClickHouse server"
            description="The machine and container limits of the first server. Disk is a soft limit: shown and warned about, not enforced."
          >
            <FieldGroup>
              <Field>
                <FieldLabel>Machine</FieldLabel>
                <MachineSelect
                  label="ClickHouse server machine"
                  items={items}
                  candidates={ready}
                  value={form.server}
                  onChange={(v) => set("server", v)}
                />
              </Field>
              {sizeInputs("ClickHouse server", "serverSize", form.serverSize)}
              <FieldDescription>
                One server has no copy of its data. Add replicas (and shards) on
                the Nodes page once the cluster runs; each can get its own size.
              </FieldDescription>
            </FieldGroup>
          </Section>
        )}

        {step === 2 && (
          <Section
            title="Keeper"
            description="Keeper coordinates replicated tables and ON CLUSTER changes. One is enough to start."
          >
            <FieldGroup>
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={form.keeperOnServer}
                  onCheckedChange={(v) => set("keeperOnServer", v === true)}
                />
                Run it on the ClickHouse server&apos;s machine (
                {machineName(form.server)})
              </Label>
              {!form.keeperOnServer && (
                <Field>
                  <FieldLabel>Machine</FieldLabel>
                  <MachineSelect
                    label="Keeper machine"
                    items={items}
                    candidates={ready}
                    value={form.keeper}
                    onChange={(v) => set("keeper", v)}
                  />
                </Field>
              )}
              {sizeInputs("Keeper", "keeperSize", form.keeperSize)}
              <FieldDescription>
                A single Keeper has no fault tolerance: if it stops, replicated
                tables become read-only. Add two more on the Nodes page later.
              </FieldDescription>
            </FieldGroup>
          </Section>
        )}

        {step === 3 && (
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
                      setPlan(null)
                      setPassword(e.target.value)
                    }}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Generate a new password"
                    onClick={() => {
                      setPlan(null)
                      setPassword(randomPassword())
                    }}
                  >
                    <RefreshCwIcon />
                  </Button>
                </div>
                <FieldDescription>
                  Save it somewhere safe; your apps connect with it. Drafts
                  don&apos;t keep it: a resumed draft gets a new one.
                </FieldDescription>
              </Field>
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={form.overcommit}
                  onCheckedChange={(v) => set("overcommit", v === true)}
                />
                Allow overcommit (reserve more than a machine has)
              </Label>
            </FieldGroup>
          </Section>
        )}

        {step === 4 && (
          <>
            <Section title="Review">
              <KeyValue
                items={[
                  ["Name", form.name],
                  ["Version", version],
                  [
                    "ClickHouse server",
                    `${machineName(form.server)} · ${form.serverSize.cpu} CPU · ${form.serverSize.memory_mb} MiB · ${form.serverSize.disk_gb} GiB`,
                  ],
                  [
                    "Keeper",
                    `${machineName(keeperMachine)} · ${form.keeperSize.cpu} CPU · ${form.keeperSize.memory_mb} MiB · ${form.keeperSize.disk_gb} GiB`,
                  ],
                  ["Overcommit", form.overcommit ? "Allowed" : "No"],
                ]}
              />
            </Section>
            {plan && <PlanReview plan={plan} />}
          </>
        )}

        {error && <FieldError>{error}</FieldError>}
        <div className="flex flex-wrap items-center gap-2">
          {step > 0 && (
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => void go(step - 1)}
            >
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button disabled={busy !== null} onClick={() => void go(step + 1)}>
              {busy === "save" ? "Saving…" : "Next"}
            </Button>
          ) : (
            <>
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
            </>
          )}
          <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {savedAt && `Saved as draft ${formatAgo(savedAt)}`}
            {draftName && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void discard()}
              >
                Delete draft
              </Button>
            )}
          </span>
        </div>
        {step === STEPS.length - 1 && (
          <p className="text-xs text-muted-foreground">
            {plan
              ? plan.errors.length > 0
                ? "Fix the problems above, then check again."
                : "Placement checked. Changing anything needs a new check."
              : "Check the placement first: ckman verifies the machines, ports and capacity."}
          </p>
        )}
      </PageBody>
    </>
  )
}
