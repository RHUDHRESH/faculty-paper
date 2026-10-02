import { Link } from "react-router-dom"
import { AlertTriangle, Check } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Rows } from "@/ui/section"
import { type Column, Table } from "@/ui/table"
import type { YearColumn } from "@/pages/principal/five-years"

/**
 * The parts the Principal's report pages share: the brief's shapes, the
 * departments table (a table on a desk, stacked rows on a phone), and the
 * lists that answer "who needs a push" and "what to settle first".
 *
 * Every number here links to the papers or the people it counts, so "can I
 * trust this figure?" is one click away (docs/jtbd/principal.md, Q6). A
 * department is always shown with the person to call about it (docs/ux/27).
 */

export type Trend = {
  year: number
  papers: number
  per_teacher: number | null
  top_quartile_share: number | null
  quartile_known: number
  financial_year: string
  paid: number
  budget: number | null
}

/** The head of a department, as the server names them (the renderer adds the photograph). */
export type Head = { user_id: string; name: string; email?: string; photo_url?: string | null; initials?: string } | null

export type Dept = {
  department: string
  teachers: number
  papers: number
  papers_prev: number
  change: number | null
  per_teacher: number | null
  five_year: number
  five_year_per_teacher: number | null
  paid: number
  budget: number | null
  cost_per_paper: number | null
  head?: Head
}

export type PushDept = Dept & { reasons: string[] }

export type PackCheck = { key: string; label: string; ok: boolean; detail: string; to: string | null }

/** The year that is still running, shown beside the five as a part year. */
export type Running = {
  year: number
  papers: number
  per_teacher: number | null
  financial_year: string
  paid: number
  as_of: string
} | null

export type Brief = {
  year: number
  /** The year is still running: its figures are to date, not comparable. */
  partial: boolean
  financial_year: string
  years_available: number[]
  headline: string
  /** What a running year needs said first; empty for a full year. */
  caveat?: string
  /** The one short sentence that carries the answer. */
  finding?: string
  /** Per teacher, across how many. */
  context?: string
  /** The money, and who leads and who is lowest. */
  detail?: string
  running?: Running
  totals: {
    papers: number
    papers_prev: number
    change: number | null
    teachers: number
    per_teacher: number | null
    per_teacher_prev: number | null
    top_quartile_share: number | null
    top_quartile_share_prev: number | null
    quartile_known: number
    paid: number
    paid_prev: number
    budget: number | null
    budget_used: number | null
    cost_per_paper: number | null
  }
  trend: Trend[]
  departments: Dept[]
  push: PushDept[]
  rising: Dept[]
  pack: PackCheck[]
  naac_331: { from: number; to: number; papers: number; teachers: number; per_teacher: number | null; band: number }
  unassigned_papers: number
  notes: string[]
}

export const n = (v: number | null | undefined) => (v == null ? "Not recorded" : v.toLocaleString("en-IN"))

/** A rupee figure without paise: a council page is read in rupees. */
export const rupees = (v: number | null | undefined) => money(v == null ? v : Math.round(v))

/** Rupees as lakh and crore, for a place a full figure will not fit ("₹12.9 lakh"). */
export function lakh(v: number | null | undefined): string {
  if (v == null) return "Not recorded"
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} crore`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(1)} lakh`
  return rupees(v)
}

export const papersUrl = (p: { year?: number; department?: string; quartile?: string }) => {
  const q = new URLSearchParams()
  if (p.year) q.set("year", String(p.year))
  if (p.department) q.set("department", p.department)
  if (p.quartile) q.set("quartile", p.quartile)
  const s = q.toString()
  return `/reports/papers${s ? `?${s}` : ""}`
}

export const deptUrl = (department: string, year?: number) =>
  `/reports/departments/${encodeURIComponent(department)}${year ? `?year=${year}` : ""}`

/** "up 192 on last year" in words; the tone is a second signal, never the only one. */
export function change(now: number | null, before: number | null, unit = "", word = "last year"): string {
  if (now == null || before == null) return "no earlier figure"
  const d = Math.round((now - before) * 100) / 100
  if (d === 0) return `the same as ${word}`
  return `${d > 0 ? "up" : "down"} ${Math.abs(d).toLocaleString("en-IN")}${unit} on ${word}`
}

export const tone = (now: number | null, before: number | null): "positive" | "critical" | "neutral" =>
  now == null || before == null || now === before ? "neutral" : now > before ? "positive" : "critical"

/** The page's answer in one sentence, set large enough to be read first. (The
 *  older pages, a head of department's among them, still use it.) */
export function Lead({ children }: { children: React.ReactNode }) {
  return (
    <p data-testid="report-answer" className="max-w-3xl text-pretty font-serif text-xl leading-snug text-ink sm:text-2xl">
      {children}
    </p>
  )
}

/* ------------------------------------------------------------------------ */
/* Five years, from the brief                                                */
/* ------------------------------------------------------------------------ */

type Measure = "papers" | "per_teacher" | "paid"

/**
 * The columns of a five-year chart: the five years of the brief, then the
 * year that is still running (if the reported year is over) as a hollow one.
 * Money is by financial year, so its axis is the financial year.
 */
export function columnsFor(b: Brief, measure: Measure): YearColumn[] {
  const cols: YearColumn[] = b.trend.map((t) => {
    const value = measure === "papers" ? t.papers : measure === "per_teacher" ? t.per_teacher : t.paid
    return {
      year: t.year,
      value,
      label: measure === "paid" ? ((value ?? 0) / 1e5).toFixed(1) : value == null ? "None" : n(value),
      axis: measure === "paid" ? t.financial_year : undefined,
    }
  })
  const r = b.running
  if (r && !b.partial) {
    const value = measure === "papers" ? r.papers : measure === "per_teacher" ? r.per_teacher : r.paid
    cols.push({
      year: r.year,
      value,
      label: measure === "paid" ? ((value ?? 0) / 1e5).toFixed(1) : value == null ? "None" : n(value),
      axis: measure === "paid" ? r.financial_year : undefined,
      running: true,
    })
  }
  // A year the brief itself reports as running is the last column already.
  if (b.partial && cols.length) cols[cols.length - 1] = { ...cols[cols.length - 1], running: true }
  return cols
}

/* ------------------------------------------------------------------------ */
/* People and lists                                                          */
/* ------------------------------------------------------------------------ */

/** The face of the person to call about a department, or a spacer of the same width. */
function HeadFace({ head }: { head?: Head }) {
  if (!head) return <span aria-hidden className="size-8 shrink-0" />
  return (
    <Avatar
      size="sm"
      person={{ name: head.name, initials: head.initials ?? initialsOf(head.name), photo_url: head.photo_url ?? null }}
    />
  )
}

/** "Dr. A. Kumar, head" or, when nobody is set, the fact said once and quietly. */
export function headLabel(head?: Head): string {
  return head ? `Head: ${head.name}` : "No head of department is set"
}

/** The fact that nobody is set as head, said once under a list instead of on every row. */
export function NoHeads({ depts }: { depts: { department: string; head?: Head }[] }) {
  const names = depts.filter((d) => !d.head).map((d) => d.department)
  if (names.length === 0) return null
  return (
    <p className="mt-2 px-1 text-sm text-fg-subtle sm:px-2">
      No head of department is set for {names.join(", ")}.
    </p>
  )
}

const pctChange = (d: Dept) =>
  d.change == null ? (d.papers ? "New this year" : "None") : `${d.change > 0 ? "+" : d.change < 0 ? "−" : ""}${Math.abs(d.change)}%`

/** Departments to call the head about, each with the reason in words and the head's face. */
export function PushList({ rows, year, empty }: { rows: PushDept[]; year: number; empty: string }) {
  if (rows.length === 0) return <p className="text-base text-fg-muted">{empty}</p>
  return (
    <Rows>
      {rows.map((d) => (
        <li key={d.department} className="relative flex items-start gap-3 px-1 py-3 sm:px-2">
          <HeadFace head={d.head} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <Link
                to={deptUrl(d.department, year)}
                className="min-w-0 truncate text-base font-medium after:absolute after:inset-0 after:content-['']"
              >
                {d.department}
              </Link>
              <span className="shrink-0 text-sm tabular text-fg-muted">
                {n(d.papers)} {d.papers === 1 ? "paper" : "papers"}, {n(d.teachers)} teachers
              </span>
            </div>
            <p className="text-sm text-fg-muted">{d.reasons.join(". ")}.</p>
            {d.head && <p className="text-sm text-fg-subtle">{headLabel(d.head)}</p>}
          </div>
        </li>
      ))}
    </Rows>
  )
}

export function RisingList({ rows, year }: { rows: Dept[]; year: number }) {
  if (rows.length === 0) return <p className="text-base text-fg-muted">No department has grown enough to name.</p>
  return (
    <Rows>
      {rows.map((d) => (
        <li key={d.department} className="relative flex items-start gap-3 px-1 py-3 sm:px-2">
          <HeadFace head={d.head} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <Link
                to={deptUrl(d.department, year)}
                className="min-w-0 truncate text-base font-medium after:absolute after:inset-0 after:content-['']"
              >
                {d.department}
              </Link>
              <span className="shrink-0 text-sm tabular text-positive">Up {d.change}%</span>
            </div>
            <p className="text-sm text-fg-muted">
              {n(d.papers_prev)} papers in {year - 1}, {n(d.papers)} in {year}.
            </p>
            {d.head && <p className="text-sm text-fg-subtle">{headLabel(d.head)}</p>}
          </div>
        </li>
      ))}
    </Rows>
  )
}

/** What each pack check opens, in words. A link that says only "Open" says nothing. */
const FIX_LABEL: Record<string, string> = {
  budget: "Open the budget",
  department: "See those papers",
  quartile: "See those papers",
  ugc: "Open accreditation",
}

/** What to settle before the pack goes to the council. Words and an icon, not colour alone. */
export function PackChecks({ checks }: { checks: PackCheck[] }) {
  return (
    <Rows>
      {checks.map((c) => (
        <li key={c.key} className="flex items-start gap-3 px-1 py-3 sm:px-2">
          {c.ok ? (
            <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-base">
              {c.label}
              <span className={cn("ml-2 text-sm", c.ok ? "text-positive" : "text-caution")}>
                {c.ok ? "Ready" : "To settle"}
              </span>
            </span>
            <span className="block text-sm text-fg-muted">{c.detail}</span>
          </span>
          {!c.ok && c.to && (
            <Button kind="default" size="sm" asChild className="shrink-0">
              <Link to={c.to}>{FIX_LABEL[c.key] ?? "Open"}</Link>
            </Button>
          )}
        </li>
      ))}
    </Rows>
  )
}

/**
 * Every department, ranked on papers per teacher. On a desk the bar carries
 * last year's value as a dark tick and the college's rate as a hairline across
 * every row, so "under half the college" is a shape and not only a sentence:
 * a department that slipped shows its bar short of its tick, and one that
 * needs a push is amber and stops short of half the hairline. On a phone the
 * kit stacks each row and keeps its labels.
 */
export function DeptTable({ b }: { b: Brief }) {
  const rows = b.departments
  const y = b.year
  const anyBudget = rows.some((d) => d.budget != null)
  const prevPer = (d: Dept) => (d.teachers ? d.papers_prev / d.teachers : 0)
  const college = b.totals.per_teacher ?? 0
  const top = Math.max(0.01, college, ...rows.map((d) => Math.max(d.per_teacher ?? 0, prevPer(d))))
  const under = (d: Dept) => d.teachers >= 3 && college > 0 && (d.per_teacher ?? 0) < college / 2

  const columns: Column<Dept>[] = [
    {
      key: "department",
      header: "Department",
      cell: (d) => (
        <span className="block">
          <span className="font-medium">{d.department}</span>
          {d.head && <span className="block text-xs text-fg-muted">{d.head.name}</span>}
        </span>
      ),
    },
    { key: "teachers", header: "Teachers", align: "right", cell: (d) => n(d.teachers) },
    {
      key: "papers",
      header: `Papers ${y}`,
      align: "right",
      empty: "None",
      cell: (d) =>
        d.papers > 0 ? (
          <Link to={papersUrl({ year: y, department: d.department })} className="underline-offset-4 hover:underline">
            {n(d.papers)}
          </Link>
        ) : null,
    },
    { key: "prev", header: String(y - 1), align: "right", empty: "None", cell: (d) => d.papers_prev || null },
    {
      key: "change",
      header: "Change",
      align: "right",
      cell: (d) => <span className={cn(d.change != null && d.change < 0 && "text-critical")}>{pctChange(d)}</span>,
    },
    {
      key: "per",
      header: "Per teacher",
      align: "right",
      cell: (d) =>
        d.teachers ? (
          <span className="flex items-center justify-end gap-2">
            <span className="relative hidden h-2 w-24 rounded-sm bg-sunken lg:block" aria-hidden>
              <span
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{
                  width: `${((d.per_teacher ?? 0) / top) * 100}%`,
                  backgroundColor: under(d) ? "var(--color-caution)" : "var(--chart-1)",
                }}
              />
              <span className="absolute -inset-y-0.5 w-0.5 bg-fg" style={{ left: `${(prevPer(d) / top) * 100}%` }} />
              {college > 0 && (
                <span
                  className="absolute -inset-y-1 w-px bg-fg-muted/70"
                  style={{ left: `${(college / top) * 100}%` }}
                />
              )}
            </span>
            <span>{n(d.per_teacher)}</span>
          </span>
        ) : (
          "No teachers on the roll"
        ),
    },
    {
      key: "five",
      header: "Five years, per teacher",
      align: "right",
      empty: "None",
      cell: (d) => (d.teachers ? d.five_year_per_teacher : null),
    },
    { key: "paid", header: `Paid FY ${b.financial_year}`, align: "right", cell: (d) => rupees(d.paid) },
    ...(anyBudget
      ? [
          {
            key: "budget",
            header: "Budget",
            align: "right" as const,
            empty: "Not set",
            cell: (d: Dept) => (d.budget == null ? null : rupees(d.budget)),
          },
        ]
      : []),
  ]

  return (
    <div className="space-y-2">
      {/* On a phone nine labelled lines a department would make a page of
          twenty-five of them a scroll of a thousand; two lines that say the
          same thing in words are read, where nine are skipped. */}
      <Rows className="sm:hidden">
        {rows.map((d) => (
          <li key={d.department}>
            <Link to={deptUrl(d.department, y)} className="row block rounded-control px-1 py-3">
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-base font-medium">{d.department}</span>
                <span className="shrink-0 text-base font-medium tabular">
                  {d.teachers ? `${n(d.per_teacher)} per teacher` : "No teachers on the roll"}
                </span>
              </span>
              <span className="block text-sm text-fg-muted">
                {d.papers} {d.papers === 1 ? "paper" : "papers"} in {y}, {d.papers_prev} in {y - 1} ({pctChange(d)}).{" "}
                {n(d.teachers)} {d.teachers === 1 ? "teacher" : "teachers"}. {rupees(d.paid)} paid.
              </span>
            </Link>
          </li>
        ))}
      </Rows>
      <div className="max-sm:hidden">
        <Table
          rows={rows}
          columns={columns}
          getKey={(d) => d.department}
          rowLink={(d) => deptUrl(d.department, y)}
          maxHeight="none"
          minWidth="44rem"
          stack={false}
          caption={`Departments ranked by papers per teacher in ${y}, with ${y - 1} for comparison`}
        />
      </div>
      <p className="hidden text-sm text-fg-muted lg:block">
        On each bar, the dark tick is {y - 1} and the grey hairline is the college&apos;s {n(b.totals.per_teacher)}. A bar
        in amber stops short of half the hairline.
      </p>
    </div>
  )
}
