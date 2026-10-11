import { useMemo, useState, type FormEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  BUILTIN_USERS,
  createUser,
  deleteUser,
  passwordProblem,
  resetUserPassword,
  updateUser,
  USERNAME_PATTERN,
  usersQuery,
  type Policy,
  type User,
} from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState } from "@/components/app/misc"
import { PageBody, PageHeader } from "@/components/app/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { formatDateTime } from "@/lib/format"

export const Route = createFileRoute("/_app/users")({
  beforeLoad: ({ context }) => {
    if (context.session.policy !== "admin") throw redirect({ to: "/clusters" })
  },
  component: UsersPage,
})

const ROLE_HELP: Record<Policy, string> = {
  admin: "Everything, including users and cluster lifecycle.",
  ordinary: "Read everything, run SQL, manage tables, sessions and backups.",
  guest: "Read-only, plus running SQL in the query console.",
}

const col = columnHelper<User>()

function UsersPage() {
  const users = useQuery(usersQuery())
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<User | "new" | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)
  const [removing, setRemoving] = useState<User | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] })

  const columns = useMemo(
    () => [
      col.accessor("username", {
        header: "Username",
        cell: (c) => <span className="font-medium">{c.getValue()}</span>,
      }),
      col.accessor("policy", {
        header: "Role",
        cell: (c) => (
          <Badge variant={c.getValue() === "admin" ? "default" : "secondary"}>
            {c.getValue()}
          </Badge>
        ),
      }),
      col.accessor("enabled", {
        header: "Enabled",
        cell: (c) => {
          const u = c.row.original
          return (
            <Switch
              checked={c.getValue()}
              disabled={BUILTIN_USERS.has(u.username)}
              aria-label={`${u.username} enabled`}
              onCheckedChange={async (enabled) => {
                try {
                  await updateUser(u.username, { enabled })
                  toast.success(
                    `${u.username} ${enabled ? "enabled" : "disabled"}`
                  )
                  await refresh()
                } catch (err) {
                  toast.error(errorMessage(err))
                }
              }}
            />
          )
        },
      }),
      col.accessor("created_at", {
        header: "Created",
        cell: (c) => formatDateTime(c.getValue()),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) => {
          const u = c.row.original
          const builtin = BUILTIN_USERS.has(u.username)
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Actions"
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={builtin}
                    onClick={() => setEditing(u)}
                  >
                    Change role
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setResetting(u)}>
                    Reset password…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={builtin}
                    onClick={() => setRemoving(u)}
                  >
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return (
    <>
      <PageHeader
        title="Users"
        description="People who can sign in to ckman."
        actions={
          <Button onClick={() => setEditing("new")}>
            <PlusIcon /> Add user
          </Button>
        }
      />
      <PageBody>
        {users.error && <ErrorState error={users.error} />}
        <DataTable
          columns={columns}
          data={users.data}
          loading={users.isPending}
          getRowId={(u) => u.username}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(ROLE_HELP) as Policy[]).map((p) => (
            <div key={p} className="rounded-lg border p-3 text-sm">
              <div className="font-medium capitalize">{p}</div>
              <div className="text-muted-foreground">{ROLE_HELP[p]}</div>
            </div>
          ))}
        </div>
      </PageBody>
      <UserDialog
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <ResetPasswordDialog
        user={resetting}
        onClose={() => setResetting(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete ${removing?.username}?`}
        description="They are signed out right away and can no longer sign in."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!removing) return
          await deleteUser(removing.username)
          toast.success(`Deleted ${removing.username}`)
          await refresh()
        }}
      />
    </>
  )
}

function UserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: User | "new" | null
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const isNew = user === "new"
  const existing = user !== null && user !== "new" ? user : null
  const [policy, setPolicy] = useState<Policy>("guest")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastUser, setLastUser] = useState(user)
  if (user !== lastUser) {
    setLastUser(user)
    setPolicy(user !== null && user !== "new" ? user.policy : "guest")
    setError(null)
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      if (isNew) {
        const username = String(form.get("username"))
        const password = String(form.get("password"))
        if (!USERNAME_PATTERN.test(username))
          throw new Error(
            "Username: start with a letter; 3–32 letters, digits or _."
          )
        const problem = passwordProblem(password)
        if (problem) throw new Error(problem)
        await createUser({ username, password, policy, enabled: true })
        toast.success(`Added ${username}`)
      } else if (existing) {
        await updateUser(existing.username, { policy })
        toast.success(`Updated ${existing.username}`)
      }
      await onSaved()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={user !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Add user" : `Change role for ${existing?.username ?? ""}`}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            {isNew && (
              <>
                <Field>
                  <FieldLabel htmlFor="u-name">Username</FieldLabel>
                  <Input
                    id="u-name"
                    name="username"
                    autoComplete="off"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="u-password">Password</FieldLabel>
                  <Input
                    id="u-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                  />
                  <FieldDescription>
                    8+ characters, mixing 3 of: digits, lowercase, uppercase,
                    symbols.
                  </FieldDescription>
                </Field>
              </>
            )}
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Select
                items={{ guest: "Guest", ordinary: "Ordinary" }}
                value={policy}
                onValueChange={(v) => setPolicy(v as Policy)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="guest">Guest</SelectItem>
                  <SelectItem value="ordinary">Ordinary</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                {ROLE_HELP[policy]} Admin can't be granted here.
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : isNew ? "Add user" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({
  user,
  onClose,
}: {
  user: User | null
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!user) return
    const password = String(new FormData(e.currentTarget).get("password"))
    const problem = passwordProblem(password)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await resetUserPassword(user.username, password)
      toast.success(`Password reset for ${user.username}`)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={user !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset password for {user?.username}</DialogTitle>
          <DialogDescription>
            Tell them the new password through a safe channel.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="r-password">New password</FieldLabel>
              <Input
                id="r-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
              />
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Reset password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
