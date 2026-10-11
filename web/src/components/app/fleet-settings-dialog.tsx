import { useState, type FormEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import { fleetSettingsQuery, saveFleetSettings } from "@/api/fleet"
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
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

// Admin settings for the whole fleet.
export function FleetSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const settings = useQuery({ ...fleetSettingsQuery(), enabled: open })
  const queryClient = useQueryClient()
  const [interval, setIntervalMin] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const value = interval ?? String(settings.data?.standby_interval_min ?? 15)

  async function save(e: FormEvent) {
    e.preventDefault()
    const n = Number(value)
    if (!Number.isInteger(n) || n < 5 || n > 1440)
      return setError("Use 5 to 1440 minutes.")
    setBusy(true)
    setError(null)
    try {
      await saveFleetSettings({ standby_interval_min: n })
      await queryClient.invalidateQueries({ queryKey: ["fleet-settings"] })
      toast.success("Fleet settings saved")
      setIntervalMin(null)
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fleet settings</DialogTitle>
          <DialogDescription>Defaults for the whole fleet.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save}>
          <Field>
            <FieldLabel htmlFor="fs-interval">
              Standby sync interval (minutes)
            </FieldLabel>
            <Input
              id="fs-interval"
              inputMode="numeric"
              value={value}
              onChange={(e) => setIntervalMin(e.target.value)}
            />
            <FieldDescription>
              How often storage-sync standbys copy changes, unless a standby
              sets its own. A standby can lose up to this much data. 5–1440;
              default 15.
            </FieldDescription>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
