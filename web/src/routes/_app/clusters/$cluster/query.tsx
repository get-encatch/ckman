import { useCallback, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { DownloadIcon, PlayIcon, Trash2Icon } from "lucide-react"

import { errorMessage } from "@/api/client"
import {
  deleteQueryHistory,
  explainQuery,
  queryHistoryQuery,
  runQuery,
  tableTreeQuery,
  type QueryResult,
} from "@/api/observability"
import { clusterQuery } from "@/api/queries"
import { type DataColumn, DataTable } from "@/components/app/data-table"
import { CodeBlock, ErrorState } from "@/components/app/misc"
import { PageBody } from "@/components/app/page-header"
import { SqlEditor } from "@/components/app/sql-editor"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/clusters/$cluster/query")({
  component: QueryPage,
})

const ANY_NODE = "__any__"

type Outcome = {
  sql: string
  ms: number
  result?: QueryResult
  explain?: string
  error?: string
}

function QueryPage() {
  const { cluster } = Route.useParams()
  const config = useQuery(clusterQuery(cluster))
  const tree = useQuery(tableTreeQuery(cluster))
  const history = useQuery(queryHistoryQuery(cluster))
  const queryClient = useQueryClient()
  const [sql, setSql] = useState("SELECT version(), hostName(), uptime()")
  const [node, setNode] = useState(ANY_NODE)
  const [running, setRunning] = useState(false)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [active, setActive] = useState(0)
  const [side, setSide] = useState<"tables" | "history">("tables")

  // CodeMirror completion schema: "db.table" -> columns
  const schema = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const [db, tables] of Object.entries(tree.data ?? {}))
      for (const [t, cols] of Object.entries(tables)) out[`${db}.${t}`] = cols
    return out
  }, [tree.data])

  const execute = useCallback(
    async (mode: "run" | "explain") => {
      // one request per statement, like the server expects
      const statements = sql
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (!statements.length) return
      setRunning(true)
      const results: Outcome[] = []
      for (const statement of statements) {
        const started = performance.now()
        try {
          if (mode === "explain") {
            const rows = await explainQuery(cluster, statement)
            results.push({
              sql: statement,
              ms: performance.now() - started,
              explain: rows
                .slice(1)
                .map((r) => String(r[0]))
                .join("\n"),
            })
          } else {
            const result = await runQuery(
              cluster,
              statement,
              node === ANY_NODE ? undefined : node
            )
            results.push({
              sql: statement,
              ms: performance.now() - started,
              result,
            })
          }
        } catch (err) {
          results.push({
            sql: statement,
            ms: performance.now() - started,
            error: errorMessage(err),
          })
          break
        }
      }
      setOutcomes(results)
      setActive(results.length - 1)
      setRunning(false)
      if (mode === "run")
        void queryClient.invalidateQueries({
          queryKey: ["cluster", cluster, "query-history"],
        })
    },
    [sql, node, cluster, queryClient]
  )

  const onRun = useCallback(() => void execute("run"), [execute])
  const hosts = config.data?.hosts ?? []
  const current = outcomes[active]

  return (
    <PageBody className="lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-64">
        <Tabs
          value={side}
          onValueChange={(v) => setSide(v as "tables" | "history")}
        >
          <TabsList className="w-full">
            <TabsTrigger value="tables">Tables</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="max-h-[70vh] overflow-auto rounded-lg border p-2 text-sm">
          {side === "tables" ? (
            tree.isPending ? (
              <Spinner />
            ) : (
              Object.entries(tree.data ?? {}).map(([db, tables]) => (
                <details
                  key={db}
                  open={db !== "default" || Object.keys(tables).length > 0}
                >
                  <summary className="cursor-pointer rounded px-1 py-0.5 font-medium hover:bg-muted">
                    {db}
                  </summary>
                  {Object.keys(tables).length === 0 && (
                    <p className="pl-4 text-xs text-muted-foreground">
                      No Distributed tables
                    </p>
                  )}
                  {Object.entries(tables).map(([t, cols]) => (
                    <details key={t} className="pl-3">
                      <summary className="cursor-pointer rounded px-1 py-0.5 hover:bg-muted">
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={(e) => {
                            e.preventDefault()
                            setSql(`SELECT *\nFROM ${db}.${t}\nLIMIT 100`)
                          }}
                        >
                          {t}
                        </button>
                      </summary>
                      <ul className="pl-4 text-xs text-muted-foreground">
                        {cols.map((c) => (
                          <li key={c} className="truncate py-0.5 font-mono">
                            {c}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </details>
              ))
            )
          ) : history.data?.length ? (
            <ul className="flex flex-col divide-y">
              {history.data.map((h) => (
                <li
                  key={h.CheckSum}
                  className="group flex items-start gap-1 py-1.5"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setSql(h.QuerySql)}
                  >
                    <code className="line-clamp-2 font-mono text-xs break-all">
                      {h.QuerySql}
                    </code>
                    <span className="text-xs text-muted-foreground">
                      {formatAgo(h.CreateTime)}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Delete from history"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={async () => {
                      await deleteQueryHistory(cluster, h.CheckSum).catch(
                        () => {}
                      )
                      await queryClient.invalidateQueries({
                        queryKey: ["cluster", cluster, "query-history"],
                      })
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-2 text-xs text-muted-foreground">
              Queries you run appear here.
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Only Distributed tables are listed. Results stop at 10,000 rows.
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <SqlEditor
          value={sql}
          onChange={setSql}
          onRun={onRun}
          schema={schema}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onRun} disabled={running}>
            {running ? <Spinner /> : <PlayIcon />} Run
          </Button>
          <Button
            variant="outline"
            onClick={() => void execute("explain")}
            disabled={running}
          >
            Explain
          </Button>
          <Select
            items={{
              [ANY_NODE]: "Any node",
              ...Object.fromEntries(hosts.map((h) => [h, h])),
            }}
            value={node}
            onValueChange={(v) => setNode(v as string)}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_NODE}>Any node</SelectItem>
              {hosts.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">
            Ctrl/⌘ + Enter to run · separate statements with ;
          </span>
        </div>

        {outcomes.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {outcomes.map((o, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActive(i)}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs",
                  i === active
                    ? "border-primary bg-primary/5"
                    : "text-muted-foreground",
                  o.error && "border-destructive/50 text-destructive"
                )}
              >
                Statement {i + 1}
              </button>
            ))}
          </div>
        )}
        {current && <ResultView outcome={current} />}
      </div>
    </PageBody>
  )
}

function ResultView({ outcome }: { outcome: Outcome }) {
  const header = useMemo(
    () => (outcome.result?.[0] ?? []) as string[],
    [outcome.result]
  )
  const rows = useMemo(() => (outcome.result ?? []).slice(1), [outcome.result])
  const columns = useMemo<DataColumn<unknown[]>[]>(
    () =>
      header.map((name, i) => ({
        id: `c${i}`,
        header: name,
        accessorFn: (row: unknown[]) => row[i],
        cell: (c: { getValue: () => unknown }) => <Cell value={c.getValue()} />,
      })),
    [header]
  )

  if (outcome.error) return <ErrorState error={new Error(outcome.error)} />
  if (outcome.explain !== undefined) return <CodeBlock code={outcome.explain} />

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="tabular-nums">
          {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"} ·{" "}
          {Math.round(outcome.ms)} ms
          {rows.length >= 10_000 && " · cut at 10,000 rows"}
        </span>
        {rows.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => downloadCsv(header, rows)}
          >
            <DownloadIcon /> CSV
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        data={rows}
        pageSize={50}
        dense
        emptyText="No rows."
      />
    </div>
  )
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">NULL</span>
  if (typeof value === "object")
    return <span className="font-mono text-xs">{JSON.stringify(value)}</span>
  return (
    <span className="font-mono text-xs whitespace-pre">{String(value)}</span>
  )
}

function downloadCsv(header: string[], rows: unknown[][]) {
  const esc = (v: unknown) => {
    const s =
      v === null || v === undefined
        ? ""
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n")
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }))
  const a = document.createElement("a")
  a.href = url
  a.download = "query-result.csv"
  a.click()
  URL.revokeObjectURL(url)
}
