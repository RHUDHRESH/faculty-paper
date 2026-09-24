import { useEffect, useRef, useState } from "react"
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Check, Handshake, Mail, Phone, Send, Users, X } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { PeoplePicker } from "@/pages/discussions"
import { Button } from "@/ui/button"
import type { Candidate } from "@/ui/composer"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { Callout, EmptyState, ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * Direct messages: one-to-one and small-group chats.
 *
 * The same private conversations Messages always had (`Thread`, DIRECT), read
 * as a chat: newest at the bottom, unread counts, and "seen" under your last
 * message. Only the people in a conversation can open it -- not the office,
 * not an administrator -- and the server answers 404 to anybody else.
 *
 * An open conversation asks for new messages every twelve seconds while it
 * is on screen, and only a conversation actually on screen counts as read:
 * the request says `read=1` only when the tab is visible, so "seen" is never
 * a hidden tab's doing.
 *
 * A collaboration request travels here as a card with Accept, Decline and
 * Suggest a call; accepting puts the collaboration on both profiles.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

export type Collab = {
  id: string
  topic: string
  journal: string | null
  message: string | null
  state: "PENDING" | "CALL" | "ACCEPTED" | "DECLINED"
  response_note: string | null
  responded_at: string | null
  sender: PersonBrief
  recipient: PersonBrief
  may_respond: boolean
  collaboration_id: string | null
}

type Message = {
  id: string
  author: PersonBrief | null
  kind: "HUMAN" | "AGENT" | "SYSTEM"
  body: string
  deleted: boolean
  created_at: string
  mine: boolean
  collab: Collab | null
  pending?: boolean
}

type Conversation = {
  id: string
  is_group: boolean
  title: string
  people: PersonBrief[]
  participants: (PersonBrief & { me: boolean; last_read_at: string | null })[]
  messages: Message[]
  may_post: boolean
}

type InboxRow = {
  id: string
  is_group: boolean
  title: string
  people: PersonBrief[]
  last: { body: string; author_id: string | null; mine: boolean; kind: string; at: string } | null
  unread: number
  updated_at: string
}

/** An open conversation re-asks this often while it is on screen. */
const CHAT_POLL_MS = 12_000
/** The inbox list (the sidebar badge is `app/unread.tsx`). */
const INBOX_POLL_MS = 30_000

/* ------------------------------------------------------------------------ */
/* The inbox                                                                 */
/* ------------------------------------------------------------------------ */

export function Inbox({ q = "", onStart }: { q?: string; onStart: () => void }) {
  const inbox = useApi<{ results: InboxRow[] }>(["dm", "inbox"], "/api/dm", { refetchInterval: INBOX_POLL_MS })
  const needle = q.trim().toLowerCase()

  if (inbox.isPending) return <SkeletonRows rows={5} rowHeight={64} />
  if (inbox.isError) {
    return (
      <ErrorState
        title="Could not load your messages"
        message="The server did not answer. Nothing has been sent, lost or deleted."
        onRetry={() => void inbox.refetch()}
      />
    )
  }
  // Searched here rather than on the server: it is your own fifty most recent
  // conversations, already on screen.
  const rows = inbox.data.results.filter(
    (r) =>
      !needle ||
      r.title.toLowerCase().includes(needle) ||
      (r.last?.body ?? "").toLowerCase().includes(needle) ||
      r.people.some((p) => p.name.toLowerCase().includes(needle))
  )
  return (
    <section className="space-y-4">
      <Callout tone="info" title="Who can read a direct message">
        Only the people in it. Not your department, not the research office, not an administrator.
      </Callout>
      {rows.length === 0 && needle ? (
        <EmptyState icon={Mail} title="Nothing matches" message="Try part of a name, or clear the search." />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No messages yet"
          message="Write to a colleague about a paper, a venue or a collaboration — one person, or a small group."
          action={
            <Button kind="primary" size="sm" onClick={onStart}>
              <Mail />
              New message
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                to={`/messages/c/${r.id}`}
                className="flex items-center gap-3 px-1 py-3 transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover"
              >
                <Faces people={r.people} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn("min-w-0 flex-1 truncate text-base", r.unread > 0 && "font-semibold")}>
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
                      {r.last ? `${r.last.mine ? "You: " : ""}${r.last.body || "A message was removed"}` : "No messages yet"}
                    </span>
                    {r.unread > 0 && (
                      <span className="grid min-w-[1.25rem] place-items-center rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg tabular">
                        <span className="sr-only">Unread: </span>
                        {r.unread}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Faces({ people }: { people: PersonBrief[] }) {
  if (people.length <= 1) return <Avatar person={people[0]} size="md" />
  return (
    <span className="relative inline-flex size-10 shrink-0" aria-hidden>
      <Avatar person={people[0]} size="sm" className="absolute left-0 top-0 ring-2 ring-bg" />
      <Avatar person={people[1]} size="sm" className="absolute bottom-0 right-0 ring-2 ring-bg" />
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* Starting a conversation                                                   */
/* ------------------------------------------------------------------------ */

/** `/messages?to=<id>[&ref=<post id>]`: straight to the one-to-one chat, opened if new. */
export function OpenChat({ to, refPost }: { to: string; refPost?: string | null }) {
  const navigate = useNavigate()
  const [failed, setFailed] = useState<string | null>(null)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    api<Conversation>(`/api/dm/with/${to}`, { method: "POST" })
      .then((c) => {
        const draft = refPost
          ? `About your post: ${window.location.origin}/discussions/p/${refPost}\n\n`
          : undefined
        navigate(`/messages/c/${c.id}`, { replace: true, state: draft ? { draft } : undefined })
      })
      .catch((err: ApiError) => setFailed(err.message))
  }, [to, refPost, navigate])
  if (failed) {
    return (
      <div className="page max-w-2xl">
        <ErrorState title="Could not open that conversation" message={failed} />
      </div>
    )
  }
  return (
    <div className="page max-w-2xl">
      <SkeletonRows rows={3} rowHeight={56} />
    </div>
  )
}

export function NewChat({ onClose, initial = [] }: { onClose: () => void; initial?: Candidate[] }) {
  const navigate = useNavigate()
  const [people, setPeople] = useState<Candidate[]>(initial)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const start = useMutation<Conversation, ApiError, void>({
    mutationFn: () =>
      api<Conversation>("/api/dm", {
        method: "POST",
        json: { participant_ids: people.map((p) => p.id), title: title.trim() || null, body: body.trim() || null },
      }),
    onSuccess: (c) => {
      onClose()
      navigate(`/messages/c/${c.id}`)
    },
  })
  const group = people.length > 1
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>
            One colleague, or a small group of up to twenty. Only the people you add can ever read it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="To">
            <PeoplePicker chosen={people} onChange={setPeople} max={20} />
          </Field>
          {group && (
            <Field label="Group name (optional)">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Seminar planning" maxLength={120} />
            </Field>
          )}
          <Field label="Message">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxRows={8} placeholder="Write your message" />
          </Field>
          {start.error && <InlineError message={start.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => start.mutate()} disabled={people.length === 0 || start.isPending}>
            <Send />
            {start.isPending ? "Opening…" : body.trim() ? "Send" : "Open conversation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* One conversation                                                          */
/* ------------------------------------------------------------------------ */

export function ChatPage() {
  const { id = "" } = useParams<{ id: string }>()
  const { me } = useAuth()
  const qc = useQueryClient()
  const location = useLocation()
  const [text, setText] = useState<string>(() => (location.state as { draft?: string } | null)?.draft ?? "")
  const [proposing, setProposing] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  const convo = useQuery<Conversation, ApiError>({
    queryKey: ["dm", "conversation", id],
    // Read only when it is in front of somebody: a poll from a hidden tab is
    // not a person reading, and "seen" must not say it was.
    queryFn: async () => {
      const reading = document.visibilityState === "visible"
      const c = await api<Conversation>(`/api/dm/${id}${reading ? "?read=1" : ""}`)
      if (reading) {
        // This fetch marked it read on the server, so the badge, the inbox
        // and the bell are stale now -- whether or not anything new arrived.
        void qc.invalidateQueries({ queryKey: ["dm", "unread"] })
        void qc.invalidateQueries({ queryKey: ["dm", "inbox"] })
        void qc.invalidateQueries({ queryKey: ["notifications"] })
      }
      return c
    },
    refetchInterval: CHAT_POLL_MS,
    enabled: !!id,
  })

  const count = convo.data?.messages.length ?? 0
  useEffect(() => {
    if (count) bottom.current?.scrollIntoView({ block: "end" })
  }, [count])

  useEffect(() => {
    if (text) box.current?.focus()
    // Only on arrival: a draft handed over from a post's 🤝 is ready to finish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = useMutation<Message, ApiError, { body: string; temp: Message }>({
    mutationFn: ({ body }) => api<Message>(`/api/dm/${id}/messages`, { method: "POST", json: { body } }),
    onMutate: ({ temp }) => {
      qc.setQueryData<Conversation>(["dm", "conversation", id], (c) => (c ? { ...c, messages: [...c.messages, temp] } : c))
    },
    onSuccess: (real, { temp }) => {
      qc.setQueryData<Conversation>(["dm", "conversation", id], (c) =>
        c ? { ...c, messages: c.messages.map((m) => (m.id === temp.id ? real : m)) } : c
      )
    },
    onError: (err, { temp, body }) => {
      qc.setQueryData<Conversation>(["dm", "conversation", id], (c) =>
        c ? { ...c, messages: c.messages.filter((m) => m.id !== temp.id) } : c
      )
      setText(body)
      toast.fail(err)
    },
  })

  function submit() {
    const body = text.trim()
    if (!body || !me) return
    send.mutate({
      body,
      temp: {
        id: `temp-${Date.now()}`,
        author: { id: me.id, name: me.name, initials: "", photo_url: me.photo_url ?? null },
        kind: "HUMAN",
        body,
        deleted: false,
        created_at: new Date().toISOString(),
        mine: true,
        collab: null,
        pending: true,
      },
    })
    setText("")
  }

  if (convo.isPending) {
    return (
      <div className="page max-w-2xl">
        <SkeletonRows rows={6} rowHeight={48} />
      </div>
    )
  }
  if (convo.isError) {
    return (
      <div className="page max-w-2xl space-y-4">
        <BackToMessages />
        <ErrorState
          title={convo.error.status === 404 ? "This conversation is not here" : "Could not load this conversation"}
          message={
            convo.error.status === 404
              ? "Only the people in a conversation can open it. The link may be wrong, or it is not one you are in."
              : "The server did not answer. Nothing has been lost."
          }
          onRetry={convo.error.status === 404 ? undefined : () => void convo.refetch()}
        />
      </div>
    )
  }

  const c = convo.data
  const other = !c.is_group ? c.people[0] : null
  const lastMine = [...c.messages].reverse().find((m) => m.mine && !m.pending && m.kind === "HUMAN")
  const seenBy = lastMine
    ? c.participants.filter((p) => !p.me && p.last_read_at && p.last_read_at >= lastMine.created_at)
    : []

  return (
    <div className="page flex max-w-2xl flex-col gap-4">
      <BackToMessages />
      <header className="flex flex-wrap items-center gap-3">
        <Faces people={c.people} />
        {/* A basis wide enough for a name, so on a phone the button wraps
            beneath it instead of squeezing the name to three letters. */}
        <div className="min-w-0 flex-1 basis-52">
          <PageTitle className="truncate text-xl sm:text-2xl">
            {other ? <PersonLink id={other.id} name={other.name} className="font-[inherit]" /> : c.title}
          </PageTitle>
          <Meta className="block truncate text-xs">
            {c.is_group ? (
              <>
                <Users className="mr-1 inline size-3 align-[-1px]" aria-hidden />
                {c.participants.length} people · only they can read this
              </>
            ) : (
              [other?.designation, other?.department].filter(Boolean).join(" · ") || "Only the two of you can read this"
            )}
          </Meta>
        </div>
        {other && (
          <Button kind="default" size="sm" onClick={() => setProposing(true)} className="w-full sm:w-auto">
            <Handshake />
            Propose a collaboration
          </Button>
        )}
      </header>

      <ol className="space-y-2" aria-label="Messages" aria-live="polite">
        {c.messages.length === 0 && (
          <li>
            <Meta className="block py-6 text-center text-sm">No messages yet. Say hello.</Meta>
          </li>
        )}
        {c.messages.map((m) => (
          <MessageRow key={m.id} m={m} group={c.is_group} conversationId={c.id} />
        ))}
      </ol>
      {lastMine && (
        <Meta className="-mt-2 block text-right text-xs" aria-live="polite">
          {seenBy.length === 0
            ? "Sent"
            : c.is_group
              ? `Seen by ${seenBy.map((p) => p.name.split(" ")[0]).join(", ")}`
              : "Seen"}
        </Meta>
      )}
      <div ref={bottom} />

      {c.may_post ? (
        <form
          className="sticky bottom-0 -mx-1 flex items-end gap-2 border-t border-line bg-bg px-1 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            maxRows={6}
            aria-label="Write a message"
            placeholder="Write a message. Enter sends, Shift+Enter starts a new line."
            className="min-w-0 flex-1"
          />
          <Button kind="primary" size="md" type="submit" disabled={!text.trim()} aria-label="Send">
            <Send />
            <span className="hidden sm:inline">Send</span>
          </Button>
        </form>
      ) : (
        <Meta className="block text-center">This conversation is closed to new messages.</Meta>
      )}

      {proposing && other && <CollabDialog person={other} onClose={() => setProposing(false)} />}
    </div>
  )
}

function BackToMessages() {
  return (
    <Button kind="quiet" size="sm" asChild className="-ml-2 self-start">
      <Link to="/messages">
        <ArrowLeft />
        Messages
      </Link>
    </Button>
  )
}

function MessageRow({ m, group, conversationId }: { m: Message; group: boolean; conversationId: string }) {
  if (m.kind === "SYSTEM") {
    return (
      <li className="py-1 text-center">
        <Meta className="text-xs">
          {m.body} · <Ago iso={m.created_at} />
        </Meta>
      </li>
    )
  }
  return (
    <li className={cn("flex gap-2", m.mine ? "justify-end" : "justify-start", m.pending && "opacity-70")}>
      {!m.mine && <Avatar person={m.author} size="sm" className="mt-auto" />}
      <div className={cn("max-w-[85%] space-y-1 sm:max-w-[75%]", m.mine && "items-end")}>
        {group && !m.mine && m.author && (
          <Meta className="block px-1 text-xs">{m.author.name}</Meta>
        )}
        {m.body && (
          <div
            className={cn(
              "whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed",
              m.mine ? "bg-accent-wash text-fg" : "bg-sunken text-fg"
            )}
          >
            {m.deleted ? <span className="italic text-fg-muted">This message was removed.</span> : linkify(m.body)}
          </div>
        )}
        {m.collab && <CollabCard collab={m.collab} conversationId={conversationId} />}
        <Meta className={cn("block px-1 text-[11px]", m.mine && "text-right")}>
          {m.pending ? "Sending…" : <Ago iso={m.created_at} />}
        </Meta>
      </div>
    </li>
  )
}

/** A link to one of our own posts stays inside the app; any other web address opens in a new tab. */
function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) => {
    if (!/^https?:\/\//.test(part)) return <span key={i}>{part}</span>
    const local = part.startsWith(window.location.origin) ? part.slice(window.location.origin.length) : null
    if (local && local.startsWith("/")) {
      return (
        <Link key={i} to={local} className="text-accent underline underline-offset-4">
          {local.startsWith("/discussions/p/") ? "the post" : local}
        </Link>
      )
    }
    return (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-4">
        {part}
      </a>
    )
  })
}

/* ------------------------------------------------------------------------ */
/* Collaboration requests                                                    */
/* ------------------------------------------------------------------------ */

const STATE_LINE: Record<Collab["state"], string> = {
  PENDING: "Waiting for an answer",
  CALL: "A call was suggested",
  ACCEPTED: "Accepted — this collaboration is on both profiles",
  DECLINED: "Declined",
}

function CollabCard({ collab, conversationId }: { collab: Collab; conversationId: string }) {
  const qc = useQueryClient()
  const [calling, setCalling] = useState(false)
  const [note, setNote] = useState("")
  const answer = useMutation<Collab, ApiError, { action: "accept" | "decline" | "call"; note?: string }>({
    mutationFn: (body) =>
      api<Collab>(`/api/collaborations/requests/${collab.id}/respond`, { method: "POST", json: body }),
    onSuccess: (_c, { action }) => {
      void qc.invalidateQueries({ queryKey: ["dm", "conversation", conversationId] })
      void qc.invalidateQueries({ queryKey: ["person"] })
      toast.ok(
        action === "accept"
          ? "Accepted. It is on both your profiles now."
          : action === "call"
            ? "Call suggested"
            : "Declined"
      )
      setCalling(false)
    },
    onError: (err) => toast.fail(err),
  })

  return (
    <section
      aria-label="Collaboration request"
      className="space-y-2 rounded-lg bg-surface px-3 py-2.5 text-sm ring-1 ring-inset ring-accent-line"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <span aria-hidden>🤝</span> Collaboration request
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-fg-muted">Topic</dt>
        <dd className="min-w-0 break-words">{collab.topic}</dd>
        {collab.journal && (
          <>
            <dt className="text-fg-muted">Journal</dt>
            <dd className="min-w-0 break-words">{collab.journal}</dd>
          </>
        )}
      </dl>
      <p className={cn("text-xs", collab.state === "ACCEPTED" ? "text-positive" : "text-fg-muted")}>
        {STATE_LINE[collab.state]}
        {collab.state === "CALL" && collab.response_note ? `: ${collab.response_note}` : ""}
      </p>
      {collab.may_respond &&
        (calling ? (
          <div className="flex flex-wrap gap-2">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="When suits you? Thursday at 3"
              aria-label="When could you talk"
              className="min-w-0 flex-1"
            />
            <Button kind="primary" size="sm" onClick={() => answer.mutate({ action: "call", note })} disabled={answer.isPending}>
              Suggest
            </Button>
            <Button kind="quiet" size="sm" onClick={() => setCalling(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button kind="primary" size="sm" onClick={() => answer.mutate({ action: "accept" })} disabled={answer.isPending}>
              <Check />
              Accept
            </Button>
            <Button kind="default" size="sm" onClick={() => setCalling(true)} disabled={answer.isPending}>
              <Phone />
              Suggest a call
            </Button>
            <Button kind="quiet" size="sm" onClick={() => answer.mutate({ action: "decline" })} disabled={answer.isPending}>
              <X />
              Decline
            </Button>
          </div>
        ))}
    </section>
  )
}

/** "Shall we write this together?" -- from a profile or a chat. Lands as a card in your chat with them. */
export function CollabDialog({ person, onClose }: { person: PersonBrief; onClose: () => void }) {
  const navigate = useNavigate()
  const first = (person.name || "").replace(/^(Dr|Mr|Ms|Mrs|Prof)\.?\s+/i, "").split(" ")[0]
  const [topic, setTopic] = useState("")
  const [journal, setJournal] = useState("")
  const [message, setMessage] = useState(`Hello ${first}, would you like to work on this together?`)
  const send = useMutation<{ conversation_id: string }, ApiError, void>({
    mutationFn: () =>
      api("/api/collaborations/requests", {
        method: "POST",
        json: { to_id: person.id, topic: topic.trim(), journal: journal.trim(), message: message.trim() },
      }),
    onSuccess: (r) => {
      onClose()
      toast.ok(`Sent to ${person.name}`)
      navigate(`/messages/c/${r.conversation_id}`)
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Propose a collaboration with {person.name}</DialogTitle>
          <DialogDescription>
            It arrives as a card in your messages with them. If they accept, the collaboration shows on both your
            profiles.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="What you would work on">
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Thin-film solar cells" maxLength={200} autoFocus />
          </Field>
          <Field label="Proposed journal (optional)">
            <Input value={journal} onChange={(e) => setJournal(e.target.value)} placeholder="Solar Energy Materials and Solar Cells" />
          </Field>
          <Field label="Message">
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxRows={8} />
          </Field>
          {send.error && <InlineError message={send.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => send.mutate()} disabled={!topic.trim() || send.isPending}>
            <Handshake />
            {send.isPending ? "Sending…" : "Send request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** An old direct thread link (`/messages/:id`) opened as a chat. */
export function DirectRedirect({ id }: { id: string }) {
  return <Navigate to={`/messages/c/${id}`} replace />
}
