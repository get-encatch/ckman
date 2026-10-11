import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { z } from "zod"

import { errorMessage } from "@/api/client"
import { importCluster } from "@/api/queries"
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
import { Textarea } from "@/components/ui/textarea"
import { expandHosts } from "@/lib/format"

const schema = z.object({
  cluster: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, _ and - only"),
  hosts: z.string().min(1, "Required"),
  port: z.coerce.number().int().min(1).max(65535),
  httpPort: z.coerce.number().int().min(1).max(65535),
  user: z.string().min(1, "Required"),
  password: z.string(),
  zkNodes: z.string(),
  zkPort: z.coerce.number().int().min(1).max(65535),
})

type Values = z.input<typeof schema>

export function ImportClusterDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      cluster: "",
      hosts: "",
      port: 9000,
      httpPort: 8123,
      user: "default",
      password: "",
      zkNodes: "",
      zkPort: 2181,
    },
  })
  const errors = form.formState.errors

  async function submit(raw: Values) {
    const values = schema.parse(raw)
    const hosts = expandHosts(values.hosts)
    const zk = expandHosts(values.zkNodes)
    if (hosts.error || zk.error)
      return setError(hosts.error ?? zk.error ?? null)
    setError(null)
    try {
      await importCluster({
        cluster: values.cluster,
        logic_cluster: "",
        hosts: hosts.hosts,
        protocol: "native",
        port: values.port,
        httpPort: values.httpPort,
        secure: false,
        user: values.user,
        password: values.password,
        zkNodes: zk.hosts,
        zkPort: values.zkPort,
      })
      toast.success(`Imported ${values.cluster}`)
      await queryClient.invalidateQueries({ queryKey: ["clusters"] })
      onOpenChange(false)
      form.reset()
      await navigate({
        to: "/clusters/$cluster",
        params: { cluster: values.cluster },
      })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a cluster</DialogTitle>
          <DialogDescription>
            Monitor and query a ClickHouse cluster that already runs. ckman
            discovers its shards and replicas; lifecycle actions (start, stop,
            upgrade, nodes) stay unavailable.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(submit)}>
          <FieldGroup>
            <Field data-invalid={!!errors.cluster}>
              <FieldLabel htmlFor="imp-cluster">Cluster name</FieldLabel>
              <Input id="imp-cluster" {...form.register("cluster")} />
              <FieldDescription>
                Must match the cluster name in ClickHouse's remote_servers.
              </FieldDescription>
              <FieldError errors={[errors.cluster]} />
            </Field>
            <Field data-invalid={!!errors.hosts}>
              <FieldLabel htmlFor="imp-hosts">ClickHouse nodes</FieldLabel>
              <Textarea
                id="imp-hosts"
                rows={2}
                placeholder="10.0.0.1, 10.0.0.2-4, 10.0.1.0/30"
                {...form.register("hosts")}
              />
              <FieldError errors={[errors.hosts]} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!errors.port}>
                <FieldLabel htmlFor="imp-port">TCP port</FieldLabel>
                <Input
                  id="imp-port"
                  inputMode="numeric"
                  {...form.register("port")}
                />
              </Field>
              <Field data-invalid={!!errors.httpPort}>
                <FieldLabel htmlFor="imp-http">HTTP port</FieldLabel>
                <Input
                  id="imp-http"
                  inputMode="numeric"
                  {...form.register("httpPort")}
                />
              </Field>
              <Field data-invalid={!!errors.user}>
                <FieldLabel htmlFor="imp-user">ClickHouse user</FieldLabel>
                <Input
                  id="imp-user"
                  autoComplete="off"
                  {...form.register("user")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="imp-password">Password</FieldLabel>
                <Input
                  id="imp-password"
                  type="password"
                  autoComplete="new-password"
                  {...form.register("password")}
                />
              </Field>
            </div>
            <div className="grid grid-cols-[1fr_8rem] gap-4">
              <Field>
                <FieldLabel htmlFor="imp-zk">
                  Keeper / ZooKeeper nodes
                </FieldLabel>
                <Input
                  id="imp-zk"
                  placeholder="optional"
                  {...form.register("zkNodes")}
                />
              </Field>
              <Field data-invalid={!!errors.zkPort}>
                <FieldLabel htmlFor="imp-zkport">Port</FieldLabel>
                <Input
                  id="imp-zkport"
                  inputMode="numeric"
                  {...form.register("zkPort")}
                />
              </Field>
            </div>
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
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
