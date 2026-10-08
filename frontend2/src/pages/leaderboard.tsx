import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { keepPreviousData } from "@tanstack/react-query"
import {
  CalendarDays,
  ChevronDown,
  Download,
  SlidersHorizontal,
  FileText,
  Gem,
  Globe2,
  Info,
  Network,
  PenLine,
  Printer,
  Quote,
  Sprout,
  Trophy,
  TrendingUp,
  UsersRound,
  Sigma,
  type LucideIcon,
} from "lucide-react"
import { useAuth } from "@/app/auth"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { DetailLink, detailHref } from "@/ui/detail-sheet"
import { InfoTip } from "@/ui/info"
import { Select } from "@/ui/field"
import { PrintStamp } from "@/pages/reports-print"
import { Distribution, RankedBars, Sparkline, Trend } from "@/ui/chart"
import { PageHeader } from "@/ui/page-header"
import { departmentArt } from "@/ui/illustration"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { Avatar, type PersonBrief } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/ui/sheet"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { EmptyCell } from "@/ui/table"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { WallBoard } from "@/pages/wall"
import { nextStep, stepSentence } from "@/pages/leaderboard-next"

/**
 * The leaderboard (docs/ux/07), counted from the publication record. It opens
 * on the reader: where they stand, who is around them and what would move
 * them, then a short Top 10 and the people rising. The full table is one
 * click away (and is what Print and CSV use). Three tabs; old `?view=trend`
 * and `?view=chart` links open Departments, where those charts now live.
 * No money anywhere: the server builds these boards without reading an amount.
 */

export type Measure =
  | "score" | "papers" | "q1" | "first" | "cited" | "h_index"
  | "rising" | "collab" | "cross_dept" | "international" | "newcomer"

type Span = { key: string; label: string; from: string | null; to: string | null }

export type BoardRow = {
  rank: number | null
  joint: boolean
  person: PersonBrief
  value: number
  papers: number
  score: number
  q1: number
  first: number
  cited: number
  h_index: number
  breakdown: Record<string, number>
  spark: number[]
  move: number | null
  new: boolean
}

type DeptRow = {
  department: string
  faculty: number
  value: number
  per_faculty: number
  papers: number
  papers_per_faculty: number
  score_per_faculty: number
  rank: number | null
  rank_per_faculty: number | null
  trend: { year: number; papers: number }[]
}

export type HonoursBoard = {
  measure: Measure
  label: string
  unit: string
  period: Span & { compared_with: Span | null }
  periods: Span[]
  scope: string | null
  departments_list: string[]
  filters: { topic: string | null; journal: string | null }
  podium: BoardRow[]
  rows: BoardRow[]
  ranked: number
  population: number
  distribution: { bucket: string; count: number; lo: number | null; hi: number }[]
  departments: DeptRow[]
  college_trend: { year: number; papers: number }[]
  top_topics: { topic: string; papers: number }[]
  top_journals: { journal: string; papers: number }[]
  topic_options: string[]
  journal_options: string[]
  totals: { papers: number; people: number; people_with_papers: number }
  spark_years: number[]
  method: { weights: Record<string, number>; source: string; papers_in_record: number; newcomer_months: number; updated: string }
  me: {
    id: string
    rank: number | null
    joint: boolean
    of: number
    population: number
    dept_rank: number | null
    dept_of: number
    department: string | null
    percentile: number | null
    move: number | null
    value: number
    alltime_rank: number | null
  } | null
}

export const MEASURES: { key: Measure; label: string; icon: LucideIcon }[] = [
  { key: "score", label: "Overall", icon: Trophy },
  { key: "papers", label: "Papers", icon: FileText },
  { key: "q1", label: "Q1", icon: Gem },
  { key: "first", label: "First author", icon: PenLine },
  { key: "cited", label: "Cited", icon: Quote },
  { key: "h_index", label: "h-index", icon: Sigma },
  { key: "rising", label: "Most improved", icon: TrendingUp },
  { key: "collab", label: "Collaborative", icon: UsersRound },
  { key: "cross_dept", label: "Cross-department", icon: Network },
  { key: "international", label: "International", icon: Globe2 },
  { key: "newcomer", label: "Newcomers", icon: Sprout },
]

const PERIOD_LABELS: Record<string, string> = {
  academic: "This academic year",
  last_academic: "Last academic year",
  calendar: "This calendar year",
  last12: "Last 12 months",
  all: "All time",
}

/** Everybody opens on the last 12 months: a full year, whatever the month. */
export const DEFAULT_PERIOD = "last12"

const VIEWS = [
  { key: "people", label: "People" },
  { key: "departments", label: "Departments" },
  { key: "wall", label: "Wall of fame" },
] as const
type View = (typeof VIEWS)[number]["key"]

/** Old links (`?view=trend`, `?view=chart`) open Departments, where those charts live now. */
export function viewOf(v: string | null): View {
  if (v === "trend" || v === "chart") return "departments"
  return VIEWS.some((x) => x.key === v) ? (v as View) : "people"
}

export function ordinal(n: number): string {
  const teen = n % 100
  if (teen >= 11 && teen <= 13) return `${n}th`
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`
}

/** "=4" for a tie, "4" otherwise, "Not ranked yet" for somebody with nothing counted this period. */
export const NOT_RANKED = "Not ranked yet"
export const NOT_RANKED_WHY = "Nothing counted for them in this period yet."

export function rankText(rank: number | null, joint: boolean): string {
  if (rank == null) return NOT_RANKED
  return joint ? `=${rank}` : String(rank)
}

function count(n: number): string {
  return n.toLocaleString("en-IN")
}

/**
 * True while the period has not finished. A running year is a part-year: set
 * against the whole of the year before, everybody "falls" every September. So
 * while it runs, the board shows last year's final place as a plain fact and
 * never an up or down (docs/audit/social/leaderboard.md).
 */
export function isRunning(period: { to: string | null }): boolean {
  return !!period.to && new Date(period.to) >= new Date()
}

/** The hero sentence. Never says "none" to someone the table ranks. */
export function standing(b: Pick<HonoursBoard, "me" | "period" | "scope">): string {
  const me = b.me
  // Filtered to a department you are not in: say so, rather than suggest you
  // are not counted at all.
  if (!me && b.scope) return `Showing ${b.scope}. You are not in this list.`
  if (!me) return "You are not on this board. It ranks active faculty members."
  const where = b.scope ?? "the college"
  if (me.rank == null) {
    const period = b.period.label.toLowerCase()
    const all = me.alltime_rank != null ? `. Your all-time rank is #${me.alltime_rank}` : ""
    return `No papers counted for you in ${period} yet${all}.`
  }
  const parts = [`You: ${me.joint ? "joint " : ""}#${me.rank} of ${count(me.of)} in ${where}`]
  if (!b.scope && me.dept_rank != null && me.department) parts.push(`#${me.dept_rank} in ${me.department}`)
  if (me.percentile != null) parts.push(`top ${me.percentile}%`)
  if (me.move != null && me.rank != null) {
    const then = b.period.compared_with?.label ?? "the last period"
    if (isRunning(b.period)) parts.push(`last year #${me.rank + me.move} (final place in ${then})`)
    else if (me.move) parts.push(`${me.move > 0 ? "up" : "down"} ${Math.abs(me.move)} places since ${then}`)
  }
  return parts.join(" · ")
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(b: HonoursBoard): string {
  const head = ["Rank", "Name", "Department", b.label, "Score", "Papers", "Q1", "First author", "Citations", "h-index"]
  const lines = b.rows.map((r) =>
    [rankText(r.rank, r.joint), r.person.name, r.person.department, r.value, r.score, r.papers, r.q1, r.first, r.cited, r.h_index]
      .map(csvCell)
      .join(",")
  )
  return [head.join(","), ...lines].join("\n")
}

/** The board's own query string plus `fmt=csv`. */
export function csvQuery(qs: URLSearchParams): string {
  const q = new URLSearchParams(qs)
  q.set("fmt", "csv")
  return q.toString()
}


/** Short, plain names for the board on screen. */
const BOARD_NAME: Partial<Record<Measure, string>> = { score: "Overall", papers: "Papers", q1: "Q1 papers", first: "First author", cited: "Cited" }

/** One sentence under the chips saying what the chosen board counts. */
export function describeBoard(measure: Measure, weights: Record<string, number> | undefined, newcomerMonths = 24): string {
  const w = weights ?? { Q1: 4, Q2: 3, Q3: 2, Q4: 1, other: 1 }
  switch (measure) {
    case "score":
      return w.Q4 === w.other
        ? `Points for each paper: Q1 ${w.Q1}, Q2 ${w.Q2}, Q3 ${w.Q3}, Q4 and others ${w.Q4}.`
        : `Points for each paper: Q1 ${w.Q1}, Q2 ${w.Q2}, Q3 ${w.Q3}, Q4 ${w.Q4}, others ${w.other}.`
    case "papers": return "Every paper counts once."
    case "q1": return "Papers in Q1 journals, the top quarter of their field."
    case "first": return "Papers where you are the first author."
    case "cited": return "Citations to your papers, from the record."
    case "h_index": return "Your h-index, from the citations in the record."
    case "rising": return "Your score this period minus the period before."
    case "collab": return "How many different co-authors you wrote with."
    case "cross_dept": return "Papers written with a colleague from another department."
    case "international": return "Papers with a co-author abroad."
    case "newcomer": return `People whose first paper came in the last ${newcomerMonths} months.`
  }
}

export function Leaderboard() {
  const [params, setParams] = useSearchParams()
  const measure = (MEASURES.some((m) => m.key === params.get("category")) ? params.get("category") : "score") as Measure
  const period = params.get("period") && PERIOD_LABELS[params.get("period")!] ? params.get("period")! : DEFAULT_PERIOD
  const view = viewOf(params.get("view"))
  // A head of department opens on their own department; "all" is the whole
  // college, chosen on purpose. Everybody else opens on the whole college.
  const { me } = useAuth()
  const home = me?.role === "HOD" ? (me.department ?? "") : ""
  const rawDepartment = params.get("department")
  const department = rawDepartment === null ? home : rawDepartment === "all" ? "" : rawDepartment
  const topic = params.get("topic") ?? ""
  const journal = params.get("journal") ?? ""

  const set = (key: string, value: string) => {
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev)
        if (value) n.set(key, value)
        else n.delete(key)
        return n
      },
      { replace: true }
    )
  }

  const qs = new URLSearchParams({ category: measure, period })
  if (department) qs.set("department", department)
  if (topic) qs.set("topic", topic)
  if (journal) qs.set("journal", journal)
  const query = useApi<HonoursBoard>(["leaderboard", "honours", measure, period, department, topic, journal], `/api/leaderboard?${qs}`, {
    placeholderData: keepPreviousData,
    enabled: view !== "wall",
  })
  const b = query.data

  const controls = (
    <Controls
      measure={measure}
      period={period}
      department={department}
      topic={topic}
      journal={journal}
      board={b}
      set={(key, value) => set(key, key === "department" && !value && home ? "all" : value)}
    />
  )

  return (
    <div className="page mx-auto max-w-[1100px] space-y-6">
      <style>{"@media print { @page { size: A4 landscape; margin: 12mm } }"}</style>
      <div className="print:hidden">
        <PageHeader
          spot="leaderboard-honours"
          title="Leaderboard"
          sub={view === "wall" ? "New papers, month by month." : "Counted from the publication record."}
          action={view === "wall" ? null : <HowCounted board={b} />}
        />
      </div>

      {/* Print-only report header. */}
      {b ? <PrintStamp title="Research leaderboard" scope={`${b.label} · ${b.period.label} · ${b.scope ?? "Whole college"}`} /> : null}

      <nav aria-label="Views" className="well flex w-full gap-1 p-1 sm:w-fit print:hidden">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            aria-current={view === v.key ? "page" : undefined}
            onClick={() => set("view", v.key === "people" ? "" : v.key)}
            className={cn(
              "h-10 flex-1 rounded-lg px-4 text-sm whitespace-nowrap transition-colors duration-[var(--dur-1)] sm:flex-none",
              view === v.key ? "bg-surface font-semibold text-fg shadow-raise ring-1 ring-line" : "font-medium text-fg-muted hover:bg-hover hover:text-fg"
            )}
          >
            {v.label}
          </button>
        ))}
      </nav>

      {view === "wall" ? (
        <WallBoard
          department={params.get("dept") ?? ""}
          month={params.get("month") ?? ""}
          onMonth={(m) => set("month", m)}
          onDepartment={(d) => set("dept", d)}
        />
      ) : query.isError ? (
        <>
          {controls}
          <ErrorState title="Could not load the leaderboard." onRetry={() => void query.refetch()} />
        </>
      ) : view === "people" ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <aside aria-label="Your place" className="space-y-6 lg:col-start-2 lg:row-start-1 print:hidden">
            {b ? <YouCard board={b} measure={measure} /> : <div className="h-48 animate-pulse rounded-2xl bg-sunken" />}
          </aside>
          <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
            {controls}
            {b ? <PeopleView board={b} /> : <SkeletonRows rows={8} />}
          </div>
          <div className="lg:col-start-2 lg:row-start-2 print:hidden">
            {b ? <Rising period={period} department={department} /> : null}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {controls}
          {b ? <DepartmentsTab board={b} /> : <SkeletonRows rows={8} />}
        </div>
      )}

      {view === "wall" ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-4 print:hidden">
          <Meta className="flex items-center gap-1.5">
            {b ? `${count(b.totals.papers)} papers counted in this period.` : "Counted from the publication record."}
            <InfoTip label="About these counts">
              {b
                ? `Counted from the ${count(b.method.papers_in_record)} papers written by current faculty in the publication record. `
                : "From the college's publication record. "}
              No money is shown.
            </InfoTip>
          </Meta>
          <Button kind="quiet" size="sm" onClick={() => window.print()} disabled={!b}>
            <Printer aria-hidden className="size-4" /> Print / PDF
          </Button>
          {/* The server's CSV, with the same filters as the board on screen. */}
          <Button kind="quiet" size="sm" asChild>
            <a href={`/api/leaderboard?${csvQuery(qs)}`} download>
              <Download aria-hidden className="size-4" /> Download CSV
            </a>
          </Button>
        </div>
      )}
    </div>
  )
}

/** The reader's bucket in the spread, from their own figure. */
function myBucket(board: HonoursBoard): string | undefined {
  const me = board.me
  if (!me) return undefined
  return board.distribution.find((d) => (me.value <= 0 ? d.bucket === "0" : d.lo != null && me.value >= d.lo && me.value <= d.hi))?.bucket
}

/** A slim histogram of the board with the reader's bar in the accent. */
function YouAreHere({ board }: { board: HonoursBoard }) {
  const mark = myBucket(board)
  const bars = board.distribution.filter((d) => d.bucket !== "0")
  if (!bars.length) return null
  const max = Math.max(1, ...bars.map((d) => d.count))
  const label = `How ${board.label.toLowerCase()} is spread: ${bars.map((d) => `${d.bucket}: ${d.count} people`).join(", ")}.${mark ? ` You are in ${mark}.` : ""}`
  return (
    <figure className="space-y-1.5">
      <div role="img" aria-label={label} className="flex h-12 items-end gap-1">
        {bars.map((d) => (
          <div key={d.bucket} className="relative flex h-full flex-1 items-end" title={`${d.bucket} ${board.unit}: ${d.count} people`}>
            <div
              className={cn("w-full rounded-t-sm", d.bucket === mark ? "bg-accent" : "bg-fg/15")}
              style={{ height: `${Math.max(6, (d.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <figcaption className="flex justify-between text-xs text-fg-muted">
        <span>Fewer {board.unit}</span>
        {mark ? <span className="font-medium text-accent">You are here</span> : null}
        <span>More</span>
      </figcaption>
    </figure>
  )
}

/**
 * The two people just above the reader and the two just below. People level
 * with the reader are counted, not listed: a run of "=105" says nothing.
 */
export function around(board: HonoursBoard): { above: BoardRow[]; below: BoardRow[]; level: number } {
  const me = board.me
  if (!me || me.rank == null) return { above: [], below: [], level: 0 }
  const ranked = board.rows.filter((r) => r.rank != null && !isMe(board, r))
  const above = ranked.filter((r) => r.value > me.value).slice(-2)
  const below = ranked.filter((r) => r.value < me.value).slice(0, 2)
  const level = ranked.filter((r) => r.value === me.value).length
  return { above, below, level }
}

function Neighbour({ row }: { row: BoardRow }) {
  return (
    <li>
      <DetailLink kind="person" id={row.person.id} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-hover hover:no-underline">
        <span className="w-9 shrink-0 tabular-nums text-fg-muted">{rankText(row.rank, row.joint)}</span>
        <Avatar person={row.person} size="xs" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{row.person.name}</span>
          <span className="block truncate text-xs text-fg-muted">{row.person.department}</span>
        </span>
        <span className="font-semibold tabular-nums">{count(row.value)}</span>
      </DetailLink>
    </li>
  )
}

/**
 * The answer at the top, and the one decorated surface on the page: who you
 * are, your place, where that sits in the spread, the people around you and
 * what would move you. Leads with the best true thing; never a bare zero.
 */
function YouCard({ board, measure }: { board: HonoursBoard; measure: Measure }) {
  const me = board.me
  const link = (o: Record<string, string>) => `/leaderboard?${new URLSearchParams({ ...(measure !== "score" ? { category: measure } : {}), ...o })}`
  const where = board.scope ?? "the college"
  const shell = "rounded-2xl bg-surface p-5 shadow-raise ring-1 ring-line sm:p-6"

  if (!me) {
    return (
      <section className={cn(shell, "space-y-4")}>
        <p className="text-sm text-fg-muted">{board.scope ? `${board.scope} at a glance. The board ranks faculty members.` : "The college at a glance. The board ranks faculty members."}</p>
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-sm text-fg-muted">People ranked</dt>
            <dd className="font-display text-3xl tabular-nums">{count(board.ranked)}</dd>
          </div>
          <div>
            <dt className="text-sm text-fg-muted">Papers counted</dt>
            <dd className="font-display text-3xl tabular-nums">{count(board.totals.papers)}</dd>
          </div>
        </dl>
        <YouAreHere board={board} />
      </section>
    )
  }

  const mine = board.rows.find((r) => isMe(board, r))
  const head = (
    <div className="flex items-center gap-3">
      <Avatar person={mine?.person ?? { name: "You", initials: "You", photo_url: null }} size="md" />
      <div className="min-w-0">
        <p className="truncate font-semibold">{mine?.person.name ?? "You"}</p>
        <p className="truncate text-sm text-fg-muted">{me.department ?? board.label}</p>
      </div>
    </div>
  )

  if (me.rank == null) {
    const period = board.period.label.replace(/^(This|Last) /, (m) => m.toLowerCase())
    return (
      <section className={cn(shell, "space-y-4")}>
        {head}
        <div className="space-y-1">
          <p className="font-display text-lg font-semibold leading-snug">No papers counted for you in {period} yet.</p>
          {me.alltime_rank != null ? (
            <p className="text-sm text-fg-muted">
              Your all-time place is <span className="font-semibold text-fg">#{me.alltime_rank}</span>.
            </p>
          ) : (
            <p className="text-sm text-fg-muted">Once your first paper is in the record, you will show here.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {board.period.key !== "last_academic" ? (
            <Button kind="default" size="sm" asChild><Link to={link({ period: "last_academic" })}>See last academic year</Link></Button>
          ) : null}
          {board.period.key !== "all" ? (
            <Button kind="quiet" size="sm" asChild><Link to={link({ period: "all" })}>All time</Link></Button>
          ) : null}
          {me.alltime_rank == null ? (
            <Button kind="primary" size="sm" asChild><Link to="/papers/new">File a paper</Link></Button>
          ) : null}
        </div>
      </section>
    )
  }

  const leads = !board.scope && me.dept_rank === 1 && me.department
  const quiet = [
    me.percentile != null ? `Top ${me.percentile}%` : null,
    !board.scope && me.dept_rank != null && me.department && !leads ? `#${me.dept_rank} in ${me.department}` : null,
  ].filter(Boolean)
  const step = nextStep(board)
  const near = around(board)

  return (
    <section className={cn(shell, "space-y-5")}>
      {head}
      <div>
        <p className="leading-tight">
          <span className="font-display text-5xl tabular-nums text-accent">#{me.rank}</span>
          <span className="ml-2 text-base text-fg-muted">of {count(me.of)} in {where}</span>
        </p>
        {leads ? <p className="mt-2 font-medium">You lead {me.department}.</p> : null}
        {quiet.length ? <p className="mt-1 text-sm text-fg-muted">{quiet.join(" · ")}</p> : null}
      </div>

      <YouAreHere board={board} />

      {near.above.length || near.below.length ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Around you</h3>
          <ol className="-mx-2 space-y-0.5">
            {near.above.map((r) => <Neighbour key={r.person.id} row={r} />)}
            <li aria-current="true" className="flex items-center gap-2.5 rounded-lg bg-accent-wash px-2 py-1.5 text-sm">
              <span className="w-9 shrink-0 tabular-nums text-fg-muted">{rankText(me.rank, me.joint)}</span>
              {mine ? <Avatar person={mine.person} size="xs" /> : null}
              <span className="min-w-0 flex-1 truncate font-semibold">
                You{near.level ? <span className="font-normal text-fg-muted"> and {near.level} level with you</span> : null}
              </span>
              <span className="font-semibold tabular-nums">{count(me.value)}</span>
            </li>
            {near.below.map((r) => <Neighbour key={r.person.id} row={r} />)}
          </ol>
        </div>
      ) : null}

      {step ? (
        <div className="space-y-1.5 border-t border-line pt-4 text-sm">
          <h3 className="font-semibold">Your next step</h3>
          {step.kind === "first" ? (
            <p>You are first. Keep going.</p>
          ) : (
            <p>
              {step.ahead.person.name} is next, {count(step.theirs)} {board.unit} to your {count(step.yours)}. {stepSentence(step)}
            </p>
          )}
          <Link to="/journal-check" className="inline-block text-accent underline-offset-2 hover:underline">
            Check a journal first
          </Link>
        </div>
      ) : null}
    </section>
  )
}

/** Most improved and Newcomers: something to aim for outside the top 10. */
function Rising({ period, department }: { period: string; department: string }) {
  const q = (category: string) => {
    const s = new URLSearchParams({ category, period })
    if (department) s.set("department", department)
    return `/api/leaderboard?${s}`
  }
  const rising = useApi<HonoursBoard>(["leaderboard", "honours", "rising", period, department, "", ""], q("rising"))
  const fresh = useApi<HonoursBoard>(["leaderboard", "honours", "newcomer", period, department, "", ""], q("newcomer"))
  const cards = [
    { title: "Most improved", icon: TrendingUp, board: rising.data },
    { title: "Newcomers", icon: Sprout, board: fresh.data },
  ]
    .map((c) => ({ ...c, top: (c.board?.rows ?? []).filter((r) => r.rank != null).slice(0, 3) }))
    .filter((c) => c.top.length)
  if (!cards.length) return null
  return (
    <section aria-label="Rising" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
      {cards.map((c) => (
        <div key={c.title} className="rounded-2xl bg-surface p-4 ring-1 ring-line">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <c.icon aria-hidden className="size-4 text-fg-muted" /> {c.title}
          </h3>
          <ol className="-mx-2">
            {c.top.map((r) => (
              <li key={r.person.id}>
                <DetailLink kind="person" id={r.person.id} className="flex w-full items-center gap-2.5 rounded-lg hover:no-underline px-2 py-1.5 text-sm hover:bg-hover">
                  <Avatar person={r.person} size="xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.person.name}</span>
                    <span className="block truncate text-xs text-fg-muted">{r.person.department}</span>
                  </span>
                  <span className="font-semibold tabular-nums">
                    {c.title === "Most improved" ? "+" : ""}{count(r.value)}
                  </span>
                </DetailLink>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  )
}

/** The five everyday boards; the rarer ones sit behind "More". */
const PRIMARY: Measure[] = ["score", "papers", "q1", "first", "cited"]

function Controls({
  measure,
  period,
  department,
  topic,
  journal,
  board,
  set,
}: {
  measure: Measure
  period: string
  department: string
  topic: string
  journal: string
  board: HonoursBoard | undefined
  set: (key: string, value: string) => void
}) {
  const active = [topic, journal].filter(Boolean).length
  const [open, setOpen] = useState(active > 0)
  useEffect(() => {
    if (active) setOpen(true)
  }, [active])
  const more = MEASURES.filter((m) => !PRIMARY.includes(m.key))
  const chosenMore = more.find((m) => m.key === measure)
  const pick = (m: Measure) => set("category", m === "score" ? "" : m)
  const chip = (on: boolean) =>
    cn(
      "inline-flex h-10 shrink-0 items-center gap-1 rounded-full px-4 text-sm font-medium transition-colors duration-[var(--dur-1)]",
      on ? "bg-navy-wash text-fg ring-1 ring-navy/40" : "bg-surface text-fg ring-1 ring-inset ring-control-edge hover:bg-hover"
    )
  const pill = "h-10 w-auto max-w-[15rem] rounded-full pl-9"
  return (
    <div className="space-y-3 print:hidden">
      <div role="group" aria-label="Board" className="flex flex-wrap gap-2">
        {MEASURES.filter((m) => PRIMARY.includes(m.key)).map((m) => (
          <button key={m.key} type="button" aria-pressed={measure === m.key} onClick={() => pick(m.key)} className={chip(measure === m.key)}>
            {BOARD_NAME[m.key] ?? m.label}
          </button>
        ))}
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-pressed={!!chosenMore} className={chip(!!chosenMore)}>
              {chosenMore ? chosenMore.label : "More"} <ChevronDown aria-hidden className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            {more.map((m) => (
              <MenuItem key={m.key} onSelect={() => pick(m.key)}>
                <span className="inline-flex items-center gap-2">
                  <m.icon aria-hidden className="size-4 text-fg-muted" /> {m.label}
                </span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>
      <p className="text-sm text-fg-muted">{describeBoard(measure, board?.method.weights, board?.method.newcomer_months)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex items-center">
          <span className="sr-only">Period</span>
          <CalendarDays aria-hidden className="pointer-events-none absolute left-3 size-4 text-fg-muted" />
          <Select className={pill} value={period} onChange={(e) => set("period", e.target.value === DEFAULT_PERIOD ? "" : e.target.value)}>
            {Object.entries(PERIOD_LABELS).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </Select>
        </label>
        <label className="relative flex items-center">
          <span className="sr-only">Scope</span>
          <UsersRound aria-hidden className="pointer-events-none absolute left-3 size-4 text-fg-muted" />
          <Select className={pill} value={department} onChange={(e) => set("department", e.target.value)}>
            <option value="">Whole college</option>
            {(board?.departments_list ?? []).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
        </label>
        <Button kind="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="h-10 rounded-full">
          <SlidersHorizontal aria-hidden className="size-4" /> Filters{active ? ` (${active})` : ""}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-sunken p-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Topic</span>
            <Select size="sm" className="w-auto max-w-[14rem]" value={topic} onChange={(e) => set("topic", e.target.value)}>
              <option value="">Any topic</option>
              {(board?.topic_options ?? []).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Journal</span>
            <Select size="sm" className="w-auto max-w-[14rem]" value={journal} onChange={(e) => set("journal", e.target.value)}>
              <option value="">Any journal</option>
              {(board?.journal_options ?? []).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </label>
          {active ? (
            <Button kind="quiet" size="sm" onClick={() => { set("topic", ""); set("journal", "") }}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}


const DEPT_HINTS: [RegExp, string][] = [
  [/PHY/, "dept-sh-physics"], [/CHY|CHEM/, "dept-sh-chemistry"], [/MATH/, "dept-sh-maths"], [/ENG(L|$)/, "dept-sh-english"],
  [/AI\W*ML/, "dept-aiml"], [/AI\W*DS/, "dept-aids"], [/ECE/, "dept-ece"], [/EEE/, "dept-eee"], [/CSE|\bCS\b/, "dept-cse"],
  [/MECH/, "dept-mech"], [/AUTO/, "dept-auto"], [/\bIT\b/, "dept-it"], [/CIVIL/, "dept-civil"], [/BME|BIOMED/, "dept-bme"],
  [/AGRI/, "dept-agri"], [/MBA/, "dept-mba"],
]
/** Department codes here look like "CSE - CS" or "S&H-PHY"; match on the telling part. */
export function deptPicture(dept: string): string {
  const k = dept.toUpperCase()
  return DEPT_HINTS.find(([re]) => re.test(k))?.[1] ?? departmentArt(dept)
}

/** A rank, or a muted "Not ranked yet" that says why on hover and to screen readers. */
export function RankCell({ rank, joint }: { rank: number | null; joint: boolean }) {
  if (rank != null) return <>{rankText(rank, joint)}</>
  return (
    <span className="text-xs text-fg-subtle" title={NOT_RANKED_WHY}>
      {NOT_RANKED}
      <span className="sr-only">. {NOT_RANKED_WHY}</span>
    </span>
  )
}

function breakdownText(r: BoardRow): string {
  const parts = Object.entries(r.breakdown)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n}×${k}`)
  return `${r.papers} paper${r.papers === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}`
}


/** Q1 to other, darkest to lightest: quality reads left to right. */
const MIX = [
  { key: "q1", label: "Q1", cls: "bg-navy" },
  { key: "q2", label: "Q2", cls: "bg-navy/70" },
  { key: "q3", label: "Q3", cls: "bg-navy/45" },
  { key: "q4", label: "Q4", cls: "bg-navy/25" },
  { key: "other", label: "Other", cls: "bg-fg/15" },
] as const

/** The breakdown keys arrive as "q1" or "Q1"; read either. */
function part(r: Pick<BoardRow, "breakdown">, key: string): number {
  return r.breakdown[key] ?? r.breakdown[key.toUpperCase()] ?? 0
}

export function MixBar({ row }: { row: Pick<BoardRow, "breakdown"> }) {
  const parts = MIX.map((m) => ({ ...m, n: part(row, m.key) })).filter((m) => m.n > 0)
  const total = parts.reduce((s, m) => s + m.n, 0)
  if (!total) return null
  const title = `Paper mix: ${parts.map((m) => `${m.n} ${m.label}`).join(", ")}`
  return (
    <span role="img" aria-label={title} title={title} data-mix className="flex h-1 w-full max-w-48 overflow-hidden rounded-full bg-sunken">
      {parts.map((m) => (
        <span key={m.key} className={m.cls} style={{ width: `${(m.n / total) * 100}%` }} />
      ))}
    </span>
  )
}

function MixLegend() {
  return (
    <p aria-hidden className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      <span>Paper mix</span>
      {MIX.map((m) => (
        <span key={m.key} className="inline-flex items-center gap-1">
          <span className={cn("inline-block size-2 rounded-full", m.cls)} /> {m.label}
        </span>
      ))}
    </p>
  )
}

/** Gold, silver and bronze, quietly: a small chip, not a plinth. */
const MEDAL = [
  "bg-area-honours-wash text-area-honours ring-1 ring-gold/60",
  "bg-sunken text-fg-muted ring-1 ring-edge",
  "bg-sunken text-fg-muted ring-1 ring-edge",
]

const TOP = 10

function PeopleView({ board }: { board: HonoursBoard }) {
  const [all, setAll] = useState(false)
  const [withZero, setWithZero] = useState(false)
  const ranked = board.rows.filter((r) => r.rank != null)
  const unranked = board.rows.length - ranked.length
  const top = ranked.slice(0, TOP)
  const table = withZero ? board.rows : ranked
  const myRef = useRef<HTMLTableRowElement | null>(null)
  const [offscreen, setOffscreen] = useState(false)
  useEffect(() => {
    const el = myRef.current
    if (!all || !el || typeof IntersectionObserver === "undefined") {
      setOffscreen(false)
      return
    }
    const io = new IntersectionObserver(([e]) => setOffscreen(!e.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [all, table.length])

  if (board.measure === "rising" && !board.ranked)
    return <Sub>Nobody has risen yet this period. It starts counting once two periods have papers.</Sub>
  if (!ranked.length) return <Sub>Nobody has anything counted in this period yet.</Sub>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2 print:hidden">
        <h2 className="font-display text-lg font-semibold">Top {Math.min(TOP, ranked.length)}</h2>
        <MixLegend />
      </div>
      <ol aria-label="Top 10" className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line print:hidden">
        {top.map((r) => {
          const you = isMe(board, r)
          const medal = r.rank != null && r.rank <= 3 ? MEDAL[r.rank - 1] : null
          return (
            <li key={r.person.id} aria-current={you ? "true" : undefined}>
              <DetailLink
                kind="person"
                id={r.person.id}
                className={cn("flex w-full min-h-16 hover:no-underline items-center gap-3 px-4 py-2 hover:bg-hover sm:gap-4", you && "bg-accent-wash")}
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full text-sm tabular-nums",
                    medal ? cn("font-semibold ring-1", medal) : "text-fg-muted"
                  )}
                >
                  {rankText(r.rank, r.joint)}
                </span>
                <Avatar person={r.person} size="sm" />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate font-semibold text-fg">{r.person.name}{you ? " (you)" : ""}</span>
                  <span className="block truncate text-sm text-fg-muted">{r.person.department}</span>
                  <MixBar row={r} />
                </span>
                <span className="shrink-0 text-right">
                  <span className="text-lg font-semibold tabular-nums">{count(r.value)}</span>
                  <span className="ml-1 text-xs text-fg-muted">{board.unit}</span>
                </span>
              </DetailLink>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 print:hidden">
        {ranked.length > TOP || unranked ? (
          <Button kind="default" size="sm" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? "Hide the full list" : `Show everyone (${count(ranked.length)})`}
          </Button>
        ) : null}
        {unranked ? (
          <Meta>
            {count(unranked)} {unranked === 1 ? "person has" : "people have"} nothing counted in this period.
          </Meta>
        ) : null}
      </div>

      {/* The full table: on screen when asked for, always in print. */}
      <div className={cn(all ? "block" : "hidden print:block")}>
        {unranked ? (
          <label className="mb-2 flex items-center gap-2 text-sm text-fg-muted print:hidden">
            <input type="checkbox" checked={withZero} onChange={(e) => setWithZero(e.target.checked)} className="size-4" />
            Include people with nothing counted
          </label>
        ) : null}
        <div className="overflow-x-auto rounded-2xl ring-1 ring-line print:ring-0">
          <table className="w-full min-w-[36rem] bg-surface text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                {["#", "Name and department", board.label, "Papers", "Q1", "Citations", "Paper mix"].map((h, i) => (
                  <th key={h} scope="col" className={cn("border-b border-line px-3 py-2 font-medium", i >= 2 && i <= 5 && "text-right")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.map((r) => {
                const me = isMe(board, r)
                return (
                  <tr
                    key={r.person.id}
                    ref={me ? myRef : undefined}
                    aria-current={me ? "true" : undefined}
                    className={cn("border-b border-line/60 last:border-0 hover:bg-hover/50", me && "bg-accent-wash hover:bg-accent-wash")}
                  >
                    <td className="px-3 py-2 tabular-nums text-fg-muted"><RankCell rank={r.rank} joint={r.joint} /></td>
                    <td className="px-3 py-2">
                      <DetailLink kind="person" id={r.person.id} className="flex items-center gap-2">
                        <Avatar person={r.person} size="xs" className="print:hidden" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-fg">{r.person.name}{me ? " (you)" : ""}</span>
                          <span className="block truncate text-xs text-fg-muted">{r.person.department}</span>
                        </span>
                      </DetailLink>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums" title={breakdownText(r)}>{count(r.value)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.papers}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.q1}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.cited}</td>
                    <td className="px-3 py-2"><MixBar row={r} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {board.me && all && offscreen ? <PinnedMe board={board} /> : null}
    </div>
  )
}

function isMe(board: HonoursBoard, r: BoardRow): boolean {
  return !!board.me && r.person.id === board.me.id
}

/** Shown only while the reader's own row is in the open table and scrolled away. */
function PinnedMe({ board }: { board: HonoursBoard }) {
  const me = board.me!
  return (
    <div role="status" className="sticky bottom-3 z-20 flex items-center gap-3 rounded-xl bg-surface px-4 py-2 text-sm shadow-raise ring-1 ring-accent-line print:hidden">
      <span className="font-display text-lg tabular-nums text-accent">{rankText(me.rank, me.joint)}</span>
      <span className="flex-1 text-fg-muted">Your place{me.percentile != null ? `, top ${me.percentile}%` : ""}</span>
      <span className="font-semibold tabular-nums">{count(me.value)} <span className="font-normal text-fg-muted">{board.unit}</span></span>
    </div>
  )
}

/** Departments, then the college over the years and how the board is spread. */
function DepartmentsTab({ board }: { board: HonoursBoard }) {
  const me = board.me
  return (
    <div className="space-y-10">
      <DepartmentsView board={board} />
      <section className="space-y-4">
        <h2 className="font-display text-lg font-semibold">Over the years</h2>
        <div className="grid gap-5 lg:grid-cols-2">
          <Trend
            title={`Papers by year · ${board.scope ?? "whole college"}`}
            dimension="Year"
            points={board.college_trend.map((t) => ({ key: String(t.year), count: t.papers }))}
            showAmounts={false}
            className="lg:col-span-2"
          />
          <RankedBars title="Top topics this period" dimension="Topic" points={board.top_topics.map((t) => ({ key: t.topic, count: t.papers }))} showAmounts={false} />
          <RankedBars title="Top journals this period" dimension="Journal" points={board.top_journals.map((t) => ({ key: t.journal, count: t.papers, to: detailHref({ kind: "journal", name: t.journal }) }))} showAmounts={false} />
        </div>
      </section>
      <section className="space-y-4">
        <h2 className="font-display text-lg font-semibold">How it is spread</h2>
        <Distribution
          title={`How ${board.label.toLowerCase()} is spread`}
          caption={me?.percentile != null ? `You're in the top ${me.percentile}% of ${board.scope ?? "the college"}.` : undefined}
          dimension={board.unit}
          points={board.distribution.map((d) => ({ key: d.bucket, count: d.count }))}
          mark={myBucket(board)}
          showAmounts={false}
        />
      </section>
    </div>
  )
}

function DepartmentsView({ board }: { board: HonoursBoard }) {
  const [perFaculty, setPerFaculty] = useState(true)
  const points = board.departments.map((d) => ({ key: d.department, count: perFaculty ? d.per_faculty : d.value }))
  const sorted = [...board.departments].sort((a, b) => (perFaculty ? b.per_faculty - a.per_faculty : b.value - a.value))
  const leaders = sorted.filter((d) => (perFaculty ? d.rank_per_faculty : d.rank) != null).slice(0, 3)
  return (
    <div className="space-y-5">
      {leaders.length ? (
        <ol aria-label="Leading departments" className="grid gap-3 sm:grid-cols-3">
          {leaders.map((d, i) => (
            <li key={d.department} className={cn("flex items-center gap-4 rounded-2xl bg-paper p-4 ring-1 ring-line sm:flex-col sm:text-center", i === 0 && "ring-gold/60")}>
              <Picture name={deptPicture(d.department)} className="h-20 w-24 shrink-0 sm:h-28 sm:w-full" />
              <div className="min-w-0">
                <p className="text-xs text-fg-muted">{i === 0 ? "Leading department" : ordinal(i + 1)}</p>
                <p className="truncate font-display text-lg font-semibold">{d.department}</p>
                <p className="text-sm text-fg-muted tabular-nums">
                  {perFaculty ? `${d.per_faculty} per head` : `${count(d.value)} ${board.unit}`} · {d.faculty} faculty
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex gap-2 print:hidden" role="group" aria-label="Normalise">
        <Button size="sm" kind={perFaculty ? "primary" : "quiet"} onClick={() => setPerFaculty(true)}>Per faculty member</Button>
        <Button size="sm" kind={!perFaculty ? "primary" : "quiet"} onClick={() => setPerFaculty(false)}>Total</Button>
      </div>
      <RankedBars
        title={`${board.label} by department${perFaculty ? ", per faculty member" : ""}`}
        caption={perFaculty ? "Divided by each department's head-count, so small departments compare fairly." : undefined}
        dimension="Department"
        points={points}
        limit={20}
        showAmounts={false}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              {["#", "Department", "Faculty", board.label, "Per faculty", "Papers", "Papers / faculty", "5 years"].map((h) => (
                <th key={h} scope="col" className="sticky top-0 border-b border-line bg-bg px-3 py-2 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => (
              <tr key={d.department} className="border-b border-line/60">
                <td className="px-3 py-2 tabular-nums text-fg-muted">{(perFaculty ? d.rank_per_faculty : d.rank) ?? <EmptyCell text="Not ranked" />}</td>
                <td className="px-3 py-2 font-medium">{d.department}</td>
                <td className="px-3 py-2 tabular-nums">{d.faculty}</td>
                <td className="px-3 py-2 tabular-nums">{count(d.value)}</td>
                <td className="px-3 py-2 tabular-nums">{d.per_faculty}</td>
                <td className="px-3 py-2 tabular-nums">{d.papers}</td>
                <td className="px-3 py-2 tabular-nums">{d.papers_per_faculty}</td>
                <td className="px-3 py-2"><Sparkline values={d.trend.map((t) => t.papers)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HowCounted({ board }: { board: HonoursBoard | undefined }) {
  const w = board?.method.weights
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button kind="default" size="sm"><Info aria-hidden /> How it's counted</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>How it's counted</SheetTitle>
          <SheetDescription>From the college's publication record. These are the same papers as on Home and My papers.</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-3 text-sm">
          <SectionTitle>Score</SectionTitle>
          <p>{w ? `Q1 = ${w.Q1}, Q2 = ${w.Q2}, Q3 = ${w.Q3}, Q4 = ${w.Q4}, any other indexed paper = ${w.other}.` : "Q1 = 4, Q2 = 3, Q3 = 2, Q4 = 1, other = 1."}</p>
          <SectionTitle>Categories</SectionTitle>
          <ul className="list-disc space-y-1 pl-5">
            <li>Most improved: score this period minus the period before.</li>
            <li>Collaborative: distinct co-authors. Cross-department: papers with a colleague from another department. International: papers with a co-author abroad.</li>
            <li>Newcomers: first paper within the last {board?.method.newcomer_months ?? 24} months.</li>
            <li>h-index and citations use the citation counts in the record.</li>
          </ul>
          <SectionTitle>Ties and zeros</SectionTitle>
          <p>Equal figures share a rank, shown as “=4”. People with nothing counted in the period are listed without a rank, so zeros never make a tie.</p>
          <p className="text-fg-muted">No money is shown on any leaderboard.</p>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

export default Leaderboard
