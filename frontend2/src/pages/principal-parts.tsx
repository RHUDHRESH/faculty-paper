import { Link } from "react-router-dom"
import { AlertTriangle, Check } from "lucide-react"

import { cn } from "@/lib/cn"
import { money } from "@/ui/paper"
import { Rows } from "@/ui/section"
import { type Column, Table } from "@/ui/table"

/**
 * The parts the Principal's report pages share: the brief's shapes, the
 * one-sentence answer, the departments table (a table on a desk, stacked rows
 * on a phone) and the lists that answer "who needs a push".
 *
 * Every number here links to the papers or the people it counts, so "can I
 * trust this figure?" is one click away (docs/jtbd/principal.md, Q6).
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
}

export type PushDept = Dept & { reasons: string[] }

export type PackCheck = { key: string; label: string; ok: boolean; detail: string; to: string | null }

export type Brief = {
  year: number
  /** The year is still running: its figures are to date, not comparable. */
  partial: boolean
  financial_year: string
  years_available: number[]
  headline: string
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

/** The page's answer in one sentence, set large enough to be read first. */
export function Lead({ children }: { children: React.ReactNode }) {
  return (
    <p data-testid="report-answer" className="max-w-3xl text-pretty font-serif text-xl leading-snug text-ink sm:text-2xl">
      {children}
    </p>
  )
}

const pctChange = (d: Dept) =>
  d.change == null ? (d.papers ? "New this year" : "None") : `${d.change > 0 ? "+" : d.change < 0 ? "−" : ""}${Math.abs(d.change)}%`

/** Departments to call the head about, each with the reason in words. */
export function PushList({ rows, year, empty }: { rows: PushDept[]; year: number; empty: string }) {
  if (rows.length === 0) return <p className="text-base text-fg-muted">{empty}</p>
  return (
    <Rows>
      {rows.map((d) => (
        <li key={d.department}>
          <Link to={deptUrl(d.department, year)} className="row block rounded-control px-1 py-2.5 sm:px-2">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-base font-medium">{d.department}</span>
              <span className="shrink-0 text-sm tabular text-fg-muted">
                {n(d.papers)} papers, {n(d.teachers)} teachers
              </span>
            </span>
            <span className="block text-sm text-fg-muted">{d.reasons.join(". ")}</span>
          </Link>
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
        <li key={d.department}>
          <Link to={deptUrl(d.department, year)} className="row block rounded-control px-1 py-2.5 sm:px-2">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-base font-medium">{d.department}</span>
              <span className="shrink-0 text-sm tabular text-positive">Up {d.change}%</span>
            </span>
            <span className="block text-sm text-fg-muted">
              {n(d.papers_prev)} papers in {year - 1}, {n(d.papers)} in {year}
            </span>
          </Link>
        </li>
      ))}
    </Rows>
  )
}

/** What to settle before the pack goes to the council. Words and an icon, not colour alone. */
export function PackChecks({ checks }: { checks: PackCheck[] }) {
  return (
    <Rows>
      {checks.map((c) => (
        <li key={c.key} className="flex items-start gap-3 px-1 py-2.5 sm:px-2">
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
            <Link
              to={c.to}
              className="inline-flex min-h-8 shrink-0 items-center text-sm text-accent underline-offset-4 hover:underline max-sm:min-h-10"
            >
              Open
            </Link>
          )}
        </li>
      ))}
    </Rows>
  )
}

/**
 * Every department, ranked on papers per teacher. On a desk the bar carries
 * last year's value as a dark tick, so a department that slipped shows its bar
 * short of it; on a phone the kit stacks each row and keeps its labels.
 */
export function DeptTable({ b }: { b: Brief }) {
  const rows = b.departments
  const y = b.year
  const anyBudget = rows.some((d) => d.budget != null)
  const prevPer = (d: Dept) => (d.teachers ? d.papers_prev / d.teachers : 0)
  const top = Math.max(0.01, ...rows.map((d) => Math.max(d.per_teacher ?? 0, prevPer(d))))

  const columns: Column<Dept>[] = [
    {
      key: "department",
      header: "Department",
      cell: (d) => <span className="font-medium">{d.department}</span>,
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
            <span className="relative hidden h-2 w-20 rounded-sm bg-sunken lg:block" aria-hidden>
              <span
                className="absolute inset-y-0 left-0 rounded-sm bg-accent"
                style={{ width: `${((d.per_teacher ?? 0) / top) * 100}%` }}
              />
              <span className="absolute -inset-y-0.5 w-0.5 bg-fg" style={{ left: `${(prevPer(d) / top) * 100}%` }} />
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
    {
      key: "cost",
      header: "Paid per paper",
      align: "right",
      empty: "None",
      cell: (d) => (d.cost_per_paper ? rupees(d.cost_per_paper) : null),
    },
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
          minWidth="52rem"
          stack={false}
          caption={`Departments ranked by papers per teacher in ${y}, with ${y - 1} for comparison`}
        />
      </div>
      <p className="hidden text-sm text-fg-muted lg:block">
        On each bar, the dark tick is {y - 1}: a department that slipped shows its bar short of the tick.
      </p>
    </div>
  )
}
