import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  createFileRoute,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import { ArrowRightIcon } from "lucide-react"

import {
  rebalanceExecute,
  rebalanceInfo,
  rebalancePlan,
  type RebalanceInfo,
  type RebalancePlan,
  type RebalanceRequest,
} from "@/api/data-manage"
import { tableTreeQuery } from "@/api/observability"
import { clusterQuery } from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { ErrorState } from "@/components/app/misc"
import { PageBody, Section } from "@/components/app/page-header"
import { StatusPill } from "@/components/app/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { formatBytes, formatNumber } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/$cluster/rebalance")({
  component: RebalancePage,
})

function RebalancePage() {
  const { cluster } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const config = useQuery(clusterQuery(cluster))
  const tree = useQuery(tableTreeQuery(cluster))
  const navigate = useNavigate()

  const [database, setDatabase] = useState<string | null>(null)
  const [pattern, setPattern] = useState(".*")
  const [strategy, setStrategy] = useState<"partition" | "shardingkey">(
    "partition"
  )
  const [shardingKey, setShardingKey] = useState("")
  const [drainLast, setDrainLast] = useState(false)
  const [busy, setBusy] = useState<"info" | "plan" | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [info, setInfo] = useState<RebalanceInfo[] | null>(null)
  const [plan, setPlan] = useState<RebalancePlan | null>(null)
  const [confirm, setConfirm] = useState(false)

  const shardCount = config.data?.shards?.length ?? 0

  function request(): RebalanceRequest | null {
    if (!database) {
      setError(new Error("Choose a database."))
      return null
    }
    return {
      tables: [
        {
          database,
          table: pattern || ".*",
          policy: strategy,
          shardingKey: strategy === "shardingkey" ? shardingKey : undefined,
        },
      ],
      except_max_shard: drainLast,
    }
  }

  async function check() {
    const body = request()
    if (!body) return
    setBusy("info")
    setError(null)
    setPlan(null)
    try {
      setInfo((await rebalanceInfo(cluster, body)) ?? [])
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  async function preview() {
    const body = request()
    if (!body) return
    if (strategy === "shardingkey" && !shardingKey)
      return setError(new Error("Enter the sharding key column."))
    setBusy("plan")
    setError(null)
    try {
      setPlan(await rebalancePlan(cluster, body))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  const planTables = plan?.tables ?? []
  const hasWork =
    !!plan?.except_shard_drain ||
    planTables.some((t) => (t.moves?.length ?? 0) > 0 || t.reshuffle)

  return (
    <PageBody className="max-w-5xl">
      <Section
        title="Rebalance data across shards"
        description="ClickHouse never moves existing rows by itself. After adding a shard, or when one shard holds much more than the others, this moves data so each shard carries a similar share."
      >
        {shardCount < 2 && (
          <ErrorState
            error={
              new Error(
                "This cluster has a single shard, so there is nothing to balance."
              )
            }
          />
        )}
        <FieldGroup className="rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Database</FieldLabel>
              <Select
                value={database}
                onValueChange={(v) => setDatabase(v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a database" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(tree.data ?? {}).map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="rb-pattern">Local tables (regex)</FieldLabel>
              <Input
                id="rb-pattern"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                className="font-mono"
              />
              <FieldDescription>
                Tables under a Distributed table, e.g. ^events_local$ or .* for
                all.
              </FieldDescription>
            </Field>
          </div>
          <FieldSet>
            <FieldLegend variant="label">How to move data</FieldLegend>
            <RadioGroup
              value={strategy}
              onValueChange={(v) =>
                setStrategy(v as "partition" | "shardingkey")
              }
              className="gap-3"
            >
              <Label className="flex items-start gap-2 font-normal">
                <RadioGroupItem value="partition" className="mt-0.5" />
                <span>
                  Move whole partitions
                  <span className="block text-xs text-muted-foreground">
                    Fast and cheap. Needs several partitions per table; rows of
                    one partition stay together.
                  </span>
                </span>
              </Label>
              <Label className="flex items-start gap-2 font-normal">
                <RadioGroupItem value="shardingkey" className="mt-0.5" />
                <span>
                  Re-shard every row by its sharding key
                  <span className="block text-xs text-muted-foreground">
                    Exact balance and keeps the "same key → same shard" rule,
                    but copies all data through a temporary table. Needs free
                    disk for a full copy.
                  </span>
                </span>
              </Label>
            </RadioGroup>
            {strategy === "shardingkey" && (
              <Input
                placeholder="Sharding key column, e.g. user_id"
                value={shardingKey}
                onChange={(e) => setShardingKey(e.target.value)}
                className="max-w-sm font-mono"
              />
            )}
          </FieldSet>
          <Label className="flex items-start gap-2 font-normal">
            <Checkbox
              checked={drainLast}
              onCheckedChange={(v) => setDrainLast(v === true)}
              className="mt-0.5"
            />
            <span>
              Empty the last shard first
              <span className="block text-xs text-muted-foreground">
                Use before removing shard {shardCount}: its data moves to the
                other shards.
              </span>
            </span>
          </Label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void check()}
              disabled={busy !== null}
            >
              {busy === "info" && <Spinner />} Check balance
            </Button>
            {isAdmin && (
              <Button
                onClick={() => void preview()}
                disabled={busy !== null || shardCount < 2}
              >
                {busy === "plan" && <Spinner />} Preview moves
              </Button>
            )}
          </div>
          {error !== null && <ErrorState error={error} />}
        </FieldGroup>
      </Section>

      {info && (
        <Section title="Current balance">
          {info.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No matching tables with a Distributed table on top.
            </p>
          )}
          {info.map((t) => {
            const pct = t.imbalance_ratio * 100
            return (
              <div
                key={`${t.database}.${t.table}`}
                className="flex flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {t.database}.{t.table}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {t.engine}
                    </span>
                  </span>
                  <StatusPill
                    tone={pct < 5 ? "ok" : pct < 20 ? "warn" : "bad"}
                    label={`${pct.toFixed(1)}% above average on the fullest shard`}
                  />
                </div>
                {t.warnings?.map((w, i) => (
                  <p
                    key={i}
                    className="text-xs text-amber-700 dark:text-amber-400"
                  >
                    {w.EN}
                  </p>
                ))}
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1">Shard</th>
                      <th>Node</th>
                      <th className="text-right">Rows</th>
                      <th className="text-right">On disk</th>
                      <th className="text-right">Partitions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.shards.map((s) => (
                      <tr key={s.shard_num} className="border-t">
                        <td className="py-1.5">{s.shard_num}</td>
                        <td className="font-mono">{s.host}</td>
                        <td className="text-right tabular-nums">
                          {formatNumber(s.rows)}
                        </td>
                        <td className="text-right tabular-nums">
                          {formatBytes(s.compressed_bytes)}
                        </td>
                        <td className="text-right tabular-nums">
                          {s.partition_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </Section>
      )}

      {plan && (
        <Section
          title="Planned moves"
          actions={
            hasWork && (
              <Button onClick={() => setConfirm(true)}>Run rebalance</Button>
            )
          }
        >
          {plan.except_shard_drain && (
            <p className="text-sm">
              First, all data on{" "}
              <span className="font-mono">
                {plan.except_shard_drain.src_host}
              </span>{" "}
              moves to{" "}
              <span className="font-mono">
                {plan.except_shard_drain.dst_host}
              </span>
              .
            </p>
          )}
          {!hasWork && (
            <p className="text-sm text-muted-foreground">
              Already balanced: nothing to move.
            </p>
          )}
          {planTables.map((t) => (
            <div
              key={`${t.database}.${t.table}`}
              className="flex flex-col gap-2 rounded-lg border p-4 text-sm"
            >
              <span className="font-medium">
                {t.database}.{t.table}
              </span>
              {t.warnings?.map((w, i) => (
                <p
                  key={i}
                  className="text-xs text-amber-700 dark:text-amber-400"
                >
                  {w.EN}
                </p>
              ))}
              {t.reshuffle && (
                <p>
                  Re-shard {formatNumber(t.reshuffle.total_rows)} rows by{" "}
                  <span className="font-mono">{t.reshuffle.sharding_key}</span>{" "}
                  across {t.reshuffle.shards} shards. Needs about{" "}
                  {formatBytes(t.reshuffle.compressed_bytes)} of free disk for
                  the temporary copy.
                </p>
              )}
              {t.moves && t.moves.length > 0 && (
                <>
                  <p className="text-muted-foreground">
                    {t.moves.length} partition(s),{" "}
                    {formatBytes(t.moves.reduce((n, m) => n + m.bytes, 0))} in
                    total
                  </p>
                  <ul className="flex flex-col gap-1">
                    {t.moves.map((m) => (
                      <li
                        key={`${m.partition}-${m.src_host}`}
                        className="flex flex-wrap items-center gap-2 font-mono text-xs"
                      >
                        <span className="font-medium">{m.partition}</span>
                        <span>{m.src_host}</span>
                        <ArrowRightIcon className="size-3" />
                        <span>{m.dst_host}</span>
                        <span className="text-muted-foreground">
                          {formatBytes(m.bytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!t.reshuffle && !t.moves?.length && (
                <p className="text-muted-foreground">
                  No moves for this table.
                </p>
              )}
            </div>
          ))}
        </Section>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run this rebalance?"
        description="Data moves between shards while the cluster keeps serving. Queries may briefly see a moving partition twice or not at all, so run it at a quiet time. You can stop it from the task page between steps."
        confirmLabel="Run rebalance"
        onConfirm={async () => {
          const body = request()
          if (!body) return
          const taskId = await rebalanceExecute(cluster, body)
          if (taskId)
            await navigate({ to: "/tasks/$taskId", params: { taskId } })
        }}
      />
    </PageBody>
  )
}
