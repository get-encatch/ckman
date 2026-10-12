import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import { backupSettingsQuery, saveBackupSettings } from "@/api/data-manage"
import { machinesQuery } from "@/api/fleet"
import { clusterQuery } from "@/api/queries"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const ANY = "__any__"

// BackupSource: which replicas this cluster's backups read. Each shard is
// read from a replica that isn't read-only, preferring this zone if set,
// then the least lagging and least busy. Only for clusters on fleet machines
// spread over zones.
export function BackupSource({
  cluster,
  canWrite,
}: {
  cluster: string
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const config = useQuery(clusterQuery(cluster))
  const machines = useQuery(machinesQuery())
  const settings = useQuery(backupSettingsQuery(cluster))
  const hosts = new Set(config.data?.hosts ?? [])
  const zones = [
    ...new Set(
      (machines.data ?? [])
        .filter((m) => hosts.has(m.ip) && m.zone)
        .map((m) => m.zone)
    ),
  ].sort()
  if (!config.data?.docker || (zones.length < 2 && !settings.data?.zone))
    return null
  const current = settings.data?.zone || ANY
  const items: Record<string, string> = {
    [ANY]: "Any replica (healthiest, least busy)",
    ...Object.fromEntries(zones.map((z) => [z, `Prefer replicas in ${z}`])),
  }

  async function save(v: string) {
    try {
      await saveBackupSettings(cluster, v === ANY ? "" : v)
      await queryClient.invalidateQueries({
        queryKey: ["cluster", cluster, "backup-settings"],
      })
      toast.success("Saved; the next backups read from there")
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="font-medium">Read backups from</span>
      <Select
        items={items}
        value={current}
        disabled={!canWrite}
        onValueChange={(v) => void save(v as string)}
      >
        <SelectTrigger className="w-72" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([k, label]) => (
            <SelectItem key={k} value={k}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">
        Read-only replicas are never used; a table that isn&apos;t replicated is
        read from the replica holding its rows.
      </span>
    </div>
  )
}
