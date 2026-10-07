import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"

import { firstName } from "@/lib/names"
import { useAuth, type Me } from "@/app/auth"
import { guidesFor, ROLE_INTRO } from "@/app/guides"
import { api } from "@/lib/api"
import { Button } from "@/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Picture } from "@/ui/picture"

const FACULTY_FIRST: { id: string; title: string; when: string; to: string }[] = [
  { id: "file", title: "File a paper", when: "Pull it from your Scopus record, tick three things, attach the files.", to: "/papers/new" },
  { id: "profile", title: "Make your profile yours", when: "A photo, your ORCID iD and a phone number, in under a minute. They help the college match your papers.", to: "/me" },
  { id: "claims", title: "See where a claim is", when: "How far it has come, and when the money is expected.", to: "/papers/claims" },
]

/** Whether the first-sign-in welcome should open for this session. */
export function shouldWelcome(me: Me | null): boolean {
  return !!me && !me.impersonated_by && me.welcome_seen === false && !me.must_change_password
}

/**
 * The first-sign-in welcome: the three things this role does most, each a
 * link to the page. Closed once, remembered on the server, never shown again.
 * Never opens while a super admin is viewing as someone.
 */
export function Welcome() {
  const { me } = useAuth()
  const [open, setOpen] = useState(() => shouldWelcome(me))
  if (!me || !shouldWelcome(me)) return null

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
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent size="lg" data-testid="welcome">
        <DialogHeader>
          <DialogTitle>{me.placeholder ? "Welcome" : `Welcome, ${first}`}</DialogTitle>
          <DialogDescription>{ROLE_INTRO[me.role]}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex items-center gap-4">
            <Picture name="onboard-welcome" eager className="size-24 shrink-0 max-sm:size-16" />
            <p className="text-sm text-fg-muted">The three things you will do most. Each one opens the right page.</p>
          </div>
          <ol className="divide-y divide-line">
            {top.map((g, i) => (
              <li key={g.id}>
                <Link
                  to={g.to}
                  onClick={close}
                  className="group flex items-start gap-3 py-3 hover:text-accent"
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-fg group-hover:text-accent">{g.title}</span>
                    <span className="block text-sm text-fg-muted">{g.when}</span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-fg-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ol>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" asChild>
            <Link to="/help" onClick={close}>
              All help guides
            </Link>
          </Button>
          <Button kind="primary" onClick={close}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
