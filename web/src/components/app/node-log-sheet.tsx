import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { nodeLog } from "@/api/queries"
import { ErrorState } from "@/components/app/misc"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function NodeLogSheet({
  cluster,
  ip,
  onClose,
  withSsh,
}: {
  cluster: string
  ip: string | null
  onClose: () => void
  withSsh: <T>(
    fn: (ssh: { password?: string }) => Promise<T>
  ) => Promise<T | undefined>
}) {
  const [logType, setLogType] = useState<"normal" | "error">("error")
  const [lines, setLines] = useState(300)
  const [filter, setFilter] = useState("")
  const bottom = useRef<HTMLDivElement>(null)

  const log = useQuery({
    queryKey: ["cluster", cluster, "node-log", ip, logType, lines],
    // a failed SSH call can return an unparseable body; that surfaces as an error
    queryFn: async () =>
      (await withSsh((p) =>
        nodeLog(cluster, ip ?? "", { logType, lines, tail: true }, p)
      )) ?? "",
    enabled: ip !== null,
    staleTime: 0,
    gcTime: 0,
  })

  useEffect(() => {
    bottom.current?.scrollIntoView()
  }, [log.data])

  const shown = (log.data ?? "")
    .split("\n")
    .filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()))

  return (
    <Sheet open={ip !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
      >
        <SheetHeader>
          <SheetTitle>Logs · {ip}</SheetTitle>
          <SheetDescription>
            Last lines of the ClickHouse server log on this node.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap items-center gap-3 border-y px-4 py-3">
          <Tabs
            value={logType}
            onValueChange={(v) => setLogType(v as "normal" | "error")}
          >
            <TabsList>
              <TabsTrigger value="error">Errors</TabsTrigger>
              <TabsTrigger value="normal">All</TabsTrigger>
            </TabsList>
          </Tabs>
          <Label className="flex items-center gap-2 font-normal">
            Lines
            <Input
              type="number"
              min={10}
              max={1000}
              defaultValue={lines}
              onBlur={(e) =>
                setLines(
                  Math.min(1000, Math.max(10, Number(e.target.value) || 10))
                )
              }
              className="w-20"
            />
          </Label>
          <Input
            placeholder="Filter lines…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-48"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void log.refetch()}
            disabled={log.isFetching}
          >
            {log.isFetching && <Spinner />} Reload
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
          {log.error ? (
            <ErrorState error={log.error} />
          ) : log.isPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </div>
          ) : (
            <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {shown.length && log.data
                ? shown.join("\n")
                : "No matching lines."}
            </pre>
          )}
          <div ref={bottom} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
