import { useEffect, useRef, useState } from "react"
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
 * Two details that are easy to get wrong and matter:
 *
 * - **The href is followed with the router, never `window.location`.** A full
 *   page load throws away the session context the app has already fetched and
 *   flashes the sign-in screen on a slow connection.
 * - **The href is translated first.** The server emits paths from the app
 *   that existed when the notification was written — `/finance`, not
 *   `/payments` — and following one literally lands on the catch-all. That is
 *   exactly the dead link `audit/routes.mjs` exists to catch for sidebar
 *   items; a notification is just a link nobody audited.
 */

type Notification = {
  id: string
  title: string
  body: string | null
  href: string | null
  read: boolean
  created_at: string
}

/** How often the unread count is refetched while the app is open. */
const POLL_MS = 45_000

//: The server writes hrefs against whichever app was current when the
//: notification was written. These are the paths that moved.
const DESTINATIONS: Record<string, string> = {
  "/finance": "/payments",
  "/admin/clearing": "/clearing",
  "/admin/users": "/people",
  "/admin": "/",
  "/faculty": "/papers",
  "/principal": "/approvals",
}

function destinationFor(href: string | null): string | null {
  if (!href) return null
  const [path, query] = href.split("?")
  const mapped = DESTINATIONS[path] ?? path
  return query ? `${mapped}?${query}` : mapped
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
  // actually opened: polling fifty rows every forty-five seconds to render a
  // number is fifty rows nobody looked at.
  const listQuery = useApi<Notification[]>(["notifications", "list"], "/api/notifications", {
    enabled: open,
  })

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  async function follow(item: Notification) {
    setOpen(false)
    // Marked read optimistically-ish: the navigation is what the reader
    // asked for and must not wait on a bookkeeping request.
    if (!item.read) {
      void api(`/api/notifications/${item.id}/read`, { method: "POST" })
        .then(() => {
          void qc.invalidateQueries({ queryKey: ["notifications"] })
        })
        .catch(() => {})
    }
    const to = destinationFor(item.href)
    if (to) navigate(to)
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
        kind="quiet"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
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
          role="dialog"
          aria-label="Notifications"
          className={cn(
            "absolute right-0 z-50 mt-1 w-80 overflow-hidden rounded-lg bg-surface",
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
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void follow(item)}
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
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
