import { useMemo, useState } from "react"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { HistoryIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  backupPoliciesQuery,
  describeMode,
  backupQueueQuery,
  deletePolicy,
  groupPolicies,
  policyRunsQuery,
  runTime,
  triggerPolicy,
  updatePolicy,
  type BackupTask,
} from "@/api/data-manage"
import { connectionsQuery } from "@/api/storage"
import { BackupFormDialog } from "@/components/app/backup-form-dialog"
import { BackupTaskSheet } from "@/components/app/backup-task-sheet"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState } from "@/components/app/misc"
import { PageBody, Section } from "@/components/app/page-header"
import { RestoreDialog } from "@/components/app/restore-dialog"
import { RunStatusBadge } from "@/components/app/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { formatAgo } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/$cluster/backups")({
  component: BackupsPage,
})

const col = columnHelper<BackupTask>()

function BackupsPage() {
  const { cluster } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const canWrite = session.policy !== "guest"
  const policies = useQuery({
    ...backupPoliciesQuery(cluster),
    refetchInterval: 10_000,
  })
  const connections = useQuery(connectionsQuery())
  const connectionNames = useMemo(
    () =>
      Object.fromEntries(
        (connections.data ?? []).map((c) => [c.connection_id, c.name])
      ),
    [connections.data]
  )
  const queue = useQuery({
    ...backupQueueQuery(cluster),
    refetchInterval: 5000,
  })
  const queryClient = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<BackupTask | null>(null)

  const tasks = useMemo(
    () => groupPolicies(policies.data ?? []),
    [policies.data]
  )
  // latest run of each task's first policy, for the "Last run" column
  const latest = useQueries({
    queries: tasks.map((t) => ({
      ...policyRunsQuery(t.policies[0].policy_id, 1),
      refetchInterval: 10_000,
    })),
  })
  const latestByTask = useMemo(
    () => Object.fromEntries(tasks.map((t, i) => [t.id, latest[i]?.data?.[0]])),
    [tasks, latest]
  )

  const refresh = () =>
    queryClient
      .invalidateQueries({ queryKey: ["cluster", cluster] })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ["backup-policy-runs"] })
      )

  async function runNow(task: BackupTask, full = false) {
    const results = await Promise.allSettled(
      task.policies.map((p) => triggerPolicy(p.policy_id, full))
    )
    const failed = results.filter((r) => r.status === "rejected")
    if (failed.length)
      toast.error(
        `${failed.length} of ${results.length} failed: ${errorMessage((failed[0] as PromiseRejectedResult).reason)}`
      )
    else
      toast.success(
        `Started ${results.length} backup run${results.length === 1 ? "" : "s"}`
      )
    await refresh()
  }

  async function setEnabled(task: BackupTask, enabled: boolean) {
    try {
      await Promise.all(
        task.policies.map((p) => updatePolicy({ ...p, enabled }))
      )
      toast.success(enabled ? "Schedule enabled" : "Schedule paused")
    } catch (err) {
      toast.error(errorMessage(err))
    }
    await refresh()
  }

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Backup",
        cell: (c) => (
          <button
            type="button"
            className="text-left font-medium hover:underline"
            onClick={() => setViewing(c.row.original.id)}
          >
            {c.getValue()}
          </button>
        ),
      }),
      col.accessor((t) => t.policies[0].schedule_type, {
        id: "schedule",
        header: "Schedule",
        cell: (c) => {
          const p = c.row.original.policies[0]
          return p.schedule_type === "scheduled" ? (
            <span className="font-mono text-xs">{p.crontab}</span>
          ) : (
            <Badge variant="secondary">One-off</Badge>
          )
        },
      }),
      col.accessor((t) => t.policies.length, {
        id: "tables",
        header: "Tables",
        cell: (c) => (
          <span
            className="line-clamp-1 max-w-56 text-sm"
            title={c.row.original.policies
              .map((p) => `${p.database}.${p.table}`)
              .join(", ")}
          >
            {c.row.original.policies.map((p) => p.table).join(", ")}
          </span>
        ),
      }),
      col.accessor((t) => describeMode(t.policies[0]), {
        id: "mode",
        header: "Mode",
      }),
      col.accessor((t) => t.policies[0].target_type, {
        id: "target",
        header: "Target",
        cell: (c) => {
          const p = c.row.original.policies[0]
          return p.target_type === "s3"
            ? p.connection_id
              ? `${connectionNames[p.connection_id] ?? "S3 connection"} · ${p.s3?.Bucket}`
              : `S3 · ${p.s3?.Bucket}`
            : `Local · ${p.local?.path}`
        },
      }),
      col.display({
        id: "last",
        header: "Last run",
        cell: (c) => {
          const run = latestByTask[c.row.original.id]
          return run ? (
            <div className="flex items-center gap-2">
              <RunStatusBadge status={run.status} />
              <span className="text-xs text-muted-foreground">
                {formatAgo(runTime(run))}
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground">Never</span>
          )
        },
      }),
      col.display({
        id: "enabled",
        header: "On",
        cell: (c) => {
          const t = c.row.original
          if (t.policies[0].schedule_type !== "scheduled") return null
          const on = t.policies.every((p) => p.enabled)
          return (
            <Switch
              checked={on}
              disabled={!canWrite}
              aria-label={`${t.name} schedule`}
              onCheckedChange={(v) => void setEnabled(t, v)}
            />
          )
        },
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) => {
          const t = c.row.original
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${t.name}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setViewing(t.id)}>
                    Runs and restore
                  </DropdownMenuItem>
                  {canWrite && (
                    <>
                      {t.policies[0].backup_style === "native" ? (
                        <>
                          <DropdownMenuItem onClick={() => void runNow(t)}>
                            Run incremental now
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void runNow(t, true)}
                          >
                            Run full backup now
                          </DropdownMenuItem>
                        </>
                      ) : (
                        <DropdownMenuItem onClick={() => void runNow(t)}>
                          Run now
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setRemoving(t)}
                      >
                        Delete…
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
    [latestByTask, canWrite, connectionNames]
  )

  const viewingTask = tasks.find((t) => t.id === viewing) ?? null

  return (
    <PageBody>
      <Section
        title="Backups"
        description="Copies of table partitions to S3 or a local path on each node, run once or on a schedule."
        actions={
          <>
            {queue.data &&
              (queue.data.running > 0 || queue.data.queued > 0) && (
                <Badge variant="outline">
                  {queue.data.running} running · {queue.data.queued} queued
                </Badge>
              )}
            {canWrite && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRestoreOpen(true)}
                >
                  <HistoryIcon /> Restore…
                </Button>
                <Button size="sm" onClick={() => setFormOpen(true)}>
                  <PlusIcon /> New backup
                </Button>
              </>
            )}
          </>
        }
      >
        {policies.error && <ErrorState error={policies.error} />}
        <DataTable
          columns={columns}
          data={tasks}
          loading={policies.isPending}
          searchable
          emptyText="No backups set up yet."
          getRowId={(t) => t.id}
        />
      </Section>
      <BackupFormDialog
        cluster={cluster}
        open={formOpen}
        onOpenChange={setFormOpen}
        onCreated={refresh}
      />
      <RestoreDialog
        key={restoreOpen ? "open" : "closed"}
        cluster={cluster}
        policies={policies.data ?? []}
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
      />
      <BackupTaskSheet
        cluster={cluster}
        task={viewingTask}
        canWrite={canWrite}
        onClose={() => setViewing(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete backup "${removing?.name}"?`}
        description="Deletes the schedule and its run history in ckman. The backed-up files in S3 or on disk stay where they are."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!removing) return
          for (const p of removing.policies) await deletePolicy(p.policy_id)
          toast.success("Backup deleted")
          await refresh()
        }}
      />
    </PageBody>
  )
}
