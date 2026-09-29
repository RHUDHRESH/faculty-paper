import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { AtSign, Send } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Textarea } from "@/ui/field"
import { applyEdit, insertMention, markupFor, toDisplay, toMarkup, type Model } from "@/ui/mention-text"
import { Avatar, initialsOf } from "@/ui/person"
import { ColumnLabel, Meta } from "@/ui/text"
import { Tooltip, TooltipProvider } from "@/ui/tooltip"

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

export type Candidate = {
  kind: string
  id: string
  label: string
  hint: string | null
  /** People only: their face, filled in by the server. */
  photo_url?: string | null
  initials?: string
}

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
  DEPARTMENT: "Department",
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


/** A candidate as markup, and as the words the writer sees. */
function mentionFor(c: Candidate): { label: string; markup: string } {
  if (c.kind === "AGENT") return { label: "agent", markup: "@agent" }
  return { label: c.label, markup: markupFor(c.kind, c.label, c.id) }
}

/**
 * Where a message is written, with `@` as a menu rather than as folklore.
 *
 * `value` is markup — what the server parses — and `onChange` hands markup
 * back. What the writer sees is the display text: `@Dr. R. Subhashini` drawn
 * as a mention by a highlight layer mirrored behind a transparent textarea.
 * The textarea stays a real textarea, so the caret, IME, paste, spellcheck
 * and screen readers behave as they do everywhere else; a mention deleted
 * from either end goes whole.
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
  prompt = "Keep typing — a colleague's name, a journal, a claim number, or agent to ask the assistant.",
  sendLabel = "Post",
  rows = 3,
  maxRows = 10,
  offer,
  toolbar,
  autoFocus,
  textareaRef,
  menu = "above",
  canSend,
  collapsible,
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
  /** One quiet line until focused. Default: on for reply boxes (Enter sends). */
  collapsible?: boolean
  className?: string
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef ?? ownRef
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [term, setTerm] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const listId = useRef(`mentions-${Math.random().toString(36).slice(2, 9)}`).current

  // The display model follows `value` unless `value` is exactly what the
  // model already stands for — a prefilled draft or a box cleared after
  // sending both re-derive it; our own keystrokes do not.
  const [model, setModel] = useState<Model>(() => toDisplay(value))
  const shown = toMarkup(model) === value ? model : toDisplay(value)

  const search = useMentionSearch(term, hint ? KIND_FOR_HINT[hint] : null)
  const results = offer
    ? search.results.filter((c) => offer.includes(c.kind as MentionKind))
    : search.results
  const status = search.status
  const open = term !== null
  const sendable = canSend ?? !!value.trim()
  const collapse = (collapsible ?? submitOnEnter) && !focused && !value.trim() && !autoFocus
  useEffect(() => setActive(0), [search.results])

  function commit(next: Model) {
    setModel(next)
    onChange(toMarkup(next))
  }

  // A controlled textarea loses the caret when the value is rewritten, which
  // after inserting (or removing) a mention would drop it at the end.
  const caretAfter = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = caretAfter.current
    if (at === null) return
    caretAfter.current = null
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(at, at)
  })

  function readTrigger(m: Model, caret: number) {
    const match = m.text.slice(0, caret).match(TRIGGER_RE)
    // Inside a mention there is nothing to look up.
    const inside = m.spans.some((s) => s.start < caret && s.end >= caret)
    if (!match || inside) {
      setTerm(null)
      setHint(null)
      return
    }
    setHint(match[1] ? match[1].toLowerCase() : null)
    setTerm(match[2] ?? "")
  }

  function onType(next: string, caret: number) {
    const r = applyEdit(shown, next, caret)
    if (r.model.text !== next) caretAfter.current = r.caret
    commit(r.model)
    readTrigger(r.model, r.caret)
  }

  function insert(candidate: Candidate) {
    const caret = ref.current?.selectionStart ?? shown.text.length
    const m = shown.text.slice(0, caret).match(/@(?:[A-Za-z]+:)?[A-Za-z0-9._-]*$/)
    const from = m ? caret - m[0].length : caret
    const { label: l, markup } = mentionFor(candidate)
    const r = insertMention(shown, from, caret, l, markup, candidate.kind)
    caretAfter.current = r.caret
    commit(r.model)
    onPick?.(candidate)
    setTerm(null)
    setHint(null)
  }

  function startMention() {
    const caret = ref.current?.selectionStart ?? shown.text.length
    const before = shown.text.slice(0, caret)
    const spacer = before && !/\s$/.test(before) ? " " : ""
    const at = caret + spacer.length + 1
    const r = applyEdit(shown, `${before}${spacer}@${shown.text.slice(caret)}`, at)
    caretAfter.current = at
    commit(r.model)
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

  // The highlight layer: the same text in the same box, mentions tinted.
  const layer: ReactNode[] = []
  let last = 0
  shown.spans.forEach((s, i) => {
    layer.push(shown.text.slice(last, s.start))
    layer.push(
      <mark key={i} className="rounded-sm bg-accent-wash text-accent">
        {shown.text.slice(s.start, s.end)}
      </mark>
    )
    last = s.end
  })
  // A trailing newline needs a character after it or the mirror is a line short.
  layer.push(shown.text.slice(last) + "​")

  const sendReason = !busy && !sendable ? "Write something first" : undefined

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn("relative space-y-2", className)}>
        <div className={cn("flex items-center justify-between gap-2", hideLabel && "sr-only")}>
          <label htmlFor={`${listId}-input`} className="text-sm font-medium">
            {label}
          </label>
          {!hideLabel && !onSend && (
            <Tooltip content="Name a person, journal, paper or department">
              <Button kind="quiet" size="icon" type="button" onClick={startMention} aria-label="Mention somebody">
                <AtSign />
              </Button>
            </Tooltip>
          )}
        </div>

        <div className="relative rounded-md bg-surface">
          <div
            ref={mirrorRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-base text-fg"
          >
            {layer}
          </div>
          <Textarea
            ref={ref}
            id={`${listId}-input`}
            value={shown.text}
            onChange={(e) => onType(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop
            }}
            onClick={(e) => readTrigger(shown, e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              // A click on an option fires `mousedown` first and cancels this, so
              // the list closing on blur never eats the choice.
              setFocused(false)
              setTerm(null)
              setHint(null)
            }}
            rows={collapse ? 1 : rows}
            maxRows={maxRows}
            placeholder={placeholder}
            autoFocus={autoFocus}
            className="relative bg-transparent text-transparent caret-fg selection:bg-accent/25"
            style={{ WebkitTextFillColor: "transparent" }}
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
                <p className="px-3 py-2 text-sm text-fg-muted" role="status">
                  Nobody and nothing called “{term}”. Check the spelling, or try a surname.
                </p>
              )}
              {results.length > 0 && (
                <ul id={listId} role="listbox" aria-label="Mentions" className="max-h-64 overflow-y-auto py-1">
                  {results.map((c, i) => (
                    <li key={`${c.kind}-${c.id}`} role="none">
                      <button
                        id={`${listId}-opt-${i}`}
                        role="option"
                        aria-selected={i === active}
                        type="button"
                        tabIndex={-1}
                        // `mousedown` rather than `click`: the textarea's blur
                        // closes the list, and by the time `click` fires there is
                        // nothing left to click.
                        onMouseDown={(e) => {
                          e.preventDefault()
                          insert(c)
                        }}
                        onMouseEnter={() => setActive(i)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm",
                          i === active ? "bg-selected" : "hover:bg-hover"
                        )}
                      >
                        {c.kind === "USER" ? (
                          <Avatar
                            person={{
                              name: c.label,
                              initials: c.initials ?? initialsOf(c.label),
                              photo_url: c.photo_url ?? null,
                            }}
                            size="sm"
                          />
                        ) : (
                          <ColumnLabel className="w-8 shrink-0 text-center">
                            {KIND_LABEL[c.kind] || c.kind}
                          </ColumnLabel>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{c.label}</span>
                          {c.hint && <Meta className="block truncate text-xs">{c.hint}</Meta>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {!collapse && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {(hideLabel || onSend) && (
                <Tooltip content="Mention a colleague, journal or department">
                  <Button kind="quiet" size="icon" type="button" onClick={startMention} aria-label="Mention somebody">
                    <AtSign />
                  </Button>
                </Tooltip>
              )}
              {toolbar ?? (
                <Meta className="text-xs">
                  {open
                    ? "↑↓ to choose · Enter to insert · Esc to dismiss"
                    : submitOnEnter
                      ? "Enter sends · Shift+Enter for a new line"
                      : "Type @ to name someone"}
                </Meta>
              )}
            </div>
            {onSend && (
              <div className="ml-auto flex items-center gap-2">
                {sendReason && (
                  <Meta id={`${listId}-why`} className="text-xs">
                    {sendReason}
                  </Meta>
                )}
                <Button
                  kind="primary"
                  size="sm"
                  type="button"
                  disabled={busy || !sendable}
                  aria-describedby={sendReason ? `${listId}-why` : undefined}
                  onClick={onSend}
                >
                  <Send />
                  {busy ? "Posting…" : sendLabel}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

