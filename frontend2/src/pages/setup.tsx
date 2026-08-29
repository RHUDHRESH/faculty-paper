import { useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { CheckCircle2, LoaderCircle } from "lucide-react"

import { Mark } from "@/ui/art"
import { Button } from "@/ui/button"
import { Field, Input, PasswordInput } from "@/ui/field"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"

/**
 * First-run setup: the door a new college walks through.
 *
 * A system with no accounts in it asks three questions — whose institution
 * this is, who the first administrator is, and what password guards them —
 * and then it is a working installation, with no management command and no
 * demo passwords anywhere near it. Once one account exists the door closes
 * permanently: the status endpoint says so, the server refuses the POST, and
 * this page says "already set up" rather than pretending otherwise.
 *
 * Saveetha's own instance never sees this screen; it was born with accounts.
 * The screen exists for the second college, and the third.
 */

type Status = { needs_setup: boolean }

export function Setup() {
  const navigate = useNavigate()
  const status = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api<Status>("/api/setup/status"),
  })

  const [step, setStep] = useState(0)
  const [collegeName, setCollegeName] = useState("")
  const [adminName, setAdminName] = useState("")
  const [adminEmail, setAdminEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (status.isLoading) {
    return (
      <Frame>
        <Card>
          <div className="grid place-items-center py-16">
            <span className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" />
          </div>
        </Card>
      </Frame>
    )
  }

  if (status.data && !status.data.needs_setup) {
    return (
      <Frame>
        <Card>
          <CheckCircle2 className="size-10 text-ok" />
          <h1 className="mt-4 text-xl font-semibold">Already set up</h1>
          <p className="mt-2 text-base text-fg-muted">
            This system has accounts in it, so setup is finished. Sign in as one
            of them — the college's name can be changed afterwards under
            Institution in the office settings.
          </p>
          <Button kind="primary" className="mt-6" onClick={() => navigate("/")}>
            Go to sign in
          </Button>
        </Card>
      </Frame>
    )
  }

  if (done) {
    return (
      <Frame>
        <Card>
          <CheckCircle2 className="size-10 text-ok" />
          <h1 className="mt-4 text-xl font-semibold">{collegeName.trim()} is set up</h1>
          <p className="mt-2 text-base text-fg-muted">
            The administrator account <strong>{adminEmail.trim()}</strong> is
            ready. Sign in with the password you just chose — everything else
            (people, departments, the payout policy, journals) is set up from
            inside.
          </p>
          <Button kind="primary" className="mt-6" onClick={() => navigate("/")}>
            Sign in
          </Button>
        </Card>
      </Frame>
    )
  }

  const passwordOk = password.length >= 12
  const canContinue =
    step === 0
      ? collegeName.trim().length >= 2
      : step === 1
        ? adminName.trim() !== "" && adminEmail.includes("@") && passwordOk && password === confirm
        : true

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (step < 2) {
      setStep(step + 1)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api("/api/setup", {
        method: "POST",
        json: {
          college_name: collegeName.trim(),
          admin_name: adminName.trim(),
          admin_email: adminEmail.trim(),
          admin_password: password,
        },
      })
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup could not finish")
      setBusy(false)
    }
  }

  return (
    <Frame>
      <Card>
        <h1 className="text-xl font-semibold">Set up your college</h1>
        <ol className="mt-2 flex gap-1.5" aria-label="Progress">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              aria-current={i === step}
              className={cn("h-1 flex-1 rounded-full", i <= step ? "bg-accent" : "bg-line")}
            />
          ))}
        </ol>

        {step === 0 && (
          <div className="mt-6 space-y-4">
            <Field
              label="College name"
              hint="Shown on the sign-in screen, the sidebar and every export."
            >
              <Input
                autoFocus
                value={collegeName}
                onChange={(e) => setCollegeName(e.target.value)}
                placeholder="e.g. Saveetha Engineering College"
              />
            </Field>
            <p className="text-sm text-fg-muted">
              This installation will belong to that institution: its accounts,
              its papers, its payout policy. One installation per college.
            </p>
          </div>
        )}

        {step === 1 && (

          <div className="mt-6 space-y-4">
            <Field label="Administrator name">
              <Input
                autoFocus
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
              />
            </Field>
            <Field
              label="Administrator email"
              hint="Used to sign in. Accounts are never created by signing up — this is the one this system makes for you."
            >
              <Input
                type="email"
                autoComplete="username"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
              />
            </Field>
            <Field
              label="Administrator password"
              hint="At least 12 characters. It guards every account in the college, so it is held to more than an ordinary reset password."
            >
              <PasswordInput
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field
              label="Type the password again"
              error={
                confirm !== "" && confirm !== password
                  ? "The two passwords do not match yet."
                  : undefined
              }
            >
              <PasswordInput
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-md bg-caution-wash px-3 py-2 text-sm">{error}</p>
        )}

        <form onSubmit={submit} className="mt-6 flex items-center gap-3">
          {step > 0 && (
            <Button type="button" kind="quiet" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <Button type="submit" kind="primary" disabled={!canContinue || busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {step === 2 ? "Create the system" : "Continue"}
          </Button>
          <span className="text-sm text-fg-muted">
            {3 - step} step{3 - step === 1 ? "" : "s"} left
          </span>
        </form>
      </Card>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh place-items-center bg-sunken px-4 py-12">
      <div className="w-full max-w-[30rem]">
        <Link to="/" className="mb-6 inline-block">
          <Mark className="size-10 text-accent" />
        </Link>
        {children}
      </div>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg bg-surface p-6 shadow-sm">{children}</div>
}
