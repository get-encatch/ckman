import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { RefreshCwIcon } from "lucide-react"

import { errorMessage } from "@/api/client"
import {
  clusterListQuery,
  deployCluster,
  packagesQuery,
  type DeployRequest,
} from "@/api/queries"
import { PageBody, PageHeader, Section } from "@/components/app/page-header"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
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
import { expandHosts } from "@/lib/format"

export const Route = createFileRoute("/_app/clusters/new-packages")({
  beforeLoad: ({ context }) => {
    if (context.session.policy !== "admin") throw redirect({ to: "/clusters" })
  },
  component: CreateClusterPage,
})

type Coordination = "keeper-standalone" | "keeper-internal" | "zookeeper"

function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

function CreateClusterPage() {
  const packages = useQuery(packagesQuery("all"))
  const existing = useQuery(clusterListQuery())
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [name, setName] = useState("")
  const [comment, setComment] = useState("")
  const [pkg, setPkg] = useState<string | null>(null)
  const [shards, setShards] = useState(2)
  const [replicas, setReplicas] = useState(2)
  const [ips, setIps] = useState<string[][]>([])
  const [coordination, setCoordination] =
    useState<Coordination>("keeper-standalone")
  const [keeperNodes, setKeeperNodes] = useState("")
  const [zkPort, setZkPort] = useState(2181)
  const [cwd, setCwd] = useState("/opt/clickhouse/")
  const [dataPath, setDataPath] = useState("/var/lib/")
  const [keeperPath, setKeeperPath] = useState("/var/lib/clickhouse-keeper/")
  const [chPassword, setChPassword] = useState(randomPassword)
  const [sshUser, setSshUser] = useState("root")
  const [sshAuth, setSshAuth] = useState("2")
  const [sshPassword, setSshPassword] = useState("")
  const [sshPort, setSshPort] = useState(22)
  const [port, setPort] = useState(9000)
  const [httpPort, setHttpPort] = useState(8123)
  const [keeperTcp, setKeeperTcp] = useState(9181)
  const [keeperRaft, setKeeperRaft] = useState(9234)
  const [force, setForce] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selectedPkg = packages.data?.find(
    (p) => `${p.pkgType}|${p.pkgName}` === pkg
  )
  const isTgz = selectedPkg?.pkgType.endsWith("tgz") ?? true
  const pkgItems = useMemo(
    () =>
      Object.fromEntries(
        (packages.data ?? []).map((p) => [
          `${p.pkgType}|${p.pkgName}`,
          `${p.version} (${p.pkgType})`,
        ])
      ),
    [packages.data]
  )

  const grid = Array.from({ length: shards }, (_, s) =>
    Array.from({ length: replicas }, (_, r) => ips[s]?.[r] ?? "")
  )
  const setIp = (s: number, r: number, value: string) =>
    setIps(() => {
      const next = grid.map((row) => [...row])
      next[s][r] = value.trim()
      return next
    })

  function fillFrom(text: string) {
    const { hosts } = expandHosts(text)
    setIps(
      Array.from({ length: shards }, (_, s) =>
        Array.from(
          { length: replicas },
          (_, r) => hosts[s * replicas + r] ?? ""
        )
      )
    )
  }

  async function submit() {
    setError(null)
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
      return setError("Name: start with a letter; letters, digits and _ only.")
    if (existing.data?.some((c) => c.cluster === name))
      return setError(`A cluster named ${name} already exists.`)
    if (!selectedPkg)
      return setError(
        "Choose a ClickHouse version. Upload one on the Packages page first."
      )
    const all = grid.flat()
    if (all.some((ip) => !ip))
      return setError("Fill in an IP for every replica.")
    if (new Set(all).size !== all.length)
      return setError("Each node needs its own IP.")
    const keeper = expandHosts(keeperNodes)
    if (keeper.error) return setError(keeper.error)
    if (coordination !== "keeper-internal" && keeper.hosts.length === 0)
      return setError(
        coordination === "zookeeper"
          ? "List the ZooKeeper nodes."
          : "List the Keeper nodes."
      )
    if (coordination === "keeper-internal" && isTgz)
      return setError(
        "Keeper inside ClickHouse needs rpm/deb packages. Use separate Keeper nodes with tgz."
      )
    for (const [label, path] of [
      ["Install folder", cwd],
      ["Data folder", dataPath],
      ["Keeper folder", keeperPath],
    ] as const)
      if (!/^\/.+\/$/.test(path))
        return setError(`${label} must start and end with /.`)
    if (keeperPath === "/" || keeperPath === "/var/lib/")
      return setError(
        "Use a dedicated Keeper folder: ckman empties it when (un)installing Keeper."
      )
    if (sshAuth !== "2" && !sshPassword)
      return setError("Enter the SSH password.")
    if (!chPassword)
      return setError("Set a password for the default ClickHouse user.")

    const body: DeployRequest = {
      Cluster: name,
      Comment: comment || undefined,
      PkgType: selectedPkg.pkgType,
      PkgName: selectedPkg.pkgName,
      Cwd: isTgz ? cwd : undefined,
      Shards: grid.map((row) => ({ Replicas: row.map((Ip) => ({ Ip })) })),
      Protocol: "native",
      Port: port,
      HttpPort: httpPort,
      Secure: false,
      Keeper: coordination === "zookeeper" ? "zookeeper" : "clickhouse-keeper",
      KeeperConf:
        coordination === "zookeeper"
          ? undefined
          : {
              Runtime:
                coordination === "keeper-internal" ? "internal" : "standalone",
              KeeperNodes:
                coordination === "keeper-standalone" ? keeper.hosts : undefined,
              TcpPort: keeperTcp,
              RaftPort: keeperRaft,
              Path: keeperPath,
              Coordination: {
                OperationTimeoutMs: 10000,
                SessionTimeoutMs: 30000,
                ForceSync: false,
              },
            },
      ZkNodes: coordination === "zookeeper" ? keeper.hosts : undefined,
      ZkPort: zkPort,
      Password: chPassword,
      EncryptType: 0,
      Path: dataPath,
      SshUser: sshUser,
      AuthenticateType: Number(sshAuth),
      SshPassword: sshAuth !== "2" ? sshPassword : undefined,
      SshPort: sshPort,
    }
    setBusy(true)
    try {
      const taskId = await deployCluster(body, force)
      await queryClient.invalidateQueries({ queryKey: ["clusters"] })
      await navigate({ to: "/tasks/$taskId", params: { taskId } })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const keeperCount = expandHosts(keeperNodes).hosts.length

  return (
    <>
      <PageHeader
        title="Create cluster with packages"
        description="ckman installs ClickHouse packages directly on servers over SSH. For new clusters, prefer running them as containers on fleet machines."
      />
      <PageBody className="max-w-3xl">
        <Section title="Basics">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="c-name">Cluster name</FieldLabel>
                <Input
                  id="c-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="analytics"
                />
                <FieldDescription>
                  Used in ON CLUSTER and Distributed tables.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>ClickHouse version</FieldLabel>
                <Select
                  items={pkgItems}
                  value={pkg}
                  onValueChange={(v) => setPkg(v as string)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        packages.data?.length === 0
                          ? "No packages uploaded"
                          : "Choose a version"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(packages.data ?? []).map((p) => (
                      <SelectItem
                        key={`${p.pkgType}|${p.pkgName}`}
                        value={`${p.pkgType}|${p.pkgName}`}
                      >
                        {p.version} ({p.pkgType})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Missing one?{" "}
                  <Link to="/packages" className="underline underline-offset-2">
                    Upload packages
                  </Link>
                  .
                </FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="c-comment">
                Description (optional)
              </FieldLabel>
              <Input
                id="c-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>
          </FieldGroup>
        </Section>

        <Section
          title="Shards and replicas"
          description="Shards split the data; replicas keep copies of each shard on other servers."
        >
          <div className="flex flex-wrap items-end gap-4">
            <Field className="w-28">
              <FieldLabel htmlFor="c-shards">Shards</FieldLabel>
              <Input
                id="c-shards"
                type="number"
                min={1}
                max={64}
                value={shards}
                onChange={(e) =>
                  setShards(
                    Math.min(64, Math.max(1, Number(e.target.value) || 1))
                  )
                }
              />
            </Field>
            <Field className="w-28">
              <FieldLabel htmlFor="c-replicas">Replicas each</FieldLabel>
              <Input
                id="c-replicas"
                type="number"
                min={1}
                max={8}
                value={replicas}
                onChange={(e) =>
                  setReplicas(
                    Math.min(8, Math.max(1, Number(e.target.value) || 1))
                  )
                }
              />
            </Field>
            <Field className="min-w-60 flex-1">
              <FieldLabel htmlFor="c-paste">
                Fill from a list (optional)
              </FieldLabel>
              <Input
                id="c-paste"
                placeholder="10.51.40.11-14"
                onBlur={(e) => e.target.value && fillFrom(e.target.value)}
              />
            </Field>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Shard</th>
                  {Array.from({ length: replicas }, (_, r) => (
                    <th key={r} className="px-3 py-2">
                      Replica {r + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {grid.map((row, s) => (
                  <tr key={s}>
                    <td className="px-3 py-2 font-medium">{s + 1}</td>
                    {row.map((ip, r) => (
                      <td key={r} className="px-2 py-1.5">
                        <Input
                          aria-label={`Shard ${s + 1} replica ${r + 1} IP`}
                          value={ip}
                          onChange={(e) => setIp(s, r, e.target.value)}
                          placeholder="IP address"
                          className="min-w-32 font-mono"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="Coordination"
          description="Replication and ON CLUSTER statements need Keeper (or ZooKeeper)."
        >
          <RadioGroup
            value={coordination}
            onValueChange={(v) => setCoordination(v as Coordination)}
            className="gap-3"
          >
            <Label className="flex items-start gap-2 font-normal">
              <RadioGroupItem value="keeper-standalone" className="mt-0.5" />
              <span>
                ClickHouse Keeper on its own servers (recommended)
                <span className="block text-xs text-muted-foreground">
                  Use 3 small servers so Keeper survives one failure.
                </span>
              </span>
            </Label>
            <Label className="flex items-start gap-2 font-normal">
              <RadioGroupItem
                value="keeper-internal"
                className="mt-0.5"
                disabled={isTgz}
              />
              <span className={isTgz ? "text-muted-foreground" : undefined}>
                ClickHouse Keeper inside the ClickHouse servers
                <span className="block text-xs text-muted-foreground">
                  Fewer servers; needs rpm/deb packages.
                </span>
              </span>
            </Label>
            <Label className="flex items-start gap-2 font-normal">
              <RadioGroupItem value="zookeeper" className="mt-0.5" />
              <span>
                An existing ZooKeeper ensemble
                <span className="block text-xs text-muted-foreground">
                  ckman doesn't install ZooKeeper.
                </span>
              </span>
            </Label>
          </RadioGroup>
          {coordination !== "keeper-internal" && (
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field>
                <FieldLabel htmlFor="c-keeper">
                  {coordination === "zookeeper"
                    ? "ZooKeeper nodes"
                    : "Keeper servers"}
                </FieldLabel>
                <Input
                  id="c-keeper"
                  value={keeperNodes}
                  onChange={(e) => setKeeperNodes(e.target.value)}
                  placeholder="10.51.40.21-23"
                  className="font-mono"
                />
                {coordination === "keeper-standalone" &&
                  keeperCount > 0 &&
                  keeperCount % 2 === 0 && (
                    <FieldDescription className="text-amber-700 dark:text-amber-400">
                      Use an odd number ({keeperCount + 1}): {keeperCount}{" "}
                      Keeper servers tolerate no more failures than{" "}
                      {keeperCount - 1}.
                    </FieldDescription>
                  )}
              </Field>
              {coordination === "zookeeper" && (
                <Field>
                  <FieldLabel htmlFor="c-zkport">Port</FieldLabel>
                  <Input
                    id="c-zkport"
                    type="number"
                    value={zkPort}
                    onChange={(e) => setZkPort(Number(e.target.value))}
                  />
                </Field>
              )}
            </div>
          )}
        </Section>

        <Section
          title="Access"
          description="ckman needs SSH as root or a sudo user on every server."
        >
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="c-sshuser">SSH user</FieldLabel>
                <Input
                  id="c-sshuser"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Sign in with</FieldLabel>
                <Select
                  items={{
                    "2": "SSH key",
                    "0": "Password (stored)",
                    "1": "Password (asked each time)",
                  }}
                  value={sshAuth}
                  onValueChange={(v) => setSshAuth(v as string)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">SSH key</SelectItem>
                    <SelectItem value="0">Password (stored)</SelectItem>
                    <SelectItem value="1">
                      Password (asked each time)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="c-sshport">SSH port</FieldLabel>
                <Input
                  id="c-sshport"
                  type="number"
                  value={sshPort}
                  onChange={(e) => setSshPort(Number(e.target.value))}
                />
              </Field>
            </div>
            {sshAuth === "2" ? (
              <FieldDescription>
                ckman uses the private key in its conf/id_rsa file. Add the
                matching public key to the SSH user's authorized_keys on every
                server.
              </FieldDescription>
            ) : (
              <Field>
                <FieldLabel htmlFor="c-sshpw">SSH password</FieldLabel>
                <Input
                  id="c-sshpw"
                  type="password"
                  autoComplete="new-password"
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="c-chpw">
                Password for ClickHouse's "default" user
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="c-chpw"
                  value={chPassword}
                  onChange={(e) => setChPassword(e.target.value)}
                  autoComplete="off"
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Generate another"
                  onClick={() => setChPassword(randomPassword())}
                >
                  <RefreshCwIcon />
                </Button>
              </div>
              <FieldDescription>
                Save it somewhere safe; you'll need it to connect your apps.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </Section>

        <Collapsible>
          <CollapsibleTrigger
            render={<Button variant="ghost" size="sm" className="-ml-2" />}
          >
            Folders and ports
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="grid gap-4 sm:grid-cols-2">
              {isTgz && (
                <Field>
                  <FieldLabel htmlFor="c-cwd">Install folder</FieldLabel>
                  <Input
                    id="c-cwd"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    className="font-mono"
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="c-data">Data folder</FieldLabel>
                <Input
                  id="c-data"
                  value={dataPath}
                  onChange={(e) => setDataPath(e.target.value)}
                  className="font-mono"
                />
                <FieldDescription>
                  Data goes in a "clickhouse" folder inside it.
                </FieldDescription>
              </Field>
              {coordination !== "zookeeper" && (
                <Field>
                  <FieldLabel htmlFor="c-kpath">Keeper folder</FieldLabel>
                  <Input
                    id="c-kpath"
                    value={keeperPath}
                    onChange={(e) => setKeeperPath(e.target.value)}
                    className="font-mono"
                  />
                  <FieldDescription>
                    Must already exist on every server. Use a folder only Keeper
                    uses.
                  </FieldDescription>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="c-port">Native port</FieldLabel>
                <Input
                  id="c-port"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="c-http">HTTP port</FieldLabel>
                <Input
                  id="c-http"
                  type="number"
                  value={httpPort}
                  onChange={(e) => setHttpPort(Number(e.target.value))}
                />
              </Field>
              {coordination !== "zookeeper" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="c-ktcp">Keeper client port</FieldLabel>
                    <Input
                      id="c-ktcp"
                      type="number"
                      value={keeperTcp}
                      onChange={(e) => setKeeperTcp(Number(e.target.value))}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="c-kraft">Keeper raft port</FieldLabel>
                    <Input
                      id="c-kraft"
                      type="number"
                      value={keeperRaft}
                      onChange={(e) => setKeeperRaft(Number(e.target.value))}
                    />
                  </Field>
                </>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex flex-col gap-3 border-t pt-6">
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={force}
              onCheckedChange={(v) => setForce(v === true)}
            />
            Overwrite servers that already run ClickHouse
          </Label>
          {error && <FieldError>{error}</FieldError>}
          <div className="flex gap-2">
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? "Checking servers…" : "Create cluster"}
            </Button>
            <Button
              variant="outline"
              render={<Link to="/clusters" />}
              nativeButton={false}
            >
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            ckman first checks SSH access, folders and CPU architecture on every
            server, then installs in the background. You'll see the progress
            next.
          </p>
        </div>
      </PageBody>
    </>
  )
}
