import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

// Clusters set up with "SSH password, not saved" need the password for every
// SSH operation. `withSsh` asks for it first when `needPassword` is true.
export function useSshGate(needPassword: boolean | undefined) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const pending = useRef<((password: string | null) => void) | null>(null)

  function ask() {
    return new Promise<string | null>((resolve) => {
      pending.current = resolve
      setValue("")
      setOpen(true)
    })
  }

  async function withSsh<T>(
    fn: (ssh: { password?: string }) => Promise<T>
  ): Promise<T | undefined> {
    if (!needPassword) return fn({})
    const password = await ask()
    if (password === null) return undefined
    return fn({ password })
  }

  function finish(result: string | null) {
    setOpen(false)
    pending.current?.(result)
    pending.current = null
  }

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>SSH password</DialogTitle>
          <DialogDescription>
            This cluster doesn't store its SSH password. Enter it to continue.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            finish(value)
          }}
        >
          <Field>
            <FieldLabel htmlFor="ssh-password">Password</FieldLabel>
            <Input
              id="ssh-password"
              type="password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => finish(null)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )

  return { withSsh, dialog }
}
