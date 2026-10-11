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

const CRON_PRESETS: Record<string, string> = {
  "0 0 2 * * *": "Daily at 02:00",
  "0 0 * * * *": "Every hour",
  "0 0 3 * * 0": "Weekly, Sunday 03:00",
  custom: "Custom…",
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
  const [style, setStyle] = useState<"full" | "incremental">("full")
  const [incType, setIncType] = useState<"daily" | "partition">("daily")
  const [daysBefore, setDaysBefore] = useState(1)
  const [partitions, setPartitions] = useState("")
  const [target, setTarget] = useState<"s3" | "local">("s3")
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

  const summary = useQuery({
    ...tableSummaryQuery(cluster, database ?? ""),
    enabled: open && !!database,
  })
  const databases = Object.keys(tree.data ?? {})
  const scheduled = schedule === "scheduled"
  const effectiveStyle = scheduled ? "incremental" : style
  const effectiveType = scheduled ? "daily" : incType
  const selected = (summary.data ?? []).filter((t) => tables.has(t.name))
  const notDaily = selected
    .filter((t) => !t.daily_compatible)
    .map((t) => t.name)

  function reset() {
    setSchedule("immediate")
    setName("")
    setDatabase(null)
    setTables(new Set())
    setStyle("full")
    setPartitions("")
    setClean(false)
    setError(null)
  }

  async function submit() {
    const crontab = cronPreset === "custom" ? cron.trim() : cronPreset
    if (!database || tables.size === 0)
      return setError("Pick a database and at least one table.")
    const unpartitioned = selected
      .filter((t) => t.partition_format === "none")
      .map((t) => t.name)
    if (unpartitioned.length)
      return setError(
        `ckman backs up one partition at a time, so tables need a PARTITION BY key. Not partitioned: ${unpartitioned.join(", ")}.`
      )
    if (scheduled) {
      const problem = cronProblem(crontab)
      if (problem) return setError(problem)
      if (!instances.data?.[0])
        return setError("No ckman instance available to run the schedule.")
    }
    if (
      effectiveStyle === "incremental" &&
      effectiveType === "daily" &&
      notDaily.length
    )
      return setError(
        `Not partitioned by day: ${notDaily.join(", ")}. Use full or by-partition backups for these.`
      )
    const partList = partitions.split(/[\s,]+/).filter(Boolean)
    if (
      effectiveStyle === "incremental" &&
      effectiveType === "partition" &&
      partList.length === 0
    )
      return setError("List the partitions to back up.")
    if (
      target === "s3" &&
      (!s3.Endpoint || !s3.AccessKeyID || !s3.SecretAccessKey || !s3.Bucket)
    )
      return setError("Fill in the S3 endpoint, keys and bucket.")
    if (target === "local" && !localPath.startsWith("/"))
      return setError("Use an absolute local path.")

    const body: BackupRequest = {
      schedule_type: schedule,
      task_name: name || undefined,
      crontab: scheduled ? crontab : undefined,
      instance: scheduled ? instances.data?.[0] : undefined,
      database,
      tables: [...tables],
      backup_style: effectiveStyle,
      backup_type: effectiveType,
      partitions: effectiveType === "partition" ? partList : undefined,
      days_before: effectiveType === "daily" ? daysBefore : undefined,
      target,
      s3:
        target === "s3"
          ? { ...s3, Endpoint: s3.Endpoint.replace(/\/+$/, "") }
          : undefined,
      local: target === "local" ? { path: localPath } : undefined,
      Compression: compression,
      clean,
      // checksums only make sense without compression
      checksum: compression === "none",
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
            Each node backs up its own share of the chosen tables, partition by
            partition.
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
            {scheduled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  items={CRON_PRESETS}
                  value={cronPreset}
                  onValueChange={(v) => setCronPreset(v as string)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CRON_PRESETS).map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {cronPreset === "custom" && (
                  <Input
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    placeholder="0 30 1 * * *"
                    className="font-mono"
                  />
                )}
                <FieldDescription className="sm:col-span-2">
                  Scheduled backups are incremental: each run copies day
                  partitions that aren't backed up yet. Cron format has 6
                  fields, seconds first; runs must be at least an hour apart.
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

          {!scheduled && (
            <FieldSet>
              <FieldLegend variant="label">What to copy</FieldLegend>
              <RadioGroup
                value={style}
                onValueChange={(v) => setStyle(v as "full" | "incremental")}
                className="flex gap-6"
              >
                <Label className="flex items-center gap-2 font-normal">
                  <RadioGroupItem value="full" /> Everything
                </Label>
                <Label className="flex items-center gap-2 font-normal">
                  <RadioGroupItem value="incremental" /> Only partitions not
                  backed up yet
                </Label>
              </RadioGroup>
              {style === "incremental" && (
                <RadioGroup
                  value={incType}
                  onValueChange={(v) => setIncType(v as "daily" | "partition")}
                  className="flex gap-6"
                >
                  <Label className="flex items-center gap-2 font-normal">
                    <RadioGroupItem value="daily" /> Day partitions
                  </Label>
                  <Label className="flex items-center gap-2 font-normal">
                    <RadioGroupItem value="partition" /> Named partitions
                  </Label>
                </RadioGroup>
              )}
            </FieldSet>
          )}
          {effectiveStyle === "incremental" && effectiveType === "daily" && (
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
          {effectiveStyle === "incremental" &&
            effectiveType === "partition" && (
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
              value={target}
              onValueChange={(v) => setTarget(v as "s3" | "local")}
              className="flex gap-6"
            >
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="s3" /> S3 or compatible (MinIO…)
              </Label>
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="local" /> A path on each node
              </Label>
            </RadioGroup>
            {target === "s3" ? (
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
            ) : (
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
