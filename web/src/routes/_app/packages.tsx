import { useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { Trash2Icon, UploadIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage } from "@/api/client"
import {
  deletePackage,
  packagesQuery,
  uploadPackage,
  type PackageInfo,
} from "@/api/queries"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { columnHelper, DataTable } from "@/components/app/data-table"
import { ErrorState } from "@/components/app/misc"
import { PageBody, PageHeader, Section } from "@/components/app/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

export const Route = createFileRoute("/_app/packages")({
  component: PackagesPage,
})

const col = columnHelper<PackageInfo>()

function PackagesPage() {
  const { session } = useRouteContext({ from: "/_app" })
  const isAdmin = session.policy === "admin"
  const packages = useQuery(packagesQuery("all"))
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<{
    done: number
    total: number
  } | null>(null)
  const [remove, setRemove] = useState<PackageInfo | null>(null)

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    const list = [...files]
    setUploading({ done: 0, total: list.length })
    let failed = 0
    // one file per request; sequential keeps the backend's memory use low
    for (const file of list) {
      try {
        await uploadPackage(file)
      } catch (err) {
        failed++
        toast.error(`${file.name}: ${errorMessage(err)}`)
      }
      setUploading((u) => u && { ...u, done: u.done + 1 })
    }
    setUploading(null)
    if (fileInput.current) fileInput.current.value = ""
    if (failed < list.length)
      toast.success(`Uploaded ${list.length - failed} file(s)`)
    await queryClient.invalidateQueries({ queryKey: ["packages"] })
  }

  const columns = useMemo(
    () => [
      col.accessor("version", {
        header: "Version",
        cell: (c) => (
          <span className="font-medium tabular-nums">{c.getValue()}</span>
        ),
      }),
      col.accessor("pkgType", {
        header: "Type",
        cell: (c) => <Badge variant="outline">{c.getValue()}</Badge>,
      }),
      col.accessor("pkgName", {
        header: "Main file",
        enableSorting: false,
        cell: (c) => (
          <span className="font-mono text-xs text-muted-foreground">
            {c.getValue()}
          </span>
        ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (c) =>
          isAdmin && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${c.row.original.version}`}
                onClick={() => setRemove(c.row.original)}
              >
                <Trash2Icon />
              </Button>
            </div>
          ),
      }),
    ],
    [isAdmin]
  )

  return (
    <>
      <PageHeader
        title="Packages"
        description="ClickHouse versions available for creating and upgrading clusters."
        actions={
          isAdmin && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".tgz,.rpm,.deb"
                multiple
                className="hidden"
                onChange={(e) => void upload(e.target.files)}
              />
              <Button
                onClick={() => fileInput.current?.click()}
                disabled={uploading !== null}
              >
                <UploadIcon /> Upload files
              </Button>
            </>
          )
        }
      />
      <PageBody>
        {uploading && (
          <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
            <span>
              Uploading{" "}
              {uploading.done + 1 > uploading.total
                ? uploading.total
                : uploading.done + 1}{" "}
              of {uploading.total}…
            </span>
            <Progress value={(uploading.done / uploading.total) * 100} />
          </div>
        )}
        {packages.error && <ErrorState error={packages.error} />}
        <DataTable
          columns={columns}
          data={packages.data}
          loading={packages.isPending}
          emptyText="No complete packages yet. Upload the files for a version below."
          getRowId={(p) => `${p.pkgType}/${p.version}`}
          initialSorting={[{ id: "version", desc: true }]}
        />
        <Section
          title="Which files to upload"
          description="A version appears above once its common-static, server and client files are all uploaded. Clusters using ClickHouse Keeper on separate nodes also need the keeper file."
        >
          <div className="rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-6">
            clickhouse-common-static-&lt;version&gt;-amd64.tgz
            <br />
            clickhouse-server-&lt;version&gt;-amd64.tgz
            <br />
            clickhouse-client-&lt;version&gt;-amd64.tgz
            <br />
            clickhouse-keeper-&lt;version&gt;-amd64.tgz
          </div>
          <p className="text-sm text-muted-foreground">
            Download them from{" "}
            <a
              href="https://packages.clickhouse.com/tgz/stable/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              packages.clickhouse.com/tgz/stable
            </a>
            . The .rpm and .deb packages work too.
          </p>
        </Section>
      </PageBody>
      <ConfirmDialog
        open={remove !== null}
        onOpenChange={(o) => !o && setRemove(null)}
        title={`Delete ClickHouse ${remove?.version}?`}
        description="Removes all files of this version from ckman. Running clusters are not affected, but you can't add nodes on this version until you upload it again."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!remove) return
          await deletePackage(remove.version, remove.pkgType)
          toast.success(`Deleted ${remove.version}`)
          await queryClient.invalidateQueries({ queryKey: ["packages"] })
        }}
      />
    </>
  )
}
