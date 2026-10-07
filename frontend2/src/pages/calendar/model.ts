import {
  AlarmClock,
  Bell,
  CalendarDays,
  CalendarRange,
  ClipboardList,
  FileCheck,
  FileUp,
  GraduationCap,
  IndianRupee,
  Megaphone,
  Mic,
  Presentation,
  Sparkles,
  Telescope,
  UsersRound,
  Wrench,
  type LucideIcon,
} from "lucide-react"

/* ------------------------------------------------------------------------ */
/* What the server sends                                                    */
/* ------------------------------------------------------------------------ */

export type Visibility = "PRIVATE" | "PUBLIC" | "DEPARTMENT" | "OFFICE"

export type EventRow = {
  id: string
  title: string
  kind: string
  kind_label: string
  starts_on: string
  ends_on: string | null
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
  description: string | null
  visibility: Visibility
  department: string | null
  thread_id: string | null
  claim_id: string | null
  claim_title: string | null
  created_by: string | null
  created_by_id: string | null
  /** Seminars, workshops and the like. Absent until the server sends them. */
  venue?: string | null
  speaker?: string | null
  link?: string | null
}

/** A date the record already holds. Never editable here. */
export type RecordRow = {
  id: string
  kind: "PAID" | "PUBLISHED" | "FILED" | "CUTOFF" | "PAYOUT" | "COLLEAGUE" | "SCOUT" | "DEPT"
  kind_label: string
  title: string
  starts_on: string
  count: number
  /** The college's total for the office roles; your own for a claimant. */
  amount: number | null
  claim_id: string | null
  titles: string[]
  whole_month: boolean
  /** A colleague's publication: who, with their face. */
  person?: { user_id: string; name: string; photo_url?: string | null; initials?: string } | null
  /** A scout deadline's source page. */
  url?: string | null
}

export type CalendarPayload = {
  start: string
  end: string
  results: EventRow[]
  kinds: { key: string; label: string }[]
  record?: RecordRow[]
  record_kinds?: { key: string; label: string }[]
  visibilities?: Visibility[]
}

export type FeedLink = { url: string; webcal: string; google_subscribe_url: string }

/** GET /api/calendar/google/status: where this person stands with Google Calendar. */
export type GoogleStatus = {
  /** The server has the Google client id and secret: a real "Connect" is possible. */
  configured: boolean
  connected: boolean
  google_email: string | null
  calendar_name: string | null
  last_synced: string | null
  /** In words, for the person: the last sync's trouble, or that Google ended the link. */
  error: string | null
  /** Google ended the link: only connecting again helps. */
  needs_reconnect: boolean
  /** Google's own "add by URL" page, filled in with this person's feed. */
  subscribe_url: string
}

/** Connect is the one thing to do here: possible, and not (or no longer) done. */
export function wantsConnect(status: GoogleStatus | undefined): boolean {
  return Boolean(status?.configured && (!status.connected || status.needs_reconnect))
}

/* ------------------------------------------------------------------------ */
/* One thing on the grid                                                    */
/* ------------------------------------------------------------------------ */

/** The three layers the filter chips switch. */
export type Layer = "college" | "papers" | "colleagues" | "mine"
export const ALL_LAYERS: Layer[] = ["college", "papers", "colleagues", "mine"]

export type CalItem = {
  key: string
  title: string
  kind: string
  kindLabel: string
  /** Inclusive, YYYY-MM-DD. */
  start: string
  end: string
  startTime: string | null
  endTime: string | null
  layer: Layer
  event?: EventRow
  record?: RecordRow
}

/** A private "something else" is a reminder: that is what the person made it as. */
function isReminder(e: EventRow): boolean {
  return e.visibility === "PRIVATE" && e.kind === "OTHER"
}

export function toItems(data: CalendarPayload | undefined): CalItem[] {
  if (!data) return []
  const events: CalItem[] = data.results.map((e) => ({
    key: `e-${e.id}`,
    title: e.title,
    kind: isReminder(e) ? "REMINDER" : e.kind,
    kindLabel: isReminder(e) ? "Reminder" : kindLabelOf(e.kind),
    start: e.starts_on,
    end: e.ends_on && e.ends_on > e.starts_on ? e.ends_on : e.starts_on,
    startTime: e.all_day ? null : e.starts_at,
    endTime: e.all_day ? null : e.ends_at,
    layer: e.visibility === "PRIVATE" ? "mine" : "college",
    event: e,
  }))
  const record: CalItem[] = (data.record ?? []).map((r) => ({
    key: r.id,
    title: plainPayment(r.kind, r.title),
    kind: r.kind,
    kindLabel: plainPayment(r.kind, r.kind_label),
    // A month's payments sit on the month's first day, not across it: a bar
    // the width of the grid says nothing.
    start: r.starts_on,
    end: r.starts_on,
    startTime: null,
    endTime: null,
    layer: r.kind === "CUTOFF" || r.kind === "PAYOUT" || r.kind === "DEPT" ? "college" : r.kind === "COLLEAGUE" ? "colleagues" : "papers",
    record: r,
  }))
  return [...events, ...record].sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      (a.startTime ?? "").localeCompare(b.startTime ?? "") ||
      a.title.localeCompare(b.title)
  )
}

/**
 * The server names the college's monthly run and its filing cutoff with the
 * word "payout"; a lecturer reads "payment" (docs/ux/19). Only the college's
 * own dates are reworded, never the title of a paper.
 */
export function plainPayment(kind: string, text: string): string {
  if (kind !== "PAYOUT" && kind !== "CUTOFF") return text
  return text.replace(/payouts/gi, (m) => (m[0] === "P" ? "Payments" : "payments")).replace(/payout/gi, (m) => (m[0] === "P" ? "Payment" : "payment"))
}

/* ------------------------------------------------------------------------ */
/* Kinds: a shape and a colour, and the words stay in the text colour        */
/* ------------------------------------------------------------------------ */

/**
 * What each kind of event is called. A kind this list has never heard of (the
 * server may learn new ones before this page does) reads "Event" rather than
 * as its code.
 */
const KIND_LABEL: Record<string, string> = {
  DEADLINE: "Deadline",
  SUBMISSION_WINDOW: "Submission window",
  PAYOUT_RUN: "Payment run",
  MEETING: "Meeting",
  SEMINAR: "Seminar",
  WORKSHOP: "Workshop",
  CONFERENCE: "Conference",
  FDP: "Faculty development programme",
  CALL_FOR_PAPERS: "Call for papers",
  REMINDER: "Reminder",
  OTHER: "Event",
}

export function kindLabelOf(kind: string): string {
  return KIND_LABEL[kind] ?? "Event"
}

type KindStyle = { icon: LucideIcon; colour: string }

const PEOPLE = "var(--area-people, #b04a2f)"
const RECORD = "var(--area-record, var(--color-brand))"
const TIME = "var(--area-time)"

/**
 * Colour is a left rule and an icon; the words stay `fg`, so the text never
 * depends on a tint. Every colour here is at least 4.5:1 against its own chip
 * in light and dark (measured, not guessed), and colour is never the only
 * clue: no two event kinds share a shape.
 */
export const KIND_STYLE: Record<string, KindStyle> = {
  DEADLINE: { icon: AlarmClock, colour: "var(--color-critical)" },
  CUTOFF: { icon: AlarmClock, colour: "var(--color-critical)" },
  SUBMISSION_WINDOW: { icon: CalendarRange, colour: TIME },
  PAYOUT_RUN: { icon: IndianRupee, colour: "var(--color-positive)" },
  MEETING: { icon: UsersRound, colour: PEOPLE },
  SEMINAR: { icon: Presentation, colour: "var(--color-navy)" },
  WORKSHOP: { icon: Wrench, colour: "var(--color-caution)" },
  CONFERENCE: { icon: Mic, colour: "var(--color-navy)" },
  FDP: { icon: GraduationCap, colour: TIME },
  CALL_FOR_PAPERS: { icon: Megaphone, colour: "var(--color-caution)" },
  PAID: { icon: IndianRupee, colour: "var(--color-positive)" },
  PAYOUT: { icon: IndianRupee, colour: "var(--color-positive)" },
  COLLEAGUE: { icon: Sparkles, colour: PEOPLE },
  // Was `--color-gold`, which is 2.1:1 on its own chip in light mode.
  SCOUT: { icon: Telescope, colour: "var(--color-caution)" },
  DEPT: { icon: ClipboardList, colour: TIME },
  PUBLISHED: { icon: FileCheck, colour: RECORD },
  FILED: { icon: FileUp, colour: RECORD },
  REMINDER: { icon: Bell, colour: "var(--color-fg-muted)" },
  OTHER: { icon: CalendarDays, colour: "var(--color-fg-muted)" },
}

export function kindStyle(kind: string): KindStyle {
  return KIND_STYLE[kind] ?? KIND_STYLE.OTHER
}

/* ------------------------------------------------------------------------ */
/* Dates. Always the local calendar date, never toISOString (UTC).           */
/* ------------------------------------------------------------------------ */

export function iso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function parse(value: string): Date {
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

export function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

/** Weeks start on Monday. */
export function startOfWeek(d: Date): Date {
  const shift = (d.getDay() + 6) % 7
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -shift)
}

/** The Monday-to-Sunday weeks that cover a month. */
export function monthWeeks(anchor: Date): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  const weeks: Date[][] = []
  for (let w = startOfWeek(first); w <= last; w = addDays(w, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)))
  }
  return weeks
}

export function weekDays(anchor: Date): Date[] {
  const w = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => addDays(w, i))
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

// Fixed, not from `Intl`: "Sept" in one locale and "Sep" in another is the
// kind of difference a reader notices between two pages of the same app.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DAYS_SUN_FIRST = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function monthLabel(d: Date): string {
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}

export function dayLabel(value: string, withWeekday = false): string {
  return parse(value).toLocaleDateString("en-IN", {
    weekday: withWeekday ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/** "Wed 7 Oct": the year only when it is not this one. */
export function shortDay(value: string, now = new Date()): string {
  const d = parse(value)
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`
  return `${DAYS_SUN_FIRST[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`
}

/** "12–24 Oct", "30 Oct – 3 Nov", "30 Dec 2026 – 2 Jan 2027": a span as short as it can be said. */
export function rangeLabel(from: string, to: string, now = new Date()): string {
  const a = parse(from)
  const b = parse(to)
  const thisYear = now.getFullYear()
  const day = (d: Date, year: boolean) => `${d.getDate()} ${MONTHS[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ""}`
  if (from === to) return day(a, a.getFullYear() !== thisYear)
  if (a.getFullYear() !== b.getFullYear()) return `${day(a, true)} – ${day(b, true)}`
  const tail = a.getFullYear() === thisYear ? "" : ` ${a.getFullYear()}`
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()]}${tail}`
  return `${day(a, false)} – ${day(b, false)}${tail}`
}

/** "14:30" as people read it: "2:30 pm", or "2:30pm" and "9am" where room is tight. */
export function clock(value: string, compact = false): string {
  const [h, m] = value.split(":").map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return value
  const suffix = h >= 12 ? "pm" : "am"
  const hour = h % 12 === 0 ? 12 : h % 12
  const minutes = String(m).padStart(2, "0")
  if (compact) return m === 0 ? `${hour}${suffix}` : `${hour}:${minutes}${suffix}`
  return `${hour}:${minutes} ${suffix}`
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000)
}

export function relative(value: string, today: string): string {
  const n = daysBetween(today, value)
  if (n === 0) return "today"
  if (n === 1) return "tomorrow"
  if (n > 1) return `in ${n} days`
  if (n === -1) return "yesterday"
  return `${-n} days ago`
}

export function overlaps(item: CalItem, from: string, to: string): boolean {
  return item.start <= to && item.end >= from
}

/**
 * The days the agenda lists. On the current month it starts today and runs at
 * least to `horizon` (the hero's "Next" window), so whatever "Next" names is
 * also listed below it; the empty check must use this same window, or a month
 * whose dates are all past draws an empty list instead of the quiet state.
 */
export function agendaWindow(
  from: string,
  to: string,
  today: string,
  horizon: string,
  currentMonth: boolean
): [string, string] {
  if (!currentMonth) return [from, to]
  return [from < today ? today : from, to > horizon ? to : horizon]
}

/**
 * Lanes for a row of days: each item takes the first lane free across its
 * span, longest first, so a window reads as one bar and never as broken bits.
 */
export function lanes(items: CalItem[], from: string, to: string): { item: CalItem; lane: number }[] {
  const inRow = items
    .filter((i) => overlaps(i, from, to))
    .sort(
      (a, b) =>
        daysBetween(b.start, b.end) - daysBetween(a.start, a.end) ||
        a.start.localeCompare(b.start) ||
        (a.startTime ?? "").localeCompare(b.startTime ?? "")
    )
  const taken: [string, string][][] = []
  return inRow.map((item) => {
    const s = item.start < from ? from : item.start
    const e = item.end > to ? to : item.end
    let lane = 0
    while (taken[lane]?.some(([a, b]) => s <= b && e >= a)) lane++
    ;(taken[lane] ??= []).push([s, e])
    return { item, lane }
  })
}

/* ------------------------------------------------------------------------ */
/* Google Calendar                                                           */
/* ------------------------------------------------------------------------ */

function compact(date: string, time?: string | null): string {
  const d = date.replaceAll("-", "")
  return time ? `${d}T${time.replace(":", "")}00` : d
}

/**
 * The "Add to Google Calendar" template link. All-day ends are exclusive;
 * timed ones carry the college's zone so Google does not guess.
 */
export function googleTemplateUrl(item: CalItem, origin = window.location.origin): string {
  const params = new URLSearchParams({ action: "TEMPLATE", text: item.title })
  if (item.startTime) {
    const endTime = item.endTime ?? plusHour(item.startTime)
    params.set("dates", `${compact(item.start, item.startTime)}/${compact(item.end, endTime)}`)
    params.set("ctz", "Asia/Kolkata")
  } else {
    params.set("dates", `${compact(item.start)}/${compact(iso(addDays(parse(item.end), 1)))}`)
  }
  if (item.event?.venue) params.set("location", item.event.venue)
  const details = [item.event?.description, paperLink(item) ? `${origin}${paperLink(item)}` : null]
    .filter(Boolean)
    .join("\n\n")
  if (details) params.set("details", details)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

export function plusHour(t: string): string {
  const [h, m] = t.split(":").map(Number)
  return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

export function paperLink(item: CalItem): string | null {
  const id = item.event?.claim_id ?? item.record?.claim_id
  return id ? `/papers/${id}` : null
}

/** When, in a line: "All day", "12–24 Oct", "2:30 pm – 4:00 pm". */
export function timeLabel(item: CalItem): string {
  if (!item.startTime) return item.start === item.end ? "All day" : rangeLabel(item.start, item.end)
  return item.endTime ? `${clock(item.startTime)} – ${clock(item.endTime)}` : clock(item.startTime)
}
