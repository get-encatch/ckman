import { useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"

import { errorMessage } from "@/api/client"
import { unreplicatedTablesQuery, type NodeInfo } from "@/api/queries"
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
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cluster: string
  shardCount: number
  isReplica: boolean
  nodes: NodeInfo[]
  onSubmit: (
    body: { ips: string[]; shard: number; sourceSchemaHost: string },
    force: boolean
  ) => Promise<void>
}) {
  const healthy = nodes.filter((n) => n.status === "green")
  const [shard, setShard] = useState(String(shardCount + 1))
  const [source, setSource] = useState<string | null>(healthy[0]?.ip ?? null)
  const [force, setForce] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const newShard = Number(shard) === shardCount + 1
  const unreplicated = useQuery({
    ...unreplicatedTablesQuery(cluster),
    enabled: open && !newShard,
  })
  const notCopied = newShard ? [] : (unreplicated.data ?? [])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const { hosts, error: parseError } = expandHosts(
      String(new FormData(e.currentTarget).get("ips"))
    )
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
        { ips: hosts, shard: Number(shard), sourceSchemaHost: source },
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
            <Field>
              <FieldLabel htmlFor="add-ips">Server IPs</FieldLabel>
              <Textarea
                id="add-ips"
                name="ips"
                rows={2}
                placeholder="10.51.40.15, 10.51.40.16"
              />
            </Field>
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
                onValueChange={(v) => setShard(v as string)}
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
                  . The new replica gets empty copies. Convert them on Tables →
                  Replication (no restart) and the replica fills itself.
                </p>
              )}
            </Field>
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
              Overwrite if ClickHouse already runs on a new server
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
