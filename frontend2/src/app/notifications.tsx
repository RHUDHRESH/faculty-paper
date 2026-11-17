import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import {
  Award,
  Bell,
  CalendarDays,
  CheckCheck,
  Clock,
  FileCheck2,
  FilePen,
  FileText,
  FileX2,
  Handshake,
  Inbox,
  IndianRupee,
  MessageSquare,
  Quote,
  ShieldCheck,
  Target,
  type LucideIcon,
} from "lucide-react"

import { useAuth } from "@/app/auth"
import { notificationsOf, useBadges, type ShellBadges } from "@/app/badges"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { api } from "@/lib/api"
import { BADGES_KEY, useApi } from "@/lib/query"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/ui/button"
import { Avatar } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { toDisplay } from "@/ui/mention-text"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"

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

export type Notification = {
  id: string
  title: string
  body: string | null
  href: string | null
  read: boolean
  /** When it was read; null when unread, and on rows read before this was kept. */
  read_at?: string | null
  /** The thing it was about has been deleted: the row stays, the link is gone. */
  gone?: boolean
  created_at: string
  /** The kind of alert (core.services.notify.KINDS) and the tab it sits under. */
  kind?: string
  section?: string
  /** How many things one grouped line stands for: "Asha and 2 others ...". */
  count?: number
  /** Whoever did it most recently, with a face; null for system lines. */
  actor?: { user_id: string; name: string; initials: string; photo_url: string | null } | null
  /** Set on "Approved for payment" and "Paid" for your own paper: offer to share it. */
  share_paper_id?: string | null
}

/** The filter tabs, shared by the bell and the notifications screen. */
export const SECTION_TABS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "papers", label: "Papers" },
  { key: "people", label: "People" },
  { key: "work", label: "Work" },
  { key: "updates", label: "Updates" },
]

/**
 * The tabs a person can use. "Work" holds the alerts about papers reaching a
 * queue somebody works from; a faculty member has no queue, so an always-empty
 * tab would only ask them what it means.
 */
export function sectionTabsFor(role: string | undefined): { key: string; label: string }[] {
  return role === "FACULTY" || role === "HOD" ? SECTION_TABS.filter((t) => t.key !== "work") : SECTION_TABS
}

/** Which rows the page shows: everything, what is unread, or what has been read. */
export type ReadState = "" | "unread" | "read"

/** The list's address: a tab, a read state, and how many rows (one more than shown tells there are more). */
export function listPath(section: string, state: ReadState = "", limit?: number): string {
  const q = new URLSearchParams()
  if (section) q.set("section", section)
  if (state) q.set("state", state)
  if (limit) q.set("limit", String(limit))
  const text = q.toString()
  return text ? `/api/notifications?${text}` : "/api/notifications"
}

/** The number a grouped line stands for, beside its title. */
export function GroupCount({ count }: { count?: number }) {
  if (!count || count < 2) return null
  return (
    <span
      title={`${count} in this line`}
      className="shrink-0 rounded-full bg-sunken px-1.5 text-xs font-medium tabular-nums text-fg-muted"
    >
      {count}
    </span>
  )
}

/**
 * How often the open panel's rows are refetched. The unread count behind the
 * badge is not polled here: it rides the shell's one badges request
 * (`app/badges.ts`).
 */
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

//: A desk alert names a paper in a queue (`/principal?claim=ID`). The queue page
//: does not open papers by itself; the review page does, with the queue's name
//: so its rail lists the same papers.
const DESK_QUEUES: Record<string, string> = {
  "/admin/clearing": "clearing",
  "/clearing": "clearing",
  "/principal": "approvals",
  "/approvals": "approvals",
  "/authorisations": "authorisations",
}
//: Mirrors REVIEW_DESKS in main.tsx: Finance pays from its own list and has no
//: review page.
const REVIEWERS = ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR"]

export function destinationFor(href: string | null, role?: string): string | null {
  if (!href) return null
  const [path, query] = href.split("?")
  const claim = new URLSearchParams(query ?? "").get("claim")
  const queue = DESK_QUEUES[path]
  if (claim && queue && (!role || REVIEWERS.includes(role))) return `/review/${claim}?queue=${queue}`
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

export function relative(iso: string): string {
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

/**
 * Reading, as the bell and the page both do it.
 *
 * Every answer from the server carries the new unread count. It is written
 * into the badge at once, so the number never says something already wrong
 * while the real one is on its way, and then the badge and every list are
 * read again to confirm it.
 */
export function useNotificationActions() {
  const qc = useQueryClient()

  function settle(unread: number | undefined) {
    if (typeof unread === "number") {
      qc.setQueryData<ShellBadges>(BADGES_KEY, (old) =>
        old ? { ...old, notifications: { unread } } : old
      )
    }
    void qc.invalidateQueries({ queryKey: BADGES_KEY })
    return qc.invalidateQueries({ queryKey: ["notifications"] })
  }

  /** One alert read. Never throws: a bookkeeping request must not block where the reader is going. */
  function markRead(id: string): Promise<void> {
    return api<{ unread?: number }>(`/api/notifications/${id}/read`, { method: "POST" })
      .then((r) => void settle(r?.unread))
      .catch(() => {})
  }

  /** Everything read, or one tab's worth when `section` is given. */
  async function markAll(section = ""): Promise<void> {
    try {
      const r = await api<{ unread?: number }>(
        `/api/notifications/read-all${section ? `?section=${section}` : ""}`,
        { method: "POST" }
      )
      await settle(r?.unread)
      toast.ok("Marked all read.")
    } catch (err) {
      toast.fail(err)
    }
  }

  return { markRead, markAll }
}

/** When it was read, in the words the list uses: "Read 12 Nov", or just "Read". */
export function readLabel(item: { read: boolean; read_at?: string | null }): string {
  if (!item.read) return "Unread"
  if (!item.read_at) return "Read"
  const at = new Date(item.read_at)
  if (Number.isNaN(at.getTime())) return "Read"
  return `Read ${at.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
}

export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState("")
  const { me } = useAuth()
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const { markRead, markAll } = useNotificationActions()

  // `unread`, not `count` — the endpoint's own key, whatever API.md said.
  const unreadQuery = useBadges(notificationsOf)
  const unread = unreadQuery.data?.unread ?? 0

  // The list is a bare array, not an envelope. Only fetched once the bell is
  // actually opened: fifty rows on a timer to render one number is fifty rows
  // nobody looked at. While it is open it polls, so the rows stay current.
  const listQuery = useApi<Notification[]>(["notifications", "list", section], listPath(section), {
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

  function follow(item: Notification) {
    // Marked read optimistically-ish: the navigation is what the reader asked
    // for and must not wait on a bookkeeping request.
    if (!item.read) void markRead(item.id)
    const to = item.gone ? null : destinationFor(item.href, me?.role)
    // A notification with nowhere to go still has to be markable, and closing
    // the panel on it would read as the click having done nothing at all.
    if (!to) return
    close(false)
    navigate(to)
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
                "rounded-full bg-critical px-1 text-xs font-semibold leading-4 text-accent-fg"
              )}
            >
              {formatCount(unread)}
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
            // Both bells now sit at the right-hand end of a bar along the top
            // (the 64px desktop bar from lg up, the 48px header below it), so
            // the panel hangs from the bell's bottom edge and ends at its right
            // edge. It used to open upward and rightward from the bell, which
            // was right when the desktop bell lived in the sidebar's footer and
            // put the whole panel above the top of the screen once it moved.
            "absolute right-0 top-full mt-1",
            "z-50 w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg bg-surface",
            "shadow-pop ring-1 ring-inset ring-edge"
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <Button kind="quiet" size="sm" onClick={() => void markAll(section)} className="-mr-1.5">
                <CheckCheck />
                Mark all read
              </Button>
            )}
          </div>

          <div
            role="tablist"
            aria-label="Which notifications"
            className="flex gap-0.5 overflow-x-auto border-b border-line px-2 py-1.5"
          >
            {sectionTabsFor(me?.role).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={section === t.key}
                onClick={() => setSection(t.key)}
                className={cn(
                  "h-7 shrink-0 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors",
                  "duration-[var(--dur-1)] ease-out",
                  section === t.key
                    ? "bg-action text-action-fg ring-transparent"
                    : "text-fg-muted ring-transparent hover:bg-hover hover:text-fg hover:ring-edge"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {listQuery.isLoading ? (
              <p className="px-3 py-8 text-center text-sm text-fg-muted">Loading…</p>
            ) : listQuery.isError ? (
              <p className="px-3 py-8 text-center text-sm text-critical">
                Could not load these. Nothing has been lost.
              </p>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                <Picture name="empty-no-notifications" className="w-28" />
                <p className="text-sm text-fg-muted">
                  {section ? "Nothing in this tab." : "You are all caught up."}
                </p>
              </div>
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
                        "block w-full px-3 py-2.5 text-left transition-colors outline-none",
                        "duration-[var(--dur-1)] ease-out hover:bg-hover",
                        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                        !item.read && "bg-accent-wash"
                      )}
                    >
                      <NotificationLine item={item} compact />
                    </button>
                    {item.share_paper_id && (
                      // Outside the row's button: a control inside a control is
                      // two targets a screen reader announces as one.
                      <div className="pb-2 pl-14 pr-3">
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
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-sm">
            <Link
              to="/notifications"
              onClick={() => close(false)}
              className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            >
              See all
            </Link>
            <Link
              to="/settings/notifications"
              onClick={() => close(false)}
              className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            >
              Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

/** Today, Earlier this week, Older -- in that order, empty groups left out.
 *  "This week" starts on Monday, as the weekly summary does. */
export function groupByDay<T extends { created_at: string }>(
  items: T[],
  now: Date = new Date()
): [string, T[]][] {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const monday = today - ((start.getDay() + 6) % 7) * 86_400_000
  const groups: Record<string, T[]> = { Today: [], "Earlier this week": [], Older: [] }
  for (const item of items) {
    const t = new Date(item.created_at).getTime()
    groups[t >= today ? "Today" : t >= monday ? "Earlier this week" : "Older"].push(item)
  }
  return (["Today", "Earlier this week", "Older"] as const)
    .filter((k) => groups[k].length)
    .map((k) => [k, groups[k]])
}

/** A small glyph for what the line is about, when no person did it. */
const KIND_ICONS: Record<string, LucideIcon> = {
  claim_approved: FileCheck2,
  claim_paid: IndianRupee,
  claim_sent_back: FilePen,
  claim_not_accepted: FileX2,
  claim_status: FileText,
  citation: Quote,
  digest: CalendarDays,
  nudge_cutoff: Clock,
  nudge_quota: Clock,
  desk: Inbox,
  message: MessageSquare,
  collab: Handshake,
  badge: Award,
  target: Target,
  moderation: ShieldCheck,
}

/** The face of whoever did it, or the kind's glyph. */
export function NotificationLead({ item }: { item: Notification }) {
  if (item.actor) return <Avatar person={item.actor} size="sm" />
  const Icon = (item.kind && KIND_ICONS[item.kind]) || Bell
  return (
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-sunken">
      <Icon className="size-4 text-fg-muted" />
    </span>
  )
}

/** One line: lead, what happened, when, and a dot while unread. */
export function NotificationLine({ item, compact }: { item: Notification; compact?: boolean }) {
  return (
    <span className="flex items-start gap-3">
      <NotificationLead item={item} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 text-sm", compact && "truncate", !item.read && "font-medium")}>
            {item.title}
          </span>
          <GroupCount count={item.count} />
          <Meta className="shrink-0 text-xs">{relative(item.created_at)}</Meta>
        </span>
        {item.body && (
          <span
            className={cn(
              "mt-0.5 block text-sm text-fg-muted",
              compact ? "line-clamp-2" : "line-clamp-3 whitespace-pre-line"
            )}
          >
            {toDisplay(item.body).text}
          </span>
        )}
        {item.gone && <span className="mt-0.5 block text-sm text-fg-subtle">No longer available.</span>}
      </span>
      <span className="flex h-5 w-2 shrink-0 items-center">
        {!item.read && <span role="img" aria-label="Unread" className="size-2 rounded-full bg-accent" />}
      </span>
    </span>
  )
}
