import { useState, type FormEvent } from "react"
import { motion } from "motion/react"
import { Eye, EyeOff, LoaderCircle } from "lucide-react"

import { useAuth } from "@/app/auth"
import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"

/**
 * The way in.
 *
 * Two fields and one button, centred on white. No marketing panel, no
 * gradient, no illustration — 525 people sign in here on a Monday morning and
 * every one of them wants to be past it.
 *
 * The password can be read back. That is not a nicety: the passwords this
 * system issues look like `RzSRfIOD%V*uQYfw2_j0L#2M`, they are handed over on
 * paper, and a failed attempt cannot tell somebody whether the caps lock was
 * down or the `l` they typed was a `1`. Five failures locks the account.
 */
export function SignIn() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in")
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh place-items-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[21rem]"
      >
        <div className="mb-7">
          <div className="mb-4 grid size-8 place-items-center rounded-[--radius] bg-[--color-accent] text-xs font-semibold text-white">
            SE
          </div>
          <h1 className="text-xl font-semibold">Faculty Publication App</h1>
          <p className="mt-1 text-base text-[--color-fg-muted]">
            Saveetha Engineering College
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(
                "h-10 w-full rounded-[--radius] bg-[--color-surface] px-3 text-base",
                "ring-1 ring-inset ring-[--color-field] outline-none",
                "focus-visible:ring-2 focus-visible:ring-[--color-accent]"
              )}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={shown ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)}
                onBlur={() => setCaps(false)}
                className={cn(
                  "h-10 w-full rounded-[--radius] bg-[--color-surface] pl-3 pr-10 text-base",
                  "ring-1 ring-inset ring-[--color-field] outline-none",
                  "focus-visible:ring-2 focus-visible:ring-[--color-accent]"
                )}
              />
              <button
                type="button"
                // Out of the tab order: Tab from the password field should
                // reach Sign in, not a control you did not come here for.
                tabIndex={-1}
                onClick={() => setShown((v) => !v)}
                aria-label={shown ? "Hide password" : "Show password"}
                aria-pressed={shown}
                className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-[--radius-sm] text-[--color-fg-subtle] hover:text-[--color-fg]"
              >
                {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {caps && (
              <p role="status" className="text-xs text-[--color-caution]">
                Caps lock is on.
              </p>
            )}
          </div>

          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              role="alert"
              className="rounded-[--radius] bg-[--color-critical-wash] px-3 py-2 text-sm text-[--color-critical]"
            >
              {error}
            </motion.p>
          )}

          <Button kind="primary" size="lg" type="submit" disabled={busy} className="w-full">
            {busy && <LoaderCircle className="animate-spin" />}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </motion.div>
    </div>
  )
}
