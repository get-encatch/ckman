import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  backupDisksQuery,
  createBackup,
  cronProblem,
  instancesQuery,
  tableSummaryQuery,
  type BackupRequest,
} from "@/api/data-manage"
import { tableTreeQuery } from "@/api/observability"
import { bucketProblem, bucketsQuery, connectionsQuery } from "@/api/storage"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import { Spinner } from "@/components/ui/spinner"
import { formatBytes } from "@/lib/format"

const FULL_PRESETS: Record<string, string> = {
  "0 0 2 * * 0": "Weekly, Sunday 02:00",
  "0 0 2 * * *": "Daily at 02:00",
  "0 0 2 1 * *": "Monthly, 1st at 02:00",
  custom: "Custom…",
}

const INCR_PRESETS: Record<string, string> = {
  "0 0 * * * *": "Every hour",
  "0 0 */4 * * *": "Every 4 hours",
  "0 0 */6 * * *": "Every 6 hours",
  "0 0 */12 * * *": "Every 12 hours",
  custom: "Custom…",
}

// A preset select with a custom-cron field.
function CronPicker({
  label,
  presets,
  preset,
  custom,
  onPreset,
  onCustom,
}: {
  label: string
  presets: Record<string, string>
  preset: string
  custom: string
  onPreset: (v: string) => void
  onCustom: (v: string) => void
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        items={presets}
        value={preset}
        onValueChange={(v) => onPreset(v as string)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(presets).map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {preset === "custom" && (
        <Input
          value={custom}
          onChange={(e) => onCustom(e.target.value)}
          placeholder="0 30 1 * * *"
          className="font-mono"
        />
      )}
    </Field>
  )
}

const CRON_PRESETS: Record<string, string> = {
  "0 0 2 * * *": "Daily at 02:00",
  "0 0 * * * *": "Every hour",
  "0 0 3 * * 0": "Weekly, Sunday 03:00",
  custom: "Custom…",
}

type Mode = "native" | "full" | "new-days" | "named"

const MODES: {
  value: Mode
  label: string
  help: string
  schedulable: boolean
}[] = [
  {
    value: "native",
    label: "Whole table, incremental (recommended)",
    help: "ClickHouse copies only data that changed since the last backup, including late rows in old days. Works for any table.",
    schedulable: true,
  },
  {
    value: "new-days",
    label: "Day partitions not backed up yet",
    help: "Copies each finished day once. Good for archiving; rows that arrive later for an already-copied day are not picked up.",
    schedulable: true,
  },
  {
    value: "full",
    label: "Every partition, separately",
    help: "A full copy, one backup per partition.",
    schedulable: false,
  },
  {
    value: "named",
    label: "Named partitions",
    help: "Only the partitions you list, if not backed up yet.",
    schedulable: false,
  },
]

const MODE_REQUEST: Record<
  Mode,
  Pick<BackupRequest, "backup_style" | "backup_type">
> = {
  native: { backup_style: "native", backup_type: "partition" },
  full: { backup_style: "full", backup_type: "partition" },
  "new-days": { backup_style: "incremental", backup_type: "daily" },
  named: { backup_style: "incremental", backup_type: "partition" },
}

export function BackupFormDialog({
  cluster,
  open,
  onOpenChange,
  onCreated,
}: {
  cluster: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => Promise<unknown>
}) {
  const tree = useQuery({ ...tableTreeQuery(cluster), enabled: open })
  const instances = useQuery({ ...instancesQuery(), enabled: open })
  const disks = useQuery({ ...backupDisksQuery(cluster), enabled: open })

  const [schedule, setSchedule] = useState<"immediate" | "scheduled">(
    "immediate"
  )
  const [cronPreset, setCronPreset] = useState("0 0 2 * * *")
  const [cron, setCron] = useState("")
  const [name, setName] = useState("")
  const [database, setDatabase] = useState<string | null>(null)
  const [tables, setTables] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>("native")
  const [fullPreset, setFullPreset] = useState("0 0 2 * * 0")
  const [fullCustom, setFullCustom] = useState("")
  const [incrPreset, setIncrPreset] = useState("0 0 * * * *")
  const [incrCustom, setIncrCustom] = useState("")
  const [keepFull, setKeepFull] = useState(4)
  const [daysBefore, setDaysBefore] = useState(1)
  const [partitions, setPartitions] = useState("")
  // "saved" = an S3 connection from the Storage page; "s3" = typed in here
  const [target, setTarget] = useState<"saved" | "s3" | "local">("saved")
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [bucket, setBucket] = useState("")
  const [s3, setS3] = useState({
    Endpoint: "",
    AccessKeyID: "",
    SecretAccessKey: "",
    Region: "",
    Bucket: "",
  })
  const [localPath, setLocalPath] = useState("")
  const [compression, setCompression] = useState("zstd")
  const [clean, setClean] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connections = useQuery({ ...connectionsQuery(), enabled: open })
  const hasConnections = (connections.data?.length ?? 0) > 0
  // fall back to typing S3 settings when no connection has been saved yet
  const effectiveTarget =
    target === "saved" && connections.data && !hasConnections ? "s3" : target
  const buckets = useQuery({
    ...bucketsQuery(connectionId ?? ""),
    enabled: open && effectiveTarget === "saved" && !!connectionId,
  })
  const newBucket =
    bucket !== "" &&
    buckets.data !== undefined &&
    !buckets.data.includes(bucket)

  const summary = useQuery({
    ...tableSummaryQuery(cluster, database ?? ""),
    enabled: open && !!database,
  })
  const databases = Object.keys(tree.data ?? {})
  const scheduled = schedule === "scheduled"
  // a schedule can only use the modes that copy something new on each run
  const effectiveMode: Mode =
    scheduled && (mode === "full" || mode === "named") ? "native" : mode
  const native = effectiveMode === "native"
  const selected = (summary.data ?? []).filter((t) => tables.has(t.name))
  const notDaily = selected
    .filter((t) => !t.daily_compatible)
    .map((t) => t.name)

  function reset() {
    setSchedule("immediate")
    setName("")
    setDatabase(null)
    setTables(new Set())
    setMode("native")
    setPartitions("")
    setClean(false)
    setError(null)
  }

  async function submit() {
    const pick = (preset: string, custom: string) =>
      preset === "custom" ? custom.trim() : preset
    const crontab = native
      ? pick(incrPreset, incrCustom)
      : pick(cronPreset, cron)
    const fullCrontab = native ? pick(fullPreset, fullCustom) : ""
    if (!database || tables.size === 0)
      return setError("Pick a database and at least one table.")
    if (scheduled) {
      const problem =
        cronProblem(crontab) ?? (native ? cronProblem(fullCrontab) : null)
      if (problem) return setError(problem)
      if (!instances.data?.[0])
        return setError("No ckman instance available to run the schedule.")
    }
    if (effectiveMode === "new-days" && notDaily.length)
      return setError(
        `Not partitioned by day: ${notDaily.join(", ")}. Use a whole-table backup for these.`
      )
    const partList = partitions.split(/[\s,]+/).filter(Boolean)
    if (effectiveMode === "named" && partList.length === 0)
      return setError("List the partitions to back up.")
    if (effectiveTarget === "saved") {
      if (!connectionId) return setError("Choose a storage connection.")
      const problem = bucketProblem(bucket)
      if (problem) return setError(`Bucket: ${problem}`)
    }
    if (
      effectiveTarget === "s3" &&
      (!s3.Endpoint || !s3.AccessKeyID || !s3.SecretAccessKey || !s3.Bucket)
    )
      return setError("Fill in the S3 endpoint, keys and bucket.")
    if (effectiveTarget === "local" && !localPath.startsWith("/"))
      return setError("Use an absolute local path.")

    const body: BackupRequest = {
      schedule_type: schedule,
      task_name: name || undefined,
      crontab: scheduled ? crontab : undefined,
      instance: scheduled ? instances.data?.[0] : undefined,
      database,
      tables: [...tables],
      ...MODE_REQUEST[effectiveMode],
      partitions: effectiveMode === "named" ? partList : undefined,
      days_before: effectiveMode === "new-days" ? daysBefore : undefined,
      full_crontab: scheduled && native ? fullCrontab : undefined,
      keep_full: scheduled && native ? keepFull : undefined,
      target: effectiveTarget === "local" ? "local" : "s3",
      connection_id:
        effectiveTarget === "saved" ? (connectionId ?? undefined) : undefined,
      s3:
        effectiveTarget === "saved"
          ? {
              Endpoint: "",
              AccessKeyID: "",
              SecretAccessKey: "",
              Region: "",
              Bucket: bucket,
            }
          : effectiveTarget === "s3"
            ? { ...s3, Endpoint: s3.Endpoint.replace(/\/+$/, "") }
            : undefined,
      local: effectiveTarget === "local" ? { path: localPath } : undefined,
      Compression: compression,
      // native backups chain on each other, so they can't drop partitions,
      // and file checksums only exist for per-partition backups
      clean: native ? false : clean,
      checksum: !native && compression === "none",
    }
    setBusy(true)
    setError(null)
    try {
      const res = await createBackup(cluster, body)
      toast.success(
        scheduled
          ? "Backup scheduled"
          : `Started ${res.run_ids?.length ?? 0} backup run(s)`
      )
      await onCreated()
      onOpenChange(false)
      reset()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New backup</DialogTitle>
          <DialogDescription>
            Each shard backs up its own share of the chosen tables, using
            ClickHouse's BACKUP TABLE.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">When</FieldLegend>
            <RadioGroup
              value={schedule}
              onValueChange={(v) => setSchedule(v as "immediate" | "scheduled")}
              className="flex gap-6"
            >
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="immediate" /> Once, now
              </Label>
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="scheduled" /> On a schedule
              </Label>
            </RadioGroup>
            {scheduled && native && (
              <div className="grid gap-3 sm:grid-cols-2">
                <CronPicker
                  label="Full backup"
                  presets={FULL_PRESETS}
                  preset={fullPreset}
                  custom={fullCustom}
                  onPreset={setFullPreset}
                  onCustom={setFullCustom}
                />
                <CronPicker
                  label="Incremental backups"
                  presets={INCR_PRESETS}
                  preset={incrPreset}
                  custom={incrCustom}
                  onPreset={setIncrPreset}
                  onCustom={setIncrCustom}
                />
                <Field orientation="horizontal" className="sm:col-span-2">
                  <FieldLabel htmlFor="bk-keep">Keep the last</FieldLabel>
                  <Input
                    id="bk-keep"
                    type="number"
                    min={0}
                    max={52}
                    value={keepFull}
                    onChange={(e) =>
                      setKeepFull(
                        Math.min(52, Math.max(0, Number(e.target.value) || 0))
                      )
                    }
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">
                    full backups with their incrementals (0 keeps everything)
                  </span>
                </Field>
                <FieldDescription className="sm:col-span-2">
                  Each full backup starts a new chain; incrementals copy only
                  what changed since the previous backup. Older chains are
                  deleted after a new full backup succeeds. Cron format: 6
                  fields, seconds first; at least an hour apart.
                </FieldDescription>
              </div>
            )}
            {scheduled && !native && (
              <div className="grid gap-3 sm:grid-cols-2">
                <CronPicker
                  label="Run"
                  presets={CRON_PRESETS}
                  preset={cronPreset}
                  custom={cron}
                  onPreset={setCronPreset}
                  onCustom={setCron}
                />
                <FieldDescription className="self-end sm:col-span-2">
                  Cron format has 6 fields, seconds first; runs must be at least
                  an hour apart.
                </FieldDescription>
              </div>
            )}
          </FieldSet>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Database</FieldLabel>
              <Select
                value={database}
                onValueChange={(v) => {
                  setDatabase(v as string)
                  setTables(new Set())
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      tree.isPending ? "Loading…" : "Choose a database"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {databases.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="bk-name">Name (optional)</FieldLabel>
              <Input
                id="bk-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="nightly events"
              />
            </Field>
          </div>

          {database && (
            <Field>
              <FieldLabel>Tables</FieldLabel>
              <div className="max-h-48 overflow-y-auto rounded-lg border p-2">
                {summary.isPending ? (
                  <Spinner />
                ) : summary.data?.length ? (
                  summary.data.map((t) => (
                    <Label
                      key={t.name}
                      className="flex items-center gap-2 rounded px-1 py-1 font-normal hover:bg-muted"
                    >
                      <Checkbox
                        checked={tables.has(t.name)}
                        onCheckedChange={(v) => {
                          const next = new Set(tables)
                          if (v === true) next.add(t.name)
                          else next.delete(t.name)
                          setTables(next)
                        }}
                      />
                      <span className="font-mono text-sm">{t.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {t.partition_format === "none"
                          ? "not partitioned"
                          : `by ${t.partition_format}`}{" "}
                        · {formatBytes(t.total_bytes)}
                      </span>
                    </Label>
                  ))
                ) : (
                  <p className="p-1 text-sm text-muted-foreground">
                    No MergeTree tables in {database}.
                  </p>
                )}
              </div>
            </Field>
          )}

          <FieldSet>
            <FieldLegend variant="label">What to copy</FieldLegend>
            <RadioGroup
              value={effectiveMode}
              onValueChange={(v) => setMode(v as Mode)}
              className="gap-3"
            >
              {MODES.filter((m) => !scheduled || m.schedulable).map((m) => (
                <Label
                  key={m.value}
                  className="flex items-start gap-2 font-normal"
                >
                  <RadioGroupItem value={m.value} className="mt-0.5" />
                  <span>
                    {m.label}
                    <span className="block text-xs text-muted-foreground">
                      {m.help}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </FieldSet>
          {effectiveMode === "new-days" && (
            <Field orientation="horizontal">
              <FieldLabel htmlFor="bk-days">Skip the newest</FieldLabel>
              <Input
                id="bk-days"
                type="number"
                min={1}
                max={365}
                value={daysBefore}
                onChange={(e) =>
                  setDaysBefore(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">
                day(s), which may still receive rows
              </span>
            </Field>
          )}
          {effectiveMode === "named" && (
            <Field>
              <FieldLabel htmlFor="bk-parts">Partitions</FieldLabel>
              <Input
                id="bk-parts"
                value={partitions}
                onChange={(e) => setPartitions(e.target.value)}
                placeholder="20261001, 20261002"
                className="font-mono"
              />
            </Field>
          )}

          <FieldSet>
            <FieldLegend variant="label">Where</FieldLegend>
            <RadioGroup
              value={effectiveTarget}
              onValueChange={(v) => setTarget(v as "saved" | "s3" | "local")}
              className="flex flex-wrap gap-x-6 gap-y-2"
            >
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="saved" disabled={!hasConnections} />{" "}
                Saved S3 connection
              </Label>
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="s3" /> Other S3 (enter details)
              </Label>
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="local" /> A path on each node
              </Label>
            </RadioGroup>
            {connections.data && !hasConnections && (
              <FieldDescription>
                Tip: admins can save S3 connections on the Storage page, so
                backups only need a bucket name.
              </FieldDescription>
            )}
            {effectiveTarget === "saved" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Connection</FieldLabel>
                  <Select
                    items={Object.fromEntries(
                      (connections.data ?? []).map((c) => [
                        c.connection_id,
                        c.name,
                      ])
                    )}
                    value={connectionId}
                    onValueChange={(v) => setConnectionId(v as string)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a connection" />
                    </SelectTrigger>
                    <SelectContent>
                      {(connections.data ?? []).map((c) => (
                        <SelectItem
                          key={c.connection_id}
                          value={c.connection_id}
                        >
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="bk-bucket">Bucket</FieldLabel>
                  <Input
                    id="bk-bucket"
                    list="bk-bucket-list"
                    value={bucket}
                    onChange={(e) =>
                      setBucket(e.target.value.toLowerCase().trim())
                    }
                    placeholder={
                      connectionId
                        ? "Pick or type a new name"
                        : "Choose a connection first"
                    }
                    disabled={!connectionId}
                    className="font-mono"
                  />
                  <datalist id="bk-bucket-list">
                    {(buckets.data ?? []).map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                  {newBucket && (
                    <FieldDescription>
                      New bucket: it will be created when you save.
                    </FieldDescription>
                  )}
                  {buckets.error && (
                    <FieldDescription className="text-destructive">
                      Couldn't list buckets: {buckets.error.message}
                    </FieldDescription>
                  )}
                </Field>
              </div>
            )}
            {effectiveTarget === "s3" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  placeholder="Endpoint, e.g. https://s3.ap-south-1.amazonaws.com"
                  value={s3.Endpoint}
                  onChange={(e) => setS3({ ...s3, Endpoint: e.target.value })}
                  className="sm:col-span-2"
                />
                <Input
                  placeholder="Bucket"
                  value={s3.Bucket}
                  onChange={(e) => setS3({ ...s3, Bucket: e.target.value })}
                />
                <Input
                  placeholder="Region (optional)"
                  value={s3.Region}
                  onChange={(e) => setS3({ ...s3, Region: e.target.value })}
                />
                <Input
                  placeholder="Access key ID"
                  autoComplete="off"
                  value={s3.AccessKeyID}
                  onChange={(e) =>
                    setS3({ ...s3, AccessKeyID: e.target.value })
                  }
                />
                <Input
                  placeholder="Secret access key"
                  type="password"
                  autoComplete="new-password"
                  value={s3.SecretAccessKey}
                  onChange={(e) =>
                    setS3({ ...s3, SecretAccessKey: e.target.value })
                  }
                />
              </div>
            )}
            {effectiveTarget === "local" && (
              <>
                <Input
                  placeholder="/backup/clickhouse/"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  className="font-mono"
                />
                {disks.data && disks.data.length > 0 && (
                  <FieldDescription>
                    Configured backup disks:{" "}
                    {disks.data.map((d) => `${d.name} (${d.path})`).join(", ")}
                  </FieldDescription>
                )}
              </>
            )}
          </FieldSet>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Compression</FieldLabel>
              <Select
                items={{
                  zstd: "zstd",
                  gzip: "gzip",
                  none: "none (enables checksums)",
                }}
                value={compression}
                onValueChange={(v) => setCompression(v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zstd">zstd</SelectItem>
                  <SelectItem value="gzip">gzip</SelectItem>
                  <SelectItem value="none">none (enables checksums)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {!native && (
              <Label className="flex items-start gap-2 self-end pb-2 font-normal">
                <Checkbox
                  checked={clean}
                  onCheckedChange={(v) => setClean(v === true)}
                  className="mt-0.5"
                />
                <span>
                  Drop partitions from ClickHouse after a successful backup
                  <span className="block text-xs text-destructive">
                    Frees disk space; data then only lives in the backup.
                  </span>
                </span>
              </Label>
            )}
          </div>
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : scheduled ? "Create schedule" : "Start backup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
