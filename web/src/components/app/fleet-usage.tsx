import { cn } from "@/lib/utils"

// One bar with three layers: total (track), reserved (container limits) and
// used. Reserved above total means the machine is overcommitted.
export function CapacityBar({
  used,
  reserved,
  total,
  format,
  className,
}: {
  used: number
  reserved?: number
  total: number
  format: (n: number) => string
  className?: string
}) {
  if (!total) return <span className="text-xs text-muted-foreground">—</span>
  const pct = (n: number) => Math.min(100, Math.max(0, (n / total) * 100))
  const usedPct = pct(used)
  const color =
    usedPct >= 90
      ? "bg-red-500"
      : usedPct >= 70
        ? "bg-amber-500"
        : "bg-emerald-500"
  const over = reserved !== undefined && reserved > total
  return (
    <div className={cn("flex min-w-40 flex-col gap-1", className)}>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {reserved !== undefined && reserved > 0 && (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              over ? "bg-red-500/30" : "bg-sky-500/30"
            )}
            style={{ width: `${pct(reserved)}%` }}
          />
        )}
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", color)}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {format(used)} used
        {reserved !== undefined && reserved > 0 && (
          <span className={cn(over && "text-red-600 dark:text-red-400")}>
            {" "}
            · {format(reserved)} reserved
          </span>
        )}{" "}
        / {format(total)}
      </span>
    </div>
  )
}

export const formatCores = (n: number) =>
  `${Number.isInteger(n) ? n : n.toFixed(1)} cores`
