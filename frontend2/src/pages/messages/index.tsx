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
import { toDisplay } from "@/ui/mention-text"
import { Avatar, initialsOf } from "@/ui/person"
import { Picture } from "@/ui/picture"
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

// The office is not a person: a calm navy wash instead of a face.
const OFFICE_NAVY =
  "bg-[color-mix(in_srgb,var(--color-brand)_12%,transparent)] text-[var(--color-brand)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-brand)_20%,transparent)]"

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
          "flex overflow-hidden md:h-[calc(100dvh-4rem)] md:rounded-panel md:border md:border-line md:bg-surface",
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
        <OfficeRow rows={office} />
        <div className="mx-4 my-1 border-t border-line" aria-hidden />
        {inbox.isPending ? (
          <div className="px-4">
            <SkeletonRows rows={5} rowHeight={56} />
          </div>
        ) : inbox.isError ? (
          <div className="px-4">
            <ErrorState
              title="Could not load your messages"
              onRetry={() => void inbox.refetch()}
            />
          </div>
        ) : rows.length === 0 ? (
          needle ? (
            <Meta className="block px-4 py-6 text-sm">Nothing matches. Try part of a name.</Meta>
          ) : (
            <InboxSuggestions />
          )
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
                          ? `${r.last.mine ? "You: " : ""}${r.last.body ? toDisplay(r.last.body).text : "A message was removed"}`
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
  // A quiet dot; the count only when there is more than one.
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-[var(--area-people)] tabular">
      <span className="sr-only">Unread: {n}</span>
      {n > 1 && <span aria-hidden>{n}</span>}
      <span className="size-2 rounded-full bg-[var(--area-people)]" aria-hidden />
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
  const { me } = useAuth()
  const isOffice = can(me?.role).clear
  const latest = rows[0]
  const open = rows.filter((t) => !t.resolved).length
  const unread = rows.reduce((n, r) => n + (r.unread || 0), 0)
  return (
    <InboxLink to="/messages/office">
      <OfficeAvatar />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>
            {isOffice ? "Questions from faculty" : "Research office"}
          </span>
          {latest && (
            <Meta className="shrink-0 text-xs">
              <Ago iso={latest.updated_at} />
            </Meta>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "text-fg" : "text-fg-muted")}>
            {latest ? (latest.last?.body ? `${latest.last.mine ? "You: " : ""}${latest.last.body}` : latest.title) : isOffice ? "No questions right now" : "Ask about your claims"}
          </span>
          {unread > 0 ? (
            <Unread n={unread} />
          ) : (
            open > 0 && <Meta className="shrink-0 text-xs tabular">{open} waiting</Meta>
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
  inside: {
    user_id: string | null
    name: string
    initials?: string | null
    photo_url?: string | null
    department: string | null
    papers_together: number
  }[]
}

type Coauthor = {
  id: string
  name: string
  initials: string
  photo_url: string | null
  department: string | null
  together: number
}

/** Your co-authors who have an account here -- only they can be messaged -- most papers together first. */
function useCoauthors(limit: number): Coauthor[] {
  const { me } = useAuth()
  const people = useApi<Coauthors>(["people", me?.id, "coauthors"], `/api/people/${me?.id ?? "me"}/coauthors`, {
    enabled: !!me?.id,
  })
  return (people.data?.inside ?? [])
    .filter((p) => p.user_id && p.user_id !== me?.id)
    .sort((a, b) => b.papers_together - a.papers_together)
    .slice(0, limit)
    .map((p) => ({
      id: p.user_id!,
      name: p.name,
      initials: p.initials || initialsOf(p.name),
      photo_url: p.photo_url ?? null,
      department: p.department,
      together: p.papers_together,
    }))
}

function firstName(name: string): string {
  const words = name.replace(/\b(Dr|Mr|Ms|Mrs|Miss|Prof|Er)\b\.?/gi, " ").split(/[\s.]+/).filter(Boolean)
  // "Dr.G.Venkatesan": the initial is not what anybody is called.
  return words.find((w) => w.length > 1) ?? words[0] ?? name
}

function StartPane({ onNew }: { onNew: () => void }) {
  const { me } = useAuth()
  const worked = useCoauthors(6)
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center">
      <Picture name="empty-no-messages" className="h-40 w-60" eager />
      <h2 className="display mt-4 text-2xl">
        {me?.name ? `Hello, ${firstName(me.name)}` : "Start a conversation"}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">Private between the two of you.</p>

      {worked.length > 0 && (
        <div className="mt-8 w-full max-w-lg">
          <p className="mb-3 text-sm text-fg-muted">Co-authors</p>
          <ul className="flex flex-wrap justify-center gap-2">
            {worked.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/messages?to=${p.id}`}
                  title={`${p.name}${p.department ? `, ${p.department}` : ""} · ${p.together} paper${p.together === 1 ? "" : "s"} together`}
                  className="group inline-flex items-center gap-2 rounded-full bg-surface py-1 pl-1 pr-3 text-sm shadow-raise ring-1 ring-inset ring-control-edge transition-colors duration-[var(--dur-1)] ease-out hover:bg-[var(--area-people-wash)] hover:ring-[var(--area-people)]"
                >
                  <Avatar person={p} size="sm" />
                  <span className="max-w-[10rem] truncate font-medium">{p.name}</span>
                  <MessageCircle className="size-3.5 text-fg-subtle group-hover:text-[var(--area-people)]" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button kind={worked.length ? "default" : "primary"} size="md" onClick={onNew} className="mt-6">
        <PenLine />
        Write to someone else
      </Button>
    </div>
  )
}

/** The inbox with nothing in it yet: your co-authors, one click from a chat. */
function InboxSuggestions() {
  const worked = useCoauthors(4)
  if (worked.length === 0) {
    return <Meta className="block px-4 py-6 text-sm">No conversations yet.</Meta>
  }
  return (
    <div className="pt-1">
      <Meta className="block px-4 pb-1 text-xs">No conversations yet. Say hello.</Meta>
      <ul>
        {worked.map((p) => (
          <li key={p.id}>
            <Link
              to={`/messages?to=${p.id}`}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover"
            >
              <Avatar person={p} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <Meta className="block truncate text-xs">
                  {p.together} paper{p.together === 1 ? "" : "s"} together
                  {p.department ? ` · ${p.department}` : ""}
                </Meta>
              </span>
              <span className="shrink-0 text-xs font-medium text-[var(--area-people)]">Message</span>
            </Link>
          </li>
        ))}
      </ul>
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
          <h1 className="truncate text-base font-semibold">{isOffice ? "Questions from faculty" : "Research office"}</h1>
          <Meta className="block truncate text-xs">
            {isOffice ? "Open one to answer it" : "Whoever is on duty at the research office"}
          </Meta>
        </div>
        {/* The office is the one answering; asking itself a question is not a job. */}
        {!isOffice && (
          <Button kind="primary" size="sm" onClick={() => setAsking(true)}>
            <PenLine />
            <span className="hidden sm:inline">Ask the research office</span>
            <span className="sm:hidden">Ask</span>
          </Button>
        )}
      </header>
      <p className="flex items-center gap-1.5 border-b border-line px-4 py-1.5 text-xs text-fg-muted">
        <Lock className="size-3 shrink-0" aria-hidden />
        {isOffice
          ? "Each conversation can be read by the research office and the person who asked."
          : "Only you and the research office can read this."}
      </p>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {office.isPending ? (
          <SkeletonRows rows={3} rowHeight={56} />
        ) : office.isError ? (
          <ErrorState
            title="Could not load your conversations with the office"
            onRetry={() => void office.refetch()}
          />
        ) : threads.length === 0 ? (
          <p className="mx-auto max-w-sm py-8 text-center text-sm text-fg-muted">
            {isOffice
              ? "No questions from faculty right now. A new one shows here and in Notifications."
              : "You have not written to the research office yet."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {threads.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/messages/o/${t.id}`}
                  className="flex items-center gap-3 rounded-control px-2 py-3 transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover"
                >
                  {isOffice && t.created_by && (
                    <Avatar
                      person={{ name: t.created_by, initials: t.created_by_initials || initialsOf(t.created_by), photo_url: t.created_by_photo_url ?? null }}
                      size="md"
                    />
                  )}
                  <span className="min-w-0 flex-1">
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
                        <span>Waiting for an answer</span>
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
        <Thread embedded />
      </div>
    </div>
  )
}
