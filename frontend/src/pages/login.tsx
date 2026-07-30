"use client"

import { type FormEvent, useState } from "react"
import { motion } from "framer-motion"
import { Navigate, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { portalPath } from "@/lib/utils"

const DEMOS = [
  { role: "Faculty", email: "faculty@college.edu", password: "faculty123" },
  { role: "HoD", email: "hod@college.edu", password: "hod123" },
  { role: "Principal", email: "principal@college.edu", password: "principal123" },
  { role: "Finance", email: "finance@college.edu", password: "finance123" },
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
      await login(email.trim(), password)
      toast.success("Welcome back")
      const me = await fetch(
        `${import.meta.env.VITE_API_BASE || ""}/api/auth/me`,
        { credentials: "include" }
      ).then((r) => r.json())
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
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_-10%,hsl(191_35%_88%)_0%,hsl(210_22%_97%)_45%,hsl(210_16%_94%)_100%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "radial-gradient(hsl(191 20% 70% / 0.25) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-[400px]"
      >
        <div className="mb-10 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary/70">
            Saveetha Engineering College
          </p>
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-semibold tracking-tight text-foreground">
            Publication
            <span className="block text-primary">Tickets</span>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Submit once. Track every approval.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-[1.25rem] border border-border/80 bg-card/85 p-6 shadow-[0_12px_40px_-24px_hsl(191_72%_20%/0.35)] backdrop-blur-xl"
        >
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="h-12"
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
              className="h-12"
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        {showDemos ? (
          <div className="mt-8 space-y-2">
            <p className="text-center text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Demo accounts
            </p>
            <div className="grid gap-1.5">
              {DEMOS.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  onClick={() => {
                    setEmail(d.email)
                    setPassword(d.password)
                  }}
                  className="flex items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/70 hover:text-accent-foreground active:scale-[0.99]"
                >
                  <span className="font-medium">{d.role}</span>
                  <span className="font-mono text-[11px] opacity-70">{d.email}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </motion.div>
    </div>
  )
}
