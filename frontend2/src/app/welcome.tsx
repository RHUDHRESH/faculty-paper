import { useState } from "react"
import { Link } from "react-router-dom"
import { X } from "lucide-react"

import { firstName } from "@/lib/names"
import { useAuth, type Me } from "@/app/auth"
import { guidesFor, ROLE_INTRO } from "@/app/guides"
import { api } from "@/lib/api"
import { Button } from "@/ui/button"

const FACULTY_FIRST: { id: string; title: string; when: string; to: string }[] = [
  { id: "file", title: "File a paper", when: "Pull it from your Scopus record, tick three things, attach the files.", to: "/papers/new" },
  { id: "profile", title: "Make your profile yours", when: "A photo, your ORCID iD and a phone number, in under a minute. They help the college match your papers.", to: "/me" },
  { id: "claims", title: "See where a claim is", when: "How far it has come, and when the money is expected.", to: "/papers/claims" },
]

/** Whether the first-sign-in welcome should open for this session. */
export function shouldWelcome(me: Me | null): boolean {
  return !!me && !me.impersonated_by && me.welcome_seen === false && !me.must_change_password
}

/** Whether the welcome note belongs on this page: Home only, never over other content. */
export function welcomeOnHome(me: Me | null, pathname: string): boolean {
  return pathname === "/" && shouldWelcome(me)
}

/**
 * The first-sign-in welcome: an inline note at the top of Home, never a dialog.
 * The three things this role does most, each a link to the page. Closed once,
 * remembered on the server, never shown again. Never shows while a super admin
 * is viewing as someone.
 */
export function Welcome() {
  const { me } = useAuth()
  // Open until closed here. Not seeded from `me`: the auth load may still be
  // in flight when this mounts, and the note appears once `me` arrives.
  const [open, setOpen] = useState(true)
  // On phones only the first item shows until the person asks for the rest.
  const [showRest, setShowRest] = useState(false)
  if (!me || !open || !shouldWelcome(me)) return null

  const close = () => {
    setOpen(false)
    // Fire and forget: the worst case is seeing the welcome once more.
    void api("/api/auth/me/welcome-seen", { method: "POST" }).catch(() => {})
  }
  // A faculty member's first minute is theirs to spend on three things, in
  // this order: the paper, the face and IDs the college matches them by, and
  // where a claim stands. The generic guides stay for every other role.
  const top = me.role === "FACULTY" ? FACULTY_FIRST : guidesFor(me.role).slice(0, 3)
  const first = firstName(me.name) || me.name

  return (
    <section aria-label="Welcome" data-testid="welcome" className="rounded-2xl bg-surface px-5 py-4 ring-1 ring-line">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold">{me.placeholder ? "Welcome" : `Welcome, ${first}`}</h2>
        <Button kind="quiet" size="icon-sm" aria-label="Dismiss the welcome" onClick={close}>
          <X aria-hidden />
        </Button>
      </div>
      <p className="mt-1 max-w-[65ch] text-sm text-fg-muted">{ROLE_INTRO[me.role]}</p>
      <ol className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
        {top.map((g, i) => (
          <li key={g.id} className={i > 0 && !showRest ? "hidden sm:block" : undefined}>
            <Link to={g.to} onClick={close} className="group flex items-start gap-3 hover:text-accent">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-fg group-hover:text-accent">{g.title}</span>
                <span className="block text-sm text-fg-muted">{g.when}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {!showRest && top.length > 1 && (
        <Button kind="quiet" size="sm" className="mt-3 sm:hidden" onClick={() => setShowRest(true)}>
          Show the rest
        </Button>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button kind="default" size="sm" onClick={close}>
          Got it
        </Button>
        <Button kind="quiet" size="sm" asChild>
          <Link to="/help" onClick={close}>
            All help guides
          </Link>
        </Button>
      </div>
    </section>
  )
}
