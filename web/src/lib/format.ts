import { formatDistanceToNowStrict } from "date-fns"

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]

export function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
    return "—"
  let value = bytes
  let unit = 0
  while (Math.abs(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : value < 10 ? 2 : 1)} ${UNITS[unit]}`
}

const numberFormat = new Intl.NumberFormat()
export function formatNumber(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return numberFormat.format(n)
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
})

function toDate(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined || value === "") return null
  const d =
    typeof value === "number"
      ? new Date(value < 1e12 ? value * 1000 : value) // accept unix seconds
      : new Date(value)
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() <= 1) return null
  return d
}

export function formatDateTime(
  value: string | number | Date | null | undefined
) {
  const d = toDate(value)
  return d ? dateTimeFormat.format(d) : "—"
}

export function formatAgo(value: string | number | Date | null | undefined) {
  const d = toDate(value)
  return d ? `${formatDistanceToNowStrict(d)} ago` : "—"
}

export function formatMs(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

// "27.38 GiB/95.82 GiB" → 0.2857
export function usedFraction(pair: string) {
  const [used, total] = pair.split("/").map((p) => parseSize(p.trim()))
  if (!used || !total) return null
  return used / total
}

function parseSize(text: string) {
  const m = /^([\d.]+)\s*([KMGTP]?i?B)?$/i.exec(text)
  if (!m) return null
  const mult: Record<string, number> = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    PIB: 1024 ** 5,
  }
  return Number(m[1]) * (mult[(m[2] ?? "B").toUpperCase()] ?? 1)
}

// Expand "10.0.0.1, 10.0.0.2-5, 10.0.1.0/30" into a de-duplicated IP list.
export function expandHosts(text: string): { hosts: string[]; error?: string } {
  const out: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const item = raw.trim()
    if (!item) continue
    const range = /^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/.exec(item)
    const cidr = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(item)
    if (range) {
      const [, prefix, from, to] = range
      const a = Number(from)
      const b = Number(to)
      if (a > b || b > 255) return { hosts: [], error: `Bad range ${item}` }
      for (let i = a; i <= b; i++) out.push(`${prefix}${i}`)
    } else if (cidr) {
      const bits = Number(cidr[5])
      if (bits < 24 || bits > 32)
        return { hosts: [], error: `Use /24–/32 for ${item}` }
      const base =
        ((Number(cidr[1]) << 24) |
          (Number(cidr[2]) << 16) |
          (Number(cidr[3]) << 8) |
          Number(cidr[4])) >>>
        0
      const size = 2 ** (32 - bits)
      const start = base & ~(size - 1)
      for (let i = 0; i < size; i++) {
        const n = (start + i) >>> 0
        out.push(
          [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")
        )
      }
    } else if (
      /^\d+\.\d+\.\d+\.\d+$/.test(item) ||
      /^[a-zA-Z0-9.-]+$/.test(item)
    ) {
      out.push(item)
    } else {
      return { hosts: [], error: `Not an IP or host: ${item}` }
    }
  }
  return { hosts: [...new Set(out)] }
}
