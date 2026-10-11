import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router"
import { MoreHorizontalIcon } from "lucide-react"
import { toast } from "sonner"

import {
  deleteTask,
  isTaskActive,
  stopTask,
  taskListQuery,
  type TaskSummary,
} from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState } from "@/components/app/misc"
import { PageBody, PageHeader } from "@/components/app/page-header"
import { TaskStatusBadge } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatAgo, formatDateTime } from "@/lib/format"
import { taskLabel } from "@/lib/labels"

export const Route = createFileRoute("/_app/tasks/")({
  component: TasksPage,
})

const col = columnHelper<TaskSummary>()

function TasksPage() {
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const tasks = useQuery(taskListQuery())
  const queryClient = useQueryClient()
  const [action, setAction] = useState<{
    kind: "stop" | "delete"
    task: TaskSummary
  } | null>(null)

  const running = tasks.data?.filter((t) => isTaskActive(t.Status)).length ?? 0

  const columns = useMemo(
    () => [
      col.accessor((t) => t.Option.EN, {
        id: "operation",
        header: "Operation",
        cell: (c) => (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: c.row.original.TaskId }}
            className="font-medium hover:underline"
          >
            {taskLabel(c.getValue())}
          </Link>
        ),
      }),
      col.accessor("ClusterName", {
        header: "Cluster",
        cell: (c) => (
          <Link
            to="/clusters/$cluster"
            params={{ cluster: c.getValue() }}
            className="hover:underline"
          >
            {c.getValue()}
          </Link>
        ),
      }),
      col.accessor("Status", {
        header: "Status",
        cell: (c) => <TaskStatusBadge status={c.getValue()} />,
      }),
      col.accessor("Message", {
        header: "Message",
        enableSorting: false,
        cell: (c) => (
          <span
            className="line-clamp-2 max-w-md text-xs text-muted-foreground"
            title={c.getValue()}
          >
            {c.getValue() === "Success" ? "" : c.getValue()}
          </span>
        ),
      }),
      col.accessor("CreateTime", {
        header: "Started",
        sortFn: "datetime",
        cell: (c) => (
          <span title={formatDateTime(c.getValue())}>
            {formatAgo(c.getValue())}
          </span>
        ),
      }),
      col.accessor("Duration", { header: "Duration", enableSorting: false }),
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
                      aria-label="Actions"
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    render={
                      <Link to="/tasks/$taskId" params={{ taskId: t.TaskId }} />
                    }
                  >
                    View progress
                  </DropdownMenuItem>
                  {isAdmin && isTaskActive(t.Status) && (
                    <DropdownMenuItem
                      onClick={() => setAction({ kind: "stop", task: t })}
                    >
                      Stop…
                    </DropdownMenuItem>
                  )}
                  {isAdmin && !isTaskActive(t.Status) && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setAction({ kind: "delete", task: t })}
                    >
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      }),
    ],
    [isAdmin]
  )

  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          running > 0
            ? `${running} task${running === 1 ? "" : "s"} running. This page refreshes automatically.`
            : "Deploys, upgrades, node changes, settings changes and rebalances."
        }
      />
      <PageBody>
        {tasks.error && <ErrorState error={tasks.error} />}
        <DataTable
          columns={columns}
          data={tasks.data}
          loading={tasks.isPending}
          searchable
          searchPlaceholder="Search tasks…"
          emptyText="No tasks yet."
          getRowId={(t) => t.TaskId}
          initialSorting={[{ id: "CreateTime", desc: true }]}
        />
      </PageBody>
      <ConfirmDialog
        open={action !== null}
        onOpenChange={(o) => !o && setAction(null)}
        title={
          action?.kind === "stop"
            ? "Stop this task?"
            : "Delete this task record?"
        }
        description={
          action?.kind === "stop"
            ? "ckman stops after the step in progress finishes. Nodes may be left half-changed; check the cluster afterwards."
            : "This only removes the record from the task list."
        }
        confirmLabel={action?.kind === "stop" ? "Stop task" : "Delete"}
        destructive
        onConfirm={async () => {
          if (!action) return
          if (action.kind === "stop") await stopTask(action.task.TaskId)
          else await deleteTask(action.task.TaskId)
          toast.success(
            action.kind === "stop" ? "Task stopped" : "Task deleted"
          )
          await queryClient.invalidateQueries({ queryKey: ["tasks"] })
        }}
      />
    </>
  )
}
