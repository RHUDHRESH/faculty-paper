import { useEffect, useRef, useState, type FormEvent } from "react"
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
          <div className="mb-4 grid size-8 place-items-center rounded-md bg-accent text-xs font-semibold text-white">
            SE
          </div>
          <h1 className="text-xl font-semibold">Faculty Publication App</h1>
          <p className="mt-1 text-base text-fg-muted">
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
                "h-10 w-full rounded-md bg-surface px-3 text-base",
                "ring-1 ring-inset ring-field outline-none",
                "focus-visible:ring-2 focus-visible:ring-accent"
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
                  "h-10 w-full rounded-md bg-surface pl-3 pr-10 text-base",
                  "ring-1 ring-inset ring-field outline-none",
                  "focus-visible:ring-2 focus-visible:ring-accent"
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
                className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-sm text-fg-subtle hover:text-fg"
              >
                {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {caps && (
              <p role="status" className="text-xs text-caution">
                Caps lock is on.
              </p>
            )}
          </div>

          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              role="alert"
              className="rounded-md bg-critical-wash px-3 py-2 text-sm text-critical"
            >
              {error}
            </motion.p>
          )}

          <Button kind="primary" size="lg" type="submit" disabled={busy} className="w-full">
            {busy && <LoaderCircle className="animate-spin" />}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <GoogleButton onError={setError} />
      </motion.div>
    </div>
  )
}


type GoogleConfig = {
  enabled: boolean
  client_id: string | null
  hosted_domain: string | null
}

/**
 * Continue with Google — for an account this college already has.
 *
 * The server is asked first whether it is configured, because the alternative
 * is worse than no button: one that renders, is pressed, and does nothing
 * reads as the account being broken rather than the feature being off. With
 * no client id the page shows the password form alone and says nothing about
 * Google at all.
 *
 * Signing in this way never creates an account. An address Google recognises
 * and this college does not is refused, and the refusal says so plainly —
 * these accounts carry staff ids and decide who gets paid, so a free signup
 * form is not a thing that can be allowed to mint one.
 */
function GoogleButton({ onError }: { onError: (message: string | null) => void }) {
  const { signInWithGoogle } = useAuth()
  const [config, setConfig] = useState<GoogleConfig | null>(null)
  const [ready, setReady] = useState(false)
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    // A failure here is not shown. Not being able to tell whether Google
    // sign-in is on is not something the person in front of the screen can
    // act on, and the password form below works either way.
    fetch("/api/auth/google/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c: GoogleConfig | null) => live && setConfig(c))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // Google's script is loaded only once we know there is a client id to give
  // it, so a college that does not use this never fetches it at all.
  useEffect(() => {
    if (!config?.enabled) return
    const existing = document.getElementById("gsi-script")
    if (existing) {
      setReady(true)
      return
    }
    const el = document.createElement("script")
    el.id = "gsi-script"
    el.src = "https://accounts.google.com/gsi/client"
    el.async = true
    el.defer = true
    el.onload = () => setReady(true)
    document.head.appendChild(el)
  }, [config?.enabled])

  useEffect(() => {
    if (!ready || !config?.client_id || !slot.current) return
    const google = (window as unknown as { google?: GoogleIdentity }).google
    if (!google) return

    google.accounts.id.initialize({
      client_id: config.client_id,
      hosted_domain: config.hosted_domain || undefined,
      callback: ({ credential }) => {
        onError(null)
        void signInWithGoogle(credential).catch((err: unknown) =>
          onError(
            err instanceof Error
              ? err.message
              : "Could not sign in with that Google account."
          )
        )
      },
    })
    google.accounts.id.renderButton(slot.current, {
      theme: "outline",
      size: "large",
      width: 336,
      text: "continue_with",
    })
  }, [ready, config, signInWithGoogle, onError])

  if (!config?.enabled) return null

  return (
    <div className="mt-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs text-fg-subtle">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {/* Google renders its own button in here; the height is reserved so the
          form does not jump when it arrives. */}
      <div ref={slot} className="grid min-h-10 place-items-center" />
      <p className="mt-3 text-xs text-fg-subtle">
        Use the Google account the college gave you. This signs you in to an
        account that already exists — it does not create one.
      </p>
    </div>
  )
}

/** The slice of Google Identity Services this page uses. */
type GoogleIdentity = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string
        hosted_domain?: string
        callback: (response: { credential: string }) => void
      }) => void
      renderButton: (
        parent: HTMLElement,
        options: { theme: string; size: string; width: number; text: string }
      ) => void
    }
  }
}
