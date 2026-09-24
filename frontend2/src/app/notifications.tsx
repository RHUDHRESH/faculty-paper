import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Bell } from "lucide-react"

import { cn } from "@/lib/cn"
import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/ui/button"
import { Meta } from "@/ui/text"

/**
 * The bell, and what is behind it.
 *
 * The server has been writing notifications all along — every stage a ticket
 * moves through writes one, to the desk that has to act next — and until now
 * nothing in this app read them. The header carried a bell that was not
 * wired to anything. So the system has been talking to 508 people into a
 * void, and the desks that were told a ticket needed them found out by
 * opening a queue and looking.
 *
 * Three details that are easy to get wrong and matter:
 *
 * - **The href is followed with the router, never `window.location`.** A full
 *   page load throws away the session context the app has already fetched and
 *   flashes the sign-in screen on a slow connection.
 * - **The href is translated first, and by prefix.** The server emits paths
 *   from the app that existed when the notification was written —
 *   `/finance`, not `/payments` — and following one literally lands on the
 *   catch-all. Matching whole paths only is not enough: `/faculty/profile`
 *   and `/admin/profile-requests` are both real notifications and neither is
 *   a bare section root, so a table keyed on exact paths sent both to Not
 *   Found. That is the dead link `audit/routes.mjs` exists to catch for
 *   sidebar items; a notification is just a link nobody audited.
 * - **The panel is anchored per mount point in both axes.** This bell is
 *   mounted twice and the two sit at opposite corners of the screen, so one
 *   set of offsets puts one of them off the edge — which is invisible in
 *   review, because whichever mount you are looking at is the one that works.
 */

type Notification = {
  id: string
  title: string
  body: string | null
  href: string | null
  read: boolean
  created_at: string
  /** Set on "Approved for payment" and "Paid" for your own paper: offer to share it. */
  share_paper_id?: string | null
}

/** How often the unread count is refetched while the app is open. */
const POLL_MS = 45_000

//: The server writes hrefs against whichever app was current when the
//: notification was written. These are the paths that moved. A moved leaf can
//: differ from its moved section, so the leaves are listed in their own right.
const DESTINATIONS: Record<string, string> = {
  "/admin/profile-requests": "/requests",
  "/admin/clearing": "/clearing",
  "/admin/users": "/people",
  "/faculty/profile": "/me",
  "/finance": "/payments",
  "/faculty": "/papers",
  "/principal": "/approvals",
  "/admin": "/",
}

function destinationFor(href: string | null): string | null {
  if (!href) return null
  const [path, query] = href.split("?")
  // Walk up the path so an unlisted child of a section that moved lands on the
  // section rather than on the catch-all. A notification that opens Not Found
  // is worse than one that opens the queue it was about.
  let candidate = path
  let mapped: string | null = null
  while (candidate) {
    const hit = DESTINATIONS[candidate]
    if (hit !== undefined) {
      mapped = hit
      break
    }
    const cut = candidate.lastIndexOf("/")
    if (cut <= 0) break
    candidate = candidate.slice(0, cut)
  }
  const to = mapped ?? path
  return query ? `${to}?${query}` : to
}

function relative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()

  // `unread`, not `count` — the endpoint's own key, whatever API.md said.
  const unreadQuery = useApi<{ unread: number }>(
    ["notifications", "unread"],
    "/api/notifications/unread-count",
    { refetchInterval: POLL_MS, staleTime: POLL_MS }
  )
  const unread = unreadQuery.data?.unread ?? 0

  // The list is a bare array, not an envelope. Only fetched once the bell is
  // actually opened: polling fifty rows every forty-five seconds to render one
  // number is fifty rows nobody looked at. While it is open it polls alongside
  // the count, so the badge and the rows beneath it cannot disagree.
  const listQuery = useApi<Notification[]>(["notifications", "list"], "/api/notifications", {
    enabled: open,
    refetchInterval: open ? POLL_MS : false,
    refetchOnMount: "always",
  })

  // Closing is not only `setOpen(false)`: a reader who opened the panel from
  // the keyboard is left with nothing focused, and the next Tab starts again
  // from the top of the document.
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) bellRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      // Swallowed, so Escape closes the panel without also closing whatever
      // the panel is sitting on top of.
      event.stopPropagation()
      close(true)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  // Opening moves focus into the panel, otherwise the reader's next Tab lands
  // on whatever follows the bell in the sidebar and never enters the dialog.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  function rows(): HTMLButtonElement[] {
    const found = panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-row]")
    return found ? Array.from(found) : []
  }

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const list = rows()
    if (list.length === 0) return
    event.preventDefault()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    if (event.key === "Home") next = 0
    else if (event.key === "End") next = list.length - 1
    else if (event.key === "ArrowDown") next = at < 0 ? 0 : Math.min(at + 1, list.length - 1)
    else next = at < 0 ? list.length - 1 : Math.max(at - 1, 0)
    list[next]?.focus()
  }

  function markRead(id: string): Promise<void> {
    return api(`/api/notifications/${id}/read`, { method: "POST" })
      .then(() => {
        // The prefix key invalidates both the count behind the badge and the
        // rows in the panel, which is the whole reason they are nested under
        // one name rather than being two unrelated keys.
        void qc.invalidateQueries({ queryKey: ["notifications"] })
      })
      .catch(() => {})
  }

  function follow(item: Notification) {
    // Marked read optimistically-ish: the navigation is what the reader asked
    // for and must not wait on a bookkeeping request.
    if (!item.read) void markRead(item.id)
    const to = destinationFor(item.href)
    // A notification with nowhere to go still has to be markable, and closing
    // the panel on it would read as the click having done nothing at all.
    if (!to) return
    close(false)
    navigate(to)
  }

  async function markAll() {
    try {
      await api("/api/notifications/read-all", { method: "POST" })
      await qc.invalidateQueries({ queryKey: ["notifications"] })
    } catch {
      // Nothing is lost by a failed mark-all; the rows are still there.
    }
  }

  const items = listQuery.data ?? []

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <Button
        ref={bellRef}
        kind="quiet"
        size="icon"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="relative inline-flex">
          <Bell />
          {unread > 0 && (
            <span
              className={cn(
                "absolute -right-1.5 -top-1 grid min-w-[1.05rem] place-items-center",
                "rounded-full bg-critical px-1 text-[10px] font-semibold leading-4 text-accent-fg"
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </span>
      </Button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          className={cn(
            // Anchored per mount point in BOTH axes, because this bell has two
            // and the two sit at opposite corners of the screen.
            //
            // Horizontally: in the mobile header it is flush right, so right-0
            // is correct there. In the desktop sidebar its wrapper is only as
            // wide as the button -- about 32px at the very left edge -- so
            // right-0 put the right edge of a 320px panel at x=40 and the rest
            // off the side of the screen. From md up it opens rightward.
            "absolute right-0 md:right-auto md:left-0",
            // Vertically: the mobile bell is in a 48px header at the top of the
            // screen, so it drops down. The desktop bell is in the sidebar's
            // footer, roughly 50px above the bottom of a full-height column, so
            // dropping down put a 420px panel almost entirely below the fold --
            // the same bug as the horizontal one, one axis over.
            "top-full mt-1 md:bottom-full md:top-auto md:mb-1 md:mt-0",
            "z-50 w-80 overflow-hidden rounded-lg bg-surface",
            "shadow-pop ring-1 ring-inset ring-edge"
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAll()}
                className="text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {listQuery.isLoading ? (
              <p className="px-3 py-8 text-center text-sm text-fg-muted">Loading…</p>
            ) : listQuery.isError ? (
              <p className="px-3 py-8 text-center text-sm text-critical">
                Could not load these. Nothing has been lost.
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-fg-muted">
                Nothing yet. You will hear when a ticket needs you.
              </p>
            ) : (
              <>
              {groupByDay(items).map(([label, group]) => (
              <div key={label}>
              <p className="sticky top-0 z-10 bg-surface px-3 pb-1 pt-2 text-xs font-medium text-fg-subtle">
                {label}
              </p>
              <ul className="divide-y divide-line">
                {group.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-row=""
                      onClick={() => follow(item)}
                      className={cn(
                        "block w-full px-3 py-2.5 text-left transition-colors",
                        "duration-[var(--dur-1)] ease-out hover:bg-hover",
                        !item.read && "bg-accent-wash"
                      )}
                    >
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-sm",
                            !item.read && "font-medium"
                          )}
                        >
                          {item.title}
                        </span>
                        <Meta className="shrink-0 text-xs">{relative(item.created_at)}</Meta>
                      </span>
                      {item.body && (
                        <span className="mt-0.5 line-clamp-2 block text-sm text-fg-muted">
                          {item.body}
                        </span>
                      )}
                    </button>
                    {item.share_paper_id && (
                      // Outside the row's button: a control inside a control is
                      // two targets a screen reader announces as one.
                      <div className="px-3 pb-2">
                        <Button
                          kind="default"
                          size="sm"
                          onClick={() => {
                            if (!item.read) void markRead(item.id)
                            close(false)
                            navigate(`/discussions?share=${item.share_paper_id}`)
                          }}
                        >
                          Share to the feed
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              </div>
              ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Today, Yesterday, Earlier -- in that order, empty groups left out. */
function groupByDay<T extends { created_at: string }>(items: T[]): [string, T[]][] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const yesterday = today - 86_400_000
  const groups: Record<string, T[]> = { Today: [], Yesterday: [], Earlier: [] }
  for (const item of items) {
    const t = new Date(item.created_at).getTime()
    groups[t >= today ? "Today" : t >= yesterday ? "Yesterday" : "Earlier"].push(item)
  }
  return (["Today", "Yesterday", "Earlier"] as const)
    .filter((k) => groups[k].length)
    .map((k) => [k, groups[k]])
}
