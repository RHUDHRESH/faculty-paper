import { useEffect, useRef, useState } from "react"
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, AtSign, Check, FileText, Handshake, Lock, Phone, Send, UserRound, Users, X } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
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
import { ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Tooltip, TooltipProvider } from "@/ui/tooltip"
import { Ago } from "@/ui/when"
import { StreamingText, ThinkingIndicator, useStickToBottom, useTypewriter } from "@/ui/motion/stream"

/** An assistant reply arrived in the last 20s: reveal it as if streamed, once. */
function isFresh(iso: string) {
  return Date.now() - new Date(iso).getTime() < 20_000
}

/** The last message is mine, asks @agent, is recent, and nothing has answered yet. */
function awaitingAgent(messages: { kind: string; mine?: boolean; body: string; created_at: string }[]) {
  const last = messages[messages.length - 1]
  return !!last && last.mine && last.kind === "HUMAN" && /@agent\b/i.test(last.body) && Date.now() - new Date(last.created_at).getTime() < 120_000
}

function AgentReveal({ body }: { body: string }) {
  const typed = useTypewriter(body)
  return typed.length < body.length ? <StreamingText text={typed} /> : <>{linkify(body)}</>
}

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
  /** Refused by the server; shown with Retry. Never sent by the server. */
  failed?: boolean
}

type Conversation = {
  id: string
  is_group: boolean
  title: string
  people: PersonBrief[]
  participants: (PersonBrief & { me: boolean; last_read_at: string | null })[]
  messages: Message[]
  may_post: boolean
  /** What the conversation is about, shown as a card at its top. */
  context?: ChatContext | null
  /** Offered by `/dm/with/{id}?context_kind=…`; attached by the first message sent. */
  pending_context?: ChatContext | null
}

export type ChatContext = { kind: "paper" | "person" | "collab"; id: string; title: string; href: string }

/** `ctx=paper:<id>` on a `/messages?to=` link, as the query the server reads. */
export function contextQuery(ctx: string | null | undefined): string {
  if (!ctx) return ""
  const at = ctx.indexOf(":")
  if (at < 1) return ""
  const kind = ctx.slice(0, at)
  const id = ctx.slice(at + 1)
  return `?context_kind=${encodeURIComponent(kind)}&context_id=${encodeURIComponent(id)}`
}

export type InboxRow = {
  id: string
  /** "office" rows are research-office threads, merged into the one list. */
  kind?: "person" | "group" | "office"
  href?: string
  resolved?: boolean | null
  is_group: boolean
  title: string
  people: PersonBrief[]
  last: {
    body: string
    author_id: string | null
    mine: boolean
    kind: string
    at: string
  } | null
  unread: number
  updated_at: string
}

/** An open conversation re-asks this often while it is on screen. */
const CHAT_POLL_MS = 12_000
/** The inbox list (the sidebar badge is `app/unread.tsx`). */
export const INBOX_POLL_MS = 30_000

export function Faces({ people }: { people: PersonBrief[] }) {
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
export function OpenChat({
  to,
  refPost,
  draft: given,
  ctx,
}: {
  to: string
  refPost?: string | null
  /** A prefilled, unsent draft (e.g. an intro request). */
  draft?: string | null
  /** `kind:id` of what this is about -- a paper, a person, a collaboration. */
  ctx?: string | null
}) {
  const navigate = useNavigate()
  const [failed, setFailed] = useState<string | null>(null)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const open = (q: string) => api<Conversation>(`/api/dm/with/${to}${q}`, { method: "POST" })
    // A context that no longer resolves must not stop the conversation opening.
    open(contextQuery(ctx))
      .catch((err: ApiError) => (ctx && err.status !== 401 ? open("") : Promise.reject(err)))
      .then((c) => {
        const draft =
          given ?? (refPost ? `About your post: ${window.location.origin}/discussions/p/${refPost}\n\n` : undefined)
        navigate(`/messages/c/${c.id}`, {
          replace: true,
          state: draft || c.pending_context ? { draft, context: c.pending_context ?? null } : undefined,
        })
      })
      .catch((err: ApiError) => setFailed(err.message))
  }, [to, refPost, given, ctx, navigate])
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
        json: {
          participant_ids: people.map((p) => p.id),
          title: title.trim() || null,
          body: body.trim() || null,
        },
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
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Seminar planning"
                maxLength={120}
              />
            </Field>
          )}
          <Field label="Message">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxRows={8}
              placeholder="Write your message"
            />
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
  const handed = location.state as { draft?: string; context?: ChatContext | null } | null
  const [text, setText] = useState<string>(() => handed?.draft ?? "")
  // Attached to the next message sent; dismissable with its ✕ until then.
  const [attach, setAttach] = useState<ChatContext | null>(() => handed?.context ?? null)
  const [proposing, setProposing] = useState(false)
  const [unsent, setUnsent] = useState<Message[]>([])
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
  // Follows new messages unless the reader has scrolled up to read history.
  const scroller = useStickToBottom<HTMLDivElement>(count)

  useEffect(() => {
    if (text) box.current?.focus()
    // Only on arrival: a draft handed over from a post's 🤝 is ready to finish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = useMutation<Message, ApiError, { body: string; temp: Message; context?: ChatContext | null }>({
    mutationFn: ({ body, context }) =>
      api<Message>(`/api/dm/${id}/messages`, {
        method: "POST",
        json: context ? { body, context: { kind: context.kind, id: context.id } } : { body },
      }),
    onMutate: ({ temp }) => {
      qc.setQueryData<Conversation>(["dm", "conversation", id], (c) =>
        c ? { ...c, messages: [...c.messages, temp] } : c
      )
    },
    onSuccess: (real, { temp, context }) => {
      qc.setQueryData<Conversation>(["dm", "conversation", id], (c) =>
        c
          ? {
              ...c,
              context: context ?? c.context,
              messages: c.messages.map((m) => (m.id === temp.id ? real : m)),
            }
          : c
      )
    },
    onError: (_err, { temp }) => {
      qc.setQueryData<Conversation>(["dm", "conversation", id], (c) =>
        c ? { ...c, messages: c.messages.filter((m) => m.id !== temp.id) } : c
      )
      // Kept on screen, marked, with Retry -- held here rather than in the
      // query cache, which the next poll would overwrite.
      setUnsent((u) => [...u, { ...temp, pending: false, failed: true }])
    },
  })

  function submit() {
    const body = text.trim()
    if (!body) return
    post(body)
    setText("")
  }

  function retry(m: Message) {
    setUnsent((u) => u.filter((x) => x.id !== m.id))
    post(m.body)
  }

  function post(body: string) {
    if (!me) return
    const context = attach
    setAttach(null)
    send.mutate({
      body,
      context,
      temp: {
        id: `temp-${Date.now()}`,
        author: {
          id: me.id,
          name: me.name,
          initials: "",
          photo_url: me.photo_url ?? null,
        },
        kind: "HUMAN",
        body,
        deleted: false,
        created_at: new Date().toISOString(),
        mine: true,
        collab: null,
        pending: true,
      },
    })
  }

  if (convo.isPending) {
    return (
      <div className="p-4">
        <SkeletonRows rows={6} rowHeight={48} />
      </div>
    )
  }
  if (convo.isError) {
    return (
      <div className="space-y-4 p-4">
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
  const lastMine = [...c.messages].reverse().find((m) => m.mine && !m.pending && !m.failed && m.kind === "HUMAN")
  const seenBy = lastMine
    ? c.participants.filter((p) => !p.me && p.last_read_at && p.last_read_at >= lastMine.created_at)
    : []
  const privacy = other
    ? `Only you and ${other.name} can read this.`
    : `Only the ${c.participants.length} people in this conversation can read this.`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <BackToMessages />
        <Faces people={c.people} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">
            {other ? <PersonLink id={other.id} name={other.name} className="font-[inherit]" /> : c.title}
          </h1>
          <Meta className="block truncate text-xs">
            {c.is_group ? (
              <>
                <Users className="mr-1 inline size-3 align-[-1px]" aria-hidden />
                Group · {c.participants.length} people
              </>
            ) : (
              [other?.designation, other?.department].filter(Boolean).join(" · ") || "Direct message"
            )}
          </Meta>
        </div>
        {other && (
          <>
            <Button kind="default" size="sm" asChild className="hidden sm:inline-flex">
              <Link to={`/u/${other.id}`}>
                <UserRound />
                Profile
              </Link>
            </Button>
            <Button kind="quiet" size="sm" onClick={() => setProposing(true)} aria-label="Propose a collaboration">
              <Handshake />
              <span className="hidden lg:inline">Propose a collaboration</span>
            </Button>
          </>
        )}
      </header>
      <p className="flex items-center gap-1.5 border-b border-line px-4 py-1.5 text-xs text-fg-muted">
        <Lock className="size-3 shrink-0" aria-hidden />
        {privacy}
      </p>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {c.context && <ContextCard context={c.context} className="mx-auto mb-4 max-w-lg" />}
        <ol className="space-y-2" aria-label="Messages" aria-live="polite">
          {c.messages.length === 0 && (
            <li>
              <Meta className="block py-6 text-center text-sm">No messages yet. Say hello.</Meta>
            </li>
          )}
          {[...c.messages, ...unsent].map((m) => (
            <MessageRow key={m.id} m={m} group={c.is_group} conversationId={c.id} onRetry={retry} />
          ))}
          {awaitingAgent(c.messages) && (
            <li className="flex justify-start pl-10">
              <ThinkingIndicator label="The assistant is thinking" />
            </li>
          )}
        </ol>
        {lastMine && (
          <Meta className="mt-1 block text-right text-xs" aria-live="polite">
            {seenBy.length === 0
              ? "Sent"
              : c.is_group
                ? `Seen by ${seenBy.map((p) => p.name.split(" ")[0]).join(", ")}`
                : "Seen"}
          </Meta>
        )}
        <div ref={bottom} />
      </div>

      {c.may_post && attach && (
        <div className="border-t border-line bg-bg px-3 pt-2">
          <ContextCard context={attach} onDismiss={() => setAttach(null)} note="attached as context" />
        </div>
      )}
      {c.may_post ? (
        <form
          className="sticky bottom-0 flex items-end gap-2 border-t border-line bg-bg px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <TooltipProvider>
            <Tooltip content="Mention a person, paper or journal — or @agent to ask the assistant.">
              <Button
                kind="quiet"
                size="md"
                type="button"
                aria-label="Mention a person, paper or journal — or @agent to ask the assistant."
                onClick={() => {
                  setText((t) => (t && !t.endsWith(" ") ? `${t} @` : `${t}@`))
                  box.current?.focus()
                }}
              >
                <AtSign />
              </Button>
            </Tooltip>
          </TooltipProvider>
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
            placeholder="Write a message…"
            className="min-w-0 flex-1"
          />
          <Button kind="primary" size="md" type="submit" disabled={!text.trim()} aria-label="Send">
            <Send />
            <span className="hidden sm:inline">Send</span>
          </Button>
        </form>
      ) : (
        <Meta className="block py-3 text-center">This conversation is closed to new messages.</Meta>
      )}

      {proposing && other && <CollabDialog person={other} onClose={() => setProposing(false)} />}
    </div>
  )
}

const CONTEXT_LABEL: Record<ChatContext["kind"], string> = {
  paper: "Paper",
  person: "About",
  collab: "Collaboration",
}

/** What a conversation is about: a paper, a person or a collaboration. */
export function ContextCard({
  context,
  onDismiss,
  note,
  className,
}: {
  context: ChatContext
  onDismiss?: () => void
  note?: string
  className?: string
}) {
  const Icon = context.kind === "paper" ? FileText : context.kind === "person" ? UserRound : Handshake
  const title = context.href ? (
    <Link to={context.href} className="truncate font-medium hover:underline">
      {context.title}
    </Link>
  ) : (
    <span className="truncate font-medium">{context.title}</span>
  )
  return (
    <div
      data-testid="context-card"
      className={cn(
        "flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm",
        className
      )}
    >
      <Icon className="size-4 shrink-0 text-[var(--area-people)]" aria-hidden />
      <Meta className="shrink-0 text-xs">{CONTEXT_LABEL[context.kind]}</Meta>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {title}
        {note && <Meta className="hidden shrink-0 text-xs sm:inline">· {note}</Meta>}
      </span>
      {onDismiss && (
        <Button kind="quiet" size="sm" type="button" onClick={onDismiss} aria-label="Remove the context">
          <X />
        </Button>
      )}
    </div>
  )
}

/** Only on a phone: the inbox and the conversation share one screen there. */
function BackToMessages() {
  return (
    <Button kind="quiet" size="sm" asChild className="-ml-2 md:hidden">
      <Link to="/messages" aria-label="Back to all messages">
        <ArrowLeft />
      </Link>
    </Button>
  )
}

function MessageRow({
  m,
  group,
  conversationId,
  onRetry,
}: {
  m: Message
  group: boolean
  conversationId: string
  onRetry: (m: Message) => void
}) {
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
      <div className={cn("flex max-w-[85%] flex-col gap-1 sm:max-w-[75%]", m.mine && "items-end")}>
        {group && !m.mine && m.author && <Meta className="block px-1 text-xs">{m.author.name}</Meta>}
        {m.body && (
          <div
            className={cn(
              "whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed",
              m.mine
                ? "rounded-br-md bg-accent text-accent-fg [&_a]:text-accent-fg"
                : "rounded-bl-md bg-sunken text-fg",
              m.failed && "bg-sunken text-fg ring-1 ring-inset ring-critical"
            )}
          >
            {m.deleted ? (
              <span className="italic opacity-75">This message was removed.</span>
            ) : m.kind === "AGENT" && isFresh(m.created_at) ? (
              <AgentReveal body={m.body} />
            ) : (
              linkify(m.body)
            )}
          </div>
        )}
        {m.collab && <CollabCard collab={m.collab} conversationId={conversationId} />}
        {m.failed ? (
          <p className="px-1 text-xs text-critical" role="alert">
            Not sent.{" "}
            <button type="button" className="font-medium underline underline-offset-4" onClick={() => onRetry(m)}>
              Retry
            </button>
          </p>
        ) : (
          <Meta className={cn("block px-1 text-[11px]", m.mine && "text-right")}>
            {m.pending ? "Sending…" : <Ago iso={m.created_at} />}
          </Meta>
        )}
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
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-accent underline underline-offset-4"
      >
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
      api<Collab>(`/api/collaborations/requests/${collab.id}/respond`, {
        method: "POST",
        json: body,
      }),
    onSuccess: (_c, { action }) => {
      void qc.invalidateQueries({
        queryKey: ["dm", "conversation", conversationId],
      })
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
            <Button
              kind="primary"
              size="sm"
              onClick={() => answer.mutate({ action: "call", note })}
              disabled={answer.isPending}
            >
              Suggest
            </Button>
            <Button kind="quiet" size="sm" onClick={() => setCalling(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              kind="primary"
              size="sm"
              onClick={() => answer.mutate({ action: "accept" })}
              disabled={answer.isPending}
            >
              <Check />
              Accept
            </Button>
            <Button kind="default" size="sm" onClick={() => setCalling(true)} disabled={answer.isPending}>
              <Phone />
              Suggest a call
            </Button>
            <Button
              kind="quiet"
              size="sm"
              onClick={() => answer.mutate({ action: "decline" })}
              disabled={answer.isPending}
            >
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
        json: {
          to_id: person.id,
          topic: topic.trim(),
          journal: journal.trim(),
          message: message.trim(),
        },
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
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Thin-film solar cells"
              maxLength={200}
              autoFocus
            />
          </Field>
          <Field label="Proposed journal (optional)">
            <Input
              value={journal}
              onChange={(e) => setJournal(e.target.value)}
              placeholder="Solar Energy Materials and Solar Cells"
            />
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
