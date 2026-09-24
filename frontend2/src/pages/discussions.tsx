import { useCallback, useEffect, useRef, useState } from "react"
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom"
import {
  ArrowLeft,
  Bot,
  Building2,
  CircleCheck,
  Lock,
  Mail,
  Plus,
  RefreshCw,
  X,
} from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Composer, renderBody, useMentionSearch, type Candidate } from "@/ui/composer"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input } from "@/ui/field"
import { PersonLink } from "@/ui/person"
import {
  Callout,
  EmptyState,
  ErrorState,
  InlineError,
  SkeletonRows,
} from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { relativeTime } from "@/ui/when"

/**
 * Messages — direct conversations, and conversations with the research office.
 *
 * The open threads that used to share this page are the feed now
 * (`pages/feed.tsx`): a post for the whole college wants to be seen, and a
 * list of thread titles hid it behind a click. What stays here is private —
 * a named few, or the office — and so it stays a conversation rather than a
 * post. An old thread link that pointed at an open thread is sent on to the
 * post it became (`feed_post_id`).
 *
 * Deliberately not a chat box. A post names the things it concerns and those
 * names resolve to real records: `@journal:"Ceramics International"` is a
 * journal we hold a quartile and a SNIP for, `@paper:ERP-001934` is a ticket,
 * `@agent` is an assistant that answers from our own tables rather than from
 * a model. So a question about what a venue pays gets an answer the system
 * can stand behind, in the thread, beside the question.
 *
 * ## Three lanes, because there are three different audiences
 *
 * `backend/core/discussions.visible_threads` answers "who may read this" from
 * the thread's `visibility`, and the four values are genuinely four different
 * things — so they are four places here, not one list with a filter:
 *
 *   DIRECT      the named people in it, held in `ThreadParticipant`, and
 *               nobody else. Not the office either: `visible_threads` gives
 *               the office every other kind of thread and not this one, and
 *               `may_moderate` returns `may_read` for a direct thread so they
 *               cannot lock one they cannot open.
 *   OFFICE      the research cell, plus whoever opened it. A quiet line to
 *               the administration — a different need from writing to a
 *               colleague, and collapsing the two would mean somebody asking
 *               about their own claim in a conversation the office cannot see.
 *   DEPARTMENT  one department, and the office.
 *   PUBLIC      everybody signed in.
 *
 * `ThreadSubscription` is *not* an audience and never has been: it routes
 * notifications and `visible_threads` does not consult it. `ThreadParticipant`
 * is the audience. Keeping that distinction visible in the copy matters,
 * because "following" and "in it" look the same from the outside.
 *
 * Visibility is enforced on the server, and a thread you may not read answers
 * 404 rather than 403 — a 403 confirms it exists, which is itself the leak.
 * This screen never has to reason about any of that: it shows what came back.
 */

/* ------------------------------------------------------------------------ */
/* Data — read out of the thread endpoints in backend/core/api.py           */
/* ------------------------------------------------------------------------ */

type Visibility = "PUBLIC" | "DEPARTMENT" | "OFFICE" | "DIRECT"

type ThreadRow = {
  id: string
  title: string
  visibility: Visibility
  department: string | null
  topic: string | null
  claim_id: string | null
  ticket_number: string | null
  journal_title: string | null
  created_by: string | null
  created_by_id: string | null
  created_at: string
  last_post_at: string
  post_count: number
  resolved: boolean
  resolved_by: string | null
  locked: boolean
  may_post: boolean
  may_moderate: boolean
}

type MentionRow = {
  kind: "USER" | "JOURNAL" | "PAPER" | "DEPARTMENT" | "AGENT"
  label: string
  user_id: string | null
  user_name: string | null
  claim_id: string | null
  ticket_number: string | null
  journal_title: string | null
  department: string | null
}

type PostRow = {
  id: string
  kind: "HUMAN" | "AGENT" | "SYSTEM"
  body: string
  deleted: boolean
  author_id: string | null
  author_name: string | null
  reply_to: string | null
  created_at: string
  edited_at: string | null
  mentions: MentionRow[]
}

type ThreadDetail = ThreadRow & {
  posts: PostRow[]
  following: boolean
  followers: number
  /** Set when this was an open thread and now lives in the feed as a post. */
  feed_post_id?: string | null
}

type ThreadList = {
  total: number
  limit: number
  offset: number
  results: ThreadRow[]
  visibilities: { key: Visibility; label: string }[]
}

const VISIBILITY_LABEL: Record<Visibility, string> = {
  PUBLIC: "Everybody",
  DEPARTMENT: "One department",
  OFFICE: "The research office",
  DIRECT: "Only the people in it",
}

/** The server caps a direct conversation at twenty other people
 *  (`discussions.check_visibility`). Enforced here too so the twenty-first
 *  is refused while it can still be undone, rather than after the message
 *  has been typed. */
const DIRECT_MAX_PEOPLE = 20

/** How many rows a lane shows before "Show more". */
const PAGE = 25

/** How often an open list re-asks the server. Long enough not to be chatter,
 *  short enough that a reply lands before somebody reloads out of doubt. */
const LIST_POLL_MS = 30_000

/** A thread is being read right now, so it refreshes faster than a list. */
const THREAD_POLL_MS = 12_000

type Lane = "direct" | "office"

const LANES: { key: Lane; label: string }[] = [
  { key: "direct", label: "Direct" },
  { key: "office", label: "The office" },
]

function readLane(value: string | null): Lane {
  return value === "office" ? "office" : "direct"
}

/* ------------------------------------------------------------------------ */
/* The list                                                                  */
/* ------------------------------------------------------------------------ */

export function Messages() {
  const { me } = useAuth()
  const office = can(me?.role).clear

  const [searchParams, setSearchParams] = useSearchParams()
  const lane = readLane(searchParams.get("lane"))
  const q = searchParams.get("q") ?? ""
  const topic = searchParams.get("topic") ?? ""
  const mine = searchParams.get("mine") === "1"
  // `?to=<id>` is the Message button on somebody's profile: the new message
  // opens already addressed to them.
  const to = searchParams.get("to")
  const [composing, setComposing] = useState<Lane | null>(to ? "direct" : null)
  const addressee = useApi<{ person: { id: string; name: string; department: string | null } }>(
    ["person", to],
    `/api/people/${to}`,
    { enabled: !!to }
  )

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  const setParam = useCallback(
    (entries: Record<string, string>) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(entries)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next
      })
    },
    [setSearchParams]
  )

  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => setParam({ q: draft }), 250)
    return () => clearTimeout(t)
  }, [draft, q, setParam])

  const filtered = !!(q || topic || (lane !== "direct" && mine))

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <PageTitle>Messages</PageTitle>
          <Sub className="mt-1">
            Write to a colleague privately, or ask the research office. Pull the
            assistant in with{" "}
            <code className="rounded-sm bg-sunken px-1 text-sm">@agent</code>. For
            something the whole college should see, post it in{" "}
            <Link to="/discussions" className="text-accent underline-offset-4 hover:underline">
              Discussions
            </Link>
            .
          </Sub>
        </div>
        <Button
          kind="primary"
          size="md"
          className="w-full sm:w-auto"
          onClick={() => setComposing(lane)}
        >
          <Plus />
          {lane === "direct" ? "New message" : "Ask the office"}
        </Button>
      </header>

      <div
        role="tablist"
        aria-label="Conversations"
        className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-sunken p-0.5"
      >
        {LANES.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={lane === t.key}
            onClick={() =>
              setParam({
                lane: t.key === "direct" ? "" : t.key,
                mine: t.key === "direct" ? "" : mine ? "1" : "",
              })
            }
            className={cn(
              "h-7 shrink-0 rounded-sm px-3 text-sm font-medium transition-colors",
              "duration-[var(--dur-1)] ease-out",
              lane === t.key
                ? "bg-surface text-fg"
                : "text-fg-muted hover:text-fg"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={lane === "direct" ? "Search your messages" : "Search office conversations"}
          aria-label="Search"
          className="w-full sm:max-w-xs"
        />
        {/* Every direct conversation is one you are in — `list_threads`
            matches `mine` on subscription, and being a participant subscribes
            you. The filter would tick and change nothing, which teaches a
            reader that the filters on this page do not work. */}
        {lane !== "direct" && (
          <Button
            kind={mine ? "default" : "quiet"}
            size="md"
            aria-pressed={mine}
            onClick={() => setParam({ mine: mine ? "" : "1" })}
          >
            Only mine
          </Button>
        )}
        {topic && (
          <Button kind="quiet" size="md" onClick={() => setParam({ topic: "" })}>
            <X />
            {topic}
          </Button>
        )}
      </div>

      {lane === "direct" ? (
        <DirectLane
          q={q}
          topic={topic}
          filtered={filtered}
          meId={me?.id}
          onStart={() => setComposing("direct")}
        />
      ) : (
        <OfficeLane
          q={q}
          topic={topic}
          mine={mine}
          filtered={filtered}
          office={office}
          meId={me?.id}
          onStart={() => setComposing("office")}
        />
      )}

      {/* Held back until the addressee has loaded, so the dialog opens with
          them already in "To" rather than filling it in a beat later. */}
      {composing && !(to && addressee.isLoading) && (
        <NewConversation
          initialLane={composing}
          initialPeople={
            to && addressee.data
              ? [
                  {
                    kind: "USER",
                    id: addressee.data.person.id,
                    label: addressee.data.person.name,
                    hint: addressee.data.person.department,
                  },
                ]
              : []
          }
          onClose={() => {
            setComposing(null)
            if (to) setParam({ to: "" })
          }}
        />
      )}
    </div>
  )
}

function listPath(params: Record<string, string | boolean | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === false) continue
    query.set(key, String(value))
  }
  return `/api/threads?${query.toString()}`
}

/**
 * The private lane: `DIRECT` threads, readable by the named people in them
 * and by nobody else — the office included.
 *
 * Split out from the open lane rather than filtered out of one list, because
 * "who else is reading this" is the single most important thing about a
 * message, and burying a private one between two public ones is how somebody
 * writes something personal into a thread the whole college can read.
 */
function DirectLane({
  q,
  topic,
  filtered,
  meId,
  onStart,
}: {
  q: string
  topic: string
  filtered: boolean
  meId?: string
  onStart: () => void
}) {
  const [pages, setPages] = useState(1)
  useEffect(() => setPages(1), [q, topic])
  const limit = PAGE * pages

  const { data, isLoading, isError, refetch } = useApi<ThreadList>(
    ["threads", "direct", q, topic, limit],
    listPath({ visibility: "DIRECT", q, topic, limit }),
    { refetchInterval: LIST_POLL_MS }
  )

  const threads = data?.results ?? []

  return (
    <section className="space-y-4">
      <Callout tone="info" title="Who can read a direct message">
        Only the people named in it. Not your department, not the research
        office, not an administrator — a direct conversation is the one kind of
        thread the office cannot open, and they cannot close or moderate one
        either.
      </Callout>

      {isLoading ? (
        <SkeletonRows rows={4} rowHeight={64} />
      ) : isError ? (
        <ErrorState
          title="Could not load your messages"
          message="The server did not answer. Nothing has been sent, lost or deleted."
          onRetry={() => void refetch()}
        />
      ) : threads.length === 0 ? (
        <EmptyState
          icon={Mail}
          title={filtered ? "Nothing matches" : "No direct messages"}
          message={
            filtered
              ? "Try clearing a filter. You only ever see the conversations you are in."
              : "Write to a colleague about a paper, a venue, or anything you would rather not put in front of the department."
          }
          action={
            filtered ? undefined : (
              <Button kind="primary" size="sm" onClick={onStart}>
                <Mail />
                New message
              </Button>
            )
          }
        />
      ) : (
        <>
          <ThreadRows threads={threads} meId={meId} />
          <ShowMore
            shown={threads.length}
            total={data?.total ?? threads.length}
            onMore={() => setPages((p) => p + 1)}
          />
        </>
      )}
    </section>
  )
}

/**
 * The quiet lane: `OFFICE` threads.
 *
 * Kept apart from Direct on purpose. "Ask the research office why my claim was
 * sent back" and "message a colleague" are different needs with different
 * audiences — the first reaches the whole research cell whoever is on duty,
 * the second reaches exactly the people you named. Merging them would mean
 * somebody picks the wrong one and finds out afterwards.
 */
function OfficeLane({
  q,
  topic,
  mine,
  filtered,
  office,
  meId,
  onStart,
}: {
  q: string
  topic: string
  mine: boolean
  filtered: boolean
  office: boolean
  meId?: string
  onStart: () => void
}) {
  const [pages, setPages] = useState(1)
  useEffect(() => setPages(1), [q, topic, mine])
  const limit = PAGE * pages

  const { data, isLoading, isError, refetch } = useApi<ThreadList>(
    ["threads", "office", q, topic, mine, limit],
    listPath({ visibility: "OFFICE", q, topic, mine, limit }),
    { refetchInterval: LIST_POLL_MS }
  )

  const threads = data?.results ?? []

  return (
    <section className="space-y-4">
      <Callout tone="info" title="Who can read a conversation with the office">
        {office
          ? "Every one of these, whoever opened it — this is the research cell's own queue. Colleagues of the person who asked cannot see theirs."
          : "You and the research office, whoever is on duty. Your colleagues cannot see it. For something only one named person should read, use Direct instead."}
      </Callout>

      {isLoading ? (
        <SkeletonRows rows={4} rowHeight={64} />
      ) : isError ? (
        <ErrorState
          title="Could not load these conversations"
          message="The server did not answer. Nothing has been sent, lost or deleted."
          onRetry={() => void refetch()}
        />
      ) : threads.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={filtered ? "Nothing matches" : "Nothing with the office"}
          message={
            filtered
              ? "Try clearing a filter."
              : "Ask why a claim was sent back, what evidence a payout needs, or anything else the research cell answers."
          }
          action={
            filtered ? undefined : (
              <Button kind="primary" size="sm" onClick={onStart}>
                <Building2 />
                Ask the office
              </Button>
            )
          }
        />
      ) : (
        <>
          <ThreadRows threads={threads} meId={meId} />
          <ShowMore
            shown={threads.length}
            total={data?.total ?? threads.length}
            onMore={() => setPages((p) => p + 1)}
          />
        </>
      )}
    </section>
  )
}

function ShowMore({
  shown,
  total,
  onMore,
}: {
  shown: number
  total: number
  onMore: () => void
}) {
  if (shown >= total) {
    return (
      <Meta className="block text-center text-xs">
        {total === 1 ? "1 conversation" : `All ${total} conversations`}
      </Meta>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <Button kind="default" size="md" onClick={onMore}>
        Show more
      </Button>
      <Meta className="text-xs tabular">
        {shown} of {total}
      </Meta>
    </div>
  )
}

function ThreadRows({ threads, meId }: { threads: ThreadRow[]; meId?: string }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {threads.map((t) => (
        <li key={t.id} className="row">
          <Link
            to={`/discussions/${t.id}`}
            className="flex items-start gap-3 px-1 py-3 sm:px-2"
          >
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-base">{t.title}</span>
                {t.resolved && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-positive-wash px-1.5 py-0.5 text-xs font-medium text-positive">
                    <CircleCheck className="size-3" aria-hidden />
                    Answered
                  </span>
                )}
                {t.locked && (
                  <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-label="Locked" />
                )}
              </span>
              <Meta className="mt-0.5 block truncate text-xs">
                {[parties(t, meId), t.topic, t.journal_title, t.ticket_number]
                  .filter(Boolean)
                  .join(" · ")}
              </Meta>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-sm tabular">{t.post_count}</span>
              <Meta className="block text-xs">{relative(t.last_post_at)}</Meta>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Who a private conversation is with, from what the list actually returns.
 *
 * `_thread_dict` sends `created_by` and nothing about the other participants,
 * so a conversation somebody else opened can be named by them and one you
 * opened cannot be named at all. Saying "You started this" is the honest
 * version of that; inventing a counterpart would be worse than admitting the
 * row cannot say. See the note in the report — one field on the list payload
 * fixes it.
 */
function parties(t: ThreadRow, meId?: string): string {
  const mine = !!meId && t.created_by_id === meId
  if (t.visibility === "OFFICE") {
    return mine ? "You and the research office" : `${t.created_by || "Somebody"} and the research office`
  }
  return mine ? "You started this" : `With ${t.created_by || "somebody"}`
}

/**
 * Who has actually written in a direct conversation.
 *
 * Deliberately NOT described as the audience. The participant rows are what
 * `visible_threads` reads, and `_thread_dict` does not send them, so a person
 * who was added and has not typed yet is invisible here. Calling this "who is
 * in it" would therefore under-report the audience of a private conversation,
 * which is the one thing this screen must never do.
 */
function speakers(posts: PostRow[], meId?: string): string {
  const names: string[] = []
  for (const p of posts) {
    if (p.deleted || p.kind !== "HUMAN") continue
    if (!p.author_id || p.author_id === meId) continue
    const name = p.author_name || "somebody"
    if (!names.includes(name)) names.push(name)
  }
  if (names.length === 0) return "Nobody else has written here yet."
  if (names.length === 1) return `${names[0]} has written here.`
  const last = names[names.length - 1]
  return `${names.slice(0, -1).join(", ")} and ${last} have written here.`
}

function audienceLabel(t: ThreadRow): string {
  if (t.visibility === "DEPARTMENT") return t.department || "One department"
  return VISIBILITY_LABEL[t.visibility]
}

/* ------------------------------------------------------------------------ */
/* One thread                                                                */
/* ------------------------------------------------------------------------ */

export function Thread() {
  const { id } = useParams<{ id: string }>()
  const { me } = useAuth()
  const [body, setBody] = useState("")

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } =
    useApi<ThreadDetail>(["thread", id], `/api/threads/${id}`, {
      enabled: !!id,
      // New posts arrive without anybody reloading. React Query only polls a
      // focused window, so a tab left open overnight is not a tab hammering
      // the server overnight.
      refetchInterval: THREAD_POLL_MS,
    })

  const post = useApiMutation<{ body: string }, unknown>(`/api/threads/${id}/posts`, {
    invalidates: [["thread", id], ["threads"], ["notifications"]],
  })

  const resolve = useApiMutation<void, unknown>(
    () => `/api/threads/${id}/resolve?resolved=${data?.resolved ? "false" : "true"}`,
    { invalidates: [["thread", id], ["threads"]] }
  )

  // Follow the conversation down as it grows, but only for a reader who is
  // already at the bottom. Yanking somebody who has scrolled up to re-read
  // an earlier post is worse than making them scroll.
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastSeen = useRef<string | undefined>(undefined)
  const newestId = data?.posts.at(-1)?.id
  useEffect(() => {
    if (!newestId) return
    const first = lastSeen.current === undefined
    const changed = lastSeen.current !== newestId
    lastSeen.current = newestId
    if (first || !changed) return
    const gap =
      document.documentElement.scrollHeight - window.scrollY - window.innerHeight
    if (gap < 240) bottomRef.current?.scrollIntoView({ block: "end" })
  }, [newestId])

  async function send() {
    const text = body.trim()
    if (!text) return
    try {
      await post.mutateAsync({ body: text })
      setBody("")
    } catch (err) {
      toast.fail(err)
    }
  }

  async function follow(next: boolean) {
    try {
      await api(`/api/threads/${id}/subscribe?following=${next}`, { method: "POST" })
      void refetch()
    } catch (err) {
      toast.fail(err)
    }
  }

  if (isLoading) {
    return (
      <div className="page space-y-6 py-8">
        <SkeletonRows rows={5} rowHeight={72} />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="page py-8">
        <Button kind="quiet" size="sm" asChild className="-ml-2 mb-4">
          <Link to="/messages">
            <ArrowLeft />
            Messages
          </Link>
        </Button>
        <ErrorState
          title={error?.status === 404 ? "No thread here" : "Could not load this thread"}
          message={
            error?.status === 404
              ? "It may have been removed, or it is not one this account can see."
              : "The server did not answer. Nothing you wrote has been lost."
          }
          onRetry={error?.status === 404 ? undefined : () => void refetch()}
        />
      </div>
    )
  }

  // An open thread from before the feed is a post now; its old link, and any
  // notification that carried it, lands on the post rather than on a copy.
  if (data.feed_post_id) {
    return <Navigate to={`/discussions/p/${data.feed_post_id}`} replace />
  }

  const direct = data.visibility === "DIRECT"
  const withOffice = data.visibility === "OFFICE"
  const restricted = direct || withOffice
  const back = direct
    ? { to: "/messages", label: "Messages" }
    : withOffice
      ? { to: "/messages?lane=office", label: "The office" }
      : { to: "/discussions", label: "Discussions" }

  return (
    <div className="page space-y-6 pb-4">
      <div>
        <Button kind="quiet" size="sm" asChild className="-ml-2">
          <Link to={back.to}>
            <ArrowLeft />
            {back.label}
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <PageTitle>{data.title}</PageTitle>
            <Sub className="mt-1 text-sm">
              {[
                restricted ? parties(data, me?.id) : data.created_by,
                `${data.followers} following`,
                `${data.post_count} ${data.post_count === 1 ? "message" : "messages"}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Sub>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              kind="quiet"
              size="md"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="Check for new messages"
            >
              <RefreshCw className={cn(isFetching && "animate-spin")} />
              {isFetching ? "Checking…" : "Refresh"}
            </Button>
            <Button kind="quiet" size="md" onClick={() => void follow(!data.following)}>
              {data.following ? "Stop following" : "Follow"}
            </Button>
            {data.may_moderate && (
              <Button kind="default" size="md" onClick={() => void resolve.mutateAsync()}>
                {data.resolved ? "Reopen" : "Mark answered"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* The audience is a property of the conversation, not a footnote about
          it, so it sits with the topic and the paper rather than in a line of
          grey metadata a reader skims past before typing something private. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={restricted ? "accent" : "plain"}>
          {direct ? <Mail className="size-3" aria-hidden /> : null}
          {withOffice ? <Building2 className="size-3" aria-hidden /> : null}
          {audienceLabel(data)}
        </Chip>
        {data.topic && (
          <Chip to={`/messages?topic=${encodeURIComponent(data.topic)}`}>{data.topic}</Chip>
        )}
        {data.claim_id && (
          <Chip to={`/papers/${data.claim_id}`}>{data.ticket_number || "The paper"}</Chip>
        )}
        {data.journal_title && (
          <Chip to={`/journals/${encodeURIComponent(data.journal_title)}`}>
            {data.journal_title}
          </Chip>
        )}
        <Meta className="ml-auto text-xs">
          Checked {dataUpdatedAt ? relative(new Date(dataUpdatedAt).toISOString()) : "just now"}
        </Meta>
      </div>

      {direct && (
        <Callout tone="info" title="Private to the people in this conversation">
          Nobody else can open it — not your department, not the research
          office, not an administrator. They cannot close or moderate it
          either. {speakers(data.posts, me?.id)}
        </Callout>
      )}

      {withOffice && (
        <Callout tone="info" title="This conversation is with the research office">
          {me?.id === data.created_by_id
            ? "You and the office, whoever is on duty. Colleagues cannot see it, and it never appears in an open list."
            : "The research office, and whoever opened it. Nobody else can read it."}
        </Callout>
      )}

      {data.locked && (
        <Callout tone="caution" title="This thread is closed to new posts">
          It stays readable. The office closed it.
        </Callout>
      )}

      <ul className="space-y-3">
        {data.posts.map((p) => (
          <Post key={p.id} post={p} isMine={p.author_id === me?.id} threadId={data.id} />
        ))}
      </ul>
      <div ref={bottomRef} />

      {data.may_post && !data.locked ? (
        <div className="sticky bottom-0 -mx-1 border-t border-line bg-bg px-1 pb-3 pt-3 sm:-mx-2 sm:px-2">
          <Composer
            value={body}
            onChange={setBody}
            onSend={() => void send()}
            busy={post.isPending}
            submitOnEnter
            label="Your reply"
          />
        </div>
      ) : data.locked ? null : (
        <Callout tone="caution" title="You cannot post here">
          This account can read this thread but not add to it.
        </Callout>
      )}
    </div>
  )
}

/** A small labelled fact about a thread — its audience, topic or paper. Links
 *  where there is somewhere to go, and is plain text where there is not, so a
 *  reader never clicks a chip that turns out to be a dead label. */
function Chip({
  children,
  to,
  tone = "plain",
}: {
  children: React.ReactNode
  to?: string
  tone?: "plain" | "accent"
}) {
  const className = cn(
    "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs",
    tone === "accent" ? "bg-accent-wash text-fg" : "bg-sunken text-fg-muted"
  )
  if (to) {
    return (
      <Link to={to} className={cn(className, "hover:bg-hover")}>
        {children}
      </Link>
    )
  }
  return <span className={className}>{children}</span>
}

/* ------------------------------------------------------------------------ */
/* A post                                                                    */
/* ------------------------------------------------------------------------ */

function Post({
  post,
  isMine,
  threadId,
}: {
  post: PostRow
  isMine: boolean
  threadId: string
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const remove = useApiMutation<void, unknown>(() => `/api/posts/${post.id}`, {
    method: "DELETE",
    invalidates: [["thread", threadId]],
  })

  if (post.deleted) {
    // A tombstone, not a hole: the replies underneath still have to make sense.
    return (
      <li className="rounded-md bg-sunken px-3 py-2">
        <Meta>This post was deleted.</Meta>
      </li>
    )
  }

  const isAgent = post.kind === "AGENT"
  const isSystem = post.kind === "SYSTEM"

  return (
    <li
      className={cn(
        "space-y-1.5 rounded-lg px-2 py-2.5 sm:px-3",
        isAgent && "bg-accent-wash",
        isSystem && "bg-sunken"
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {isAgent && <Bot className="size-3.5 text-accent" aria-hidden />}
          {isAgent ? (
            "Assistant"
          ) : isSystem ? (
            "Recorded"
          ) : (
            <PersonLink id={post.author_id} name={post.author_name || "Somebody"} />
          )}
        </span>
        <Meta className="text-xs">
          {relative(post.created_at)}
          {post.edited_at ? " · edited" : ""}
        </Meta>
      </div>

      <div className="whitespace-pre-wrap break-words text-base leading-relaxed">
        {renderBody(post.body)}
      </div>

      {post.mentions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {post.mentions
            .filter((m) => m.kind !== "AGENT")
            .map((m, i) => (
              <MentionChip key={`${m.kind}-${i}`} mention={m} />
            ))}
        </div>
      )}

      {isMine && (
        <>
          {/* Deliberately not `.reveal`. That class only un-hides inside a
              `.row` on hover or focus-within, this `<li>` is not a `.row`, and
              no phone fires either -- so the control sat at opacity 0 for
              everybody while staying in the tab order and clickable. A
              keyboard user could tab onto an invisible button and destroy a
              post with Enter, unconfirmed. */}
          <Button
            kind="quiet"
            size="sm"
            disabled={remove.isPending}
            onClick={() => setConfirmDelete(true)}
            className="text-fg-subtle hover:text-critical"
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            danger
            title="Delete this post?"
            description="It is removed from the thread for everyone. This cannot be undone."
            confirmLabel="Delete it"
            onConfirm={async () => {
              try {
                await remove.mutateAsync(undefined as never)
                toast.ok("Post deleted")
              } catch (err) {
                toast.fail(err)
              }
            }}
          />
        </>
      )}
    </li>
  )
}

/** A resolved @name, linked to the thing it actually points at. */
function MentionChip({ mention }: { mention: MentionRow }) {
  const base = "rounded-sm bg-surface px-1.5 py-0.5 text-xs ring-1 ring-inset ring-edge"

  if (mention.kind === "USER" && mention.user_id) {
    return (
      <Link to={`/u/${mention.user_id}`} className={cn(base, "hover:bg-hover")}>
        {mention.user_name || mention.label}
      </Link>
    )
  }
  if (mention.kind === "PAPER" && mention.claim_id) {
    return (
      <Link to={`/papers/${mention.claim_id}`} className={cn(base, "hover:bg-hover")}>
        {mention.ticket_number || mention.label}
      </Link>
    )
  }
  if (mention.kind === "JOURNAL" && mention.journal_title) {
    return (
      <Link
        to={`/journals/${encodeURIComponent(mention.journal_title)}`}
        className={cn(base, "hover:bg-hover")}
      >
        {mention.journal_title}
      </Link>
    )
  }
  return <span className={base}>{mention.department || mention.label}</span>
}

/* ------------------------------------------------------------------------ */
/* Picking a person                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Who is in a direct conversation. One name or several — it is a small group,
 * not a mailing list, and the server refuses the twenty-first.
 *
 * Uses `/api/mentions/search?kind=USER`, which is the only person lookup every
 * role can call: `/api/admin/users` is the office's and `/api/hod/people` is a
 * head's, so a faculty member choosing who to write to has nothing else to
 * search with.
 *
 * The chosen people become `participant_ids`, which is the audience itself —
 * `visible_threads` reads those rows. Not a notification list: getting this
 * wrong is the difference between a private conversation and one somebody was
 * merely told about and cannot open.
 */
function PeoplePicker({
  chosen,
  onChange,
  max,
  id,
  "aria-describedby": describedBy,
}: {
  chosen: Candidate[]
  onChange: (people: Candidate[]) => void
  max: number
  id?: string
  "aria-describedby"?: string
}) {
  const [query, setQuery] = useState("")
  const { status, results } = useMentionSearch(query.trim() ? query : null, "USER")

  const full = chosen.length >= max
  const offered = results.filter((c) => !chosen.some((p) => p.id === c.id))

  function add(person: Candidate) {
    if (full) return
    onChange([...chosen, person])
    setQuery("")
  }

  return (
    <div className="space-y-2">
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {chosen.map((p) => (
            <li key={p.id}>
              <span className="inline-flex items-center gap-1 rounded-sm bg-accent-wash py-0.5 pl-2 pr-0.5 text-sm">
                {p.label}
                <button
                  type="button"
                  onClick={() => onChange(chosen.filter((c) => c.id !== p.id))}
                  aria-label={`Remove ${p.label}`}
                  className="rounded-sm p-0.5 text-fg-muted hover:bg-hover hover:text-fg"
                >
                  <X className="size-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Input
        id={id}
        aria-describedby={describedBy}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={full ? `That is the maximum of ${max}` : "Type a name"}
        disabled={full}
        autoComplete="off"
      />

      {status === "loading" && <Meta className="block text-xs">Looking…</Meta>}
      {status === "failed" && (
        <InlineError message="Could not search for people just now." />
      )}
      {status === "ready" && offered.length === 0 && (
        <Meta className="block text-xs">
          {results.length > 0
            ? "Everybody matching that is already in this conversation."
            : `Nobody here matches “${query.trim()}”.`}
        </Meta>
      )}
      {offered.length > 0 && !full && (
        <ul className="max-h-40 divide-y divide-line overflow-y-auto rounded-md ring-1 ring-inset ring-edge">
          {offered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => add(c)}
                className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-sm hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <Meta className="shrink-0 truncate text-xs">{c.hint}</Meta>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Starting one                                                              */
/* ------------------------------------------------------------------------ */

type CreateBody = {
  title: string
  body: string
  visibility: Visibility
  participant_ids?: string[]
  department?: string
  topic?: string
}

/**
 * One dialog for both lanes, because the choice between them is the choice
 * being made — "is this for one colleague, or for the office" is the first
 * question, not a dropdown three fields down that somebody leaves at its
 * default and regrets. Something for everybody is a post in the feed, and the
 * dialog says so rather than offering a third lane that leads there.
 */
function NewConversation({
  initialLane,
  initialPeople = [],
  onClose,
}: {
  initialLane: Lane
  /** Already in "To" — the Message button on a colleague's profile. */
  initialPeople?: Candidate[]
  onClose: () => void
}) {
  const [lane, setLane] = useState<Lane>(initialLane)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [topic, setTopic] = useState("")
  /** DIRECT: the audience. OFFICE: nobody — see `submit`. */
  const [people, setPeople] = useState<Candidate[]>(initialPeople)

  const domains = useApi<{ domains: string[] }>(
    ["research-domains"],
    "/api/meta/research-domains?limit=302"
  )

  const create = useApiMutation<CreateBody, ThreadRow>("/api/threads", {
    invalidates: [["threads"]],
  })

  const topicOptions: ComboboxOption[] = [
    { value: "", label: "No topic", hint: "It will not group with anything" },
    ...(domains.data?.domains ?? []).map((d) => ({ value: d, label: d })),
  ]

  // `check_visibility` refuses a direct thread with an empty audience, because
  // one would be readable by its author alone -- a private note wearing the
  // shape of a sent message. Refused here too, before anything is typed.
  const nobodyChosen = lane === "direct" && people.length === 0

  const canSubmit =
    title.trim().length >= 4 && body.trim().length > 0 && !nobodyChosen && !create.isPending

  async function submit() {
    if (!canSubmit) return
    // For DIRECT the people are the audience and travel as `participant_ids`.
    // For OFFICE there is no audience to set -- the visibility names the
    // research cell -- so naming somebody there is still a mention in the
    // text, which is what `parse_mentions` and `_notify_thread` act on.
    try {
      const made = await create.mutateAsync({
        title: title.trim(),
        body: body.trim(),
        visibility: lane === "direct" ? "DIRECT" : "OFFICE",
        participant_ids: lane === "direct" ? people.map((p) => p.id) : undefined,
        topic: topic || undefined,
      })
      toast.ok(
        lane === "direct"
          ? `Sent to ${listNames(people)} — “${made.title}”`
          : `Sent to the office — “${made.title}”`
      )
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  const failure = create.error instanceof ApiError ? create.error.message : null

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{lane === "direct" ? "New message" : "Ask the research office"}</DialogTitle>
          <DialogDescription>
            {lane === "direct"
              ? "Private to the people you name. Nobody else can open it."
              : "A quiet line to the research cell. Your colleagues cannot see it."}{" "}
            For the whole college, post in{" "}
            <Link to="/discussions" onClick={onClose} className="text-accent underline-offset-4 hover:underline">
              Discussions
            </Link>{" "}
            instead.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div
            role="tablist"
            aria-label="Kind of conversation"
            className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-sunken p-0.5"
          >
            {LANES.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={lane === t.key}
                onClick={() => setLane(t.key)}
                className={cn(
                  "h-7 shrink-0 rounded-sm px-3 text-sm font-medium transition-colors",
                  "duration-[var(--dur-1)] ease-out",
                  lane === t.key ? "bg-surface text-fg" : "text-fg-muted hover:text-fg"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {lane === "direct" ? (
            <Field
              label="To"
              hint={`The people you name here are the only ones who can ever open this — the research office included. Up to ${DIRECT_MAX_PEOPLE}.`}
              error={nobodyChosen && title.trim() ? "Choose at least one person to talk to." : undefined}
            >
              <PeoplePicker chosen={people} onChange={setPeople} max={DIRECT_MAX_PEOPLE} />
            </Field>
          ) : (
            <div className="space-y-1.5">
              <SectionTitle className="text-sm">To</SectionTitle>
              <div className="flex items-center gap-2 rounded-md bg-accent-wash px-2 py-1.5 text-base">
                <Building2 className="size-4 shrink-0 text-accent" aria-hidden />
                The research office
              </div>
              <p className="text-xs text-fg-muted">
                You and the research cell, whoever is on duty. Your colleagues
                cannot see it. For something only one named person should read,
                choose Direct instead.
              </p>
            </div>
          )}

          <Field
            label="Title"
            hint="Something somebody scanning a list would recognise. At least four characters."
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                lane === "direct" ? "About the Ceramics submission" : "Why was ERP-001934 sent back?"
              }
              autoFocus
            />
          </Field>

          <Field
            label="Topic"
            hint="One of the 302 subject categories our journal data actually uses, so conversations in a field group together."
          >
            <Combobox
              value={topic}
              onChange={setTopic}
              options={topicOptions}
              placeholder={domains.isLoading ? "Loading topics…" : "No topic"}
              searchPlaceholder="Type to filter 302 categories…"
            />
          </Field>

          {domains.isError && (
            <InlineError
              message="Could not load the topic list. You can still send this without a topic."
              onRetry={() => void domains.refetch()}
            />
          )}

          <Composer
            value={body}
            onChange={setBody}
            label="Your message"
            rows={4}
            placeholder={
              lane === "direct"
                ? "What would you like to say?"
                : "What would you like to ask the office?"
            }
          />

          {failure && <InlineError message={failure} />}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {create.isPending ? "Sending…" : "Send it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** "Asha", "Asha and Ravi", "Asha, Ravi and Meera" — for a confirmation that
 *  names who a private message actually went to, rather than counting them. */
function listNames(people: Candidate[]): string {
  const names = people.map((p) => p.label)
  if (names.length === 0) return "nobody"
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

function relative(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : relativeTime(d)
}
