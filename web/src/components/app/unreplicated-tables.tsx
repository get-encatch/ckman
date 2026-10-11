import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import {
  clusterQuery,
  convertToReplicated,
  unreplicatedTablesQuery,
  type Cluster,
  type UnreplicatedTable,
} from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Section } from "@/components/app/page-header"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatNumber } from "@/lib/format"

const hasReplicas = (c: Cluster | undefined) =>
  (c?.shards ?? []).some((s) => (s.replicas?.length ?? 0) > 1)

const hasKeeper = (c: Cluster | undefined) =>
  (c?.keeper === "clickhouse-keeper" &&
    (c.KeeperConf?.keeperNodes?.length ?? 0) > 0) ||
  (c?.zkNodes?.length ?? 0) > 0

// A shard where more than one replica has rows can't be converted safely:
// both copies would end up in the replicated table.
function blockedShard(t: UnreplicatedTable) {
  const withRows = new Map<number, number>()
  for (const h of t.hosts)
    if (h.rows > 0) withRows.set(h.shard, (withRows.get(h.shard) ?? 0) + 1)
  return [...withRows.entries()].find(([, n]) => n > 1)?.[0]
}

// Overview banner: only when replicas exist, because then these tables look
// protected but aren't.
export function UnreplicatedBanner({ cluster }: { cluster: string }) {
  const config = useQuery(clusterQuery(cluster))
  const tables = useQuery({
    ...unreplicatedTablesQuery(cluster),
    enabled: hasReplicas(config.data),
  })
  const n = tables.data?.length ?? 0
  if (!hasReplicas(config.data) || n === 0) return null
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium">
          {n} table{n === 1 ? " isn't" : "s aren't"} replicated
        </span>
        <span className="text-muted-foreground">
          Plain MergeTree keeps its rows on one server: the other replicas of
          the shard hold empty copies, and losing that server loses the data.
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        nativeButton={false}
        render={
          <Link
            to="/clusters/$cluster/tables"
            params={{ cluster }}
            search={{ view: "replication" }}
          />
        }
      >
        Review and convert
      </Button>
    </div>
  )
}

// Replication tab: the list, with a convert action per table.
export function UnreplicatedSection({
  cluster,
  canConvert,
}: {
  cluster: string
  canConvert: boolean
}) {
  const config = useQuery(clusterQuery(cluster))
  const tables = useQuery(unreplicatedTablesQuery(cluster))
  const queryClient = useQueryClient()
  const [converting, setConverting] = useState<UnreplicatedTable | null>(null)
  const keeper = hasKeeper(config.data)

  if (!tables.data?.length) return null
  return (
    <Section
      title="Not replicated"
      description={
        hasReplicas(config.data)
          ? "These MergeTree tables keep their rows on one server per shard; the other replicas hold empty copies. Converting makes every replica a full copy."
          : "These MergeTree tables won't be copied to replicas you add later. Converting now (no restart) means a new replica copies them automatically."
      }
    >
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Table</TableHead>
              <TableHead>Engine</TableHead>
              <TableHead>Rows per server</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tables.data.map((t) => {
              const blocked = blockedShard(t)
              return (
                <TableRow key={`${t.database}.${t.table}`}>
                  <TableCell className="font-mono">
                    {t.database}.{t.table}
                  </TableCell>
                  <TableCell>{t.engine}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.hosts
                      .map((h) => `${h.host}: ${formatNumber(h.rows)}`)
                      .join(" · ")}
                  </TableCell>
                  <TableCell className="text-right">
                    {canConvert && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!keeper || blocked !== undefined}
                        title={
                          !keeper
                            ? "The cluster has no Keeper or ZooKeeper"
                            : blocked !== undefined
                              ? `Shard ${blocked}: more than one replica has rows. Empty all but one first.`
                              : undefined
                        }
                        onClick={() => setConverting(t)}
                      >
                        Convert to replicated…
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog
        open={converting !== null}
        onOpenChange={(o) => !o && setConverting(null)}
        title={`Convert ${converting?.database}.${converting?.table} to Replicated${converting?.engine}?`}
        description={
          <>
            On each server ClickHouse detaches the table, attaches it as
            replicated and registers it in Keeper; no restart. The table is
            unavailable for about a second per server, so inserts at that moment
            fail and should be retried. The server holding the rows goes first;
            the other replicas then copy its data.
          </>
        }
        confirmLabel="Convert"
        onConfirm={async () => {
          if (!converting) return
          const res = await convertToReplicated(
            cluster,
            converting.database,
            converting.table
          )
          toast.success(
            `${converting.database}.${converting.table} is replicated on ${res.hosts.length} server(s)`
          )
          await queryClient.invalidateQueries({
            queryKey: ["cluster", cluster],
          })
        }}
      />
    </Section>
  )
}
