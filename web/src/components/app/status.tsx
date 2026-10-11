import type { TaskStatus } from "@/api/queries"
import type { RunStatus } from "@/api/data-manage"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type Tone = "ok" | "warn" | "bad" | "info" | "muted"

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  info: "bg-sky-500",
  muted: "bg-muted-foreground/50",
}

const TEXT: Record<Tone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-400",
  info: "text-sky-700 dark:text-sky-400",
  muted: "text-muted-foreground",
}

export function StatusPill({
  tone,
  label,
  busy,
  className,
}: {
  tone: Tone
  label: React.ReactNode
  busy?: boolean
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium", TEXT[tone], className)}
    >
      {busy ? (
        <Spinner className="size-3" />
      ) : (
        <span className={cn("size-1.5 rounded-full", DOT[tone])} />
      )}
      {label}
    </Badge>
  )
}

export function NodeStatus({ status }: { status: string }) {
  return status === "green" ? (
    <StatusPill tone="ok" label="Up" />
  ) : (
    <StatusPill tone="bad" label="Down" />
  )
}

export function ClusterHealth({ status }: { status: string | undefined }) {
  if (!status) return <StatusPill tone="muted" label="Unknown" />
  // ckman's yellow/red split is unreliable; only "all nodes up" is meaningful
  return status === "green" ? (
    <StatusPill tone="ok" label="Healthy" />
  ) : (
    <StatusPill tone="bad" label="Nodes down" />
  )
}

const TASK_TONE: Record<TaskStatus, Tone> = {
  Waiting: "muted",
  Running: "info",
  Success: "ok",
  Failed: "bad",
  Stopped: "warn",
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <StatusPill
      tone={TASK_TONE[status] ?? "muted"}
      label={status}
      busy={status === "Running" || status === "Waiting"}
    />
  )
}

const RUN_TONE: Record<RunStatus, Tone> = {
  queued: "muted",
  running: "info",
  success: "ok",
  failed: "bad",
  skipped: "muted",
  interrupted: "warn",
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <StatusPill
      tone={RUN_TONE[status] ?? "muted"}
      label={status}
      busy={status === "running" || status === "queued"}
    />
  )
}

// Fraction bar for disk/memory-style values; amber at 70 %, red at 90 %.
export function UsageBar({
  fraction,
  label,
}: {
  fraction: number | null
  label: string
}) {
  if (fraction === null)
    return <span className="text-muted-foreground">{label}</span>
  const pct = Math.min(100, Math.max(0, fraction * 100))
  const color =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {label}
      </span>
    </div>
  )
}
