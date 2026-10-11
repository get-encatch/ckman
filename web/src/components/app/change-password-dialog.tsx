import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { changeOwnPassword, passwordProblem } from "@/api/queries"
import { errorMessage } from "@/api/client"
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

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const current = String(form.get("current"))
    const next = String(form.get("next"))
    const confirm = String(form.get("confirm"))
    const problem = passwordProblem(next)
    if (problem) return setError(problem)
    if (next !== confirm) return setError("The new passwords don't match.")
    setBusy(true)
    setError(null)
    try {
      await changeOwnPassword(current, next)
      toast.success("Password changed")
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Applies to your ckman sign-in.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
              <Input
                id="pw-current"
                name="current"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="pw-next">New password</FieldLabel>
              <Input
                id="pw-next"
                name="next"
                type="password"
                autoComplete="new-password"
                required
              />
              <FieldDescription>
                8+ characters, mixing 3 of: digits, lowercase, uppercase,
                symbols.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="pw-confirm">Confirm new password</FieldLabel>
              <Input
                id="pw-confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
              />
            </Field>
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
              {busy ? "Saving…" : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
