import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useRouteContext } from "@tanstack/react-router"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  checkMachine,
  deleteMachine,
  fleetStatsQuery,
  machinesQuery,
  type Machine,
  type MachineStats,
} from "@/api/fleet"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { CapacityBar, formatCores } from "@/components/app/fleet-usage"
import { MachineDialog } from "@/components/app/machine-dialog"
import { ErrorState } from "@/components/app/misc"
import { PageBody, PageHeader } from "@/components/app/page-header"
import { MachineStatusPill, LabelChips } from "@/components/app/machine-bits"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatBytes } from "@/lib/format"

export const Route = createFileRoute("/_app/machines/")({
  component: MachinesPage,
})

type Row = Machine & { stats?: MachineStats }

const col = columnHelper<Row>()

function MachinesPage() {
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const machines = useQuery(machinesQuery())
  const stats = useQuery(fleetStatsQuery())
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Machine | "new" | null>(null)
  const [removing, setRemoving] = useState<Machine | null>(null)

  const rows = useMemo<Row[]>(() => {
    const byId = new Map((stats.data ?? []).map((s) => [s.machine_id, s]))
    return (machines.data ?? []).map((m) => ({ ...m, stats: byId.get(m.id) }))
  }, [machines.data, stats.data])
  const zones = useMemo(
    () =>
      [
        ...new Set((machines.data ?? []).map((m) => m.zone).filter(Boolean)),
      ].sort(),
    [machines.data]
  )

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["machines"] })

  async function check(m: Machine) {
    try {
      const res = await checkMachine(m.id)
      toast.success(
        res.status === "ready"
          ? `${m.name} is ready`
          : `${m.name}: ${res.status_message ?? res.status}`
      )
    } catch (err) {
      toast.error(errorMessage(err))
    }
    await refresh()
  }

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Machine",
        cell: (c) => (
          <div className="flex flex-col">
            <Link
              to="/machines/$machineId"
              params={{ machineId: c.row.original.id }}
              className="font-medium hover:underline"
            >
              {c.getValue()}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">
              {c.row.original.ip}
            </span>
          </div>
        ),
      }),
      col.accessor("zone", {
        header: "Zone",
        cell: (c) => c.getValue() || "—",
      }),
      col.accessor((m) => formatLabelsInline(m), {
        id: "labels",
        header: "Labels",
        enableSorting: false,
        cell: (c) => <LabelChips labels={c.row.original.labels} />,
      }),
      col.accessor("status", {
        header: "Status",
        cell: (c) => (
          <MachineStatusPill
            status={c.getValue()}
            error={c.row.original.stats?.error}
          />
        ),
      }),
      col.accessor((m) => m.stats?.containers?.length ?? 0, {
        id: "instances",
        header: "Instances",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.display({
        id: "cpu",
        header: "CPU",
        cell: (c) => {
          const s = c.row.original.stats
          return s && !s.error ? (
            <CapacityBar
              used={s.cpu_used}
              reserved={s.reserved_cpu}
              total={s.cores}
              format={formatCores}
            />
          ) : (
            "—"
          )
        },
      }),
      col.display({
        id: "memory",
        header: "Memory",
        cell: (c) => {
          const s = c.row.original.stats
          return s && !s.error ? (
            <CapacityBar
              used={s.mem_used}
              reserved={s.reserved_mem}
              total={s.mem_total}
              format={formatBytes}
            />
          ) : (
            "—"
          )
        },
      }),
      col.display({
        id: "disk",
        header: "Disk",
        cell: (c) => {
          const s = c.row.original.stats
          return s && !s.error ? (
            <CapacityBar
              used={s.disk_used}
              reserved={s.reserved_disk}
              total={s.disk_total}
              format={formatBytes}
            />
          ) : (
            "—"
          )
        },
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) =>
          isAdmin && (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${c.row.original.name}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void check(c.row.original)}>
                    Check now
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEditing(c.row.original)}>
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setRemoving(c.row.original)}
                  >
                    Remove…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ),
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin]
  )

  return (
    <>
      <PageHeader
        title="Machines"
        description="Servers that run ClickHouse and Keeper as containers. Bars show what's used, what containers reserve (their limits) and the total."
        actions={
          isAdmin && (
            <Button onClick={() => setEditing("new")}>
              <PlusIcon /> Add machine
            </Button>
          )
        }
      />
      <PageBody>
        {machines.error && <ErrorState error={machines.error} />}
        <ZoneSummary rows={rows} />
        <DataTable
          columns={columns}
          data={rows}
          loading={machines.isPending}
          searchable
          searchPlaceholder="Search name, IP, zone, labels…"
          emptyText="No machines yet. Add a server with Docker installed."
          getRowId={(m) => m.id}
        />
      </PageBody>
      <MachineDialog
        machine={editing}
        zones={zones}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name} from the fleet?`}
        description="ckman forgets this machine; nothing on it is changed. A machine that clusters or ckman containers still use can't be removed."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return
          await deleteMachine(removing.id)
          toast.success(`Removed ${removing.name}`)
          await refresh()
        }}
      />
    </>
  )
}

const formatLabelsInline = (m: Machine) =>
  Object.entries(m.labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")

// Per-zone totals above the table.
function ZoneSummary({ rows }: { rows: Row[] }) {
  const zones = new Map<
    string,
    { machines: number; instances: number; mem: number; memUsed: number }
  >()
  for (const r of rows) {
    const z = r.zone || "No zone"
    const e = zones.get(z) ?? { machines: 0, instances: 0, mem: 0, memUsed: 0 }
    e.machines++
    e.instances += r.stats?.containers?.length ?? 0
    e.mem += r.stats?.mem_total ?? 0
    e.memUsed += r.stats?.mem_used ?? 0
    zones.set(z, e)
  }
  if (zones.size === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[...zones.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([zone, e]) => (
          <div key={zone} className="flex flex-col gap-1 rounded-lg border p-4">
            <span className="text-xs font-medium text-muted-foreground">
              {zone}
            </span>
            <span className="text-lg font-semibold tabular-nums">
              {e.machines} machine{e.machines === 1 ? "" : "s"} · {e.instances}{" "}
              instance{e.instances === 1 ? "" : "s"}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              Memory {formatBytes(e.memUsed)} / {formatBytes(e.mem)}
            </span>
          </div>
        ))}
    </div>
  )
}
