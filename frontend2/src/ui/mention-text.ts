/**
 * The two faces of a message with mentions in it.
 *
 * The server reads markup — `@user:"Dr. R. Subhashini"`, `@journal:"…"`,
 * `@paper:<id>`, `@dept:"…"`, `@agent` (`discussions.MENTION_RE`). A person
 * writing should see `@Dr. R. Subhashini`. The composer edits the display
 * text and keeps a list of spans that say which stretches of it are
 * mentions and what markup each one stands for; `toMarkup` rebuilds exactly
 * what is sent.
 */

export type Span = { start: number; end: number; markup: string; kind: string }
export type Model = { text: string; spans: Span[] }

/** The server's own pattern (backend/core/discussions.py MENTION_RE). */
const MARKUP_RE =
  /@(?:(user|person|journal|paper|dept|department|agent):)?(?:"([^"]{1,200})"|([A-Za-z0-9._-]{1,80}))/g

const BARE_RE = /^[A-Za-z0-9._-]{1,80}$/

const KIND: Record<string, string> = {
  user: "USER",
  person: "USER",
  journal: "JOURNAL",
  paper: "PAPER",
  dept: "DEPARTMENT",
  department: "DEPARTMENT",
  agent: "AGENT",
}

/**
 * Markup for a label. A label the bare form cannot carry is quoted; a
 * straight double quote inside a name cannot survive the quoted form either
 * (the server stops at it), so it becomes a typographic one.
 */
export function markupFor(kind: string, label: string, id?: string): string {
  if (kind === "AGENT") return "@agent"
  if (kind === "PAPER" && id) return `@paper:${id}`
  const clean = label.replace(/"/g, "”").trim()
  const body = BARE_RE.test(clean) ? clean : `"${clean}"`
  const prefix =
    kind === "JOURNAL" ? "journal" : kind === "DEPARTMENT" ? "dept" : kind === "PAPER" ? "paper" : "user"
  return `@${prefix}:${body}`
}

/**
 * Markup → what the writer sees. Only typed or quoted mentions (and
 * `@agent`) become pills: an untyped bare `@asha` already reads as itself.
 */
export function toDisplay(markup: string): Model {
  let text = ""
  const spans: Span[] = []
  let last = 0
  for (const m of markup.matchAll(MARKUP_RE)) {
    const [whole, hint, quoted, bare] = m
    const at = m.index ?? 0
    const isAgent = hint === "agent" || (!hint && bare === "agent")
    if (!hint && !quoted && !isAgent) continue
    const label = isAgent ? "agent" : (quoted ?? bare ?? "").trim()
    if (!label) continue
    text += markup.slice(last, at)
    const shown = `@${label}`
    spans.push({
      start: text.length,
      end: text.length + shown.length,
      markup: whole,
      kind: isAgent ? "AGENT" : hint ? KIND[hint] : "USER",
    })
    text += shown
    last = at + whole.length
  }
  text += markup.slice(last)
  return { text, spans }
}

/** What the writer sees → exactly what the server parses. */
export function toMarkup(model: Model): string {
  let out = ""
  let last = 0
  for (const s of [...model.spans].sort((a, b) => a.start - b.start)) {
    out += model.text.slice(last, s.start) + s.markup
    last = s.end
  }
  return out + model.text.slice(last)
}

/**
 * The display text changed from `prev.text` to `next` (typing, paste, cut,
 * undo). Spans move with the text; a deletion that touches a mention takes
 * the whole mention; typing strictly inside one turns it back into words.
 * `caret` (after the edit) settles which run changed when text repeats.
 */
export function applyEdit(prev: Model, next: string, caret = next.length): { model: Model; caret: number } {
  const a = prev.text
  const minLen = Math.min(a.length, next.length)
  let pre = 0
  const preMax = Math.min(minLen, caret)
  while (pre < preMax && a[pre] === next[pre]) pre++
  let suf = 0
  const sufMax = Math.min(minLen - pre, next.length - caret)
  while (suf < sufMax && a[a.length - 1 - suf] === next[next.length - 1 - suf]) suf++

  let from = pre
  let to = a.length - suf
  const inserted = next.slice(pre, next.length - suf)
  const deleting = to > from

  const kept: Span[] = []
  for (const s of prev.spans) {
    const overlaps = deleting ? s.start < to && s.end > from : s.start < from && s.end > from
    if (!overlaps) {
      kept.push(s)
      continue
    }
    if (deleting) {
      from = Math.min(from, s.start)
      to = Math.max(to, s.end)
    }
    // Pure insertion inside a mention: the span is dropped, the words stay.
  }
  const text = a.slice(0, from) + inserted + a.slice(to)
  const delta = inserted.length - (to - from)
  const spans = kept.map((s) => (s.start >= to ? { ...s, start: s.start + delta, end: s.end + delta } : s))
  return { model: { text, spans }, caret: from + inserted.length }
}

/** Replace `[from, to)` of the display text with a mention (and a space). */
export function insertMention(
  prev: Model,
  from: number,
  to: number,
  label: string,
  markup: string,
  kind: string
): { model: Model; caret: number } {
  const shown = `@${label}`
  const text = prev.text.slice(0, from) + shown + " " + prev.text.slice(to)
  const delta = shown.length + 1 - (to - from)
  const spans = prev.spans
    .filter((s) => s.end <= from || s.start >= to)
    .map((s) => (s.start >= to ? { ...s, start: s.start + delta, end: s.end + delta } : s))
  spans.push({ start: from, end: from + shown.length, markup, kind })
  spans.sort((x, y) => x.start - y.start)
  return { model: { text, spans }, caret: from + shown.length + 1 }
}
