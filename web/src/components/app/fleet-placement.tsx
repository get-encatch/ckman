import type { FleetPlan, Machine, MachineStats } from "@/api/fleet"
import { CapacityBar, formatCores } from "@/components/app/fleet-usage"
import { Section } from "@/components/app/page-header"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatBytes } from "@/lib/format"

// Shared by Create cluster and the Standby setup: machine pickers, instance
// size inputs and the placement check review.

export function machineLabel(m: Machine, s: MachineStats | undefined) {
  const free = s ? formatBytes(Math.max(0, s.mem_total - s.reserved_mem)) : "?"
  return `${m.name}${m.zone ? ` · ${m.zone}` : ""} · ${free} free`
}

export function MachineSelect({
  label,
  items,
  candidates,
  value,
  onChange,
}: {
  label: string
  items: Record<string, string>
  candidates: Machine[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <Select
      items={items}
      value={value || null}
      onValueChange={(v) => onChange((v as string) ?? "")}
    >
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue placeholder="Choose a machine" />
      </SelectTrigger>
      <SelectContent>
        {candidates.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {items[m.id]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SizeGroup({
  title,
  cpu,
  mem,
  disk,
  onCpu,
  onMem,
  onDisk,
}: {
  title: string
  cpu: string
  mem: string
  disk: string
  onCpu: (v: string) => void
  onMem: (v: string) => void
  onDisk: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <span className="text-sm font-medium">{title}</span>
      <div className="grid grid-cols-3 gap-2">
        <Field>
          <FieldLabel>CPU cores</FieldLabel>
          <Input
            inputMode="decimal"
            value={cpu}
            onChange={(e) => onCpu(e.target.value)}
            aria-label={`${title} CPU cores`}
          />
        </Field>
        <Field>
          <FieldLabel>Memory MiB</FieldLabel>
          <Input
            inputMode="numeric"
            value={mem}
            onChange={(e) => onMem(e.target.value)}
            aria-label={`${title} memory MiB`}
          />
        </Field>
        <Field>
          <FieldLabel>Disk GiB</FieldLabel>
          <Input
            inputMode="numeric"
            value={disk}
            onChange={(e) => onDisk(e.target.value)}
            aria-label={`${title} disk GiB`}
          />
        </Field>
      </div>
    </div>
  )
}

export function PlanReview({ plan }: { plan: FleetPlan }) {
  return (
    <Section
      title="Placement check"
      description={`Ports: ClickHouse ${plan.ports.tcp} (native), ${plan.ports.http} (HTTP), ${plan.ports.interserver} (replication); Keeper ${plan.ports.keeper_tcp} and ${plan.ports.keeper_raft}.`}
    >
      {plan.errors.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {plan.errors.map((e) => (
            <li key={e}>✕ {e}</li>
          ))}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {plan.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {plan.errors.length === 0 && plan.warnings.length === 0 && (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          ✓ No problems found.
        </p>
      )}
      {plan.machines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Machine</th>
                <th className="px-3 py-2 font-medium">Runs</th>
                <th className="px-3 py-2 font-medium">CPU reserved</th>
                <th className="px-3 py-2 font-medium">Memory reserved</th>
                <th className="px-3 py-2 font-medium">Disk reserved</th>
              </tr>
            </thead>
            <tbody>
              {plan.machines.map((m) => (
                <tr key={m.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {m.zone || "no zone"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">{m.roles.join(", ")}</td>
                  <td className="px-3 py-2">
                    <CapacityBar
                      usedLabel="reserved"
                      used={m.cpu}
                      total={m.cpu_total}
                      format={formatCores}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <CapacityBar
                      usedLabel="reserved"
                      used={m.mem}
                      total={m.mem_total}
                      format={formatBytes}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <CapacityBar
                      usedLabel="reserved"
                      used={m.disk}
                      total={m.disk_total}
                      format={formatBytes}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
