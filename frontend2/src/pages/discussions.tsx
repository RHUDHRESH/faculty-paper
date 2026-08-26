import { useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import {
  ArrowLeft,
  Bot,
  CircleCheck,
  Lock,
  MessagesSquare,
  Plus,
  Send,
} from "lucide-react"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
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
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * Discussions — a thread that knows what it is about.
 *
 * Deliberately not a chat box. A post names the things it concerns and those
 * names resolve to real records: `@journal:"Ceramics International"` is a
 * journal we hold a quartile and a SNIP for, `@paper:ERP-001934` is a ticket,
 * `@agent` is an assistant that answers from our own tables rather than from
 * a model. So a question about what a venue pays gets an answer the system
 * can stand behind, in the thread, beside the question.
 *
 * Visibility is three-valued and enforced on the server, and a thread you may
 * not read answers 404 rather than 403 — a 403 confirms it exists, which is
 * itself the leak. This screen never has to reason about any of that: it
 * shows what came back.
 */

/* ------------------------------------------------------------------------ */
/* Data — read out of the thread endpoints in backend/core/api.py           */
/* ------------------------------------------------------------------------ */

type Visibility = "PUBLIC" | "DEPARTMENT" | "OFFICE"

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
}

type ThreadList = {
  total: number
  results: ThreadRow[]
  visibilities: { key: Visibility; label: string }[]
}

type Candidate = { kind: string; id: string; label: string; hint: string | null }

const VISIBILITY_LABEL: Record<Visibility, string> = {
  PUBLIC: "Everybody",
  DEPARTMENT: "My department",
  OFFICE: "The office only",
}

/* ------------------------------------------------------------------------ */
/* The list                                                                  */
/* ------------------------------------------------------------------------ */

export function Discussions() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const visibility = searchParams.get("visibility") ?? ""
  const mine = searchParams.get("mine") === "1"
  const [composing, setComposing] = useState(false)

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => setParam("q", draft), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const query = new URLSearchParams()
  if (q) query.set("q", q)
  if (visibility) query.set("visibility", visibility)
  if (mine) query.set("mine", "true")

  const { data, isLoading, isError, refetch } = useApi<ThreadList>(
    ["threads", q, visibility, mine],
    `/api/threads?${query.toString()}`
  )

  const threads = data?.results ?? []

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Discussions</PageTitle>
          <Sub className="mt-1">
            Ask the office, talk to your department, or pull the assistant in with{" "}
            <code className="rounded-sm bg-sunken px-1 text-sm">@agent</code>.
          </Sub>
        </div>
        <Button kind="primary" size="md" onClick={() => setComposing(true)}>
          <Plus />
          Start a thread
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search threads"
          aria-label="Search threads"
          className="w-full max-w-xs"
        />
        <Combobox
          value={visibility}
          onChange={(v) => setParam("visibility", v)}
          options={[
            { value: "", label: "Anything I can see" },
            ...(data?.visibilities ?? []).map((v) => ({ value: v.key, label: v.label })),
          ]}
          aria-label="Filter by who can see it"
          className="w-52"
        />
        <Button
          kind={mine ? "default" : "quiet"}
          size="md"
          onClick={() => setParam("mine", mine ? "" : "1")}
        >
          Only mine
        </Button>
      </div>

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={64} />
      ) : isError ? (
        <ErrorState
          title="Could not load the threads"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => refetch()}
        />
      ) : threads.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={q || visibility || mine ? "Nothing matches" : "No threads yet"}
          message={
            q || visibility || mine
              ? "Try clearing a filter."
              : "Start one to ask the office something, or to talk to your department about where to publish."
          }
          action={
            <Button kind="primary" size="sm" onClick={() => setComposing(true)}>
              Start a thread
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {threads.map((t) => (
            <li key={t.id} className="row">
              <Link to={`/discussions/${t.id}`} className="flex items-start gap-3 px-1 py-3 sm:px-2">
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
                  <Meta className="mt-0.5 block truncate">
                    {[
                      t.created_by,
                      VISIBILITY_LABEL[t.visibility],
                      t.department,
                      t.journal_title,
                      t.ticket_number,
                    ]
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
      )}

      {composing && <NewThread onClose={() => setComposing(false)} />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One thread                                                                */
/* ------------------------------------------------------------------------ */

export function Thread() {
  const { id } = useParams<{ id: string }>()
  const { me } = useAuth()
  const [body, setBody] = useState("")

  const { data, isLoading, error, refetch } = useApi<ThreadDetail>(
    ["thread", id],
    `/api/threads/${id}`,
    { enabled: !!id }
  )

  const post = useApiMutation<{ body: string }, unknown>(`/api/threads/${id}/posts`, {
    invalidates: [["thread", id], ["threads"], ["notifications"]],
  })

  const resolve = useApiMutation<void, unknown>(
    () => `/api/threads/${id}/resolve?resolved=${data?.resolved ? "false" : "true"}`,
    { invalidates: [["thread", id], ["threads"]] }
  )

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
          <Link to="/discussions">
            <ArrowLeft />
            Discussions
          </Link>
        </Button>
        <ErrorState
          title={error?.status === 404 ? "No thread here" : "Could not load this thread"}
          message={
            error?.status === 404
              ? "It may have been removed, or it is not one this account can see."
              : "The server did not answer."
          }
          onRetry={error?.status === 404 ? undefined : () => refetch()}
        />
      </div>
    )
  }

  return (
    <div className="page space-y-6">
      <div>
        <Button kind="quiet" size="sm" asChild className="-ml-2">
          <Link to="/discussions">
            <ArrowLeft />
            Discussions
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <PageTitle>{data.title}</PageTitle>
            <Sub className="mt-1">
              {[
                data.created_by,
                VISIBILITY_LABEL[data.visibility],
                data.department,
                `${data.followers} following`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Sub>
          </div>
          <div className="flex shrink-0 gap-2">
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

      {(data.claim_id || data.journal_title) && (
        <div className="flex flex-wrap gap-2">
          {data.claim_id && (
            <Link
              to={`/papers/${data.claim_id}`}
              className="rounded-md bg-sunken px-2 py-1 text-sm underline-offset-2 hover:underline"
            >
              {data.ticket_number || "The paper"}
            </Link>
          )}
          {data.journal_title && (
            <Link
              to={`/journals/${encodeURIComponent(data.journal_title)}`}
              className="rounded-md bg-sunken px-2 py-1 text-sm underline-offset-2 hover:underline"
            >
              {data.journal_title}
            </Link>
          )}
        </div>
      )}

      {data.locked && (
        <Callout tone="caution" title="This thread is closed to new posts">
          It stays readable. The office closed it.
        </Callout>
      )}

      <ul className="space-y-4">
        {data.posts.map((p) => (
          <Post key={p.id} post={p} isMine={p.author_id === me?.id} threadId={data.id} />
        ))}
      </ul>

      {data.may_post && !data.locked && (
        <Composer
          value={body}
          onChange={setBody}
          onSend={() => void send()}
          busy={post.isPending}
        />
      )}
    </div>
  )
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
        "space-y-1.5 rounded-lg px-3 py-2.5",
        isAgent && "bg-accent-wash",
        isSystem && "bg-sunken"
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {isAgent && <Bot className="size-3.5 text-accent" aria-hidden />}
          {isAgent ? "Assistant" : isSystem ? "Recorded" : post.author_name || "Somebody"}
        </span>
        <Meta className="text-xs">
          {relative(post.created_at)}
          {post.edited_at ? " · edited" : ""}
        </Meta>
      </div>

      <div className="whitespace-pre-wrap text-base leading-relaxed">{renderBody(post.body)}</div>

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
        <button
          type="button"
          onClick={() => void remove.mutateAsync(undefined as never)}
          className="reveal text-sm text-fg-subtle underline-offset-2 hover:text-critical hover:underline"
        >
          Delete
        </button>
      )}
    </li>
  )
}

/** A resolved @name, linked to the thing it actually points at. */
function MentionChip({ mention }: { mention: MentionRow }) {
  const base = "rounded-sm bg-surface px-1.5 py-0.5 text-xs ring-1 ring-inset ring-edge"

  if (mention.kind === "USER" && mention.user_id) {
    return (
      <Link to={`/people/${mention.user_id}`} className={cn(base, "hover:bg-hover")}>
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

/** Bold the `**…**` the assistant writes, and nothing else. */
function renderBody(body: string) {
  return body.split(/(\*\*[^*]+\*\*)/g).map((chunk, i) =>
    chunk.startsWith("**") && chunk.endsWith("**") ? (
      <strong key={i}>{chunk.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{chunk}</span>
    )
  )
}

/* ------------------------------------------------------------------------ */
/* The composer, with @ autocomplete                                        */
/* ------------------------------------------------------------------------ */

/**
 * Typing `@` opens the picker.
 *
 * The candidates come from the server, scoped to what this account may see —
 * a claimant cannot enumerate other people's tickets by typing `@` and a
 * digit. A label with a space in it is inserted quoted, because a mention
 * that stops at the first space points at the wrong thing far more often
 * than not.
 */
function Composer({
  value,
  onChange,
  onSend,
  busy,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  busy: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [term, setTerm] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])

  useEffect(() => {
    if (term === null || term.length < 1) {
      setCandidates([])
      return
    }
    const t = setTimeout(() => {
      void api<{ results: Candidate[] }>(`/api/mentions/search?q=${encodeURIComponent(term)}`)
        .then((r) => setCandidates(r.results))
        .catch(() => setCandidates([]))
    }, 180)
    return () => clearTimeout(t)
  }, [term])

  function onType(next: string) {
    onChange(next)
    // The word being typed, if it started with @ and has not been closed by
    // a space since.
    const upTo = next.slice(0, ref.current?.selectionStart ?? next.length)
    const match = upTo.match(/@([A-Za-z0-9._-]*)$/)
    setTerm(match ? match[1] : null)
  }

  function insert(candidate: Candidate) {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, caret).replace(/@([A-Za-z0-9._-]*)$/, "")
    const after = value.slice(caret)
    const needsQuotes = /\s/.test(candidate.label)
    const prefix =
      candidate.kind === "AGENT"
        ? "@agent"
        : candidate.kind === "JOURNAL"
          ? `@journal:${needsQuotes ? `"${candidate.label}"` : candidate.label}`
          : candidate.kind === "PAPER"
            ? `@paper:${candidate.id}`
            : candidate.kind === "DEPARTMENT"
              ? `@dept:${needsQuotes ? `"${candidate.label}"` : candidate.label}`
              : `@user:${needsQuotes ? `"${candidate.label}"` : candidate.label}`
    onChange(`${before}${prefix} ${after}`)
    setTerm(null)
    setCandidates([])
    el?.focus()
  }

  return (
    <div className="relative space-y-2">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => onType(e.target.value)}
        rows={3}
        placeholder="Say something. Type @ to name a person, a journal, a paper — or @agent to ask the assistant."
        aria-label="Your reply"
      />

      {candidates.length > 0 && (
        <ul
          className={cn(
            "absolute bottom-full z-20 mb-1 max-h-64 w-full max-w-md overflow-y-auto",
            "rounded-lg bg-surface shadow-pop ring-1 ring-inset ring-edge"
          )}
        >
          {candidates.map((c) => (
            <li key={`${c.kind}-${c.id}`}>
              <button
                type="button"
                onClick={() => insert(c)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover"
              >
                <ColumnLabel className="w-16 shrink-0">{c.kind}</ColumnLabel>
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <Meta className="shrink-0 truncate text-xs">{c.hint}</Meta>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <Button kind="primary" size="md" disabled={busy || !value.trim()} onClick={onSend}>
          <Send />
          {busy ? "Posting…" : "Post"}
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Starting one                                                              */
/* ------------------------------------------------------------------------ */

function NewThread({ onClose }: { onClose: () => void }) {
  const { me } = useAuth()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [visibility, setVisibility] = useState<Visibility>("PUBLIC")

  const create = useApiMutation<
    { title: string; body: string; visibility: string; department?: string },
    ThreadRow
  >("/api/threads", { invalidates: [["threads"]] })

  const options: ComboboxOption[] = [
    { value: "PUBLIC", label: "Everybody", hint: "Anyone signed in can read it" },
    {
      value: "DEPARTMENT",
      label: `My department${me?.department ? ` — ${me.department}` : ""}`,
      hint: me?.department ? "Your department, and the office" : "You have no department set",
    },
    {
      value: "OFFICE",
      label: "The office only",
      hint: "The research cell, and you. Colleagues cannot see it",
    },
  ]

  async function submit() {
    try {
      const made = await create.mutateAsync({
        title: title.trim(),
        body: body.trim(),
        visibility,
        department: visibility === "DEPARTMENT" ? me?.department || undefined : undefined,
      })
      toast.ok(`Thread started — “${made.title}”`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  const canSubmit = title.trim().length >= 4 && body.trim().length > 0 && !create.isPending

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Start a thread</DialogTitle>
          <DialogDescription>
            Name what it is about and people can find it from there.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Title" hint="Something somebody scanning a list would recognise.">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Where should we send the floorplanning work?"
              autoFocus
            />
          </Field>

          <Field label="Who can see it">
            <Combobox
              value={visibility}
              onChange={(v) => setVisibility(v as Visibility)}
              options={options}
              disabled={false}
            />
          </Field>

          {visibility === "DEPARTMENT" && !me?.department && (
            <Callout tone="caution" title="No department is set on your account">
              Ask the research cell to set one, or start this thread as public.
            </Callout>
          )}

          <Field
            label="First post"
            hint="Type @ to name a person, a journal or a paper. @agent will look things up."
          >
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder='@agent what does @journal:"Ceramics International" pay?'
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={!canSubmit || (visibility === "DEPARTMENT" && !me?.department)}
            onClick={() => void submit()}
          >
            {create.isPending ? "Starting…" : "Start it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function relative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}
