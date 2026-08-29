import { useEffect, useRef, useState, type FormEvent } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Eye, EyeOff, LoaderCircle } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useCollegeName } from "@/app/institution"
import { Mark, StageTrack } from "@/ui/art"
import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"

/**
 * The way in.
 *
 * The form is still two fields and one button and it is still the first
 * thing on the page, because five hundred people sign in here on a Monday
 * morning and every one of them wants to be past it. What changed is what
 * sits beside it on a wide screen.
 *
 * That panel is not marketing. The one question the research cell's phone
 * rings about is "where has my claim got to", and the answer is a chain of
 * five desks that nobody outside the office has ever been shown. It is drawn
 * from `STAGES` in `ui/paper.tsx` — the same list every paper's progress bar
 * is built from — so it cannot describe a chain the app no longer runs. It
 * is hidden below `lg`, where the form is the whole job.
 *
 * The password can be read back. That is not a nicety: the passwords this
 * system issues look like `RzSRfIOD%V*uQYfw2_j0L#2M`, they are handed over on
 * paper, and a failed attempt cannot tell somebody whether the caps lock was
 * down or the `l` they typed was a `1`. Five failures locks the account.
 */
export function SignIn() {
  const { signIn } = useAuth()
  const collegeName = useCollegeName()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The global reduce rule in `styles.css` only reaches CSS transitions; a
  // JS-driven entrance would sail straight through it.
  const still = useReducedMotion()

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
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="grid place-items-center px-4 py-12">
        <motion.div
          initial={still ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[21rem]"
        >
          <div className="mb-7">
            {/* 64px. The mark is the only thing on this page that says whose
                system this is, so it is the size of that job and not the size
                of a favicon. */}
            <Mark className="mb-5 size-16 text-accent" title={collegeName} />
            <h1 className="text-xl font-semibold">Faculty Publication App</h1>
            <p className="mt-1 text-base text-fg-muted">{collegeName}</p>
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
                initial={still ? false : { opacity: 0, y: -4 }}
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

          <OtherWaysIn onError={setError} />
        </motion.div>
      </div>

      <WhatHappensNext still={Boolean(still)} />
    </div>
  )
}

/**
 * The half of the sign-in page that is not the form.
 *
 * Everything on it is true of this system and checkable against the code
 * that implements it: the five desks come from `STAGES`, and the two notes
 * under them are the two facts that stop the most support calls — that an
 * account here is never created by signing in, and that the password was
 * issued on paper and can be read back before it is submitted.
 *
 * Below `lg` it is not rendered at all. A person on a phone gets the form,
 * full stop.
 */
function WhatHappensNext({ still }: { still: boolean }) {
  return (
    <aside className="relative hidden overflow-hidden border-l border-line bg-sunken lg:grid lg:place-items-center">
      {/* The mark again, large enough to be texture rather than a logo, and
          light enough that it never competes with the words on top of it.
          Absolutely positioned, so it cannot move anything. */}
      <Mark className="pointer-events-none absolute -bottom-20 -right-16 size-80 text-line" />

      <motion.div
        initial={still ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-[22rem] px-4 py-12"
      >
        <h2 className="text-lg font-semibold">What happens to a paper you file</h2>
        <p className="mt-1 text-base text-fg-muted">
          Five desks, in this order. Every paper shows which one it is
          sitting on.
        </p>

        <StageTrack className="mt-6" />

        <div className="mt-2 space-y-2 border-t border-line pt-5">
          <p className="text-sm text-fg-muted">
            Signing in never creates an account — every account here was made
            by the research cell.
          </p>
          <p className="text-sm text-fg-muted">
            Your password was issued on paper. Read it back with the eye
            before you sign in; five failed attempts locks the account.
          </p>
        </div>
      </motion.div>
    </aside>
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
    <div>
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


/**
 * Everything that is not the password form.
 *
 * The divider lives here rather than in each button, because two providers
 * that each drew their own "or" produced two of them, and a college with
 * neither configured got a rule across an empty space. This asks both what
 * they are before drawing anything, and draws nothing if the answer is that
 * the password form is the only way in.
 */
function OtherWaysIn({ onError }: { onError: (message: string | null) => void }) {
  const [google, setGoogle] = useState<{ enabled: boolean } | null>(null)
  const [clerk, setClerk] = useState<{ enabled: boolean } | null>(null)

  useEffect(() => {
    let live = true
    // Neither failure is shown. Whether an alternative sign-in exists is not
    // something the person in front of the screen can act on, and the
    // password form below works either way.
    void fetch("/api/auth/google/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => live && setGoogle(c))
      .catch(() => {})
    void fetch("/api/auth/clerk/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => live && setClerk(c))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  if (!google?.enabled && !clerk?.enabled) return null

  return (
    <div className="mt-5 space-y-4">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs text-fg-subtle">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      <GoogleButton onError={onError} />
      <ClerkButton onError={onError} />
    </div>
  )
}

type ClerkConfig = { enabled: boolean; publishable_key: string | null }

/**
 * Continue with Clerk.
 *
 * Clerk is the front door and nothing else: it opens its own sign-in, and
 * what comes back is a token this app immediately trades for one of its own
 * sessions. Nothing about a role, a department or an amount is ever asked of
 * Clerk, because all of that decides who gets paid and belongs in one place.
 *
 * The SDK is imported dynamically so that a college not using Clerk never
 * downloads it. Signing in this way never creates an account — an address
 * Clerk knows and this college does not is refused, and says so.
 */
function ClerkButton({ onError }: { onError: (message: string | null) => void }) {
  const { signInWithClerk } = useAuth()
  const [config, setConfig] = useState<ClerkConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const client = useRef<ClerkClient | null>(null)

  useEffect(() => {
    let live = true
    void fetch("/api/auth/clerk/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c: ClerkConfig | null) => live && setConfig(c))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  async function start() {
    if (!config?.publishable_key) return
    setBusy(true)
    onError(null)
    try {
      if (!client.current) {
        const { Clerk } = await import("@clerk/clerk-js")
        const instance = new Clerk(config.publishable_key)
        await instance.load()
        client.current = instance as unknown as ClerkClient
      }
      const clerk = client.current

      // Already signed in to Clerk from a previous visit: go straight to the
      // exchange rather than showing a sign-in they do not need.
      let token = clerk.session ? await clerk.session.getToken() : null

      if (!token) {
        token = await new Promise<string | null>((resolve) => {
          const stop = clerk.addListener(({ session }) => {
            if (!session) return
            stop?.()
            void session.getToken().then(resolve)
          })
          clerk.openSignIn({})
        })
      }

      if (!token) {
        setBusy(false)
        return
      }
      await signInWithClerk(token)
    } catch (err) {
      // Clerk's own failures are phrased for whoever wired it up ("Clerk was
      // not loaded with Ui components"), which is no use to somebody who
      // only wants to get in. A load failure is reported as what it is --
      // the sign-in did not open -- and the password form is still there.
      const raw = err instanceof Error ? err.message : ""
      const clerkFailedToLoad =
        !raw || /clerk|ui components|failed to load|network/i.test(raw)
      onError(
        clerkFailedToLoad
          ? "Clerk did not load, so that sign-in could not be opened. Use your email and password below, or try again."
          : raw
      )
      setBusy(false)
    }
  }

  if (!config?.enabled) return null

  return (
    <div>
      <Button
        kind="default"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => void start()}
      >
        {busy && <LoaderCircle className="animate-spin" />}
        {busy ? "Signing in…" : "Continue with Clerk"}
      </Button>
      <p className="mt-3 text-xs text-fg-subtle">
        Signs you in to an account that already exists here — it does not
        create one.
      </p>
    </div>
  )
}

/** The slice of clerk-js this page uses. */
type ClerkClient = {
  session: { getToken: () => Promise<string | null> } | null
  openSignIn: (options: Record<string, unknown>) => void
  addListener: (
    handler: (payload: {
      session: { getToken: () => Promise<string | null> } | null
    }) => void
  ) => (() => void) | undefined
}
