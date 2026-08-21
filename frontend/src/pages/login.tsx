"use client"

import { type FormEvent, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { portalPath } from "@/lib/utils"

export function LoginPage() {
  const { user, loading, login } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
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
    // Two panels rather than one small card adrift in white space: the brand
    // side fills the width a desktop actually has and says what the system
    // does, and the form gets a column of its own instead of a box.
    <div className="grid min-h-svh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-14">
        {/* Depth comes from stacked light sources, not a flat fill. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: [
              "radial-gradient(42rem 30rem at 12% 8%, oklch(1 0 0 / 0.22), transparent 60%)",
              "radial-gradient(36rem 28rem at 88% 92%, oklch(0.6 0.19 320 / 0.5), transparent 62%)",
              "radial-gradient(30rem 24rem at 78% 12%, oklch(0.75 0.14 196 / 0.28), transparent 60%)",
            ].join(","),
          }}
        />
        {/* A whisper of grain stops the gradients from banding and keeps the
            surface from looking like flat vector colour. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.15] mix-blend-overlay"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")",
          }}
        />

        <div className="relative flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-10 place-items-center rounded-[calc(var(--radius)*0.8)] bg-white/15 ring-1 ring-inset ring-white/25 backdrop-blur"
          >
            <span className="text-[0.9375rem] font-semibold tracking-tight">SE</span>
          </span>
          <span className="text-sm font-medium tracking-tight opacity-90">
            Saveetha Engineering College
          </span>
        </div>

        <div className="relative max-w-lg">
          <h2 className="text-[clamp(2rem,1.2rem+1.8vw,2.75rem)] font-semibold leading-[1.1] tracking-[-0.03em]">
            Every publication claim, from submission to payment.
          </h2>
          <ul className="mt-9 space-y-4 text-[0.9375rem] leading-relaxed opacity-90">
            {[
              "Checked against Scopus and Scimago as you file",
              "One clear approval step, with the amount confirmed before it moves",
              "Every rupee traceable to the ticket that earned it",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span
                  aria-hidden
                  className="mt-[0.55rem] size-1.5 shrink-0 rounded-full bg-white/70"
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs opacity-70">
          Publication remuneration · Research cell
        </p>
      </aside>

      <main className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-[24rem] space-y-8">
          <div className="lg:hidden">
            <span
              aria-hidden
              className="grid size-11 place-items-center rounded-[calc(var(--radius)*0.8)] bg-primary text-primary-foreground shadow-e2"
            >
              <span className="text-base font-semibold tracking-tight">SE</span>
            </span>
          </div>

          <div className="space-y-2">
            <h1 className="text-display">Publication Tickets</h1>
            <p className="text-[0.9375rem] text-muted-foreground">
              Sign in with your college email.
            </p>
          </div>

          {/* No card: the column already frames the form, and a box inside a
              box is the thing that made this screen look like a widget. */}
          <form onSubmit={onSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="you@saveetha.ac.in"
                className="h-11"
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
                className="h-11"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error ? (
              <p
                className="rounded-[calc(var(--radius)*0.7)] border border-destructive/25 bg-surface-danger px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <Button type="submit" size="lg" className="h-11 w-full text-[0.9375rem]" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Forgotten your password? The research cell can reset it and unlock your
              account.
            </p>
          </form>


        </div>
      </main>
    </div>
  )
}
