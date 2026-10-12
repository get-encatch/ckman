import { useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"

import { errorMessage } from "@/api/client"
import type { Size } from "@/api/fleet"
import { unreplicatedTablesQuery, type NodeInfo } from "@/api/queries"
import { SizeGroup } from "@/components/app/fleet-placement"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { expandHosts } from "@/lib/format"

export function AddNodesDialog({
  open,
  onOpenChange,
  cluster,
  shardCount,
  isReplica,
  nodes,
  fleetMachines,
  sizeFor,
  onSubmit,
}: {
  // Docker clusters pick fleet machines instead of typing IPs, and size them
  fleetMachines?: { ip: string; label: string }[]
  sizeFor?: (shard: number) => Size // the starting size for a shard
  open: boolean
  onOpenChange: (open: boolean) => void
  cluster: string
  shardCount: number
  isReplica: boolean
  nodes: NodeInfo[]
  onSubmit: (
    body: {
      ips: string[]
      shard: number
      sourceSchemaHost: string
      size?: Size
    },
    force: boolean
  ) => Promise<void>
}) {
  const healthy = nodes.filter((n) => n.status === "green")
  const [shard, setShard] = useState(String(shardCount + 1))
  const [source, setSource] = useState<string | null>(healthy[0]?.ip ?? null)
  const [force, setForce] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const toForm = (z?: Size) => ({
    cpu: String(z?.cpu ?? ""),
    mem: String(z?.memory_mb ?? ""),
    disk: String(z?.disk_gb ?? ""),
  })
  const [size, setSize] = useState(() => toForm(sizeFor?.(Number(shard))))

  const newShard = Number(shard) === shardCount + 1
  const unreplicated = useQuery({
    ...unreplicatedTablesQuery(cluster),
    enabled: open && !newShard,
  })
  const notCopied = newShard ? [] : (unreplicated.data ?? [])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const { hosts, error: parseError } = fleetMachines
      ? { hosts: [...picked], error: undefined }
      : expandHosts(String(new FormData(e.currentTarget).get("ips")))
    if (parseError) return setError(parseError)
    if (hosts.length === 0) return setError("Enter at least one IP.")
    const existing = hosts.filter((h) => nodes.some((n) => n.ip === h))
    if (existing.length)
      return setError(`Already in the cluster: ${existing.join(", ")}`)
    if (!source)
      return setError("Pick a healthy node to copy the table definitions from.")
    if (!isReplica && hosts.length > 1)
      return setError(
        "This cluster has no replicas: add one node as a new shard."
      )
    setBusy(true)
    setError(null)
    try {
      await onSubmit(
        {
          ips: hosts,
          shard: Number(shard),
          sourceSchemaHost: source,
          size: sizeFor
            ? {
                cpu: Number(size.cpu) || 0,
                memory_mb: Number(size.mem) || 0,
                disk_gb: Number(size.disk) || 0,
              }
            : undefined,
        },
        force
      )
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add nodes to {cluster}</DialogTitle>
          <DialogDescription>
            ckman installs ClickHouse on the new servers over SSH and copies the
            table definitions to them. The servers need the same SSH access as
            the existing nodes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            {fleetMachines ? (
              <Field>
                <FieldLabel>Machines</FieldLabel>
                {fleetMachines.length === 0 ? (
                  <FieldDescription>
                    No free ready machines. Add one on the Machines page.
                  </FieldDescription>
                ) : (
                  <div className="flex max-h-48 flex-col gap-2 overflow-auto rounded-md border p-3">
                    {fleetMachines.map((m) => (
                      <Label
                        key={m.ip}
                        className="flex items-center gap-2 font-normal"
                      >
                        <Checkbox
                          checked={picked.has(m.ip)}
                          onCheckedChange={(v) =>
                            setPicked((s) => {
                              const n = new Set(s)
                              if (v === true) n.add(m.ip)
                              else n.delete(m.ip)
                              return n
                            })
                          }
                        />
                        {m.label}
                      </Label>
                    ))}
                  </div>
                )}
                <FieldDescription>
                  Each machine runs one container of this cluster.
                </FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="add-ips">Server IPs</FieldLabel>
                <Textarea
                  id="add-ips"
                  name="ips"
                  rows={2}
                  placeholder="10.51.40.15, 10.51.40.16"
                />
              </Field>
            )}
            <Field>
              <FieldLabel>Add as</FieldLabel>
              <Select
                items={{
                  ...Object.fromEntries(
                    Array.from(
                      { length: isReplica ? shardCount : 0 },
                      (_, i) => [String(i + 1), `Replicas of shard ${i + 1}`]
                    )
                  ),
                  [String(shardCount + 1)]: `A new shard (${shardCount + 1})`,
                }}
                value={shard}
                onValueChange={(v) => {
                  setShard(v as string)
                  if (sizeFor) setSize(toForm(sizeFor(Number(v))))
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isReplica &&
                    Array.from({ length: shardCount }, (_, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>
                        Replicas of shard {i + 1}
                      </SelectItem>
                    ))}
                  <SelectItem value={String(shardCount + 1)}>
                    A new shard ({shardCount + 1})
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                {newShard
                  ? "A new shard starts empty: new inserts spread to it, existing rows stay where they are until you rebalance."
                  : "Replicas copy the shard's replicated tables from their peers automatically."}
              </FieldDescription>
              {notCopied.length > 0 && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  {notCopied.length} table
                  {notCopied.length === 1 ? " isn't" : "s aren't"} replicated
                  and won't be copied:{" "}
                  <span className="font-mono">
                    {notCopied
                      .slice(0, 5)
                      .map((t) => `${t.database}.${t.table}`)
                      .join(", ")}
                    {notCopied.length > 5 ? ", …" : ""}
                  </span>
                  . The new replica gets empty copies of them.
                </p>
              )}
            </Field>
            {sizeFor && (
              <SizeGroup
                title="Each new server"
                cpu={size.cpu}
                mem={size.mem}
                disk={size.disk}
                onCpu={(v) => setSize((z) => ({ ...z, cpu: v }))}
                onMem={(v) => setSize((z) => ({ ...z, mem: v }))}
                onDisk={(v) => setSize((z) => ({ ...z, disk: v }))}
              />
            )}
            <Field>
              <FieldLabel>Copy table definitions from</FieldLabel>
              <Select
                items={Object.fromEntries(
                  healthy.map((n) => [n.ip, `${n.ip} (shard ${n.shardNumber})`])
                )}
                value={source}
                onValueChange={(v) => setSource(v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No healthy node" />
                </SelectTrigger>
                <SelectContent>
                  {healthy.map((n) => (
                    <SelectItem key={n.ip} value={n.ip}>
                      {n.ip} (shard {n.shardNumber})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={force}
                onCheckedChange={(v) => setForce(v === true)}
              />
              {fleetMachines
                ? "Allow overcommit (reserve more than a machine has)"
                : "Overwrite if ClickHouse already runs on a new server"}
            </Label>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Starting…" : "Add nodes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
