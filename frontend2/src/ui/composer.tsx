import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { AtSign, Send } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Textarea } from "@/ui/field"
import { ColumnLabel, Meta } from "@/ui/text"

/**
 * Writing something with `@` names in it — shared by the feed and by
 * private messages, so the two cannot drift into two different ideas of
 * what a mention is.
 *
 * A post names the things it concerns and those names resolve to real
 * records on the server (`discussions.parse_mentions`): `@user:"Asha Menon"`
 * is a colleague who is notified, `@journal:"Ceramics International"` is a
 * journal we hold a quartile for.
 */

export type MentionKind = "USER" | "JOURNAL" | "PAPER" | "DEPARTMENT" | "AGENT"

export type Candidate = { kind: string; id: string; label: string; hint: string | null }

/** A mention as the server resolved and stored it. */
export type ResolvedMention = {
  kind: MentionKind
  label: string
  user_id: string | null
  user_name: string | null
  department?: string | null
  journal_title?: string | null
}

type SearchStatus = "idle" | "prompt" | "loading" | "ready" | "failed"

/**
 * What `@` offers, and honestly which of the five things it is doing.
 *
 * `failed` is a separate state from `ready` with no results on purpose: a
 * search that could not run and a search that found nothing look identical
 * if both render an empty list, and the reader concludes the colleague they
 * are trying to name does not exist.
 */
export function useMentionSearch(term: string | null, kind?: string | null) {
  const [status, setStatus] = useState<SearchStatus>("idle")
  const [results, setResults] = useState<Candidate[]>([])

  useEffect(() => {
    if (term === null) {
      setStatus("idle")
      setResults([])
      return
    }
    if (term.trim().length === 0) {
      // `mention_candidates` answers nothing for an empty query, so say what
      // to type instead of firing a request that cannot succeed.
      setStatus("prompt")
      setResults([])
      return
    }

    let live = true
    setStatus("loading")
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ q: term })
      if (kind) query.set("kind", kind)
      api<{ results: Candidate[] }>(`/api/mentions/search?${query.toString()}`)
        .then((r) => {
          if (!live) return
          setResults(r.results)
          setStatus("ready")
        })
        .catch(() => {
          if (!live) return
          setResults([])
          setStatus("failed")
        })
    }, 180)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [term, kind])

  return { status, results }
}

const KIND_LABEL: Record<string, string> = {
  USER: "Person",
  JOURNAL: "Journal",
  PAPER: "Paper",
  DEPARTMENT: "Dept",
  AGENT: "Agent",
}

/** `@`, optionally typed (`@journal:`), at the start of a word, up to the
 *  caret. The leading word boundary matters: without it every email address
 *  somebody pastes opens the picker. */
const TRIGGER_RE =
  /(?:^|\s)@(?:(user|person|journal|paper|dept|department|agent):)?([A-Za-z0-9._-]*)$/

const KIND_FOR_HINT: Record<string, string> = {
  user: "USER",
  person: "USER",
  journal: "JOURNAL",
  paper: "PAPER",
  dept: "DEPARTMENT",
  department: "DEPARTMENT",
  agent: "AGENT",
}

/** Written back into the text. A label with a space in it is quoted, because
 *  a mention that stops at the first space points at the wrong thing far more
 *  often than not — which is why the server's own regex accepts a quoted form. */
function mentionText(candidate: Candidate): string {
  const quoted = /\s/.test(candidate.label) ? `"${candidate.label}"` : candidate.label
  switch (candidate.kind) {
    case "AGENT":
      return "@agent"
    case "JOURNAL":
      return `@journal:${quoted}`
    case "PAPER":
      return `@paper:${candidate.id}`
    case "DEPARTMENT":
      return `@dept:${quoted}`
    default:
      return `@user:${quoted}`
  }
}

/** `**bold**` as the assistant writes it, and every `@name` marked as one. */
const INLINE_RE =
  /(\*\*[^*]+\*\*|@(?:[A-Za-z]+:)?(?:"[^"]{1,200}"|[A-Za-z0-9._-]{1,80}))/g

/** `@user:"Asha Menon"` as a reader should see it: `@Asha Menon`. */
function mentionLabel(token: string): string {
  return token.replace(/^@(?:[A-Za-z]+:)?/, "").replace(/^"|"$/g, "")
}

/**
 * A post's text with its mentions drawn as mentions.
 *
 * With `mentions` (what the server resolved when the post was saved) a
 * colleague's name becomes a link to their profile; without, every `@name`
 * is at least marked, so the feature is discoverable by reading. A mention
 * that renders as ordinary text is a feature nobody finds, which is how `@`
 * stayed a secret in the first place.
 */
export function renderBody(body: string, mentions?: ResolvedMention[]) {
  return body.split(INLINE_RE).map((chunk, i) => {
    if (chunk.startsWith("**") && chunk.endsWith("**")) {
      return <strong key={i}>{chunk.slice(2, -2)}</strong>
    }
    if (chunk.startsWith("@") && chunk.length > 1) {
      if (mentions) {
        const label = mentionLabel(chunk).toLowerCase()
        const person = mentions.find(
          (m) => m.kind === "USER" && m.user_id && m.label.toLowerCase() === label
        )
        if (person?.user_id) {
          return (
            <Link
              key={i}
              to={`/u/${person.user_id}`}
              className="font-medium text-accent underline-offset-4 hover:underline"
            >
              @{person.user_name || mentionLabel(chunk)}
            </Link>
          )
        }
        return (
          <span key={i} className="font-medium text-accent">
            @{mentionLabel(chunk)}
          </span>
        )
      }
      return (
        <span key={i} className="font-medium text-accent">
          {chunk}
        </span>
      )
    }
    return <span key={i}>{chunk}</span>
  })
}

/**
 * Where a message is written, with `@` as a menu rather than as folklore.
 *
 * The trigger is advertised, there is a button that types it for you, and
 * the list is a real listbox you can drive from the keyboard. Enter sends and
 * Shift+Enter starts a new line — and the screen says which, because guessing
 * wrong posts half a sentence to a room of colleagues.
 *
 * `offer` narrows what the menu suggests. The feed does not resolve papers or
 * answer `@agent`, so offering them there would be offering something that
 * then silently does nothing.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onPick,
  busy,
  submitOnEnter = false,
  label,
  hideLabel = false,
  placeholder = "Say something. Type @ to name a person, a journal or a paper — or @agent to ask the assistant.",
  prompt = "Keep typing — a colleague's name, a journal, a ticket number, or agent to ask the assistant.",
  sendLabel = "Post",
  rows = 3,
  maxRows = 10,
  offer,
  toolbar,
  autoFocus,
  textareaRef,
  menu = "above",
  canSend,
  className,
}: {
  value: string
  onChange: (v: string) => void
  onSend?: () => void
  /** Told about every name chosen from the menu — the feed sends the ids with
   *  the text, so a namesake is never the colleague who gets notified. */
  onPick?: (candidate: Candidate) => void
  busy?: boolean
  submitOnEnter?: boolean
  label: string
  hideLabel?: boolean
  placeholder?: string
  prompt?: string
  sendLabel?: string
  rows?: number
  maxRows?: number
  offer?: MentionKind[]
  /** Controls that sit beside the send button: attach, link, audience. */
  toolbar?: ReactNode
  autoFocus?: boolean
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  /** Where the @ menu opens. Above for a composer pinned to the bottom of a
   *  conversation, below for one at the top of a feed. */
  menu?: "above" | "below"
  /** Whether there is anything to send. Text, by default; the feed also sends
   *  a post that is only a picture. */
  canSend?: boolean
  className?: string
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef ?? ownRef
  const [term, setTerm] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const listId = useRef(`mentions-${Math.random().toString(36).slice(2, 9)}`).current

  const search = useMentionSearch(term, hint ? KIND_FOR_HINT[hint] : null)
  const results = offer
    ? search.results.filter((c) => offer.includes(c.kind as MentionKind))
    : search.results
  const status = search.status
  const open = term !== null
  const sendable = canSend ?? !!value.trim()
  useEffect(() => setActive(0), [search.results])

  // A controlled textarea loses the caret when the value is rewritten from
  // outside, which after inserting a mention would drop it at the end of the
  // message rather than after the name just chosen.
  const caretAfterInsert = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = caretAfterInsert.current
    if (at === null) return
    caretAfterInsert.current = null
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(at, at)
  })

  function readTrigger(next: string, caret: number) {
    const match = next.slice(0, caret).match(TRIGGER_RE)
    if (!match) {
      setTerm(null)
      setHint(null)
      return
    }
    setHint(match[1] ? match[1].toLowerCase() : null)
    setTerm(match[2] ?? "")
  }

  function onType(next: string) {
    onChange(next)
    readTrigger(next, ref.current?.selectionStart ?? next.length)
  }

  function insert(candidate: Candidate) {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, caret).replace(/@(?:[A-Za-z]+:)?([A-Za-z0-9._-]*)$/, "")
    const after = value.slice(caret)
    const text = `${mentionText(candidate)} `
    caretAfterInsert.current = before.length + text.length
    onChange(`${before}${text}${after}`)
    onPick?.(candidate)
    setTerm(null)
    setHint(null)
  }

  function startMention() {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, caret)
    const spacer = before && !/\s$/.test(before) ? " " : ""
    const next = `${before}${spacer}@${value.slice(caret)}`
    caretAfterInsert.current = before.length + spacer.length + 1
    onChange(next)
    setHint(null)
    setTerm("")
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "Escape") {
        e.preventDefault()
        setTerm(null)
        setHint(null)
        return
      }
      if (results.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setActive((i) => (i + 1) % results.length)
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setActive((i) => (i - 1 + results.length) % results.length)
          return
        }
        // Enter and Tab both commit the highlighted name. Enter must not fall
        // through to "send" here or choosing a colleague posts the message.
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault()
          insert(results[Math.min(active, results.length - 1)])
          return
        }
      }
    }

    if (submitOnEnter && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!busy && sendable) onSend?.()
    }
  }

  return (
    <div className={cn("relative space-y-2", className)}>
      <div className={cn("flex items-center justify-between gap-2", hideLabel && "sr-only")}>
        <label htmlFor={`${listId}-input`} className="text-sm font-medium">
          {label}
        </label>
        {!hideLabel && (
          <Button
            kind="quiet"
            size="sm"
            type="button"
            onClick={startMention}
            title="Name a person, journal, paper or department"
          >
            <AtSign />
            Mention
          </Button>
        )}
      </div>

      <div className="relative">
      <Textarea
        ref={ref}
        id={`${listId}-input`}
        value={value}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={onKeyDown}
        onClick={(e) => readTrigger(value, e.currentTarget.selectionStart)}
        onBlur={() => {
          // A click on an option fires `mousedown` first and cancels this, so
          // the list closing on blur never eats the choice.
          setTerm(null)
          setHint(null)
        }}
        rows={rows}
        maxRows={maxRows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results.length > 0 ? `${listId}-opt-${active}` : undefined}
      />

      {open && (
        <div
          className={cn(
            "absolute z-20 w-full max-w-md overflow-hidden",
            menu === "above" ? "bottom-full mb-1" : "top-full mt-1",
            "rounded-lg bg-surface shadow-pop ring-1 ring-inset ring-edge"
          )}
        >
          {status === "prompt" && <p className="px-3 py-2 text-sm text-fg-muted">{prompt}</p>}
          {status === "loading" && (
            <p className="px-3 py-2 text-sm text-fg-muted" role="status">
              Looking…
            </p>
          )}
          {status === "failed" && (
            <p className="px-3 py-2 text-sm text-critical" role="alert">
              Could not search. Your message is untouched — type the name in full and post it
              anyway.
            </p>
          )}
          {status === "ready" && results.length === 0 && (
            <p className="px-3 py-2 text-sm text-fg-muted">Nothing here answers to “{term}”.</p>
          )}
          {results.length > 0 && (
            <ul id={listId} role="listbox" aria-label="Mentions" className="max-h-64 overflow-y-auto">
              {results.map((c, i) => (
                <li key={`${c.kind}-${c.id}`} role="none">
                  <button
                    id={`${listId}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    type="button"
                    // `mousedown` rather than `click`: the textarea's blur
                    // closes the list, and by the time `click` fires there is
                    // nothing left to click.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      insert(c)
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                      i === active ? "bg-selected" : "hover:bg-hover"
                    )}
                  >
                    <ColumnLabel className="w-14 shrink-0">{KIND_LABEL[c.kind] || c.kind}</ColumnLabel>
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.hint && (
                      <Meta className="hidden shrink-0 truncate text-xs sm:block">{c.hint}</Meta>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {toolbar ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {hideLabel && (
              <Button
                kind="quiet"
                size="sm"
                type="button"
                onClick={startMention}
                title="Name a colleague or a department"
                aria-label="Mention somebody"
              >
                <AtSign />
                <span className="hidden sm:inline">Mention</span>
              </Button>
            )}
            {toolbar}
          </div>
        ) : (
          <Meta className="text-xs">
            {open
              ? "↑↓ to choose · Enter to insert · Esc to dismiss"
              : submitOnEnter
                ? "Enter sends · Shift+Enter starts a new line · @ names someone"
                : "Enter starts a new line · @ names someone"}
          </Meta>
        )}
        {onSend && (
          <Button
            kind="primary"
            size="md"
            type="button"
            disabled={busy || !sendable}
            onClick={onSend}
            className="ml-auto"
          >
            <Send />
            {busy ? "Posting…" : sendLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
