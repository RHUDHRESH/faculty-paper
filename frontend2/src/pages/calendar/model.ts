import {
  AlarmClock,
  Bell,
  CalendarDays,
  CalendarRange,
  FileText,
  IndianRupee,
  UsersRound,
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
}

/** A date the record already holds. Never editable here. */
export type RecordRow = {
  id: string
  kind: "PAID" | "PUBLISHED" | "FILED" | "CUTOFF"
  kind_label: string
  title: string
  starts_on: string
  count: number
  /** The college's total for the office roles; your own for a claimant. */
  amount: number | null
  claim_id: string | null
  titles: string[]
  whole_month: boolean
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

/* ------------------------------------------------------------------------ */
/* One thing on the grid                                                    */
/* ------------------------------------------------------------------------ */

/** The three layers the filter chips switch. */
export type Layer = "college" | "papers" | "mine"

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

export function toItems(data: CalendarPayload | undefined): CalItem[] {
  if (!data) return []
  const events: CalItem[] = data.results.map((e) => ({
    key: `e-${e.id}`,
    title: e.title,
    kind: e.visibility === "PRIVATE" && e.kind === "OTHER" ? "REMINDER" : e.kind,
    kindLabel: e.visibility === "PRIVATE" && e.kind === "OTHER" ? "Reminder" : e.kind_label,
    start: e.starts_on,
    end: e.ends_on && e.ends_on > e.starts_on ? e.ends_on : e.starts_on,
    startTime: e.all_day ? null : e.starts_at,
    endTime: e.all_day ? null : e.ends_at,
    layer: e.visibility === "PRIVATE" ? "mine" : "college",
    event: e,
  }))
  const record: CalItem[] = (data.record ?? []).map((r) => ({
    key: r.id,
    title: r.title,
    kind: r.kind,
    kindLabel: r.kind_label,
    // A month's payments sit on the month's first day, not across it: a bar
    // the width of the grid says nothing.
    start: r.starts_on,
    end: r.starts_on,
    startTime: null,
    endTime: null,
    layer: r.kind === "CUTOFF" ? "college" : "papers",
    record: r,
  }))
  return [...events, ...record].sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      (a.startTime ?? "").localeCompare(b.startTime ?? "") ||
      a.title.localeCompare(b.title)
  )
}

/* ------------------------------------------------------------------------ */
/* Kinds: colour is a dot and a left rule; text stays fg                     */
/* ------------------------------------------------------------------------ */

type KindStyle = { icon: LucideIcon; colour: string }

const PEOPLE = "var(--area-people, #b04a2f)"
const RECORD = "var(--area-record, var(--color-brand))"

export const KIND_STYLE: Record<string, KindStyle> = {
  DEADLINE: { icon: AlarmClock, colour: "var(--color-critical)" },
  CUTOFF: { icon: AlarmClock, colour: "var(--color-critical)" },
  SUBMISSION_WINDOW: { icon: CalendarRange, colour: "var(--area-time)" },
  PAYOUT_RUN: { icon: IndianRupee, colour: "var(--color-positive)" },
  MEETING: { icon: UsersRound, colour: PEOPLE },
  PAID: { icon: FileText, colour: RECORD },
  PUBLISHED: { icon: FileText, colour: RECORD },
  FILED: { icon: FileText, colour: RECORD },
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
  const details = [item.event?.description, paperLink(item) ? `${origin}${paperLink(item)}` : null]
    .filter(Boolean)
    .join("\n\n")
  if (details) params.set("details", details)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function plusHour(t: string): string {
  const [h, m] = t.split(":").map(Number)
  return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

export function paperLink(item: CalItem): string | null {
  const id = item.event?.claim_id ?? item.record?.claim_id
  return id ? `/papers/${id}` : null
}

export function timeLabel(item: CalItem): string {
  if (!item.startTime) return item.start === item.end ? "All day" : `${dayLabel(item.start)} → ${dayLabel(item.end)}`
  return item.endTime ? `${item.startTime}–${item.endTime}` : item.startTime
}
