"use client"

import { type FormEvent, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { portalPath } from "@/lib/utils"

// Four accounts, one per role. The research-cell and HoD logins were stood
// down: the research cell works through Admin, and the HoD step is gone.
const DEMOS = [
  { role: "Faculty", email: "faculty@college.edu", password: "faculty123" },
  { role: "Admin", email: "admin@college.edu", password: "" },
  { role: "Finance", email: "finance@college.edu", password: "finance123" },
  { role: "Principal", email: "principal@college.edu", password: "principal123" },
]

const showDemos = import.meta.env.DEV

export function LoginPage() {
  const { user, loading, login } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState(showDemos ? "faculty@college.edu" : "")
  const [password, setPassword] = useState(showDemos ? "faculty123" : "")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  if (!loading && user) {
    return <Navigate to={portalPath(user.portal)} replace />
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      // login() already returns the authenticated user — the extra raw /me
      // fetch here was a second round-trip for data we were holding.
      const me = await login(email.trim(), password)
      toast.success("Welcome back")
      nav(portalPath(me.portal))
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed"
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden px-4 py-10">
      {/* A quiet wash of the brand hue behind the card, so the sign-in screen
          belongs to the product rather than looking like a bare form. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-background"
        style={{
          backgroundImage:
            "radial-gradient(60rem 40rem at 50% -10%, var(--surface-brand), transparent 65%)",
        }}
      />
      <div className="w-full max-w-[26rem] space-y-7">
        <div className="flex flex-col items-center text-center">
          <span
            aria-hidden
            className="grid size-12 place-items-center rounded-[calc(var(--radius)*0.9)] bg-primary text-primary-foreground shadow-e2"
          >
            <span className="text-lg font-semibold tracking-tight">SE</span>
          </span>
          <h1 className="text-display mt-4">Publication Tickets</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Saveetha Engineering College · submit once, track every approval
          </p>
        </div>

        <Card className="shadow-e3">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use your college email and password.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Forgotten your password? The research cell can reset it and unlock
                your account.
              </p>
            </form>
          </CardContent>
        </Card>

        {showDemos ? (
          <details className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-muted-foreground">
              Demo accounts
            </summary>
            <div className="mt-3 grid gap-1">
              {DEMOS.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  onClick={() => {
                    setEmail(d.email)
                    setPassword(d.password)
                  }}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <span className="font-medium">{d.role}</span>
                  <span className="font-mono opacity-80">{d.email}</span>
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  )
}
