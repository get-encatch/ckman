import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  createFileRoute,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { errorMessage } from "@/api/client"
import {
  clusterConfigQuery,
  clusterStatusQuery,
  saveClusterConfig,
  type ClusterConfig,
} from "@/api/queries"
import { ErrorState } from "@/components/app/misc"
import { PageBody, Section } from "@/components/app/page-header"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

export const Route = createFileRoute("/_app/clusters/$cluster/settings")({
  component: SettingsPage,
})

type KeeperConf = {
  TcpPort: number
  RaftPort: number
  Coordination?: { OperationTimeoutMs: number; SessionTimeoutMs: number }
}

const AUTH_TYPES: Record<string, string> = {
  "2": "SSH key (ckman's conf/id_rsa)",
  "0": "Password, stored in ckman",
  "1": "Password, asked each time",
}

function SettingsPage() {
  const { cluster } = Route.useParams()
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const config = useQuery(clusterConfigQuery(cluster))
  const status = useQuery(clusterStatusQuery(cluster))
  const navigate = useNavigate()

  const [draft, setDraft] = useState<ClusterConfig | null>(null)
  const [expert, setExpert] = useState<[string, string][]>([])
  const [policy, setPolicy] = useState<"Rolling" | "Full">("Rolling")
  const [force, setForce] = useState(false)
  const [sshPassword, setSshPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // reset the form whenever fresh settings arrive
  const [loaded, setLoaded] = useState<typeof config.data>(undefined)
  if (config.data && config.data !== loaded) {
    setLoaded(config.data)
    setDraft(structuredClone(config.data.config))
    setExpert(Object.entries(config.data.config.Expert ?? {}))
  }

  if (config.error)
    return (
      <PageBody>
        <ErrorState error={config.error} />
      </PageBody>
    )
  if (config.data?.mode === "import")
    return (
      <PageBody>
        <p className="text-sm text-muted-foreground">
          Imported clusters can't be reconfigured from ckman.
        </p>
      </PageBody>
    )
  if (!draft)
    return (
      <PageBody>
        <Skeleton className="h-96 max-w-3xl" />
      </PageBody>
    )

  const set = <K extends keyof ClusterConfig>(
    key: K,
    value: ClusterConfig[K]
  ) => setDraft((d) => (d ? { ...d, [key]: value } : d))
  const keeper = draft.KeeperConf as KeeperConf | null | undefined
  const setKeeper = (patch: Partial<KeeperConf>) =>
    setDraft((d) =>
      d
        ? { ...d, KeeperConf: { ...(d.KeeperConf as KeeperConf), ...patch } }
        : d
    )
  const usesKeeper = draft.Keeper === "clickhouse-keeper" && keeper
  const disabled = !isAdmin

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const body: ClusterConfig = {
        ...draft,
        Expert: Object.fromEntries(
          expert.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])
        ),
      }
      const taskId = await saveClusterConfig(cluster, body, {
        force,
        policy,
        password: status.data?.needPassword ? sshPassword : undefined,
      })
      await navigate({ to: "/tasks/$taskId", params: { taskId } })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageBody className="max-w-3xl">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          Only admins can change settings.
        </p>
      )}

      <Section title="General">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="s-comment">Description</FieldLabel>
            <Input
              id="s-comment"
              disabled={disabled}
              value={draft.Comment ?? ""}
              onChange={(e) => set("Comment", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="s-port">Native port</FieldLabel>
              <Input
                id="s-port"
                type="number"
                disabled={disabled}
                value={draft.Port}
                onChange={(e) => set("Port", Number(e.target.value))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-http">HTTP port</FieldLabel>
              <Input
                id="s-http"
                type="number"
                disabled={disabled}
                value={draft.HttpPort}
                onChange={(e) => set("HttpPort", Number(e.target.value))}
              />
            </Field>
            <Field>
              <FieldLabel>ckman connects via</FieldLabel>
              <Select
                items={{ native: "Native protocol", http: "HTTP" }}
                disabled={disabled}
                value={draft.Protocol}
                onValueChange={(v) => set("Protocol", v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="native">Native protocol</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="s-password">
              Password of the "default" ClickHouse user
            </FieldLabel>
            <Input
              id="s-password"
              type="password"
              autoComplete="new-password"
              disabled={disabled}
              value={draft.Password}
              onFocus={(e) => e.target.select()}
              onChange={(e) => set("Password", e.target.value)}
            />
            <FieldDescription>
              Leave as is to keep the current password.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </Section>

      <Section
        title="SSH access"
        description="How ckman logs in to the nodes to install, restart and configure ClickHouse."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="s-sshuser">User</FieldLabel>
            <Input
              id="s-sshuser"
              disabled={disabled}
              value={draft.SshUser}
              onChange={(e) => set("SshUser", e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="s-sshport">Port</FieldLabel>
            <Input
              id="s-sshport"
              type="number"
              disabled={disabled}
              value={draft.SshPort}
              onChange={(e) => set("SshPort", Number(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel>Sign-in</FieldLabel>
            <Select
              items={AUTH_TYPES}
              disabled={disabled}
              value={String(draft.AuthenticateType)}
              onValueChange={(v) => set("AuthenticateType", Number(v))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(AUTH_TYPES).map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.AuthenticateType === 0 && (
            <Field className="sm:col-span-3">
              <FieldLabel htmlFor="s-sshpw">SSH password</FieldLabel>
              <Input
                id="s-sshpw"
                type="password"
                autoComplete="new-password"
                disabled={disabled}
                value={draft.SshPassword}
                onChange={(e) => set("SshPassword", e.target.value)}
              />
            </Field>
          )}
        </div>
      </Section>

      {usesKeeper && keeper && (
        <Section title="Keeper">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="s-ktcp">Client port</FieldLabel>
              <Input
                id="s-ktcp"
                type="number"
                disabled={disabled}
                value={keeper.TcpPort}
                onChange={(e) => setKeeper({ TcpPort: Number(e.target.value) })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-kraft">Raft port</FieldLabel>
              <Input
                id="s-kraft"
                type="number"
                disabled={disabled}
                value={keeper.RaftPort}
                onChange={(e) =>
                  setKeeper({ RaftPort: Number(e.target.value) })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-ksess">Session timeout (ms)</FieldLabel>
              <Input
                id="s-ksess"
                type="number"
                placeholder="30000 (default)"
                disabled={disabled}
                value={keeper.Coordination?.SessionTimeoutMs || ""}
                onChange={(e) =>
                  setKeeper({
                    Coordination: {
                      ...(keeper.Coordination ?? {
                        OperationTimeoutMs: 0,
                        SessionTimeoutMs: 0,
                      }),
                      SessionTimeoutMs: Number(e.target.value),
                    },
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-kop">Operation timeout (ms)</FieldLabel>
              <Input
                id="s-kop"
                type="number"
                placeholder="10000 (default)"
                disabled={disabled}
                value={keeper.Coordination?.OperationTimeoutMs || ""}
                onChange={(e) =>
                  setKeeper({
                    Coordination: {
                      ...(keeper.Coordination ?? {
                        OperationTimeoutMs: 0,
                        SessionTimeoutMs: 0,
                      }),
                      OperationTimeoutMs: Number(e.target.value),
                    },
                  })
                }
              />
            </Field>
          </div>
        </Section>
      )}

      <Section
        title="Extra server settings"
        description="Written into every node's config.xml. Keys are paths like merge_tree/parts_to_throw_insert or max_concurrent_queries."
      >
        <div className="flex flex-col gap-2">
          {expert.map(([k, v], i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label="Setting"
                placeholder="max_concurrent_queries"
                disabled={disabled}
                value={k}
                onChange={(e) =>
                  setExpert(
                    expert.map((row, j) =>
                      j === i ? [e.target.value, row[1]] : row
                    )
                  )
                }
                className="font-mono"
              />
              <Input
                aria-label="Value"
                placeholder="200"
                disabled={disabled}
                value={v}
                onChange={(e) =>
                  setExpert(
                    expert.map((row, j) =>
                      j === i ? [row[0], e.target.value] : row
                    )
                  )
                }
                className="font-mono"
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove"
                disabled={disabled}
                onClick={() => setExpert(expert.filter((_, j) => j !== i))}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={disabled}
            onClick={() => setExpert([...expert, ["", ""]])}
          >
            <PlusIcon /> Add setting
          </Button>
        </div>
      </Section>

      {isAdmin && (
        <Section title="Apply">
          <div className="flex flex-col gap-4 rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              Port, Keeper and extra-setting changes restart ClickHouse.
              Description and SSH changes only update ckman.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <Field className="w-60">
                <FieldLabel>Restart</FieldLabel>
                <Select
                  items={{
                    Rolling: "Rolling (one node at a time)",
                    Full: "Full (all at once)",
                  }}
                  value={policy}
                  onValueChange={(v) => setPolicy(v as "Rolling" | "Full")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Rolling">
                      Rolling (one node at a time)
                    </SelectItem>
                    <SelectItem value="Full">Full (all at once)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {status.data?.needPassword && (
                <Field className="w-56">
                  <FieldLabel htmlFor="s-apply-pw">SSH password</FieldLabel>
                  <Input
                    id="s-apply-pw"
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                  />
                </Field>
              )}
              <Label className="flex h-9 items-center gap-2 font-normal">
                <Checkbox
                  checked={force}
                  onCheckedChange={(v) => setForce(v === true)}
                />
                Rewrite configs and restart even if nothing changed
              </Label>
            </div>
            {error && <FieldError>{error}</FieldError>}
            <div className="flex gap-2">
              <Button onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Save settings"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (config.data) {
                    setDraft(structuredClone(config.data.config))
                    setExpert(Object.entries(config.data.config.Expert ?? {}))
                  }
                }}
              >
                Discard changes
              </Button>
            </div>
          </div>
        </Section>
      )}
    </PageBody>
  )
}
