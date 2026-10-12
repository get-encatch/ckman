import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router"
import {
  DownloadIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ServerIcon,
} from "lucide-react"
import { toast } from "sonner"

import { deleteDraft, draftsQuery, type ClusterDraft } from "@/api/fleet"
import {
  clusterListQuery,
  forgetCluster,
  isTaskActive,
  taskQuery,
  type Cluster,
} from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ImportClusterDialog } from "@/components/app/import-cluster-dialog"
import { ErrorState } from "@/components/app/misc"
import { PageBody, PageHeader, Section } from "@/components/app/page-header"
import { StatusPill } from "@/components/app/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { formatAgo } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(clusterListQuery()),
  component: ClustersPage,
})

const col = columnHelper<Cluster>()

function ClustersPage() {
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const clusters = useQuery(clusterListQuery())
  const queryClient = useQueryClient()
  const [importOpen, setImportOpen] = useState(false)
  const [forget, setForget] = useState<Cluster | null>(null)

  const columns = useMemo(
    () => [
      col.accessor("cluster", {
        header: "Cluster",
        cell: (c) => (
          <div className="flex min-w-48 flex-col">
            <Link
              to="/clusters/$cluster"
              params={{ cluster: c.getValue() }}
              className="font-medium hover:underline"
            >
              {c.getValue()}
            </Link>
            {c.row.original.comment && (
              <span className="max-w-md truncate text-xs text-muted-foreground">
                {c.row.original.comment}
              </span>
            )}
          </div>
        ),
      }),
      col.accessor("version", {
        header: "Version",
        cell: (c) => (
          <span className="tabular-nums">{c.getValue() || "—"}</span>
        ),
      }),
      col.accessor((c) => c.shards?.length ?? 0, {
        id: "layout",
        header: "Layout",
        cell: (c) => {
          const shards = c.row.original.shards ?? []
          const replicas = Math.max(
            0,
            ...shards.map((s) => s.replicas?.length ?? 0)
          )
          return (
            <span className="whitespace-nowrap tabular-nums">
              {shards.length} × {replicas}
              <span className="ml-1 text-xs text-muted-foreground">
                ({c.row.original.hosts?.length ?? 0} nodes)
              </span>
            </span>
          )
        },
      }),
      col.accessor("keeper", {
        header: "Coordination",
        cell: (c) =>
          c.getValue() === "clickhouse-keeper"
            ? `Keeper (${c.row.original.KeeperConf?.runtime ?? "standalone"})`
            : "ZooKeeper",
      }),
      col.accessor("mode", {
        header: "Managed",
        cell: (c) =>
          c.getValue() === "import" ? (
            <Badge variant="secondary">Imported</Badge>
          ) : (
            <Badge variant="outline">Deployed</Badge>
          ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) => (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Actions" />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  render={
                    <Link
                      to="/clusters/$cluster"
                      params={{ cluster: c.row.original.cluster }}
                    />
                  }
                >
                  Open
                </DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setForget(c.row.original)}
                  >
                    Remove from ckman…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      }),
    ],
    [isAdmin]
  )

  const drafts = useQuery({ ...draftsQuery(), enabled: isAdmin })
  const [dropDraft, setDropDraft] = useState<ClusterDraft | null>(null)
  const empty = clusters.data?.length === 0 && !drafts.data?.length

  return (
    <>
      <PageHeader
        title="Clusters"
        description="ClickHouse clusters deployed or imported into ckman."
        actions={
          isAdmin && (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <DownloadIcon /> Import
              </Button>
              <Button nativeButton={false} render={<Link to="/clusters/new" />}>
                <PlusIcon /> Create cluster
              </Button>
            </>
          )
        }
      />
      <PageBody>
        {clusters.error && <ErrorState error={clusters.error} />}
        {isAdmin && !!drafts.data?.length && (
          <Section
            title="Drafts"
            description="Create-cluster forms saved part-way. A draft reserves its cluster name."
          >
            <ul className="flex flex-col divide-y rounded-lg border">
              {drafts.data.map((d) => (
                <DraftRow
                  key={d.name}
                  draft={d}
                  onDelete={() => setDropDraft(d)}
                />
              ))}
            </ul>
          </Section>
        )}
        {empty ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerIcon />
              </EmptyMedia>
              <EmptyTitle>No clusters yet</EmptyTitle>
              <EmptyDescription>
                Create a cluster on your servers, or import one that already
                runs.
              </EmptyDescription>
            </EmptyHeader>
            {isAdmin && (
              <EmptyContent>
                <div className="flex gap-2">
                  <Button
                    nativeButton={false}
                    render={<Link to="/clusters/new" />}
                  >
                    Create cluster
                  </Button>
                  <Button variant="outline" onClick={() => setImportOpen(true)}>
                    Import
                  </Button>
                </div>
              </EmptyContent>
            )}
          </Empty>
        ) : !!clusters.data?.length || clusters.isPending ? (
          <DataTable
            columns={columns}
            data={clusters.data}
            loading={clusters.isPending}
            searchable
            searchPlaceholder="Search clusters…"
            getRowId={(c) => c.cluster}
          />
        ) : null}
      </PageBody>
      <ImportClusterDialog open={importOpen} onOpenChange={setImportOpen} />
      <ConfirmDialog
        open={dropDraft !== null}
        onOpenChange={(o) => !o && setDropDraft(null)}
        title={`Delete the draft ${dropDraft ? draftTitle(dropDraft) : ""}?`}
        description="The saved form is lost and its cluster name is free again. Nothing was deployed from it."
        confirmLabel="Delete draft"
        destructive
        onConfirm={async () => {
          if (!dropDraft) return
          await deleteDraft(dropDraft.name)
          toast.success("Draft deleted")
          await queryClient.invalidateQueries({ queryKey: ["cluster-drafts"] })
        }}
      />
      <ConfirmDialog
        open={forget !== null}
        onOpenChange={(o) => !o && setForget(null)}
        title={`Remove ${forget?.cluster} from ckman?`}
        description="ckman stops managing this cluster. Its servers and data are not touched, and you can import it again later."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!forget) return
          await forgetCluster(forget.cluster)
          toast.success(`Removed ${forget.cluster} from ckman`)
          await queryClient.invalidateQueries({ queryKey: ["clusters"] })
        }}
      />
    </>
  )
}

const draftTitle = (d: ClusterDraft) =>
  d.name.startsWith("draft-") ? "Unnamed draft" : d.name

const DRAFT_STEPS = 5

function DraftRow({
  draft,
  onDelete,
}: {
  draft: ClusterDraft
  onDelete: () => void
}) {
  const task = useQuery({
    ...taskQuery(draft.task_id ?? ""),
    enabled: !!draft.task_id,
  })
  const status = task.data?.Status
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <div className="flex min-w-48 flex-col">
        <span className="font-medium">{draftTitle(draft)}</span>
        <span className="text-xs text-muted-foreground">
          Step {Math.min(draft.step + 1, DRAFT_STEPS)} of {DRAFT_STEPS} · saved{" "}
          {formatAgo(draft.updated_at)}
        </span>
      </div>
      {draft.task_id && status ? (
        isTaskActive(status) ? (
          <StatusPill tone="warn" busy label="Creating" />
        ) : status === "Success" ? (
          <StatusPill tone="ok" label="Created" />
        ) : (
          <StatusPill tone="bad" label="Create failed" />
        )
      ) : (
        <StatusPill tone="info" label="Draft" />
      )}
      <div className="ml-auto flex gap-2">
        {draft.task_id && (
          <Button
            size="sm"
            variant="ghost"
            nativeButton={false}
            render={
              <Link to="/tasks/$taskId" params={{ taskId: draft.task_id }} />
            }
          >
            Task
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={<Link to="/clusters/new" search={{ draft: draft.name }} />}
        >
          Resume
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </li>
  )
}
