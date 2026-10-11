import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  clearNodeOverride,
  nodeOverrideQuery,
  saveNodeOverride,
  type OverrideResult,
} from "@/api/queries"
import { ErrorState } from "@/components/app/misc"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"

const EXAMPLE = `<clickhouse>
    <max_concurrent_queries>200</max_concurrent_queries>
</clickhouse>`

export function NodeOverrideSheet({
  cluster,
  ip,
  canEdit,
  onClose,
}: {
  cluster: string
  ip: string | null
  canEdit: boolean
  onClose: () => void
}) {
  const override = useQuery({
    ...nodeOverrideQuery(cluster, ip ?? ""),
    enabled: ip !== null,
  })
  const queryClient = useQueryClient()
  const [xml, setXml] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [loaded, setLoaded] = useState<typeof override.data>(undefined)
  if (override.data !== loaded) {
    setLoaded(override.data)
    setXml(override.data?.xml ?? "")
    setError(null)
  }

  function report(result: OverrideResult, verb: string) {
    if (result.reloaded) toast.success(`${verb} and reloaded on ${ip}`)
    else
      toast.warning(
        `${verb}, but the reload failed: ${result.warning ?? "unknown error"}`
      )
  }

  async function save(clear: boolean) {
    if (!ip) return
    if (!clear) {
      const doc = new DOMParser().parseFromString(xml, "application/xml")
      if (doc.querySelector("parsererror"))
        return setError("That isn't valid XML.")
    }
    setBusy(true)
    setError(null)
    try {
      const result = clear
        ? await clearNodeOverride(cluster, ip)
        : await saveNodeOverride(cluster, ip, xml)
      report(result, clear ? "Cleared" : "Saved")
      await queryClient.invalidateQueries({
        queryKey: ["cluster", cluster, "override", ip],
      })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={ip !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle>Config override · {ip}</SheetTitle>
          <SheetDescription>
            Extra server settings for this node only, written to
            config.d/node_override.xml and applied with SYSTEM RELOAD CONFIG.
            Settings that need a restart take effect at the next restart.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 px-4">
          {override.error && <ErrorState error={override.error} />}
          <Textarea
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            placeholder={EXAMPLE}
            readOnly={!canEdit}
            spellCheck={false}
            className="min-h-80 flex-1 font-mono text-xs"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        {canEdit && (
          <SheetFooter className="flex-row justify-between">
            <Button
              variant="outline"
              disabled={busy || !override.data?.xml}
              onClick={() => void save(true)}
            >
              Remove override
            </Button>
            <Button
              disabled={busy || xml.trim() === ""}
              onClick={() => void save(false)}
            >
              {busy ? "Saving…" : "Save and reload"}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
