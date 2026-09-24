import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { PartyPopper, X } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { badgeIcon, type Badge } from "@/ui/badge-shelf"
import { enterTransition, exitTransition } from "@/ui/motion"

export type Celebration = {
  id: string
  kind: "BADGE" | "TARGET"
  title: string
  body: string
  created_at: string
  badge: Badge | null
}

/**
 * A new badge, or the department reaching a target, said once on the home
 * screen and then never again.
 *
 * "Once" is kept by the server, not by this browser: the items are marked
 * seen the moment they are drawn, so the same news does not greet somebody a
 * second time on their phone. Nothing here asks for anything back -- no
 * "keep it up", no streak to protect -- because a celebration that turns into
 * a demand is not a celebration.
 *
 * A super admin viewing as somebody sees the panel but does not use it up;
 * the person it is for still gets to see it. Draws nothing on error or when
 * there is nothing to celebrate.
 */
export function Celebrations({ className }: { className?: string }) {
  const { me } = useAuth()
  const viewing = Boolean(me?.impersonated_by)
  const query = useApi<{ celebrations: Celebration[] }>(["celebrations"], "/api/me/celebrations", {
    staleTime: Infinity,
  })
  const client = useQueryClient()
  const [open, setOpen] = useState(true)
  // What this visit shows, fixed when it first arrives: the cached list is
  // emptied as soon as the server has it as seen (below), and the panel on
  // screen must not vanish mid-read because of that.
  const [shown, setShown] = useState<Celebration[] | null>(null)
  const marked = useRef(false)
  const fetched = query.data?.celebrations
  const items = shown ?? fetched ?? []

  useEffect(() => {
    if (shown === null && fetched && fetched.length > 0) setShown(fetched)
  }, [fetched, shown])

  useEffect(() => {
    if (viewing || marked.current || items.length === 0) return
    marked.current = true
    // Seen is recorded on the server, and the cached copy is emptied with it:
    // the query never goes stale on its own, so leaving the page and coming
    // back would otherwise draw the same news a second time. A failure only
    // means it is shown again next visit -- the harmless direction.
    api("/api/me/celebrations/seen", { method: "POST", json: { ids: items.map((c) => c.id) } })
      .then(() => client.setQueryData(["celebrations"], { celebrations: [] }))
      .catch(() => {})
  }, [items, viewing, client])

  if (query.isError || items.length === 0) return null

  return (
    <AnimatePresence initial>
      {open && (
        <motion.section
          aria-label="Something to celebrate"
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: enterTransition }}
          exit={{ opacity: 0, y: -6, transition: exitTransition }}
          className={className}
        >
          <div className="panel-lead relative p-5 sm:p-6">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="absolute top-3 right-3 grid size-8 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
            >
              <X className="size-4" />
            </button>
            <p className="flex items-center gap-2 pr-10 text-sm font-medium text-accent">
              <PartyPopper className="size-4" aria-hidden />
              {items.length === 1 ? "Something to celebrate" : `${items.length} things to celebrate`}
            </p>
            <ul className="mt-3 space-y-3">
              {items.map((c) => (
                <CelebrationRow key={c.id} item={c} />
              ))}
            </ul>
            {items.some((c) => c.kind === "BADGE") && (
              <Link to="/me#badges" className="mt-4 inline-block text-sm text-accent hover:underline">
                See all your badges
              </Link>
            )}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}

function CelebrationRow({ item: c }: { item: Celebration }) {
  const Icon = c.badge ? badgeIcon(c.badge.kind) : PartyPopper
  return (
    <li className="flex min-w-0 items-start gap-3">
      <motion.span
        aria-hidden
        initial={{ scale: 0.6, rotate: -8 }}
        animate={{ scale: 1, rotate: 0, transition: { type: "spring", stiffness: 380, damping: 14 } }}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg"
      >
        <Icon className="size-5" />
      </motion.span>
      <div className="min-w-0">
        <p className="text-lg font-semibold">{c.title}</p>
        {c.body && <p className="line-clamp-2 text-sm text-fg-muted">{c.body}</p>}
      </div>
    </li>
  )
}
