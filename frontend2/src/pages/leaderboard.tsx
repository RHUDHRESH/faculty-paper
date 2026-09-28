import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { keepPreviousData } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  SlidersHorizontal,
  FileText,
  Gem,
  Globe2,
  Info,
  Minus,
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

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Distribution, RankedBars, Sparkline, Trend } from "@/ui/chart"
import { HeroBand } from "@/ui/hero"
import { departmentArt } from "@/ui/illustration"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { Avatar, type PersonBrief } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/ui/sheet"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle, Sub } from "@/ui/text"
import { WallBoard } from "@/pages/wall"

/**
 * The leaderboard (docs/ux/07): report-grade, counted from the publication
 * record, many categories and four views, all in the URL. Wall of fame is a
 * tab (docs/ux/14). No money anywhere: the server builds these boards
 * without reading an amount, and nothing here would show one.
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

const VIEWS = [
  { key: "people", label: "Ranked" },
  { key: "departments", label: "Departments" },
  { key: "trend", label: "Trend" },
  { key: "chart", label: "Distribution" },
  { key: "wall", label: "Wall of fame" },
] as const
type View = (typeof VIEWS)[number]["key"]

const TOP = 50

const selectClass =
  "h-8 max-w-[14rem] rounded-md border-0 bg-surface px-2 text-sm text-fg shadow-well ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent"

export function ordinal(n: number): string {
  const teen = n % 100
  if (teen >= 11 && teen <= 13) return `${n}th`
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`
}

/** "=4" for a tie, "4" otherwise, "—" for somebody with nothing counted. */
export function rankText(rank: number | null, joint: boolean): string {
  if (rank == null) return "—"
  return joint ? `=${rank}` : String(rank)
}

function count(n: number): string {
  return n.toLocaleString("en-IN")
}

/** The hero sentence. Never says "none" to someone the table ranks. */
export function standing(b: Pick<HonoursBoard, "me" | "period" | "scope">): string {
  const me = b.me
  if (!me) return "You are not on this board — it ranks active faculty members."
  const where = b.scope ?? "the college"
  if (me.rank == null) {
    const period = b.period.label.toLowerCase()
    const all = me.alltime_rank != null ? ` — your all-time rank is #${me.alltime_rank}` : ""
    return `No papers counted for you in ${period} yet${all}.`
  }
  const parts = [`You: ${me.joint ? "joint " : ""}#${me.rank} of ${count(me.of)} in ${where}`]
  if (!b.scope && me.dept_rank != null && me.department) parts.push(`#${me.dept_rank} in ${me.department}`)
  if (me.percentile != null) parts.push(`top ${me.percentile}%`)
  if (me.move) parts.push(`${me.move > 0 ? "↑" : "↓"}${Math.abs(me.move)} since the last period`)
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

export function Leaderboard() {
  const [params, setParams] = useSearchParams()
  const measure = (MEASURES.some((m) => m.key === params.get("category")) ? params.get("category") : "score") as Measure
  const period = params.get("period") && PERIOD_LABELS[params.get("period")!] ? params.get("period")! : "academic"
  const view = (VIEWS.some((v) => v.key === params.get("view")) ? params.get("view") : "people") as View
  const department = params.get("department") ?? ""
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

  return (
    <div className="page space-y-5">
      <style>{"@media print { @page { size: A4 landscape; margin: 12mm } }"}</style>
      <HeroBand spot="leaderboard-honours"
        area="honours"
        eyebrow="Honours"
        title="Leaderboard"
        sentence={view === "wall" ? "New papers, month by month." : b ? standing(b) : "Counting the publication record…"}
        actions={
          view === "wall" ? null : (
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button kind="quiet" size="sm" onClick={() => window.print()} disabled={!b}>
                <Printer aria-hidden className="size-4" /> Print / PDF
              </Button>
              {/* The server's CSV, with the same filters as the board on screen. */}
              <Button kind="quiet" size="sm" asChild>
                <a href={`/api/leaderboard?${csvQuery(qs)}`} download>
                  <Download aria-hidden className="size-4" /> Download CSV
                </a>
              </Button>
              <HowCounted board={b} />
            </div>
          )
        }
      />

      {/* Print-only report header. */}
      {b ? (
        <div className="hidden print:block">
          <p className="font-display text-xl">Saveetha Engineering College · Research leaderboard</p>
          <p className="text-sm">
            {b.label} · {b.period.label} · {b.scope ?? "Whole college"} · generated {new Date().toLocaleDateString("en-IN")}
          </p>
        </div>
      ) : null}

      <nav aria-label="Views" className="flex gap-1 overflow-x-auto border-b border-line print:hidden">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            aria-current={view === v.key ? "page" : undefined}
            onClick={() => set("view", v.key === "people" ? "" : v.key)}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm",
              view === v.key ? "border-gold font-semibold text-fg" : "border-transparent text-fg-muted hover:text-fg"
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
      ) : (
        <>
          <Controls
            measure={measure}
            period={period}
            department={department}
            topic={topic}
            journal={journal}
            board={b}
            set={set}
          />

          {query.isError ? (
            <ErrorState title="Could not load the leaderboard." message="Nothing has changed." onRetry={() => void query.refetch()} />
          ) : !b ? (
            <SkeletonRows rows={8} />
          ) : view === "people" ? (
            <PeopleView board={b} />
          ) : view === "departments" ? (
            <DepartmentsView board={b} />
          ) : view === "trend" ? (
            <TrendView board={b} />
          ) : (
            <ChartView board={b} />
          )}
          <Meta className="block">
            Counted from the college's publication record ({count(b?.method.papers_in_record ?? 0)} papers). No money is shown.
          </Meta>
        </>
      )}
    </div>
  )
}

/** The six everyday categories; the rarer ones sit behind "More". */
const PRIMARY: Measure[] = ["score", "papers", "q1", "first", "cited", "h_index"]

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
  const active = [department, topic, journal].filter(Boolean).length
  const [open, setOpen] = useState(active > 0)
  const more = MEASURES.filter((m) => !PRIMARY.includes(m.key))
  const chosenMore = more.find((m) => m.key === measure)
  const pick = (m: Measure) => set("category", m === "score" ? "" : m)
  const seg = (on: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm whitespace-nowrap",
      on ? "bg-paper font-semibold text-fg shadow-raise ring-1 ring-line" : "text-fg-muted hover:text-fg"
    )
  return (
    <div className="space-y-3 print:hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div role="group" aria-label="Category" className="-mx-1 flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-sunken p-1">
          {MEASURES.filter((m) => PRIMARY.includes(m.key)).map((m) => (
            <button key={m.key} type="button" aria-pressed={measure === m.key} onClick={() => pick(m.key)} className={seg(measure === m.key)}>
              {m.label}
            </button>
          ))}
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-pressed={!!chosenMore} className={seg(!!chosenMore)}>
                {chosenMore ? chosenMore.label : "More"} <ChevronDown aria-hidden className="size-3.5" />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
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
        <div className="flex items-center gap-2 sm:ml-auto">
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">Period</span>
            <select className={selectClass} value={period} onChange={(e) => set("period", e.target.value === "academic" ? "" : e.target.value)}>
              {Object.entries(PERIOD_LABELS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </label>
          <Button kind="quiet" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <SlidersHorizontal aria-hidden className="size-4" /> Filters{active ? ` (${active})` : ""}
          </Button>
        </div>
      </div>
      {open ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Scope</span>
            <select className={selectClass} value={department} onChange={(e) => set("department", e.target.value)}>
              <option value="">Whole college</option>
              {(board?.departments_list ?? []).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Topic</span>
            <select className={selectClass} value={topic} onChange={(e) => set("topic", e.target.value)}>
              <option value="">Any topic</option>
              {(board?.topic_options ?? []).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Journal</span>
            <select className={selectClass} value={journal} onChange={(e) => set("journal", e.target.value)}>
              <option value="">Any journal</option>
              {(board?.journal_options ?? []).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          {active ? (
            <Button kind="quiet" size="sm" onClick={() => { set("department", ""); set("topic", ""); set("journal", "") }}>
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

function Move({ row }: { row: Pick<BoardRow, "move" | "new" | "rank"> }) {
  if (row.rank == null) return null
  if (row.new) return <span className="text-xs text-fg-muted">new</span>
  if (row.move == null) return null
  if (row.move === 0)
    return (
      <span className="inline-flex items-center text-fg-muted" title="No change">
        <Minus aria-hidden className="size-3" /><span className="sr-only">no change</span>
      </span>
    )
  const up = row.move > 0
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs tabular-nums", up ? "text-positive" : "text-critical")}>
      <Icon aria-hidden className="size-3" />
      {Math.abs(row.move)}
      <span className="sr-only">{up ? " places up" : " places down"}</span>
    </span>
  )
}

function breakdownText(r: BoardRow): string {
  const parts = Object.entries(r.breakdown)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n}×${k}`)
  return `${r.papers} paper${r.papers === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}`
}

/** Gold, silver, bronze: the plinth colour, the ring round the face, the plinth height. */
const MEDAL = [
  { plinth: "bg-gradient-to-b from-[#f3dc93] to-[#e2bf5c] text-[#6b4f0c]", ring: "ring-[#d9b24a]", h: "h-16 sm:h-32" },
  { plinth: "bg-gradient-to-b from-[#e6e8ec] to-[#c7cbd2] text-[#4a4f58]", ring: "ring-[#b4b8bf]", h: "h-11 sm:h-24" },
  { plinth: "bg-gradient-to-b from-[#ecc9a6] to-[#cf9a68] text-[#5e3a18]", ring: "ring-[#c08a5a]", h: "h-8 sm:h-16" },
]

function Podium({ board }: { board: HonoursBoard }) {
  if (!board.podium.length) return null
  // Visual order 2 · 1 · 3, the classic podium.
  const order = [1, 0, 2].filter((i) => board.podium[i])
  return (
    <section className="rounded-2xl bg-paper px-3 pt-6 ring-1 ring-line sm:px-8">
      <p className="text-center text-sm text-fg-muted">
        {board.label} · {board.period.label}
      </p>
      <ol aria-label="Podium" className="mx-auto mt-4 grid max-w-3xl grid-cols-3 items-end gap-2 sm:gap-6">
        {order.map((i) => {
          const r = board.podium[i]
          const first = i === 0
          const m = MEDAL[Math.min((r.rank ?? i + 1) - 1, 2)] ?? MEDAL[i]
          return (
            <li key={r.person.id} className="flex min-w-0 flex-col items-center">
              <Link to={`/people/${r.person.id}`} className="group flex min-w-0 flex-col items-center gap-1 px-1 pb-3 text-center">
                <span className={cn("rounded-full ring-4 ring-offset-2 ring-offset-paper", m.ring)}>
                  <Avatar person={r.person} size={first ? "xl" : "lg"} className={cn(!first && "sm:size-20")} />
                </span>
                <span className="mt-2 line-clamp-2 text-sm font-semibold group-hover:underline sm:text-base">{r.person.name}</span>
                <span className="hidden max-w-full truncate text-xs text-fg-muted sm:block">{r.person.department}</span>
                <span className="font-display text-2xl tabular-nums sm:text-3xl" title={breakdownText(r)}>
                  {count(r.value)}
                </span>
                <Sparkline values={r.spark} label={`Papers per year, ${board.spark_years[0]}–${board.spark_years.at(-1)}`} className="hidden sm:block" />
              </Link>
              <div aria-hidden className={cn("flex w-full items-start justify-center rounded-t-lg pt-1 font-display text-lg sm:pt-2 sm:text-4xl", m.plinth, m.h)}>
                {r.rank}
              </div>
              <span className="sr-only">{r.joint ? `joint ${r.rank}` : `#${r.rank}`}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function PeopleView({ board }: { board: HonoursBoard }) {
  const [all, setAll] = useState(false)
  const shown = all ? board.rows : board.rows.filter((r, i) => i < TOP || isMe(board, r))
  const myRef = useRef<HTMLTableRowElement | null>(null)
  const [offscreen, setOffscreen] = useState(false)
  useEffect(() => {
    const el = myRef.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(([e]) => setOffscreen(!e.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [shown.length])

  if (board.measure === "rising" && !board.ranked)
    return <Sub>Nobody has risen yet this period — it starts counting once two periods have papers.</Sub>

  return (
    <div className="space-y-5">
      <Podium board={board} />
      <p className="text-sm text-fg-muted">
        {count(board.ranked)} of {count(board.population)} people ranked by {board.label.toLowerCase()} ({board.unit}). People with nothing counted are listed without a rank.
      </p>

      {/* Desktop table — ten columns need 1024px; below that the list (a11y audit: 992px wide at 768) */}
      <div className="hidden lg:block print:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              {["#", "Name / department", board.label, "Score", "Papers", "Q1", "First", "Cited", "Trend", "Move"].map((h, i) => (
                <th key={h} scope="col" className={cn("sticky top-0 z-10 border-b border-line bg-bg px-3 py-2 font-normal print:static", i >= 2 && i <= 7 && "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const me = isMe(board, r)
              return (
                <tr
                  key={r.person.id}
                  ref={me ? myRef : undefined}
                  aria-current={me ? "true" : undefined}
                  className={cn(
                    "border-b border-line/60 hover:bg-hover/50",
                    me && "bg-accent-wash shadow-[inset_3px_0_0_var(--color-accent)] hover:bg-accent-wash",
                    r.rank == null && "text-fg-muted"
                  )}
                >
                  <td className="px-3 py-2.5 tabular-nums text-fg-muted">{rankText(r.rank, r.joint)}</td>
                  <td className="px-3 py-2">
                    <Link to={`/people/${r.person.id}`} className="flex items-center gap-2 hover:underline">
                      <Avatar person={r.person} size="sm" className="print:hidden" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-fg">{r.person.name}{me ? " (you)" : ""}</span>
                        <span className="block truncate text-xs text-fg-muted">{r.person.department}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums" title={breakdownText(r)}>{count(r.value)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.score}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.papers}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.q1}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.first}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.cited}</td>
                  <td className="px-3 py-2"><Sparkline values={r.spark} /></td>
                  <td className="px-3 py-2"><Move row={r} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Phone list */}
      <ol className="divide-y divide-line/60 border-y border-line lg:hidden print:hidden">
        {shown.map((r) => (
          <li key={r.person.id} className={cn(isMe(board, r) && "bg-accent-wash shadow-[inset_3px_0_0_var(--color-accent)]")}>
            <Link to={`/people/${r.person.id}`} className="flex items-center gap-3 px-3 py-2">
              <span className="w-8 shrink-0 text-sm tabular-nums text-fg-muted">{rankText(r.rank, r.joint)}</span>
              <Avatar person={r.person} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.person.name}</span>
                <span className="block truncate text-xs text-fg-muted">{r.person.department}</span>
              </span>
              <span className="text-right">
                <span className="block font-semibold tabular-nums">{count(r.value)}</span>
                <Move row={r} />
              </span>
            </Link>
          </li>
        ))}
      </ol>

      {!all && board.rows.length > TOP ? (
        <Button kind="quiet" size="sm" onClick={() => setAll(true)} className="print:hidden">
          Show all {count(board.rows.length)}
        </Button>
      ) : null}

      {board.me && offscreen ? <PinnedMe board={board} /> : null}
    </div>
  )
}

function isMe(board: HonoursBoard, r: BoardRow): boolean {
  return !!board.me && r.person.id === board.me.id
}

function PinnedMe({ board }: { board: HonoursBoard }) {
  const me = board.me!
  return (
    <div
      role="status"
      className="sticky bottom-3 z-20 flex items-center gap-3 rounded-xl bg-paper px-4 py-2 text-sm shadow-raise ring-1 ring-line print:hidden"
    >
      <span className="font-display text-lg tabular-nums text-accent">{rankText(me.rank, me.joint)}</span>
      <span className="flex-1 text-fg-muted">Your place{me.percentile != null ? `, top ${me.percentile}%` : ""}</span>
      <span className="font-semibold tabular-nums">{count(me.value)} <span className="font-normal text-fg-muted">{board.unit}</span></span>
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
                <p className="truncate font-display text-xl">{d.department}</p>
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
                <td className="px-3 py-2 tabular-nums text-fg-muted">{perFaculty ? d.rank_per_faculty ?? "—" : d.rank ?? "—"}</td>
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

function TrendView({ board }: { board: HonoursBoard }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Trend
        title={`Papers by year · ${board.scope ?? "whole college"}`}
        dimension="Year"
        points={board.college_trend.map((t) => ({ key: String(t.year), count: t.papers }))}
        showAmounts={false}
        className="lg:col-span-2"
      />
      <RankedBars title="Top topics this period" dimension="Topic" points={board.top_topics.map((t) => ({ key: t.topic, count: t.papers }))} showAmounts={false} />
      <RankedBars title="Top journals this period" dimension="Journal" points={board.top_journals.map((t) => ({ key: t.journal, count: t.papers }))} showAmounts={false} />
    </div>
  )
}

function ChartView({ board }: { board: HonoursBoard }) {
  const me = board.me
  const mark = me ? board.distribution.find((d) => (me.value <= 0 ? d.bucket === "0" : d.lo != null && me.value >= d.lo && me.value <= d.hi))?.bucket : undefined
  return (
    <div className="space-y-3">
      <Distribution
        title={`How ${board.label.toLowerCase()} is spread`}
        caption={me?.percentile != null ? `You're in the top ${me.percentile}% of ${board.scope ?? "the college"}.` : undefined}
        dimension={board.unit}
        points={board.distribution.map((d) => ({ key: d.bucket, count: d.count }))}
        mark={mark}
        showAmounts={false}
      />
    </div>
  )
}

function HowCounted({ board }: { board: HonoursBoard | undefined }) {
  const w = board?.method.weights
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button kind="quiet" size="sm"><Info aria-hidden className="size-4" /> How it's counted</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>How it's counted</SheetTitle>
          <SheetDescription>From the college's publication record — the same papers as Home and My papers.</SheetDescription>
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
