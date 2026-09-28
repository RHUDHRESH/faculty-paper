import { useState } from "react"
import { Link, Navigate, NavLink, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeft, Building2, CircleCheck, Lock, MessageCircle, PenLine, Search } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { ChatPage, Faces, INBOX_POLL_MS, NewChat, OpenChat, type InboxRow } from "@/pages/chat"
import { NewConversation, Thread, type ThreadRow } from "@/pages/discussions"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { Avatar } from "@/ui/person"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { Ago } from "@/ui/when"

/**
 * Messages: one inbox, and a conversation is a conversation (docs/ux/10).
 *
 * Two panes on a desktop -- the inbox on the left, whatever is open on the
 * right -- and one pane at a time on a phone, with a back arrow. The research
 * office is a pinned row at the top of the inbox rather than a tab; its
 * titled conversations open in the same right-hand pane.
 *
 * Nothing about who may read what is decided here. `/api/dm` returns only the
 * conversations you are in, `/api/threads?visibility=OFFICE` only yours with
 * the office (or the whole queue for the office itself), and a conversation
 * you are not in answers 404.
 *
 * Routes, all rendering this one layout:
 *   /messages              nothing open: "Start a conversation"
 *   /messages?to=<id>[&ctx=paper:<id>]  straight into the chat with that person,
 *                          with what it is about offered as a context card
 *   /messages/c/:id        a direct or group conversation
 *   /messages/office       the research office
 *   /messages/o/:id        one conversation with the office
 * Old links: `?lane=office` lands on /messages/office, `/messages/:id` opens
 * inside this two-pane layout
 * through `Thread` (and a direct one is redirected to /c/). The inbox is the
 * one merged `/api/dm` list; office threads in it carry kind "office".
 */

type Pane = "start" | "chat" | "office" | "office-thread"

const OFFICE_NAVY = "bg-[var(--color-brand)] text-white"

export function MessagesPage({ pane }: { pane: Pane }) {
  const [params] = useSearchParams()
  const to = params.get("to")
  const [composing, setComposing] = useState(false)

  if (pane === "start" && params.get("lane") === "office") return <Navigate to="/messages/office" replace />

  const open = pane !== "start" || !!to
  return (
    <div className="page">
      <div
        className={cn(
          "flex overflow-hidden md:h-[calc(100dvh-4rem)] md:rounded-xl md:border md:border-line md:bg-surface",
          // A phone has room for one pane: the header plus the page padding.
          "min-h-[calc(100dvh-7rem)] md:min-h-0"
        )}
      >
        <aside
          aria-label="Conversations"
          className={cn(
            "w-full shrink-0 flex-col md:flex md:w-[340px] md:border-r md:border-line",
            open ? "hidden" : "flex"
          )}
        >
          <InboxPane onNew={() => setComposing(true)} />
        </aside>
        <section
          aria-label="Conversation"
          className={cn("min-w-0 flex-1 flex-col bg-bg md:flex", open ? "flex" : "hidden")}
        >
          {to ? (
            <OpenChat to={to} refPost={params.get("ref")} draft={params.get("draft")} ctx={params.get("ctx")} />
          ) : pane === "chat" ? (
            <ChatPage />
          ) : pane === "office" ? (
            <OfficePane />
          ) : pane === "office-thread" ? (
            <OfficeThreadPane />
          ) : (
            <StartPane onNew={() => setComposing(true)} />
          )}
        </section>
      </div>

      {/* The phone's New: a floating button, over the inbox only. */}
      {!open && (
        <Button
          kind="primary"
          size="lg"
          onClick={() => setComposing(true)}
          aria-label="New message"
          className="fixed bottom-5 right-5 z-20 size-14 rounded-full shadow-[var(--shadow-pop)] md:hidden"
        >
          <PenLine />
        </Button>
      )}
      {composing && <NewChat onClose={() => setComposing(false)} />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The inbox                                                                 */
/* ------------------------------------------------------------------------ */

function InboxPane({ onNew }: { onNew: () => void }) {
  const [q, setQ] = useState("")
  const needle = q.trim().toLowerCase()
  const inbox = useApi<{ results: InboxRow[] }>(["dm", "inbox"], "/api/dm", {
    refetchInterval: INBOX_POLL_MS,
  })

  // One list from the server (docs/ux/10): office threads arrive in it with
  // kind "office" and are gathered into the pinned row; the rest are Recent.
  const all = inbox.data?.results ?? []
  const office = all.filter((r) => r.kind === "office")
  // Searched here rather than on the server: it is your own fifty most recent
  // conversations, already on screen.
  const rows = all.filter((r) => r.kind !== "office").filter(
    (r) =>
      !needle ||
      r.title.toLowerCase().includes(needle) ||
      (r.last?.body ?? "").toLowerCase().includes(needle) ||
      r.people.some((p) => p.name.toLowerCase().includes(needle))
  )

  return (
    <>
      <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-1 md:pt-4">
        <h1 className="display text-[1.75rem] leading-9">Messages</h1>
        <Button kind="primary" size="sm" onClick={onNew} className="hidden md:inline-flex">
          <PenLine />
          New
        </Button>
      </header>
      <div className="relative mx-4 mb-3">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people and messages"
          aria-label="Search people and messages"
          className="w-full pl-9"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-24 md:pb-2">
        <GroupHead>Pinned</GroupHead>
        <OfficeRow rows={office} />
        <GroupHead>Recent</GroupHead>
        {inbox.isPending ? (
          <div className="px-4">
            <SkeletonRows rows={5} rowHeight={56} />
          </div>
        ) : inbox.isError ? (
          <div className="px-4">
            <ErrorState
              title="Could not load your messages"
              message="The server did not answer. Nothing has been sent, lost or deleted."
              onRetry={() => void inbox.refetch()}
            />
          </div>
        ) : rows.length === 0 ? (
          <Meta className="block px-4 py-6 text-sm">
            {needle ? "Nothing matches. Try part of a name." : "No conversations yet."}
          </Meta>
        ) : (
          <ul>
            {rows.map((r) => (
              <li key={r.id}>
                <InboxLink to={`/messages/c/${r.id}`}>
                  <Faces people={r.people} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm",
                          r.unread > 0 ? "font-semibold" : "font-medium"
                        )}
                      >
                        {r.is_group ? "Group: " : ""}
                        {r.title}
                      </span>
                      {r.last && (
                        <Meta className="shrink-0 text-xs">
                          <Ago iso={r.last.at} />
                        </Meta>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={cn("min-w-0 flex-1 truncate text-sm", r.unread ? "text-fg" : "text-fg-muted")}>
                        {r.last
                          ? `${r.last.mine ? "You: " : ""}${r.last.body || "A message was removed"}`
                          : "No messages yet"}
                      </span>
                      <Unread n={r.unread} />
                    </span>
                  </span>
                </InboxLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function GroupHead({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-[0.04em] text-fg-subtle">{children}</p>
}

function InboxLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 px-4 py-2.5 transition-colors duration-[var(--dur-1)] ease-out",
          isActive ? "bg-[var(--area-people-wash)] shadow-[inset_3px_0_0_var(--area-people)]" : "hover:bg-hover"
        )
      }
    >
      {children}
    </NavLink>
  )
}

function Unread({ n }: { n: number }) {
  if (!n) return null
  return (
    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--area-people)] px-1.5 text-xs font-semibold text-white tabular dark:text-bg">
      <span className="sr-only">Unread: </span>
      {n}
    </span>
  )
}

function OfficeAvatar({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        OFFICE_NAVY,
        size === "lg" ? "size-12" : "size-10"
      )}
      aria-hidden
    >
      <Building2 className={size === "lg" ? "size-6" : "size-5"} />
    </span>
  )
}

type ThreadList = { total: number; results: ThreadRow[] }

function useOfficeThreads() {
  return useApi<ThreadList>(["threads", "office", "inbox"], "/api/threads?visibility=OFFICE&limit=25", {
    refetchInterval: INBOX_POLL_MS,
  })
}

function OfficeRow({ rows }: { rows: InboxRow[] }) {
  // Already newest first from the server.
  const latest = rows[0]
  const open = rows.filter((t) => !t.resolved).length
  const unread = rows.reduce((n, r) => n + (r.unread || 0), 0)
  return (
    <InboxLink to="/messages/office">
      <OfficeAvatar />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>
            Research office
          </span>
          {latest && (
            <Meta className="shrink-0 text-xs">
              <Ago iso={latest.updated_at} />
            </Meta>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "text-fg" : "text-fg-muted")}>
            {latest ? (latest.last?.body ? `${latest.last.mine ? "You: " : ""}${latest.last.body}` : latest.title) : "Ask about your claims"}
          </span>
          {unread > 0 ? (
            <Unread n={unread} />
          ) : (
            open > 0 && <Meta className="shrink-0 text-xs tabular">{open} open</Meta>
          )}
        </span>
      </span>
    </InboxLink>
  )
}

/* ------------------------------------------------------------------------ */
/* Nothing open                                                              */
/* ------------------------------------------------------------------------ */

/** `/api/people/{id}/coauthors`: the part the empty state needs. */
type Coauthors = {
  inside: { user_id: string | null; name: string; department: string | null; papers_together: number }[]
}

function StartPane({ onNew }: { onNew: () => void }) {
  const { me } = useAuth()
  const people = useApi<Coauthors>(
    ["people", me?.id, "coauthors"],
    `/api/people/${me?.id ?? "me"}/coauthors`,
    { enabled: !!me?.id }
  )
  // Colleagues with an account here -- only they can be messaged.
  const worked = (people.data?.inside ?? [])
    .filter((p) => p.user_id && p.user_id !== me?.id)
    .slice(0, 3)
    .map((p) => ({ id: p.user_id!, name: p.name, department: p.department, together: p.papers_together }))
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-10 text-center">
      <div className="rounded-3xl bg-[var(--area-people-wash)] p-4">
        <img src="/illustrations/empty-messages.svg" alt="" width={200} height={125} className="h-auto w-[200px]" />
      </div>
      <div className="max-w-sm space-y-1">
        <h2 className="text-lg font-semibold">Start a conversation</h2>
        <p className="text-sm text-fg-muted">Message a co-author about a paper, a venue or an idea.</p>
      </div>
      <Button kind="primary" size="md" onClick={onNew}>
        <PenLine />
        New message
      </Button>
      {worked.length > 0 && (
        <div className="w-full max-w-md text-left">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.04em] text-fg-subtle">
            People you've written with
          </p>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {worked.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar person={{ name: p.name, initials: "", photo_url: null }} size="md" />
                <span className="min-w-0 flex-1">
                  <Link to={`/u/${p.id}`} className="block truncate text-sm font-medium hover:underline">
                    {p.name}
                  </Link>
                  <Meta className="block truncate text-xs">
                    {[p.department, `${p.together} paper${p.together === 1 ? "" : "s"} together`]
                      .filter(Boolean)
                      .join(" · ")}
                  </Meta>
                </span>
                <Button kind="default" size="sm" asChild>
                  <Link to={`/messages?to=${p.id}`}>
                    <MessageCircle />
                    Message
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The research office                                                       */
/* ------------------------------------------------------------------------ */

function BackToInbox({ to = "/messages", label = "Back to all messages" }: { to?: string; label?: string }) {
  return (
    <Button kind="quiet" size="sm" asChild className="-ml-2 md:hidden">
      <Link to={to} aria-label={label}>
        <ArrowLeft />
      </Link>
    </Button>
  )
}

function OfficePane() {
  const { me } = useAuth()
  const isOffice = can(me?.role).clear
  const office = useOfficeThreads()
  const [asking, setAsking] = useState(false)
  const threads = office.data?.results ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <BackToInbox />
        <OfficeAvatar />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">Research office</h1>
          <Meta className="block truncate text-xs">Whoever is on duty in the research cell</Meta>
        </div>
        <Button kind="primary" size="sm" onClick={() => setAsking(true)}>
          <PenLine />
          <span className="hidden sm:inline">Ask the research office</span>
          <span className="sm:hidden">Ask</span>
        </Button>
      </header>
      <p className="flex items-center gap-1.5 border-b border-line px-4 py-1.5 text-xs text-fg-muted">
        <Lock className="size-3 shrink-0" aria-hidden />
        {isOffice
          ? "The research cell's queue: each conversation is readable by the office and the person who asked."
          : "Only you and the research office can read this."}
      </p>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <p className="mx-auto max-w-md rounded-lg bg-sunken px-3 py-2 text-center text-xs text-fg-muted">
          Ask the research office anything about your claims. They usually reply within 2 working days.
        </p>
        {office.isPending ? (
          <SkeletonRows rows={3} rowHeight={56} />
        ) : office.isError ? (
          <ErrorState
            title="Could not load your conversations with the office"
            message="The server did not answer. Nothing has been sent, lost or deleted."
            onRetry={() => void office.refetch()}
          />
        ) : threads.length === 0 ? null : (
          <ul className="space-y-2">
            {threads.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/messages/o/${t.id}`}
                  className="block rounded-xl border border-line bg-surface px-3 py-2.5 transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
                    <Meta className="shrink-0 text-xs">
                      <Ago iso={t.last_post_at} />
                    </Meta>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-xs text-fg-muted">
                    {t.resolved ? (
                      <span className="inline-flex items-center gap-1 text-positive">
                        <CircleCheck className="size-3" aria-hidden />
                        Answered
                      </span>
                    ) : (
                      <span>Open</span>
                    )}
                    <span aria-hidden>·</span>
                    <span className="tabular">
                      {t.post_count} message{t.post_count === 1 ? "" : "s"}
                    </span>
                    {isOffice && t.created_by && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="truncate">{t.created_by}</span>
                      </>
                    )}
                    {t.ticket_number && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t.ticket_number}</span>
                      </>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      {asking && <NewConversation initialLane="office" initialPeople={[]} onClose={() => setAsking(false)} />}
    </div>
  )
}

/* Route entries: one layout, told which pane is open. */
export const MessagesStart = () => <MessagesPage pane="start" />
export const MessagesChat = () => <MessagesPage pane="chat" />
export const MessagesOffice = () => <MessagesPage pane="office" />
export const MessagesOfficeThread = () => <MessagesPage pane="office-thread" />

/** One conversation with the office, in the right-hand pane. */
function OfficeThreadPane() {
  const { id } = useParams<{ id: string }>()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Button kind="quiet" size="sm" asChild className="-ml-2">
          <Link to="/messages/office">
            <ArrowLeft />
            Research office
          </Link>
        </Button>
      </div>
      <div className="[&_.page]:!max-w-none [&_.page]:!px-4 [&_.page]:!py-4" key={id}>
        <Thread />
      </div>
    </div>
  )
}
