import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  operatePartition,
  partitionsQuery,
  type PartitionRow,
} from "@/api/observability"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState } from "@/components/app/misc"
import { StatusPill } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format"

const col = columnHelper<PartitionRow>()

export function PartitionsSheet({
  cluster,
  table,
  canWrite,
  onClose,
}: {
  cluster: string
  table: string | null
  canWrite: boolean
  onClose: () => void
}) {
  const partitions = useQuery({
    ...partitionsQuery(cluster, table ?? ""),
    enabled: table !== null,
  })
  const queryClient = useQueryClient()
  const [op, setOp] = useState<{
    row: PartitionRow
    kind: "detach" | "attach" | "drop"
  } | null>(null)

  const columns = useMemo(
    () => [
      col.accessor("partition", {
        header: "Partition",
        cell: (c) => <span className="font-mono">{c.getValue()}</span>,
      }),
      col.accessor("status", {
        header: "State",
        cell: (c) =>
          c.getValue() ? (
            <StatusPill tone="ok" label="Attached" />
          ) : (
            <StatusPill tone="muted" label="Detached" />
          ),
      }),
      col.accessor("rows", {
        header: "Rows",
        cell: (c) => (
          <span className="tabular-nums">{formatNumber(c.getValue())}</span>
        ),
      }),
      col.accessor("compressed", {
        header: "On disk",
        cell: (c) => (
          <span className="tabular-nums">{formatBytes(c.getValue())}</span>
        ),
      }),
      col.accessor("parts", {
        header: "Parts",
        cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
      }),
      col.accessor("max_time", {
        header: "Newest row",
        cell: (c) => formatDateTime(c.getValue()),
      }),
      col.accessor("disk_name", { header: "Disk" }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) =>
          canWrite && (
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  setOp({
                    row: c.row.original,
                    kind: c.row.original.status ? "detach" : "attach",
                  })
                }
              >
                {c.row.original.status ? "Detach" : "Attach"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive"
                onClick={() => setOp({ row: c.row.original, kind: "drop" })}
              >
                Drop
              </Button>
            </div>
          ),
      }),
    ],
    [canWrite]
  )

  const text = {
    detach:
      "The partition's data is moved aside on every node and stops showing in queries. You can attach it again later.",
    attach: "The detached data becomes visible in queries again on every node.",
    drop: "The partition's data is deleted on every node. This can't be undone.",
  }

  return (
    <Sheet open={table !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-4xl"
      >
        <SheetHeader>
          <SheetTitle>Partitions · {table}</SheetTitle>
          <SheetDescription>
            Totals over all shards (one replica of each).
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-4">
          {partitions.error && <ErrorState error={partitions.error} />}
          <DataTable
            columns={columns}
            data={partitions.data}
            loading={partitions.isPending}
            searchable
            emptyText="No partitions."
            getRowId={(p) => p.partition}
            dense
          />
        </div>
        <ConfirmDialog
          open={op !== null}
          onOpenChange={(o) => !o && setOp(null)}
          title={
            op
              ? `${op.kind[0].toUpperCase()}${op.kind.slice(1)} partition ${op.row.partition}?`
              : ""
          }
          description={op ? text[op.kind] : undefined}
          confirmLabel={
            op ? `${op.kind[0].toUpperCase()}${op.kind.slice(1)}` : "Confirm"
          }
          destructive={op?.kind !== "attach"}
          onConfirm={async () => {
            if (!op) return
            await operatePartition(cluster, op.row, op.kind)
            toast.success(`Partition ${op.row.partition}: ${op.kind} done`)
            await queryClient.invalidateQueries({
              queryKey: ["cluster", cluster],
            })
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
