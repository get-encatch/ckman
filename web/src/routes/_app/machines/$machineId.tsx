import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  AUTH_KEY,
  checkMachine,
  deleteMachine,
  machineQuery,
  machinesQuery,
  machineStatsQuery,
  type ContainerStats,
} from "@/api/fleet"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { CapacityBar, formatCores } from "@/components/app/fleet-usage"
import { LabelChips, MachineStatusPill } from "@/components/app/machine-bits"
import { MachineDialog } from "@/components/app/machine-dialog"
import { CodeBlock, ErrorState, KeyValue } from "@/components/app/misc"
import { PageBody, PageHeader, Section } from "@/components/app/page-header"
import { StatusPill, UsageBar } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import { formatAgo, formatBytes } from "@/lib/format"

export const Route = createFileRoute("/_app/machines/$machineId")({
  component: MachinePage,
})

const col = columnHelper<ContainerStats>()

function MachinePage() {
  const { machineId } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const machine = useQuery(machineQuery(machineId))
  const stats = useQuery(machineStatsQuery(machineId))
  const all = useQuery(machinesQuery())
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [checking, setChecking] = useState(false)
  const zones = useMemo(
    () =>
      [...new Set((all.data ?? []).map((m) => m.zone).filter(Boolean))].sort(),
    [all.data]
  )

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["machines"] })

  async function check() {
    setChecking(true)
    try {
      await checkMachine(machineId)
      await refresh()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setChecking(false)
    }
  }

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Container",
        cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
      }),
      col.accessor("cluster", {
        header: "Cluster",
        cell: (c) => c.getValue() || "—",
      }),
      col.accessor("role", {
        header: "Role",
        cell: (c) =>
          c.getValue() === "keeper"
            ? "Keeper"
            : c.getValue() === "clickhouse"
              ? "ClickHouse"
              : "—",
      }),
      col.accessor("state", {
        header: "State",
        cell: (c) =>
          c.getValue() === "running" ? (
            <StatusPill tone="ok" label="Running" />
          ) : (
            <StatusPill tone="bad" label={c.getValue()} />
          ),
      }),
      col.accessor("cpu_percent", {
        header: "CPU",
        cell: (c) => {
          const r = c.row.original
          return (
            <span className="tabular-nums">
              {(r.cpu_percent / 100).toFixed(2)} /{" "}
              {r.cpu_limit ? formatCores(r.cpu_limit) : "no limit"}
            </span>
          )
        },
      }),
      col.accessor("mem_used", {
        header: "Memory",
        cell: (c) => {
          const r = c.row.original
          return r.mem_limit ? (
            <UsageBar
              fraction={r.mem_used / r.mem_limit}
              label={`${formatBytes(r.mem_used)} / ${formatBytes(r.mem_limit)}`}
            />
          ) : (
            `${formatBytes(r.mem_used)} (no limit)`
          )
        },
      }),
      col.accessor("disk_used", {
        header: "Disk",
        cell: (c) => {
          const r = c.row.original
          return r.disk_limit ? (
            <UsageBar
              fraction={r.disk_used / r.disk_limit}
              label={`${formatBytes(r.disk_used)} / ${formatBytes(r.disk_limit)}`}
            />
          ) : (
            formatBytes(r.disk_used)
          )
        },
      }),
      col.accessor("image", {
        header: "Image",
        cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
      }),
    ],
    []
  )

  if (machine.error)
    return (
      <PageBody>
        <ErrorState error={machine.error} />
      </PageBody>
    )
  const m = machine.data
  const s = stats.data

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {m?.name ?? "Machine"}
            {m && <MachineStatusPill status={m.status} error={s?.error} />}
          </span>
        }
        description={m ? `${m.ip}${m.zone ? ` · ${m.zone}` : ""}` : undefined}
        actions={
          isAdmin &&
          m && (
            <>
              <Button
                variant="outline"
                disabled={checking}
                onClick={() => void check()}
              >
                {checking ? "Checking…" : "Check now"}
              </Button>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="destructive" onClick={() => setRemoving(true)}>
                Remove…
              </Button>
            </>
          )
        }
      />
      <PageBody>
        {m?.status === "no_docker" && (
          <Section
            title="Docker isn't installed"
            description="Install Docker on the machine, then click Check now. On Debian or Ubuntu:"
          >
            <CodeBlock
              code={
                "curl -fsSL https://get.docker.com | sh\nsystemctl enable --now docker"
              }
            />
          </Section>
        )}
        {s?.error && (
          <ErrorState error={new Error(`Can't read usage: ${s.error}`)} />
        )}
        <div className="grid gap-3 lg:grid-cols-3">
          <UsageCard title="CPU">
            {s && !s.error && (
              <CapacityBar
                used={s.cpu_used}
                reserved={s.reserved_cpu}
                total={s.cores}
                format={formatCores}
              />
            )}
          </UsageCard>
          <UsageCard title="Memory">
            {s && !s.error && (
              <CapacityBar
                used={s.mem_used}
                reserved={s.reserved_mem}
                total={s.mem_total}
                format={formatBytes}
              />
            )}
          </UsageCard>
          <UsageCard title={`Disk (${m?.data_dir ?? "data folder"})`}>
            {s && !s.error && (
              <CapacityBar
                used={s.disk_used}
                reserved={s.reserved_disk}
                total={s.disk_total}
                format={formatBytes}
              />
            )}
          </UsageCard>
        </div>
        <Section
          title="Containers"
          description="ClickHouse and Keeper instances ckman runs on this machine."
        >
          <DataTable
            columns={columns}
            data={s?.containers ?? []}
            loading={stats.isPending}
            emptyText="No ckman containers on this machine yet."
            getRowId={(c) => c.name}
          />
        </Section>
        {m && (
          <Section title="Details">
            <KeyValue
              items={[
                ["Hostname", m.facts.hostname || "—"],
                ["OS", `${m.facts.os || "—"} (${m.facts.arch || "?"})`],
                ["Docker", m.facts.docker_version || "Not installed"],
                ["Labels", <LabelChips key="l" labels={m.labels} />],
                [
                  "SSH",
                  `${m.ssh_user}@${m.ip}:${m.ssh_port} · ${m.authenticate_type === AUTH_KEY ? "ckman's key" : "password"}`,
                ],
                ["Data folder", m.data_dir],
                ["Last checked", formatAgo(m.facts.checked_at)],
              ]}
            />
          </Section>
        )}
      </PageBody>
      <MachineDialog
        machine={editing && m ? m : null}
        zones={zones}
        onClose={() => setEditing(false)}
        onSaved={refresh}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${m?.name} from the fleet?`}
        description="ckman forgets this machine; nothing on it is changed. A machine that clusters or ckman containers still use can't be removed."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          await deleteMachine(machineId)
          toast.success(`Removed ${m?.name}`)
          await refresh()
          await navigate({ to: "/machines" })
        }}
      />
    </>
  )
}

function UsageCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      {children ?? <span className="text-sm text-muted-foreground">—</span>}
    </div>
  )
}
