import { useMemo, useState, type FormEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { CheckCircle2Icon, MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  bucketProblem,
  bucketsQuery,
  connectionsQuery,
  createBucket,
  createConnection,
  deleteConnection,
  testConnection,
  updateConnection,
  type ConnectionInput,
  type StorageConnection,
} from "@/api/storage"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState } from "@/components/app/misc"
import { PageBody, PageHeader } from "@/components/app/page-header"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { formatAgo } from "@/lib/format"

export const Route = createFileRoute("/_app/storage")({
  beforeLoad: ({ context }) => {
    if (context.session.policy !== "admin") throw redirect({ to: "/clusters" })
  },
  component: StoragePage,
})

const col = columnHelper<StorageConnection>()

function StoragePage() {
  const connections = useQuery(connectionsQuery())
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<StorageConnection | "new" | null>(null)
  const [bucketsOf, setBucketsOf] = useState<StorageConnection | null>(null)
  const [removing, setRemoving] = useState<StorageConnection | null>(null)

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Name",
        cell: (c) => (
          <button
            type="button"
            className="font-medium hover:underline"
            onClick={() => setBucketsOf(c.row.original)}
          >
            {c.getValue()}
          </button>
        ),
      }),
      col.accessor((c) => c.s3.Endpoint, {
        id: "endpoint",
        header: "Endpoint",
        cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
      }),
      col.accessor((c) => c.s3.Region, {
        id: "region",
        header: "Region",
        cell: (c) => c.getValue() || "—",
      }),
      col.accessor((c) => c.s3.AccessKeyID, {
        id: "key",
        header: "Access key",
        enableSorting: false,
        cell: (c) => (
          <span className="font-mono text-xs">{maskKey(c.getValue())}</span>
        ),
      }),
      col.accessor("update_time", {
        header: "Updated",
        cell: (c) => formatAgo(c.getValue()),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) => (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${c.row.original.name}`}
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setBucketsOf(c.row.original)}>
                  Buckets
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setEditing(c.row.original)}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setRemoving(c.row.original)}
                >
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      }),
    ],
    []
  )

  return (
    <>
      <PageHeader
        title="Storage"
        description="S3 connections that backups can use. Keys are stored encrypted and never shown again."
        actions={
          <Button onClick={() => setEditing("new")}>
            <PlusIcon /> Add connection
          </Button>
        }
      />
      <PageBody>
        {connections.error && <ErrorState error={connections.error} />}
        <DataTable
          columns={columns}
          data={connections.data}
          loading={connections.isPending}
          emptyText="No connections yet. Add one for AWS S3, MinIO, RustFS or any S3-compatible store."
          getRowId={(c) => c.connection_id}
        />
      </PageBody>
      <ConnectionDialog
        connection={editing}
        onClose={() => setEditing(null)}
        onSaved={() =>
          queryClient.invalidateQueries({ queryKey: ["storage-connections"] })
        }
      />
      <BucketsSheet connection={bucketsOf} onClose={() => setBucketsOf(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete connection ${removing?.name}?`}
        description="Only ckman's saved settings are deleted; buckets and backups in the store are not touched. A connection that backups still use can't be deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!removing) return
          await deleteConnection(removing.connection_id)
          toast.success(`Deleted ${removing.name}`)
          await queryClient.invalidateQueries({
            queryKey: ["storage-connections"],
          })
        }}
      />
    </>
  )
}

function maskKey(key: string) {
  return key.length <= 4 ? "••••" : `${key.slice(0, 4)}••••`
}

function ConnectionDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: StorageConnection | "new" | null
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const existing =
    connection !== null && connection !== "new" ? connection : null
  const [form, setForm] = useState<ConnectionInput>(emptyInput())
  const [tested, setTested] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"test" | "save" | null>(null)
  const [last, setLast] = useState(connection)
  if (connection !== last) {
    setLast(connection)
    setTested(null)
    setError(null)
    setForm(
      existing
        ? {
            name: existing.name,
            s3: {
              Endpoint: existing.s3.Endpoint,
              AccessKeyID: "",
              SecretAccessKey: "",
              Region: existing.s3.Region,
              InsecureSkipVerify: existing.s3.InsecureSkipVerify,
            },
          }
        : emptyInput()
    )
  }

  const set = (patch: Partial<ConnectionInput["s3"]>) => {
    setTested(null)
    setForm((f) => ({ ...f, s3: { ...f.s3, ...patch } }))
  }

  async function test() {
    setBusy("test")
    setError(null)
    try {
      const res = await testConnection({
        ...form,
        connection_id: existing?.connection_id,
      })
      setTested(res.buckets ?? [])
    } catch (err) {
      setTested(null)
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy("save")
    setError(null)
    try {
      if (existing) await updateConnection(existing.connection_id, form)
      else await createConnection(form)
      toast.success(`Saved ${form.name}`)
      await onSaved()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={connection !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.name}` : "Add S3 connection"}
          </DialogTitle>
          <DialogDescription>
            ckman checks the connection before saving by listing its buckets.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sc-name">Name</FieldLabel>
              <Input
                id="sc-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="aws-mumbai, minio-lab…"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sc-endpoint">Endpoint</FieldLabel>
              <Input
                id="sc-endpoint"
                value={form.s3.Endpoint}
                onChange={(e) => set({ Endpoint: e.target.value })}
                placeholder="https://s3.ap-south-1.amazonaws.com"
                className="font-mono"
                required
              />
              <FieldDescription>
                Without a bucket name. http:// for local MinIO-style stores.
              </FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sc-ak">Access key ID</FieldLabel>
                <Input
                  id="sc-ak"
                  value={form.s3.AccessKeyID}
                  onChange={(e) => set({ AccessKeyID: e.target.value })}
                  placeholder={existing ? "Unchanged" : undefined}
                  autoComplete="off"
                  required={!existing}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sc-sk">Secret access key</FieldLabel>
                <Input
                  id="sc-sk"
                  type="password"
                  value={form.s3.SecretAccessKey}
                  onChange={(e) => set({ SecretAccessKey: e.target.value })}
                  placeholder={existing ? "Unchanged" : undefined}
                  autoComplete="new-password"
                  required={!existing}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sc-region">Region</FieldLabel>
                <Input
                  id="sc-region"
                  value={form.s3.Region}
                  onChange={(e) => set({ Region: e.target.value })}
                  placeholder="us-east-1"
                />
              </Field>
              <Label className="flex items-center gap-2 self-end pb-2 font-normal">
                <Checkbox
                  checked={!!form.s3.InsecureSkipVerify}
                  onCheckedChange={(v) =>
                    set({ InsecureSkipVerify: v === true })
                  }
                />
                Skip TLS certificate check
              </Label>
            </div>
            {tested && (
              <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2Icon className="size-4" />
                Connected. {tested.length} bucket
                {tested.length === 1 ? "" : "s"} visible.
              </p>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6 sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => void test()}
              disabled={busy !== null || !form.s3.Endpoint}
            >
              {busy === "test" && <Spinner />} Test connection
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy !== null}>
                {busy === "save" ? "Checking…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function emptyInput(): ConnectionInput {
  return {
    name: "",
    s3: { Endpoint: "", AccessKeyID: "", SecretAccessKey: "", Region: "" },
  }
}

function BucketsSheet({
  connection,
  onClose,
}: {
  connection: StorageConnection | null
  onClose: () => void
}) {
  const buckets = useQuery({
    ...bucketsQuery(connection?.connection_id ?? ""),
    enabled: connection !== null,
  })
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!connection) return
    const problem = bucketProblem(name)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await createBucket(connection.connection_id, name)
      toast.success(`Created bucket ${name}`)
      setName("")
      await queryClient.invalidateQueries({
        queryKey: ["storage-connections", connection.connection_id, "buckets"],
      })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={connection !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>Buckets · {connection?.name}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {connection?.s3.Endpoint}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          <form onSubmit={create} className="flex flex-col gap-2">
            <Label htmlFor="bucket-name">New bucket</Label>
            <div className="flex gap-2">
              <Input
                id="bucket-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="ckman-backups"
                className="font-mono"
              />
              <Button type="submit" disabled={busy || !name}>
                {busy ? <Spinner /> : "Create"}
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </form>
          {buckets.error ? (
            <ErrorState error={buckets.error} />
          ) : buckets.isPending ? (
            <Spinner />
          ) : buckets.data?.length ? (
            <ul className="divide-y rounded-lg border text-sm">
              {buckets.data.map((b) => (
                <li key={b} className="px-3 py-2 font-mono">
                  {b}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No buckets yet.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
