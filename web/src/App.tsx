import { useEffect, useState, type FormEvent } from "react"

import { getToken, login, logout, unwrap, api } from "@/api/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// Placeholder screens that prove the API wiring; replaced by the real UI.
export function App() {
  const [signedIn, setSignedIn] = useState(() => getToken() !== null)

  return (
    <div className="flex min-h-svh items-start justify-center p-6 md:items-center">
      {signedIn ? (
        <Clusters onSignOut={() => setSignedIn(false)} />
      ) : (
        <SignIn onSignIn={() => setSignedIn(true)} />
      )}
    </div>
  )
}

function SignIn({ onSignIn }: { onSignIn: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      await login(String(form.get("username")), String(form.get("password")))
      onSignIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>ckman</CardTitle>
        <CardDescription>
          Sign in to manage ClickHouse clusters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

type Cluster = {
  cluster: string
  version: string
  hosts: string[] | null
  comment: string
}

function Clusters({ onSignOut }: { onSignOut: () => void }) {
  const [clusters, setClusters] = useState<Cluster[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    unwrap<Record<string, Cluster> | null>(api.GET("/api/v1/ck/cluster"))
      .then((byName) => setClusters(Object.values(byName ?? {})))
      .catch((err) => {
        if (getToken() === null) onSignOut()
        else setError(err instanceof Error ? err.message : String(err))
      })
  }, [onSignOut])

  async function signOut() {
    await logout().catch(() => {})
    onSignOut()
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Clusters</CardTitle>
          <CardDescription>
            ClickHouse clusters managed by ckman.
          </CardDescription>
        </div>
        <Button variant="outline" onClick={signOut}>
          Sign out
        </Button>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && clusters === null && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {clusters?.length === 0 && (
          <p className="text-sm text-muted-foreground">No clusters yet.</p>
        )}
        {clusters && clusters.length > 0 && (
          <ul className="divide-y text-sm">
            {clusters.map((c) => (
              <li key={c.cluster} className="flex justify-between gap-4 py-2">
                <span className="font-medium">{c.cluster}</span>
                <span className="text-muted-foreground tabular-nums">
                  {c.version} · {c.hosts?.length ?? 0} hosts
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export default App
