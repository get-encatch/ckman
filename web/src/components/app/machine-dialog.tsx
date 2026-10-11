import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  AUTH_KEY,
  AUTH_PASSWORD,
  createMachine,
  formatLabels,
  parseLabels,
  updateMachine,
  type Machine,
  type MachineInput,
} from "@/api/fleet"
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
import { Textarea } from "@/components/ui/textarea"

type Form = Omit<MachineInput, "labels" | "ssh_port"> & {
  labels: string
  ssh_port: string
}

const emptyForm = (): Form => ({
  name: "",
  ip: "",
  zone: "",
  labels: "",
  ssh_user: "root",
  ssh_port: "22",
  authenticate_type: AUTH_KEY,
  ssh_password: "",
  data_dir: "/var/lib/ckfleet",
})

const toForm = (m: Machine): Form => ({
  name: m.name,
  ip: m.ip,
  zone: m.zone,
  labels: formatLabels(m.labels),
  ssh_user: m.ssh_user,
  ssh_port: String(m.ssh_port),
  authenticate_type: m.authenticate_type,
  ssh_password: "",
  data_dir: m.data_dir,
})

// Adds or edits a machine. Saving checks SSH and Docker on it first.
export function MachineDialog({
  machine,
  zones,
  onClose,
  onSaved,
}: {
  machine: Machine | "new" | null
  zones: string[]
  onClose: () => void
  onSaved: (m: Machine) => Promise<unknown> | void
}) {
  const existing = machine !== null && machine !== "new" ? machine : null
  const [form, setForm] = useState<Form>(emptyForm())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState(machine)
  if (machine !== last) {
    setLast(machine)
    setError(null)
    setForm(existing ? toForm(existing) : emptyForm())
  }
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const { labels, error: labelError } = parseLabels(form.labels)
    if (labelError) return setError(labelError)
    const port = Number(form.ssh_port)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return setError("SSH port must be 1-65535")
    if (
      form.authenticate_type === AUTH_PASSWORD &&
      !existing &&
      !form.ssh_password
    )
      return setError("Enter the SSH password")
    setBusy(true)
    setError(null)
    try {
      const body: MachineInput = { ...form, labels, ssh_port: port }
      const saved = existing
        ? await updateMachine(existing.id, body)
        : await createMachine(body)
      toast.success(
        saved.status === "ready"
          ? `${saved.name} is ready: ${saved.facts.cores} cores, Docker ${saved.facts.docker_version}`
          : `${saved.name} saved, but Docker isn't running on it`
      )
      await onSaved(saved)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={machine !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.name}` : "Add machine"}
          </DialogTitle>
          <DialogDescription>
            A server ckman reaches over SSH, with Docker installed. ClickHouse
            and Keeper run on it as containers. Saving connects to it and reads
            its CPU, memory, disk and Docker version.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="m-name">Name</FieldLabel>
                <Input
                  id="m-name"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="ch-a1"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="m-ip">IP address</FieldLabel>
                <Input
                  id="m-ip"
                  value={form.ip}
                  onChange={(e) => set({ ip: e.target.value })}
                  placeholder="10.0.1.21"
                  required
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="m-zone">Zone</FieldLabel>
                <Input
                  id="m-zone"
                  list="m-zones"
                  value={form.zone}
                  onChange={(e) => set({ zone: e.target.value })}
                  placeholder="zone-a"
                />
                <datalist id="m-zones">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
                <FieldDescription>
                  Machines in one zone fail together; replicas spread across
                  zones.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="m-labels">Labels</FieldLabel>
                <Textarea
                  id="m-labels"
                  rows={2}
                  value={form.labels}
                  onChange={(e) => set({ labels: e.target.value })}
                  placeholder={"role=keeper\ndisk=nvme"}
                />
                <FieldDescription>
                  key=value, one per line. Used to pick machines.
                </FieldDescription>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="m-user">SSH user</FieldLabel>
                <Input
                  id="m-user"
                  value={form.ssh_user}
                  onChange={(e) => set({ ssh_user: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="m-port">SSH port</FieldLabel>
                <Input
                  id="m-port"
                  inputMode="numeric"
                  value={form.ssh_port}
                  onChange={(e) => set({ ssh_port: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>Sign in with</FieldLabel>
                <Select
                  items={{
                    [AUTH_KEY]: "ckman's SSH key",
                    [AUTH_PASSWORD]: "Password",
                  }}
                  value={String(form.authenticate_type)}
                  onValueChange={(v) =>
                    set({ authenticate_type: Number(v), ssh_password: "" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={String(AUTH_KEY)}>
                      ckman&apos;s SSH key
                    </SelectItem>
                    <SelectItem value={String(AUTH_PASSWORD)}>
                      Password
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {form.authenticate_type === AUTH_PASSWORD ? (
              <Field>
                <FieldLabel htmlFor="m-pass">SSH password</FieldLabel>
                <Input
                  id="m-pass"
                  type="password"
                  autoComplete="new-password"
                  value={form.ssh_password}
                  onChange={(e) => set({ ssh_password: e.target.value })}
                  placeholder={existing ? "Leave empty to keep" : ""}
                />
                <FieldDescription>Stored encrypted.</FieldDescription>
              </Field>
            ) : (
              <FieldDescription>
                Add the public key of ckman&apos;s conf/id_rsa to the
                user&apos;s authorized_keys on the machine.
              </FieldDescription>
            )}
            <Field>
              <FieldLabel htmlFor="m-dir">Data folder</FieldLabel>
              <Input
                id="m-dir"
                value={form.data_dir}
                onChange={(e) => set({ data_dir: e.target.value })}
              />
              <FieldDescription>
                Each instance gets a folder under it. Disk usage is measured on
                this volume.
              </FieldDescription>
            </Field>
            {form.ssh_user !== "root" && (
              <FieldDescription>
                A non-root user needs passwordless sudo and access to Docker.
              </FieldDescription>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Checking…" : existing ? "Save" : "Add machine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
