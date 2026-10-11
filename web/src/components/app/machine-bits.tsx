import type { MachineStatus } from "@/api/fleet"
import { StatusPill } from "@/components/app/status"
import { Badge } from "@/components/ui/badge"

export function MachineStatusPill({
  status,
  error,
}: {
  status: MachineStatus
  error?: string
}) {
  if (error) return <StatusPill tone="bad" label="Unreachable" />
  if (status === "ready") return <StatusPill tone="ok" label="Ready" />
  if (status === "no_docker")
    return <StatusPill tone="warn" label="No Docker" />
  return <StatusPill tone="bad" label="Unreachable" />
}

export function LabelChips({
  labels,
}: {
  labels: Record<string, string> | null
}) {
  const entries = Object.entries(labels ?? {})
  if (entries.length === 0)
    return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Badge key={k} variant="secondary" className="font-mono text-xs">
          {v ? `${k}=${v}` : k}
        </Badge>
      ))}
    </div>
  )
}
