/**
 * The kinds of post Discussions offers, and how an event travels inside a post.
 *
 * The server knows only a post: words, a link, a paper, a file. So a kind is
 * not a column. A paper is the paper attached. "Well done" is a post that says
 * so. An event is a post whose words end in a small readable block:
 *
 *     Seminar on thin films, open to everybody.
 *
 *     — Event —
 *     When: 2026-10-17 15:00
 *     Where: Seminar hall, Block C
 *
 * The block reads fine anywhere a post is printed (a notification, a message),
 * and `parseEvent` lifts it back out, so the Events list can adopt these posts
 * later without a migration. The link, if any, is the post's own `link_url`.
 */

export type PostKind = "question" | "paper" | "event" | "kudos"

export const KINDS: { key: PostKind; label: string; placeholder: string }[] = [
  { key: "question", label: "Ask a question", placeholder: "What would you like to ask your colleagues?" },
  {
    key: "paper",
    label: "Share a paper",
    placeholder: "Say a word about the paper: why it matters, who worked on it. Type @ to name a co-author.",
  },
  {
    key: "event",
    label: "Announce a seminar or event",
    placeholder: "What is it, and who is it for? Type @ to name a speaker.",
  },
  {
    key: "kudos",
    label: "Say well done",
    placeholder: "Who has done something worth celebrating? Type @ to name them.",
  },
]

export const EVENT_MARK = "— Event —"

export type EventInfo = { when: string; where: string }

/** The words plus the event block, ready to post. Blank fields are left out. */
export function withEvent(text: string, info: EventInfo): string {
  const lines = [EVENT_MARK]
  if (info.when.trim()) lines.push(`When: ${info.when.trim().replace("T", " ")}`)
  if (info.where.trim()) lines.push(`Where: ${info.where.trim()}`)
  if (lines.length === 1) return text.trim()
  return `${text.trim()}\n\n${lines.join("\n")}`.trim()
}

/** An event post split into its words and its block; `info` is null for any other post. */
export function parseEvent(body: string): { text: string; info: EventInfo | null } {
  const at = body.indexOf(EVENT_MARK)
  if (at < 0) return { text: body, info: null }
  const block = body.slice(at + EVENT_MARK.length)
  const grab = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim() ?? ""
  return { text: body.slice(0, at).trimEnd(), info: { when: grab("When"), where: grab("Where") } }
}

/** "2026-10-17 15:00" as a teacher reads it: "Fri 17 Oct, 3:00 pm". Anything else is shown as typed. */
export function whenLabel(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(raw)
  if (!m) return raw
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0))
  const day = d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })
  if (m[4] === undefined) return day
  return `${day}, ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`
}

/** What to call a post on its face; null for an ordinary one. */
export function kindOf(post: { body: string; paper: unknown | null }): "event" | "paper" | "kudos" | null {
  if (post.body.includes(EVENT_MARK)) return "event"
  if (/^(well done|congratulations|congrats)\b/i.test(post.body.trim())) return "kudos"
  if (post.paper) return "paper"
  return null
}

export const KIND_LABEL = { event: "Event", paper: "Paper", kudos: "Well done" } as const
