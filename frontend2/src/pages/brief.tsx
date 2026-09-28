import { useSearchParams } from "react-router-dom"
import { Download, FileText } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import { money } from "@/ui/paper"
import { Answer, PrintButton, PrintStamp } from "@/pages/reports-print"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * The year brief: the Principal's first report (docs/jtbd/principal.md).
 *
 * It answers her questions in the order the governing council asks them --
 * more or fewer papers than last year, per teacher; which departments carry
 * it; what it cost against the budget -- then hands on the artefact: an A4
 * PDF with the college header and an Excel whose sheets NAAC 3.3.1 and the
 * council pack can take as they are. Every figure is computed on the server
 * (core/services/principal_brief.py) from the ledger and the publication
 * record, so the page, the PDF and the Excel cannot disagree.
 */

type Trend = {
  year: number
  papers: number
  per_teacher: number | null
  top_quartile_share: number | null
  financial_year: string
  paid: number
  budget: number | null
}
type Dept = {
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
export type Brief = {
  year: number
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
    paid: number
    paid_prev: number
    budget: number | null
    budget_used: number | null
    cost_per_paper: number | null
  }
  trend: Trend[]
  departments: Dept[]
  naac_331: { from: number; to: number; papers: number; teachers: number; per_teacher: number | null; band: number }
  unassigned_papers: number
  notes: string[]
}

const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-IN"))

function Delta({ now, before, unit = "" }: { now: number | null; before: number | null; unit?: string }) {
  if (now == null || before == null) return <span className="text-fg-muted">no earlier figure</span>
  const d = Math.round((now - before) * 100) / 100
  if (d === 0) return <span className="text-fg-muted">same as last year</span>
  return (
    <span className={d > 0 ? "text-positive" : "text-critical"}>
      {d > 0 ? "+" : "−"}
      {Math.abs(d).toLocaleString("en-IN")}
      {unit} on last year
    </span>
  )
}

function Figure({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="text-[1.75rem] font-semibold leading-9 tabular-nums text-fg">{value}</p>
      <p className="text-sm">{children}</p>
    </div>
  )
}

/** Columns, one per year, each labelled with its value: comparable at a glance. */
function YearBars({
  title,
  rows,
  value,
  label,
  axis,
  highlight,
  tone = "bg-accent",
}: {
  title: string
  rows: Trend[]
  value: (t: Trend) => number
  label: (t: Trend) => string
  axis: (t: Trend) => string
  highlight: number
  tone?: string
}) {
  const top = Math.max(1, ...rows.map(value))
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-medium text-fg">{title}</figcaption>
      <div className="flex h-40 items-end gap-2 border-b border-line" role="img" aria-label={title}>
        {rows.map((t) => (
          <div key={t.year} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            <span className="mb-1 text-xs tabular-nums text-fg">{label(t)}</span>
            <div
              className={cn("w-full max-w-14 rounded-t-sm", t.year === highlight ? tone : "bg-fg-muted/35")}
              style={{ height: `${(value(t) / top) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2">
        {rows.map((t) => (
          <span key={t.year} className="min-w-0 flex-1 truncate text-center text-xs text-fg-muted">
            {axis(t)}
          </span>
        ))}
      </div>
    </figure>
  )
}

/** Departments ranked on papers per teacher, last year's value as a tick. */
function DeptRanking({ rows, year }: { rows: Dept[]; year: number }) {
  const ranked = rows.filter((d) => d.teachers > 0)
  const prevPer = (d: Dept) => (d.teachers ? d.papers_prev / d.teachers : 0)
  const top = Math.max(0.01, ...ranked.map((d) => Math.max(d.per_teacher ?? 0, prevPer(d))))
  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 text-sm text-fg-muted">
        Papers per teacher in {year}. The dark tick is {year - 1}, so a department that slipped shows its bar short of the
        tick.
      </figcaption>
      <ul className="space-y-2.5">
        {ranked.map((d) => (
          <li key={d.department} className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-3 text-sm">
            <span className="truncate text-fg" title={d.department}>
              {d.department}
            </span>
            <span className="relative h-3 rounded-sm bg-sunken">
              <span
                className="absolute inset-y-0 left-0 rounded-sm bg-accent"
                style={{ width: `${((d.per_teacher ?? 0) / top) * 100}%` }}
              />
              <span
                className="absolute -inset-y-1 w-0.5 bg-fg"
                style={{ left: `${(prevPer(d) / top) * 100}%` }}
                aria-hidden
              />
            </span>
            <span className="text-right tabular-nums text-fg">{n(d.per_teacher)}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

export function YearBrief() {
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const q = useApi<Brief>(["reports-brief", year], `/reports/brief${year ? `?year=${year}` : ""}`)
  const b = q.data
  const href = (fmt: "pdf" | "xlsx") => `/api/reports/brief/export?fmt=${fmt}${b ? `&year=${b.year}` : ""}`

  return (
    <div className="page space-y-10">
      <header className="page-head">
        <div className="min-w-0">
          <PrintStamp title="Research publications and incentive spend" scope={b ? `${b.year}, FY ${b.financial_year}` : ""} />
          <PageTitle>The year in brief</PageTitle>
          <Sub className="mt-1">
            Papers, papers per teacher, departments and spend against budget: the page the governing council reads.
          </Sub>
        </div>
        <div className="flex min-w-0 flex-wrap items-end gap-2 print:hidden">
          <div className="w-36">
            <ColumnLabel className="mb-1 block">Year</ColumnLabel>
            <Combobox
              aria-label="Year"
              value={b ? String(b.year) : year || null}
              onChange={(v) => setParams(v ? { year: v } : {})}
              options={(b?.years_available ?? []).map((y) => ({ value: String(y), label: String(y) }))}
            />
          </div>
          <Button kind="primary" size="sm" asChild>
            <a href={href("pdf")} download>
              <FileText />
              Council PDF
            </a>
          </Button>
          <Button size="sm" asChild>
            <a href={href("xlsx")} download>
              <Download />
              Excel (NAAC 3.3.1)
            </a>
          </Button>
          <PrintButton />
        </div>
      </header>

      {q.isError ? (
        <ErrorState title="The brief could not be loaded" onRetry={() => q.refetch()} />
      ) : !b ? (
        <div className="space-y-6">
          <Skeleton className="h-20 w-full max-w-3xl" />
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          <Answer>{b.headline}</Answer>

          <section className="grid grid-cols-[minmax(0,1fr)] gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label={`Papers, ${b.year}`} value={n(b.totals.papers)}>
              <Delta now={b.totals.papers} before={b.totals.papers_prev} />
            </Figure>
            <Figure label="Papers per teacher" value={n(b.totals.per_teacher)}>
              <Delta now={b.totals.per_teacher} before={b.totals.per_teacher_prev} />
            </Figure>
            <Figure label="In Q1 or Q2 journals" value={b.totals.top_quartile_share == null ? "—" : `${b.totals.top_quartile_share}%`}>
              <Delta now={b.totals.top_quartile_share} before={b.totals.top_quartile_share_prev} unit=" points" />
            </Figure>
            <Figure label={`Paid, FY ${b.financial_year}`} value={money(b.totals.paid)}>
              <span className="text-fg-muted">
                {b.totals.budget
                  ? `${b.totals.budget_used}% of ${money(b.totals.budget)} budget`
                  : "No budget set for this year"}
                {b.totals.cost_per_paper ? ` · ${money(b.totals.cost_per_paper)} a paper` : ""}
              </span>
            </Figure>
          </section>

          <section className="space-y-4">
            <SectionTitle>Five years, side by side</SectionTitle>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-3">
              <YearBars
                title="Papers published"
                rows={b.trend}
                value={(t) => t.papers}
                label={(t) => n(t.papers)}
                axis={(t) => String(t.year)}
                highlight={b.year}
              />
              <YearBars
                title="Papers per teacher"
                rows={b.trend}
                value={(t) => t.per_teacher ?? 0}
                label={(t) => n(t.per_teacher)}
                axis={(t) => String(t.year)}
                highlight={b.year}
              />
              <YearBars
                title="Incentives paid (₹ lakh), by financial year"
                rows={b.trend}
                value={(t) => t.paid}
                label={(t) => (t.paid / 100000).toFixed(1)}
                axis={(t) => t.financial_year}
                highlight={b.year}
                tone="bg-fg"
              />
            </div>
          </section>

          <section className="space-y-4">
            <SectionTitle>Departments, per teacher</SectionTitle>
            <DeptRanking rows={b.departments} year={b.year} />
            <TableScroller>
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr>
                    {[
                      "Department",
                      "Teachers",
                      `Papers ${b.year}`,
                      `${b.year - 1}`,
                      "Change",
                      "Per teacher",
                      "Five-year per teacher",
                      `Paid FY ${b.financial_year}`,
                      "Budget",
                      "Paid per paper",
                    ].map((h, i) => (
                      <th key={h} className={cn(stickyHeadCell, i ? "text-right" : "text-left")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {b.departments.map((d) => (
                    <tr key={d.department}>
                      <td className="px-3 py-2 text-fg">{d.department}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(d.teachers)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(d.papers)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{n(d.papers_prev)}</td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          d.change != null && d.change < 0 && "text-critical"
                        )}
                      >
                        {d.change == null ? "—" : `${d.change > 0 ? "+" : ""}${d.change}%`}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{n(d.per_teacher)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{n(d.five_year_per_teacher)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(d.paid)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">
                        {d.budget == null ? "Not set" : money(d.budget)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(d.cost_per_paper)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
            {b.unassigned_papers > 0 && (
              <Sub>
                {b.unassigned_papers} papers of {b.year} carry no department, so no row above holds them.
              </Sub>
            )}
          </section>

          <section className="space-y-2">
            <SectionTitle>NAAC metric 3.3.1</SectionTitle>
            <p className="max-w-prose text-fg">
              {n(b.naac_331.papers)} papers from {b.naac_331.from} to {b.naac_331.to} over {b.naac_331.teachers} teachers:{" "}
              <strong>{n(b.naac_331.per_teacher)} per teacher</strong>, band {b.naac_331.band} of 4 on NAAC&apos;s scale
              (10 or more is 4, 5 to 10 is 3, 3 to 5 is 2, under 3 is 1). NAAC counts UGC-CARE journals only, so treat this
              as the ceiling until the list is checked on the Accreditation page.
            </p>
          </section>

          <section className="space-y-2">
            <SectionTitle>Where the numbers come from</SectionTitle>
            <ul className="max-w-prose list-disc space-y-1 pl-5 text-sm text-fg-muted">
              {b.notes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
