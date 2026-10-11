import { useMemo, useState } from "react"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  backupRunQuery,
  describeMode,
  partitionLabel,
  isZeroTime,
  nextRunQuery,
  policyRunsQuery,
  restoreFromRun,
  runTime,
  type BackupRun,
  type BackupTask,
} from "@/api/data-manage"
import { connectionsQuery } from "@/api/storage"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState, KeyValue } from "@/components/app/misc"
import { RunStatusBadge } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  formatAgo,
  formatBytes,
  formatDateTime,
  formatNumber,
} from "@/lib/format"

const runCol = columnHelper<BackupRun>()

export function BackupTaskSheet({
  cluster,
  task,
  canWrite,
  onClose,
}: {
  cluster: string
  task: BackupTask | null
  canWrite: boolean
  onClose: () => void
}) {
  const policies = task?.policies ?? []
  const runsQueries = useQueries({
    queries: policies.map((p) => ({
      ...policyRunsQuery(p.policy_id, 30),
      refetchInterval: 5000,
    })),
  })
  const runs = useMemo(
    () =>
      runsQueries
        .flatMap((q) => q.data ?? [])
        .sort((a, b) => runTime(b).localeCompare(runTime(a))),
    [runsQueries]
  )
  const first = policies[0]
  const connections = useQuery(connectionsQuery())
  const connectionName = connections.data?.find(
    (c) => c.connection_id === first?.connection_id
  )?.name
  const next = useQuery({
    ...nextRunQuery(first?.policy_id ?? ""),
    enabled: !!first && first.schedule_type === "scheduled" && first.enabled,
  })
  const [openRun, setOpenRun] = useState<string | null>(null)

  const columns = useMemo(
    () => [
      runCol.accessor((r) => runTime(r), {
        id: "time",
        header: "When",
        cell: (c) => (
          <button
            type="button"
            className="hover:underline"
            onClick={() => setOpenRun(c.row.original.run_id)}
          >
            {formatDateTime(c.getValue())}
          </button>
        ),
      }),
      runCol.accessor("table", {
        header: "Table",
        cell: (c) => `${c.row.original.database}.${c.getValue()}`,
      }),
      runCol.accessor("operation", {
        header: "Type",
        cell: (c) => {
          const r = c.row.original
          if (r.operation === "restore") return "Restore"
          if (r.native) return r.base_run_id ? "Incremental" : "Full"
          return "Backup"
        },
      }),
      runCol.accessor("status", {
        header: "Status",
        cell: (c) => (
          <div className="flex flex-col gap-0.5">
            <RunStatusBadge status={c.getValue()} />
            {c.row.original.status_reason && (
              <span className="text-xs text-muted-foreground">
                {c.row.original.status_reason.replaceAll("_", " ")}
              </span>
            )}
          </div>
        ),
      }),
      runCol.accessor((r) => r.partitions?.length ?? 0, {
        id: "parts",
        header: "Partitions",
      }),
      runCol.accessor(
        (r) => (r.partitions ?? []).reduce((n, p) => n + p.size, 0),
        {
          id: "size",
          header: "Size",
          cell: (c) => (
            <span className="tabular-nums">{formatBytes(c.getValue())}</span>
          ),
        }
      ),
      runCol.accessor("elapsed", {
        header: "Took",
        cell: (c) => `${c.getValue()} s`,
      }),
    ],
    []
  )

  return (
    <Sheet open={task !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-4xl"
      >
        <SheetHeader>
          <SheetTitle>{task?.name}</SheetTitle>
          <SheetDescription>
            Runs of this backup. Open a successful run to restore from it.
          </SheetDescription>
        </SheetHeader>
        {first && (
          <div className="flex flex-col gap-6 px-4 pb-6">
            <KeyValue
              items={[
                [
                  "Tables",
                  policies.map((p) => `${p.database}.${p.table}`).join(", "),
                ],
                ...((first.schedule_type !== "scheduled"
                  ? [["Schedule", "One-off"]]
                  : first.full_crontab
                    ? [
                        [
                          "Full backups",
                          `${first.full_crontab}${first.enabled ? "" : " (paused)"}`,
                        ],
                        ["Incrementals", first.crontab],
                        [
                          "Keep",
                          first.keep_full
                            ? `Last ${first.keep_full} full backups and their incrementals`
                            : "Everything",
                        ],
                      ]
                    : [
                        [
                          "Schedule",
                          `${first.crontab} on ${first.instance}${first.enabled ? "" : " (paused)"}`,
                        ],
                      ]) as [string, string][]),
                ...(next.data?.next_full_run_at
                  ? ([
                      [
                        "Next full backup",
                        formatDateTime(next.data.next_full_run_at),
                      ],
                    ] as [string, string][])
                  : []),
                ...(next.data?.next_run_at
                  ? ([
                      [
                        first.full_crontab ? "Next incremental" : "Next run",
                        formatDateTime(next.data.next_run_at),
                      ],
                    ] as [string, string][])
                  : []),
                ["Mode", describeMode(first)],
                [
                  "Target",
                  first.target_type === "s3"
                    ? first.connection_id
                      ? `Saved connection ${connectionName ?? first.connection_id} · bucket ${first.s3.Bucket}`
                      : `S3 ${first.s3.Endpoint} · bucket ${first.s3.Bucket}`
                    : `Local path ${first.local.path} on each node`,
                ],
                ["Compression", first.compression || "none"],
                ["Drop partitions after backup", first.clean ? "Yes" : "No"],
              ]}
            />
            {runsQueries.some((q) => q.error) && (
              <ErrorState error={runsQueries.find((q) => q.error)?.error} />
            )}
            <DataTable
              columns={columns}
              data={runs}
              loading={runsQueries.some((q) => q.isPending)}
              emptyText="No runs yet."
              getRowId={(r) => r.run_id}
              dense
            />
          </div>
        )}
        <RunDialog
          cluster={cluster}
          runId={openRun}
          canWrite={canWrite}
          onClose={() => setOpenRun(null)}
        />
      </SheetContent>
    </Sheet>
  )
}

function RunDialog({
  cluster,
  runId,
  canWrite,
  onClose,
}: {
  cluster: string
  runId: string | null
  canWrite: boolean
  onClose: () => void
}) {
  const run = useQuery({
    ...backupRunQuery(runId ?? ""),
    enabled: runId !== null,
  })
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [wholeTable, setWholeTable] = useState(false)
  const [replace, setReplace] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [lastRun, setLastRun] = useState(runId)
  if (runId !== lastRun) {
    setLastRun(runId)
    setSelected(new Set())
    setWholeTable(false)
    setReplace(false)
  }

  const r = run.data
  const restorable = r?.operation === "backup" && r.status === "success"
  const okParts = (r?.partitions ?? []).filter((p) => p.status === "success")

  async function restore() {
    if (!r) return
    setRestoring(true)
    try {
      const whole = r.native === true && wholeTable
      await restoreFromRun(cluster, r.run_id, whole ? [] : [...selected], {
        wholeTable: whole,
        replace,
      })
      toast.success(
        whole
          ? `Restore of ${r.database}.${r.table} queued`
          : `Restore of ${selected.size} partition(s) queued`
      )
      await queryClient.invalidateQueries({ queryKey: ["backup-policy-runs"] })
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Dialog open={runId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {r
              ? `${r.operation === "restore" ? "Restore" : r.native ? (r.base_run_id ? "Incremental backup" : "Full backup") : "Backup"} of ${r.database}.${r.table}`
              : "Run"}
          </DialogTitle>
          <DialogDescription>
            {r && (
              <span className="flex items-center gap-2">
                <RunStatusBadge status={r.status} />
                {isZeroTime(r.started_at)
                  ? "Queued"
                  : `${formatDateTime(r.started_at)} · ${formatAgo(r.started_at)}`}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {run.error && <ErrorState error={run.error} />}
        {r?.error_msg && <ErrorState error={new Error(r.error_msg)} />}
        {r && (
          <div className="max-h-[50vh] overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  {restorable && canWrite && (
                    <th className="w-8 px-3 py-2">
                      <Checkbox
                        aria-label="Select all"
                        checked={
                          selected.size > 0 && selected.size === okParts.length
                        }
                        onCheckedChange={(v) =>
                          setSelected(
                            v === true
                              ? new Set(okParts.map((p) => p.partition))
                              : new Set()
                          )
                        }
                      />
                    </th>
                  )}
                  <th className="px-3 py-2">Partition</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Rows</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(r.partitions ?? []).map((p) => (
                  <tr key={p.partition}>
                    {restorable && canWrite && (
                      <td className="px-3 py-1.5">
                        <Checkbox
                          aria-label={`Restore ${p.partition}`}
                          disabled={p.status !== "success"}
                          checked={selected.has(p.partition)}
                          onCheckedChange={(v) => {
                            const next = new Set(selected)
                            if (v === true) next.add(p.partition)
                            else next.delete(p.partition)
                            setSelected(next)
                          }}
                        />
                      </td>
                    )}
                    <td className="px-3 py-1.5 font-mono">
                      {partitionLabel(p.partition)}
                    </td>
                    <td className="px-3 py-1.5">{p.status}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatNumber(p.rows)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatBytes(p.size)}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-destructive">
                      {p.msg}
                    </td>
                  </tr>
                ))}
                {(r.partitions ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      No partitions in this run.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {restorable && canWrite && (
          <div className="flex flex-col gap-3 border-t pt-3">
            {r.native && (
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={wholeTable}
                  onCheckedChange={(v) => setWholeTable(v === true)}
                />
                Restore the whole table (all partitions)
              </Label>
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
                  {wholeTable && r.native
                    ? "Empties the table on every shard first."
                    : "Drops the chosen partitions first."}{" "}
                  Without this, restored rows are added to what's there, so data
                  that still exists gets duplicated.
                </span>
              </span>
            </Label>
            <DialogFooter className="items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                {r.native
                  ? "ClickHouse also reads the earlier backups of this chain."
                  : "Restores from this run's partition backups."}
              </p>
              <Button
                variant={replace ? "destructive" : "default"}
                disabled={
                  (!(wholeTable && r.native) && selected.size === 0) ||
                  restoring
                }
                onClick={() =>
                  replace ? setConfirmReplace(true) : void restore()
                }
              >
                {restoring
                  ? "Starting…"
                  : wholeTable && r.native
                    ? "Restore table"
                    : `Restore ${selected.size || ""} partition${selected.size === 1 ? "" : "s"}`}
              </Button>
            </DialogFooter>
          </div>
        )}
        <ConfirmDialog
          open={confirmReplace}
          onOpenChange={setConfirmReplace}
          title={`Replace data in ${r?.database}.${r?.table}?`}
          description={
            wholeTable && r?.native
              ? "The table is emptied on every shard, then filled from this backup. Rows written after the backup are lost."
              : `${selected.size} partition(s) are dropped on every shard, then restored from this backup.`
          }
          typeToConfirm={r?.table}
          confirmLabel="Replace and restore"
          destructive
          onConfirm={() => restore()}
        />
      </DialogContent>
    </Dialog>
  )
}
