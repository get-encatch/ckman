import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlertIcon } from "lucide-react"

import {
  clusterQuery,
  unreplicatedTablesQuery,
  type Cluster,
} from "@/api/queries"
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

// Which engine a table uses is the user's choice: ckman only warns that plain
// MergeTree tables aren't copied to replicas.

const hasReplicas = (c: Cluster | undefined) =>
  (c?.shards ?? []).some((s) => (s.replicas?.length ?? 0) > 1)

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
        Review
      </Button>
    </div>
  )
}

// Replication tab: the tables that aren't replicated and where their rows are.
export function UnreplicatedSection({ cluster }: { cluster: string }) {
  const config = useQuery(clusterQuery(cluster))
  const tables = useQuery(unreplicatedTablesQuery(cluster))

  if (!tables.data?.length) return null
  return (
    <Section
      title="Not replicated"
      description={
        hasReplicas(config.data)
          ? "These MergeTree tables keep their rows on one server per shard; the other replicas hold empty copies. Use a Replicated engine for tables every replica should have."
          : "These MergeTree tables won't be copied to replicas you add later. Use a Replicated engine for tables every replica should have."
      }
    >
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Table</TableHead>
              <TableHead>Engine</TableHead>
              <TableHead>Rows per server</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tables.data.map((t) => (
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}
