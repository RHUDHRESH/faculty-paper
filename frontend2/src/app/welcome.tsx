import { useState } from "react"
import { Link } from "react-router-dom"
import { X } from "lucide-react"

import { firstName } from "@/lib/names"
import { useAuth, type Me } from "@/app/auth"
import { ROLE_INTRO } from "@/app/guides"
import { api } from "@/lib/api"
import { Button } from "@/ui/button"

/** Whether the first-sign-in welcome should open for this session. */
export function shouldWelcome(me: Me | null): boolean {
  return !!me && !me.impersonated_by && me.welcome_seen === false && !me.must_change_password
}

/** Whether the welcome note belongs on this page: Home only, never over other content. */
export function welcomeOnHome(me: Me | null, pathname: string): boolean {
  return pathname === "/" && shouldWelcome(me)
}

/**
 * The first-sign-in welcome: one thin line at the top of Home, never a dialog.
 * Dismissed once, remembered on the server, never shown again. Never shows
 * while a super admin is viewing as someone.
 */
export function Welcome() {
  const { me } = useAuth()
  // Open until dismissed here. Not seeded from `me`: the auth load may still be
  // in flight when this mounts, and the line appears once `me` arrives.
  const [open, setOpen] = useState(true)
  if (!me || !open || !shouldWelcome(me)) return null

  const close = () => {
    setOpen(false)
    // Fire and forget: the worst case is seeing the welcome once more.
    void api("/api/auth/me/welcome-seen", { method: "POST" }).catch(() => {})
  }
  const first = firstName(me.name) || me.name
  const hello = me.placeholder ? "Welcome." : `Welcome, ${first}.`
  // The role's one-line purpose, first sentence only, so the line stays one line.
  const purpose = ROLE_INTRO[me.role].split(/(?<=\.)\s/)[0]

  return (
    <section
      aria-label="Welcome"
      data-testid="welcome"
      className="flex items-center gap-3 rounded-control border border-accent-line bg-accent-wash px-4 py-2 text-sm text-fg"
    >
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">{hello}</span> {purpose}
      </p>
      <Link to="/help" onClick={close} className="shrink-0 font-medium text-accent hover:underline">
        See the guides
      </Link>
      <Button kind="quiet" size="icon-sm" aria-label="Dismiss" onClick={close}>
        <X aria-hidden />
      </Button>
    </section>
  )
}
