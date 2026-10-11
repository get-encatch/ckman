import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"

import { errorMessage } from "@/api/client"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ErrorState({
  error,
  className,
}: {
  error: unknown
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive",
        className
      )}
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <span className="break-words">{errorMessage(error)}</span>
    </div>
  )
}

export function CopyButton({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // clipboard unavailable (insecure context); nothing to do
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

export function CodeBlock({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  return (
    <div className={cn("relative rounded-lg border bg-muted/40", className)}>
      <CopyButton text={code} className="absolute top-1.5 right-1.5" />
      <pre className="max-h-[60vh] overflow-auto p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {code}
      </pre>
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

export function KeyValue({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
