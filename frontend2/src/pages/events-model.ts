import { formatCount } from "@/lib/count"
import type { Area } from "@/ui/chip"

/* ------------------------------------------------------------------------ */
/* What the server sends (core/api/events.py)                                */
/* ------------------------------------------------------------------------ */

export type EventKind = "SEMINAR" | "WORKSHOP" | "CONFERENCE" | "FDP" | "CALL_FOR_PAPERS" | "OTHER"

export type HubEvent = {
  id: string
  title: string
  kind: EventKind | string
  kind_label: string
  /** YYYY-MM-DD. For a call for papers this is the day it closes. */
  starts_on: string
  ends_on: string | null
  /** HH:MM, college time. Null for an all-day entry. */
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
  description: string | null
  venue: string | null
  speaker: string | null
  organiser: string | null
  link: string | null
  department: string | null
  visibility: "PUBLIC" | "DEPARTMENT" | "OFFICE" | string
  created_by: string | null
  created_by_id: string | null
  going_count: number
  going: boolean
  can_edit: boolean
  /** Editors only: how many people have been invited. */
  invited_count?: number
  /** For the viewer, when somebody invited them. */
  invited_by?: { id: string; name: string } | null
}

/* Invitations (core/api/events.py): who matches the topic, who was asked. */

export type InviteStatus = "none" | "invited" | "going"

export type InvitePerson = {
  id: string
  name: string
  department: string | null
  designation: string | null
  photo_url: string | null
  initials: string
  why: string
  score: number
  papers_on_topic: number
  status: InviteStatus
}

export type PeoplePayload = {
  event_id: string
  /** The topics the event is about, best first, with the papers the college holds on each. */
  topics: { name: string; papers: number }[]
  /** True when the topic was worked out by AI rather than read from the words. */
  ai: boolean
  counted: boolean
  people: InvitePerson[]
  total: number
}

export type InviteResult = { invited: number; already: number; skipped: number }

export type InvitedPerson = {
  id: string
  name: string
  department: string | null
  photo_url: string | null
  initials: string
  invited_at: string
  invited_by_name: string | null
  going: boolean
}

export type InvitesPayload = {
  people: InvitedPerson[]
  counts: { invited: number; going: number }
}

export type Audience = { key: "DEPARTMENT" | "PUBLIC" | string; label: string }

export type EventsPayload = {
  /** The server's today, so "this week" and "12 days left" agree with its filters. */
  today: string
  when: string
  results: HubEvent[]
  /** By kind, before the chosen kind narrows the list: what each chip shows. */
  counts: Record<string, number>
  kinds: { key: string; label: string }[]
  departments: string[]
  audiences: Audience[]
  can_add: boolean
  can_pick_department: boolean
  seminars_this_year: number
}

export type EventsSummary = {
  today: string
  this_week: HubEvent[]
  this_week_count: number
  next: HubEvent | null
  upcoming: HubEvent[]
  counts: Record<string, number>
  total: number
}

export type HighlightAuthor = { id: string; name: string; department: string | null }

export type HighlightPaper = {
  id: string
  title: string
  venue: string | null
  quartile: string | null
  date: string | null
  year: number | null
  citations: number
  authors: HighlightAuthor[]
  authors_more: number
  reason: string
}

export type Highlights = {
  period: "month" | "quarter" | "year" | string
  /** "Past 3 months". */
  label: string
  from: string
  to: string
  windows: { days: number; most_cited_days: number }
  department: string | null
  departments: string[]
  q1: HighlightPaper[]
  first_papers: HighlightPaper[]
  most_cited: HighlightPaper[]
  new_names: HighlightPaper[]
  by_department: { department: string; papers: number; q1: number }[]
  /** The whole count behind each list, which is capped. */
  counts: { q1: number; first_papers: number; most_cited: number; new_names: number }
  totals: { papers: number; q1: number; people: number }
  empty: boolean
}

/* ------------------------------------------------------------------------ */
/* Kinds                                                                     */
/* ------------------------------------------------------------------------ */

/** The word on a chip. "Faculty development programme" is a sentence; teachers say FDP. */
const KIND_WORD: Record<string, string> = {
  SEMINAR: "Seminar",
  WORKSHOP: "Workshop",
  CONFERENCE: "Conference",
  FDP: "FDP",
  CALL_FOR_PAPERS: "Call for papers",
  OTHER: "Other",
}

/** Each kind borrows an area's colour, so it can be told apart without reading. */
const KIND_AREA: Record<string, Area> = {
  SEMINAR: "research",
  WORKSHOP: "record",
  CONFERENCE: "honours",
  FDP: "people",
  CALL_FOR_PAPERS: "time",
}

export function kindWord(kind: string): string {
  return KIND_WORD[kind] ?? "Event"
}

export function kindArea(kind: string): Area | undefined {
  return KIND_AREA[kind]
}

/* ------------------------------------------------------------------------ */
/* Days and times, said the way a person says them                           */
/* ------------------------------------------------------------------------ */

// Written out rather than asked of Intl: "Thursday 8 Oct" must read the same
// on every browser and in every test, and the locale data does not promise it.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/** A local calendar day. Never `new Date("2026-10-08")`, which is midnight UTC and the day before in some zones. */
export function parseDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

export function addDays(iso: string, n: number): string {
  const d = parseDay(iso)
  d.setDate(d.getDate() + n)
  return isoDay(d)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000)
}

/** The day after `iso`, skipping the weekend: a new seminar is not on a Sunday. */
export function nextWorkingDay(iso: string): string {
  const next = addDays(iso, 1)
  const weekday = parseDay(next).getDay()
  return weekday === 6 ? addDays(next, 2) : weekday === 0 ? addDays(next, 1) : next
}

/** "15:00" is "3 pm"; "09:30" is "9:30 am". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number)
  const hour = h % 12 || 12
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`
}

/** "3 to 4 pm", or "11 am to 1:30 pm" when the two ends are not in the same half of the day. */
export function timeSpan(start: string, end?: string | null): string {
  if (!end) return clock(start)
  const [a, b] = [clock(start), clock(end)]
  const [aWhen, bWhen] = [a.slice(-2), b.slice(-2)]
  return aWhen === bWhen ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`
}

export function dayWords(iso: string, opts: { year?: boolean } = {}): string {
  const d = parseDay(iso)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${opts.year ? ` ${d.getFullYear()}` : ""}`
}

/** "5 Oct 2026": a date in a list, no weekday. */
export function shortDay(iso: string): string {
  const d = parseDay(iso)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

const isRun = (e: Pick<HubEvent, "starts_on" | "ends_on">) => !!e.ends_on && e.ends_on !== e.starts_on

/** One day with its weekday, or a run of days as one phrase: "22 to 24 Oct", "30 Oct to 2 Nov". */
export function dayRange(e: Pick<HubEvent, "starts_on" | "ends_on">): string {
  if (!isRun(e)) return dayWords(e.starts_on)
  const [a, b] = [parseDay(e.starts_on), parseDay(e.ends_on as string)]
  if (a.getFullYear() !== b.getFullYear()) return `${shortDay(e.starts_on)} to ${shortDay(e.ends_on as string)}`
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} to ${b.getDate()} ${MONTHS[a.getMonth()]}`
  return `${a.getDate()} ${MONTHS[a.getMonth()]} to ${b.getDate()} ${MONTHS[b.getMonth()]}`
}

/** "Thursday 8 Oct, 3 pm, Seminar Hall 2": how somebody would say it across a desk. */
export function whenWords(e: HubEvent): string {
  if (e.kind === "CALL_FOR_PAPERS") return `Closes ${dayRange(e)}`
  const parts = [dayRange(e)]
  if (!isRun(e) && e.starts_at) parts.push(clock(e.starts_at))
  if (e.venue) parts.push(e.venue)
  return parts.join(", ")
}

/** The square on the left: weekday, day and month. A run of days shares one tile. */
export function tile(e: Pick<HubEvent, "starts_on" | "ends_on">): { weekday: string; day: string; month: string } {
  const a = parseDay(e.starts_on)
  const base = { weekday: WEEKDAYS[a.getDay()].slice(0, 3), day: String(a.getDate()), month: MONTHS[a.getMonth()] }
  if (!isRun(e)) return base
  const b = parseDay(e.ends_on as string)
  return {
    ...base,
    day: `${a.getDate()}–${b.getDate()}`,
    month: a.getMonth() === b.getMonth() ? base.month : `${base.month}–${MONTHS[b.getMonth()]}`,
  }
}

/* ------------------------------------------------------------------------ */
/* How long to go                                                            */
/* ------------------------------------------------------------------------ */

export type Countdown = { text: string; tone: "neutral" | "caution" | "critical" | "quiet" }

/**
 * Days left to send to a call for papers. Only a call has one: a seminar is
 * not something you are late for in the same way. The tone rises as the day
 * gets close, and the words say it too ("Closes today") so colour is never
 * the only signal.
 */
export function countdown(e: HubEvent, today: string): Countdown | null {
  if (e.kind !== "CALL_FOR_PAPERS") return null
  const n = daysBetween(today, e.starts_on)
  if (n < 0) return { text: "Closed", tone: "quiet" }
  if (n === 0) return { text: "Closes today", tone: "critical" }
  if (n === 1) return { text: "1 day left", tone: "critical" }
  return { text: `${n} days left`, tone: n <= 7 ? "caution" : "neutral" }
}

/** "Today", "Tomorrow", "In 3 days", or "On until 9 Oct" for one that has begun. */
export function startsIn(e: Pick<HubEvent, "starts_on" | "ends_on">, today: string): string {
  const end = e.ends_on ?? e.starts_on
  if (daysBetween(today, end) < 0) return "Over"
  const n = daysBetween(today, e.starts_on)
  if (n === 0) return "Today"
  if (n === 1) return "Tomorrow"
  if (n > 1) return `In ${n} days`
  const last = parseDay(end)
  return `On until ${last.getDate()} ${MONTHS[last.getMonth()]}`
}

/** Whether it is over, by the server's today. */
export function isOver(e: Pick<HubEvent, "starts_on" | "ends_on">, today: string): boolean {
  return daysBetween(today, e.ends_on ?? e.starts_on) < 0
}

/* ------------------------------------------------------------------------ */
/* Grouping and asking                                                       */
/* ------------------------------------------------------------------------ */

export type MonthGroup = { key: string; label: string; events: HubEvent[] }

/** By the month each starts in, in the order given. */
export function groupByMonth(events: HubEvent[]): MonthGroup[] {
  const groups: MonthGroup[] = []
  for (const e of events) {
    const key = e.starts_on.slice(0, 7)
    let group = groups.find((g) => g.key === key)
    if (!group) {
      const d = parseDay(e.starts_on)
      group = { key, label: `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`, events: [] }
      groups.push(group)
    }
    group.events.push(e)
  }
  return groups
}

export type EventFilters = { kind?: string; department?: string; q?: string }

/** The request for one list: what is chosen goes in, what is not stays out. */
export function eventsPath(when: string, filters: EventFilters, limit?: number): string {
  const params = new URLSearchParams({ when })
  if (filters.kind) params.set("kind", filters.kind)
  if (filters.department) params.set("department", filters.department)
  if (filters.q?.trim()) params.set("q", filters.q.trim())
  if (limit) params.set("limit", String(limit))
  return `/api/events?${params}`
}

/** Who it is for, in a few words. */
export function audienceLine(e: HubEvent): string {
  if (e.visibility === "DEPARTMENT") return e.department ? `The ${e.department} department` : "One department"
  if (e.visibility === "OFFICE") return "The office"
  return e.department ? `Everybody at the college, hosted by ${e.department}` : "Everybody at the college"
}

/* ------------------------------------------------------------------------ */
/* The research showcase                                                     */
/* ------------------------------------------------------------------------ */

export const PERIODS = [
  { id: "month", label: "Past month" },
  { id: "quarter", label: "Past 3 months" },
  { id: "year", label: "Past year" },
] as const

export type Period = (typeof PERIODS)[number]["id"]

export const DEFAULT_PERIOD: Period = "quarter"

export const isPeriod = (value: string | null): value is Period => PERIODS.some((p) => p.id === value)

/** "28 new papers in the past 3 months, 3 of them in Q1 journals, by 30 colleagues." Null when there are none. */
export function showcaseSentence(h: Pick<Highlights, "label" | "totals" | "department">): string | null {
  const { papers, q1, people } = h.totals
  if (!papers) return null
  const from = h.department ? ` from ${h.department}` : ""
  let line = `${formatCount(papers)} new ${papers === 1 ? "paper" : "papers"}${from} in the ${h.label.toLowerCase()}`
  if (q1 > 0) {
    if (q1 === papers) line += papers === 1 ? ", in a Q1 journal" : ", all in Q1 journals"
    else line += q1 === 1 ? ", 1 of them in a Q1 journal" : `, ${formatCount(q1)} of them in Q1 journals`
  }
  return `${line}, by ${formatCount(people)} ${people === 1 ? "colleague" : "colleagues"}.`
}
