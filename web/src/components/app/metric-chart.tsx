import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { METRIC_LABELS, metricQuery } from "@/api/observability"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
})
const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})
const valueFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
})

export function MetricChart({
  cluster,
  metric,
  start,
  end,
}: {
  cluster: string
  metric: string
  start: number
  end: number
}) {
  // about 120 points across the range, at least one per minute
  const step = Math.max(60, Math.floor((end - start) / 120))
  const series = useQuery(metricQuery(cluster, metric, start, end, step))
  const longRange = end - start > 36 * 3600

  const { rows, config, keys } = useMemo(() => {
    const byTs = new Map<number, Record<string, number>>()
    const keys: string[] = []
    const labels: string[] = []
    for (const s of series.data ?? []) {
      // CSS-safe series key; the host is the label
      const key = `s${keys.length}`
      keys.push(key)
      labels.push(s.metric.instance)
      for (const [ts, value] of s.values ?? []) {
        const row = byTs.get(ts) ?? { ts }
        row[key] = value
        byTs.set(ts, row)
      }
    }
    const config: ChartConfig = {}
    keys.forEach((k, i) => {
      config[k] = { label: labels[i], color: `var(--chart-${(i % 5) + 1})` }
    })
    return {
      rows: [...byTs.values()].sort((a, b) => a.ts - b.ts),
      config,
      keys,
    }
  }, [series.data])

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{METRIC_LABELS[metric] ?? metric}</h3>
      {series.isPending ? (
        <Skeleton className="h-44 w-full" />
      ) : series.error || rows.length === 0 ? (
        <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
          {series.error
            ? "Couldn't load this metric."
            : "No data in this range."}
        </div>
      ) : (
        <ChartContainer config={config} className="h-44 w-full">
          <LineChart data={rows} margin={{ left: 4, right: 8, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(ts: number) =>
                (longRange ? dayTimeFormat : timeFormat).format(
                  new Date(ts * 1000)
                )
              }
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              width={44}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => valueFormat.format(v)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const ts = payload?.[0]?.payload?.ts as number | undefined
                    return ts ? dayTimeFormat.format(new Date(ts * 1000)) : ""
                  }}
                />
              }
            />
            {keys.length > 1 && (
              <ChartLegend content={<ChartLegendContent />} />
            )}
            {keys.map((k) => (
              <Line
                key={k}
                dataKey={k}
                type="monotone"
                stroke={`var(--color-${k})`}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      )}
    </div>
  )
}
