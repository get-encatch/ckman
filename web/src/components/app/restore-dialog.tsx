import { useMemo, useState } from "react"
import { useQueries } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  isRestorableNative,
  restoreFromRun,
  runTime,
  tableRunsQuery,
  type BackupPolicy,
  type BackupRun,
} from "@/api/data-manage"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
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
import { formatDateTime } from "@/lib/format"

type Scope = "database" | "table"

const runMs = (r: BackupRun) => new Date(runTime(r)).getTime()

// Restores a whole database (every table with a native backup) or one table
// to a point in time: each table uses its newest native backup taken at or
// before that point.
export function RestoreDialog({
  cluster,
  policies,
  open,
  onOpenChange,
}: {
  cluster: string
  policies: BackupPolicy[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [scope, setScope] = useState<Scope>("database")
  const [database, setDatabase] = useState("")
  const [table, setTable] = useState("")
  const [point, setPoint] = useState("")
  const [replace, setReplace] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  // database -> tables that have a native backup policy
  const tablesByDb = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const p of policies) {
      if (p.backup_style !== "native") continue
      const s = m.get(p.database) ?? new Set<string>()
      s.add(p.table)
      m.set(p.database, s)
    }
    return m
  }, [policies])
  const databases = [...tablesByDb.keys()].sort()
  const dbTables = [...(tablesByDb.get(database) ?? [])].sort()
  const tables = scope === "table" ? (table ? [table] : []) : dbTables

  const runQueries = useQueries({
    queries: tables.map((t) => ({
      ...tableRunsQuery(cluster, database, t),
      enabled: open,
    })),
  })
  const loading = runQueries.some((q) => q.isPending)
  const runsByTable = tables.map((t, i) => ({
    table: t,
    runs: (runQueries[i]?.data ?? [])
      .filter(isRestorableNative)
      .sort((a, b) => runMs(b) - runMs(a)),
  }))

  // every successful native backup time across the tables, newest first
  const points = [
    ...new Map(
      runsByTable.flatMap((t) => t.runs).map((r) => [runTime(r), r] as const)
    ).values(),
  ].sort((a, b) => runMs(b) - runMs(a))
  const pointItems = Object.fromEntries(
    points.map((r) => [
      runTime(r),
      `${formatDateTime(runTime(r))}${r.base_run_id ? "" : " (full)"}`,
    ])
  )
  const chosen =
    point && pointItems[point] ? point : (points[0] && runTime(points[0])) || ""
  const at = chosen ? new Date(chosen).getTime() : 0
  const plan = runsByTable.map((t) => ({
    table: t.table,
    run: t.runs.find((r) => runMs(r) <= at),
  }))
  const ready = plan.filter((p) => p.run)
  const target = scope === "table" ? `${database}.${table}` : database

  function reset() {
    setPoint("")
    setReplace(false)
  }

  async function submit() {
    setBusy(true)
    try {
      const results = await Promise.allSettled(
        ready.map((p) =>
          restoreFromRun(cluster, p.run!.run_id, [], {
            wholeTable: true,
            replace,
          })
        )
      )
      const failed = results.filter((r) => r.status === "rejected")
      if (failed.length === 0) {
        toast.success(`Restore of ${ready.length} table(s) queued`)
        onOpenChange(false)
      } else {
        toast.error(
          `${failed.length} of ${ready.length} restores failed to start: ${errorMessage((failed[0] as PromiseRejectedResult).reason)}`
        )
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Restore</DialogTitle>
          <DialogDescription>
            Restores from native (whole-table) backups. Each table goes back to
            its newest backup taken at or before the point you pick; ClickHouse
            reads the full backup and the incrementals on top of it.
          </DialogDescription>
        </DialogHeader>
        {databases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No native backups yet. Create a backup with the native mode first.
          </p>
        ) : (
          <FieldGroup>
            <FieldSet>
              <FieldLegend variant="label">What</FieldLegend>
              <RadioGroup
                value={scope}
                onValueChange={(v) => {
                  setScope(v as Scope)
                  reset()
                }}
                className="flex gap-6"
              >
                <Label className="flex items-center gap-2 font-normal">
                  <RadioGroupItem value="database" /> Whole database
                </Label>
                <Label className="flex items-center gap-2 font-normal">
                  <RadioGroupItem value="table" /> One table
                </Label>
              </RadioGroup>
            </FieldSet>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Database</FieldLabel>
                <Select
                  value={database}
                  onValueChange={(v) => {
                    setDatabase(v as string)
                    setTable("")
                    reset()
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a database" />
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
              {scope === "table" && (
                <Field>
                  <FieldLabel>Table</FieldLabel>
                  <Select
                    value={table}
                    onValueChange={(v) => {
                      setTable(v as string)
                      reset()
                    }}
                    disabled={!database}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a table" />
                    </SelectTrigger>
                    <SelectContent>
                      {dbTables.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            {tables.length > 0 && (
              <Field>
                <FieldLabel>Restore point</FieldLabel>
                {loading ? (
                  <Spinner />
                ) : points.length === 0 ? (
                  <FieldDescription>
                    No successful native backups for this selection yet.
                  </FieldDescription>
                ) : (
                  <Select
                    items={pointItems}
                    value={chosen}
                    onValueChange={(v) => setPoint(v as string)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {points.map((r) => (
                        <SelectItem key={r.run_id} value={runTime(r)}>
                          {pointItems[runTime(r)]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}
            {chosen && !loading && (
              <div className="max-h-48 overflow-auto rounded-md border text-sm">
                {plan.map((p) => (
                  <div
                    key={p.table}
                    className="flex justify-between gap-4 border-b px-3 py-1.5 last:border-b-0"
                  >
                    <span className="font-mono">{p.table}</span>
                    <span className="text-muted-foreground">
                      {p.run
                        ? `${formatDateTime(runTime(p.run))}${p.run.base_run_id ? " · incremental" : " · full"}`
                        : "no backup at this point, skipped"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Label className="flex items-start gap-2 font-normal">
              <Checkbox
                checked={replace}
                onCheckedChange={(v) => setReplace(v === true)}
                className="mt-0.5"
              />
              <span>
                Replace current data
                <span className="block text-xs text-muted-foreground">
                  Empties each table on every shard first, so the table matches
                  the backup exactly. Without this, restored rows are added to
                  what's there and existing data gets duplicated. Tables must
                  still exist.
                </span>
              </span>
            </Label>
          </FieldGroup>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={replace ? "destructive" : "default"}
            disabled={ready.length === 0 || busy}
            onClick={() => (replace ? setConfirming(true) : void submit())}
          >
            {busy
              ? "Starting…"
              : `Restore ${ready.length} table${ready.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Replace data in ${target}?`}
          description={`${ready.length} table(s) are emptied on every shard, then filled from the backups as of ${chosen ? formatDateTime(chosen) : ""}. Rows written after that are lost.`}
          typeToConfirm={scope === "table" ? table : database}
          confirmLabel="Replace and restore"
          destructive
          onConfirm={() => submit()}
        />
      </DialogContent>
    </Dialog>
  )
}
