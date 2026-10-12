import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"

import {
  backupHealthQuery,
  isZeroTime,
  type BackupHealth,
  type BackupHealthState,
} from "@/api/data-manage"
import {
  HealthBadge,
  healthHint,
  worstHealth,
} from "@/components/app/backup-health"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState, Stat } from "@/components/app/misc"
import { PageBody, PageHeader } from "@/components/app/page-header"
import { formatAgo, formatDateTime } from "@/lib/format"

export const Route = createFileRoute("/_app/backups")({
  component: BackupsOverviewPage,
})

// A backup as the cluster pages show it: the tables submitted together.
type Row = {
  key: string
  cluster: string
  name: string
  tables: string[]
  schedule: string
  worst: BackupHealth
  lastSuccess?: string
  nextDue?: string
}

const URGENCY: BackupHealthState[] = [
  "failing",
  "overdue",
  "retrying",
  "running",
  "waiting",
  "paused",
  "healthy",
]

const col = columnHelper<Row>()

function BackupsOverviewPage() {
  const health = useQuery(backupHealthQuery())

  const rows = useMemo(() => {
    const groups = new Map<string, BackupHealth[]>()
    for (const h of health.data ?? []) {
      const key = `${h.cluster}/${h.task_id || h.policy_id}`
      groups.set(key, [...(groups.get(key) ?? []), h])
    }
    const out: Row[] = []
    for (const [key, items] of groups) {
      const worst = worstHealth(items)!
      // the backup is only as fresh as its stalest table
      const successes = items.map((h) => h.last_success ?? "")
      const lastSuccess = successes.some((t) => !t || isZeroTime(t))
        ? undefined
        : successes.sort()[0]
      const dues = items
        .map((h) => h.next_due ?? "")
        .filter((t) => t && !isZeroTime(t))
        .sort()
      out.push({
        key,
        cluster: items[0].cluster,
        name: items[0].task_name || `${items[0].database}.${items[0].table}`,
        tables: items.map((h) => `${h.database}.${h.table}`),
        schedule: items[0].schedule,
        worst,
        lastSuccess,
        nextDue: dues[0],
      })
    }
    return out.sort(
      (a, b) =>
        URGENCY.indexOf(a.worst.state) - URGENCY.indexOf(b.worst.state) ||
        a.cluster.localeCompare(b.cluster) ||
        a.name.localeCompare(b.name)
    )
  }, [health.data])

  const count = (...states: BackupHealthState[]) =>
    rows.filter((r) => states.includes(r.worst.state)).length

  const columns = useMemo(
    () => [
      col.accessor("cluster", {
        header: "Cluster",
        cell: (c) => (
          <Link
            to="/clusters/$cluster/backups"
            params={{ cluster: c.getValue() }}
            className="font-medium hover:underline"
          >
            {c.getValue()}
          </Link>
        ),
      }),
      col.accessor("name", {
        header: "Backup",
        cell: (c) => (
          <div className="flex min-w-40 flex-col">
            <span>{c.getValue()}</span>
            <span
              className="line-clamp-1 max-w-64 text-xs text-muted-foreground"
              title={c.row.original.tables.join(", ")}
            >
              {c.row.original.tables.length === 1
                ? c.row.original.tables[0]
                : `${c.row.original.tables.length} tables`}
            </span>
          </div>
        ),
      }),
      col.accessor("schedule", {
        header: "Schedule",
        cell: (c) =>
          c.getValue() ? (
            <span className="font-mono text-xs">{c.getValue()}</span>
          ) : (
            <span className="text-muted-foreground">One-off</span>
          ),
      }),
      col.accessor((r) => URGENCY.indexOf(r.worst.state), {
        id: "health",
        header: "Health",
        cell: (c) => {
          const h = c.row.original.worst
          return (
            <div className="flex min-w-44 flex-col gap-0.5">
              <HealthBadge state={h.state} />
              <span
                className="line-clamp-2 max-w-72 text-xs text-muted-foreground"
                title={h.error || healthHint(h)}
              >
                {h.error && (h.state === "failing" || h.state === "retrying")
                  ? h.error
                  : healthHint(h)}
              </span>
            </div>
          )
        },
      }),
      col.accessor((r) => r.lastSuccess ?? "", {
        id: "last",
        header: "Last success",
        cell: (c) =>
          c.getValue() ? (
            <span title={formatDateTime(c.getValue())}>
              {formatAgo(c.getValue())}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      }),
      col.accessor((r) => r.nextDue ?? "", {
        id: "next",
        header: "Next due",
        cell: (c) =>
          c.getValue() ? (
            formatDateTime(c.getValue())
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      }),
    ],
    []
  )

  return (
    <>
      <PageHeader
        title="Backups"
        description="Every backup on every cluster, and whether it has been succeeding on schedule. Failed backups are retried up to 3 times (after 5, 15 and 45 minutes)."
      />
      <PageBody>
        {health.error && <ErrorState error={health.error} />}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Failing or overdue"
            value={health.data ? count("failing", "overdue") : "—"}
            hint="Need a look"
          />
          <Stat
            label="Retrying"
            value={health.data ? count("retrying") : "—"}
            hint="Failed; a retry is scheduled"
          />
          <Stat
            label="Healthy"
            value={health.data ? count("healthy", "running") : "—"}
            hint="On schedule"
          />
          <Stat
            label="Paused or not run yet"
            value={health.data ? count("paused", "waiting") : "—"}
          />
        </div>
        <DataTable
          columns={columns}
          data={health.data ? rows : undefined}
          loading={health.isPending}
          searchable
          searchPlaceholder="Search backups…"
          emptyText="No backups yet. Create them on a cluster's Backups tab."
          getRowId={(r) => r.key}
        />
      </PageBody>
    </>
  )
}
