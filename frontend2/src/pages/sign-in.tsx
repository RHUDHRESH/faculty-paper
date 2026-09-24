import { useEffect, useRef, useState, type FormEvent } from "react"
import { Eye, EyeOff, LoaderCircle } from "lucide-react"

import { useAuth } from "@/app/auth"
import { loadGoogleIdentity, type GoogleConfig } from "@/app/google"
import { useInstitution } from "@/app/institution"
import { Mark } from "@/ui/art"
import { JOURNEY } from "@/ui/journey"
import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"

/**
 * The way in.
 *
 * Two fields and one button, first on the page, because five hundred people
 * sign in here on a Monday morning and every one of them wants to be past it.
 * On a wide screen the other half carries the college and the four stages a
 * paper passes through -- the claimant's view of the chain, which names no
 * desk (see ui/journey.tsx).
 *
 * The password can be read back: the passwords this system issues are long
 * random strings handed over on paper. The email is remembered on this device
 * so the Monday-morning sign-in is one field, not two.
 */
const REMEMBER_KEY = "sign-in-email"

function rememberedEmail(): string {
  try {
    return localStorage.getItem(REMEMBER_KEY) || ""
  } catch {
    return ""
  }
}

export function SignIn() {
  const { signIn } = useAuth()
  const institution = useInstitution()
  const collegeName = institution.college_name || "the college"
  const [email, setEmail] = useState(rememberedEmail)
  const [remember, setRemember] = useState(() => rememberedEmail() !== "")
  const [password, setPassword] = useState("")
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forgot, setForgot] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      localStorage.setItem(REMEMBER_KEY, remember ? email.trim() : "")
    } catch {
      /* remembering is a convenience */
    }
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in")
      setBusy(false)
    }
  }

  const field = cn(
    "h-11 w-full rounded-md bg-surface px-3 text-base",
    "ring-1 ring-inset ring-field outline-none",
    "focus-visible:ring-2 focus-visible:ring-accent"
  )

  return (
    <div className="grid min-h-svh bg-bg lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <BrandPanel collegeName={collegeName} />

      <main className="grid place-items-center px-5 py-12">
        {/* CSS rather than the animation library: this is the first page most
            people load, and the library was a third of its JavaScript. */}
        <div className="frame-rise w-full max-w-[24rem]">
          {/* On a phone the brand panel is not drawn, so the page names the
              college itself. */}
          {/* The college's full wordmark, on the white side where its navy,
              red and yellow read as the college prints them. */}
          <img
            src="/brand/wordmark.png"
            alt={collegeName}
            width={1024}
            height={206}
            className="mb-8 h-auto w-full max-w-[22rem] dark:rounded-md dark:bg-white dark:p-2"
          />

          <h1 className="display text-xl">Sign in</h1>
          <p className="mt-1 text-base text-fg-muted">
            Use the email and password the research cell gave you.
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                autoFocus={!email}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={field}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <label htmlFor="password" className="text-sm font-medium">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => setForgot((v) => !v)}
                  aria-expanded={forgot}
                  className="text-sm text-accent hover:underline"
                >
                  Forgot your password?
                </button>
              </div>
              <div className="relative">
                <input
                  id="password"
                  type={shown ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  autoFocus={Boolean(email)}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)}
                  onBlur={() => setCaps(false)}
                  className={cn(field, "pr-11")}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShown((v) => !v)}
                  aria-label={shown ? "Hide password" : "Show password"}
                  aria-pressed={shown}
                  className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-sm text-fg-subtle hover:text-fg"
                >
                  {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {caps && (
                <p role="status" className="text-xs text-caution">
                  Caps lock is on.
                </p>
              )}
              {forgot && (
                <p role="status" className="rounded-md bg-sunken px-3 py-2 text-sm text-fg-muted">
                  Passwords are reset by the research cell, not by an email link.{" "}
                  {institution.support_email ? (
                    <>
                      Write to{" "}
                      <a
                        className="text-accent underline"
                        href={"mailto:" + institution.support_email}
                      >
                        {institution.support_email}
                      </a>{" "}
                      for a new one; you will change it on first sign-in.
                    </>
                  ) : (
                    "Ask them for a new one; you will change it on first sign-in."
                  )}
                </p>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Remember me on this device
            </label>

            {error && (
              <p
                role="alert"
                className="frame-overlay rounded-md bg-critical-wash px-3 py-2 text-sm text-critical"
              >
                {error}
              </p>
            )}

            <Button kind="primary" size="lg" type="submit" disabled={busy} className="h-11 w-full">
              {busy && <LoaderCircle className="animate-spin" />}
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <OtherWaysIn onError={setError} />

          {institution.sign_in_note && (
            <p className="mt-8 border-t border-line pt-4 text-sm text-fg-muted">
              {institution.sign_in_note}
            </p>
          )}
        </div>
      </main>
    </div>
  )
}

/**
 * The half of the page that is not the form: whose system this is, and what
 * happens to a paper filed in it. Drawn in the brand colour so the page has a
 * front, and hidden below `lg`, where the form is the whole job.
 */
function BrandPanel({ collegeName }: { collegeName: string }) {
  return (
    <aside className="relative hidden overflow-hidden bg-brand text-brand-fg lg:flex lg:flex-col lg:justify-between lg:p-12">
      <Mark className="pointer-events-none absolute -bottom-24 -right-20 size-[26rem] opacity-[0.07] grayscale" />

      <div className="relative flex items-center gap-3">
        <Mark className="size-9" />
        <div className="leading-tight">
          <p className="font-semibold">Faculty Publications</p>
          <p className="text-sm opacity-80">{collegeName}</p>
        </div>
      </div>

      <div className="frame-rise relative max-w-md [animation-delay:50ms]">
        <p className="text-[2.5rem] font-semibold leading-[1.1] tracking-[-0.03em] [text-wrap:balance]">
          File the paper once. See where it is. Get paid.
        </p>
        <p className="mt-4 text-base opacity-80">
          Paste a DOI and most of the claim fills itself in. After that it
          moves through four stages, and you can always see which one.
        </p>

        <ol className="mt-10 grid grid-cols-4 gap-2">
          {JOURNEY.map((stage, i) => (
            <li key={stage}>
              <span
                aria-hidden
                className="block h-1.5 rounded-full bg-brand-fg"
                style={{ opacity: 0.35 + i * 0.2 }}
              />
              <span className="mt-2 block text-sm font-medium">{stage}</span>
            </li>
          ))}
        </ol>
      </div>

      <p className="relative text-sm opacity-70">
        Signing in never creates an account. Every account here was made by the
        research cell.{" "}
        <a href="/privacy" className="underline underline-offset-2">
          Privacy
        </a>
      </p>
    </aside>
  )
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
 *
 * No domain hint is passed to Google. A Google account linked from the
 * profile page may be a personal Gmail, and Google's `hd` option would hide
 * it from the account chooser; the server enforces the college domain for
 * anyone who has not linked one.
 */
function GoogleButton({
  config,
  onError,
}: {
  config: GoogleConfig | null
  onError: (message: string | null) => void
}) {
  const { signInWithGoogle } = useAuth()
  const slot = useRef<HTMLDivElement>(null)

  // Google's script is loaded only once we know there is a client id to give
  // it, so a college that does not use this never fetches it at all.
  useEffect(() => {
    const clientId = config?.enabled ? config.client_id : null
    if (!clientId) return
    let live = true
    loadGoogleIdentity()
      .then((google) => {
        if (!live || !slot.current) return
        google.accounts.id.initialize({
          client_id: clientId,
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
      })
      // Not shown: the password form above works either way, and a script
      // that did not load is not something the person can act on.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [config, signInWithGoogle, onError])

  if (!config?.enabled) return null

  return (
    <div>
      {/* Google renders its own button in here; the height is reserved so the
          form does not jump when it arrives. */}
      <div ref={slot} className="grid min-h-10 place-items-center" />
      <p className="mt-3 text-xs text-fg-subtle">
        Use the Google account for the email on your account, or one you have
        linked. Not linked yet? Sign in with your email and password below,
        then link Google from your profile.
      </p>
    </div>
  )
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
  // Asked once, here, and handed to each button: every button used to ask
  // again for itself, a second round trip on the page everybody opens first.
  const [google, setGoogle] = useState<GoogleConfig | null>(null)
  const [clerk, setClerk] = useState<ClerkConfig | null>(null)

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
      <GoogleButton config={google} onError={onError} />
      <ClerkButton config={clerk} onError={onError} />
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
function ClerkButton({
  config,
  onError,
}: {
  config: ClerkConfig | null
  onError: (message: string | null) => void
}) {
  const { signInWithClerk } = useAuth()
  const [busy, setBusy] = useState(false)
  const client = useRef<ClerkClient | null>(null)

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
