import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router"
import { CheckCircle2Icon, CircleIcon, XCircleIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { isTaskActive, stopTask, taskListQuery, taskQuery } from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { ErrorState, KeyValue } from "@/components/app/misc"
import { PageBody, PageHeader, Section } from "@/components/app/page-header"
import { TaskStatusBadge } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { formatDateTime } from "@/lib/format"
import { taskLabel } from "@/lib/labels"

export const Route = createFileRoute("/_app/tasks/$taskId")({
  component: TaskPage,
})

function TaskPage() {
  const { taskId } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const task = useQuery(taskQuery(taskId))
  // the failure message only exists in the list endpoint
  const list = useQuery({
    ...taskListQuery(),
    enabled: !!task.data && !isTaskActive(task.data.Status),
  })
  const message = list.data?.find((t) => t.TaskId === taskId)?.Message
  const queryClient = useQueryClient()
  const finishedCluster =
    task.data && !isTaskActive(task.data.Status) ? task.data.ClusterName : null
  // the cluster list (sidebar) and the cluster change when a task ends
  useEffect(() => {
    if (!finishedCluster) return
    void queryClient.invalidateQueries({ queryKey: ["clusters"] })
    void queryClient.invalidateQueries({
      queryKey: ["cluster", finishedCluster],
    })
  }, [finishedCluster, queryClient])
  const [stopOpen, setStopOpen] = useState(false)

  if (task.error) {
    return (
      <PageBody>
        <ErrorState error={task.error} />
      </PageBody>
    )
  }
  const t = task.data
  const nodes = t?.NodeStatus ?? []
  const done = nodes.filter((n) => n.Status.EN === "Done").length
  const failed = nodes.filter((n) => n.Status.EN === "Failed").length
  const active = t ? isTaskActive(t.Status) : true

  return (
    <>
      <PageHeader
        title={t ? `${taskLabel(t.Option.EN)} · ${t.ClusterName}` : "Task"}
        description={
          t && (
            <span className="flex items-center gap-2">
              <TaskStatusBadge status={t.Status} />
              <span>
                {active ? "Running for" : "Took"} {t.Duration}
              </span>
            </span>
          )
        }
        actions={
          t && (
            <>
              <Button
                nativeButton={false}
                variant="outline"
                render={
                  <Link
                    to="/clusters/$cluster"
                    params={{ cluster: t.ClusterName }}
                  />
                }
              >
                Open cluster
              </Button>
              {session.policy === "admin" && active && (
                <Button variant="destructive" onClick={() => setStopOpen(true)}>
                  Stop task
                </Button>
              )}
            </>
          )
        }
      />
      <PageBody className="max-w-4xl">
        {!t ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : (
          <>
            {t.Status === "Failed" && message && (
              <ErrorState error={new Error(message)} />
            )}
            {t.Step?.EN && (
              <Section title="Current step">
                <p className="text-sm">
                  {active && <Spinner className="mr-2 inline size-3.5" />}
                  {t.Step.EN}
                </p>
              </Section>
            )}
            {nodes.length > 0 && (
              <Section
                title={t.Type === "keeper" ? "Keeper nodes" : "Nodes"}
                description={
                  t.Type === "keeper" && active
                    ? "Keeper is set up first; ClickHouse nodes follow."
                    : `${done} of ${nodes.length} done${failed ? `, ${failed} failed` : ""}`
                }
              >
                <Progress value={(done / nodes.length) * 100} />
                <ul className="divide-y rounded-lg border">
                  {nodes.map((n) => {
                    const state = n.Status.EN
                    return (
                      <li
                        key={n.Host}
                        className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                      >
                        <span className="font-mono">{n.Host}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          {state === "Done" ? (
                            <CheckCircle2Icon className="size-4 text-emerald-500" />
                          ) : state === "Failed" ? (
                            <XCircleIcon className="size-4 text-red-500" />
                          ) : active ? (
                            <Spinner className="size-4" />
                          ) : (
                            <CircleIcon className="size-4" />
                          )}
                          {state === "Wating" ? "Waiting" : state}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </Section>
            )}
            <Section title="Details">
              <KeyValue
                items={[
                  [
                    "Task ID",
                    <span className="font-mono text-xs">{t.TaskId}</span>,
                  ],
                  ["Cluster", t.ClusterName],
                  ["Created", formatDateTime(t.CreateTime)],
                  ["Last update", formatDateTime(t.UpdateTime)],
                ]}
              />
            </Section>
          </>
        )}
      </PageBody>
      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop this task?"
        description="ckman stops after the step in progress finishes. Nodes may be left half-changed."
        confirmLabel="Stop task"
        destructive
        onConfirm={async () => {
          await stopTask(taskId)
          toast.success("Task stopped")
          await queryClient.invalidateQueries({ queryKey: ["task", taskId] })
        }}
      />
    </>
  )
}
