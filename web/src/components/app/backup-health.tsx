import type { BackupHealth, BackupHealthState } from "@/api/data-manage"
import { isZeroTime } from "@/api/data-manage"
import { StatusPill } from "@/components/app/status"
import { formatAgo, formatDateTime } from "@/lib/format"

// Most urgent first: a backup group shows its worst state.
const ORDER: BackupHealthState[] = [
  "failing",
  "overdue",
  "retrying",
  "running",
  "waiting",
  "paused",
  "healthy",
]

const LOOK: Record<
  BackupHealthState,
  { tone: "ok" | "warn" | "bad" | "info" | "muted"; label: string }
> = {
  failing: { tone: "bad", label: "Failing" },
  overdue: { tone: "bad", label: "Overdue" },
  retrying: { tone: "warn", label: "Retrying" },
  running: { tone: "info", label: "Running" },
  waiting: { tone: "muted", label: "Not run yet" },
  paused: { tone: "muted", label: "Paused" },
  healthy: { tone: "ok", label: "Healthy" },
}

export function worstHealth(items: BackupHealth[]): BackupHealth | undefined {
  return [...items].sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)
  )[0]
}

export function HealthBadge({ state }: { state: BackupHealthState }) {
  const look = LOOK[state] ?? LOOK.waiting
  return (
    <StatusPill
      tone={look.tone}
      busy={state === "running"}
      label={look.label}
    />
  )
}

const set = (t?: string) => !!t && !isZeroTime(t)

// healthHint is one line on what the state means for this backup.
export function healthHint(h: BackupHealth): string {
  switch (h.state) {
    case "failing":
      return `Last attempt failed${h.attempt && h.attempt > 1 ? ` (attempt ${h.attempt})` : ""}${set(h.last_success) ? `; last success ${formatAgo(h.last_success)}` : ""}`
    case "retrying":
      return `Failed; attempt ${(h.attempt ?? 1) + 1} at ${formatDateTime(h.next_retry_at)}`
    case "overdue":
      return `Was due ${formatAgo(h.next_due)}${set(h.last_success) ? `; last success ${formatAgo(h.last_success)}` : "; never succeeded"}`
    case "running":
      return set(h.last_success)
        ? `Last success ${formatAgo(h.last_success)}`
        : "First backup in progress"
    case "waiting":
      return set(h.next_due)
        ? `First backup due ${formatDateTime(h.next_due)}`
        : "No backup yet"
    case "paused":
      return set(h.last_success)
        ? `Last success ${formatAgo(h.last_success)}`
        : "Schedule switched off"
    default:
      return `Last success ${formatAgo(h.last_success)}${set(h.next_due) ? ` · next ${formatDateTime(h.next_due)}` : ""}`
  }
}
