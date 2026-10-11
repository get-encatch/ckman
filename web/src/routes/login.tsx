import { useState, type FormEvent } from "react"
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { z } from "zod"

import { errorMessage, getSession, login } from "@/api/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export const Route = createFileRoute("/login")({
  validateSearch: z.object({
    // never bounce back to /login itself
    redirect: z
      .string()
      .optional()
      .transform((r) => (r && !r.startsWith("/login") ? r : undefined)),
  }),
  beforeLoad: ({ search }) => {
    if (getSession()) throw redirect({ to: search.redirect ?? "/clusters" })
  },
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const { redirect: target } = Route.useSearch()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      await login(String(form.get("username")), String(form.get("password")))
      await router.navigate({ to: target ?? "/clusters" })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">ckman</CardTitle>
          <CardDescription>
            Sign in to manage ClickHouse clusters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  required
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <Button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
