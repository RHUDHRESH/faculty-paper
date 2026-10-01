import { useEffect } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Download, FileText } from "lucide-react"

import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import { PageHeader } from "@/ui/page-header"
import { Section } from "@/ui/section"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Sub } from "@/ui/text"
import { PrintButton, PrintStamp } from "@/pages/reports-print"
import {
  type Brief,
  change,
  DeptTable,
  Lead,
  n,
  PackChecks,
  papersUrl,
  PushList,
  RisingList,
  rupees,
  tone,
} from "@/pages/principal-parts"
import { YearBars } from "@/pages/year-bars"

export type { Brief }

/**
 * The year brief: the Principal's first report (docs/jtbd/principal.md, Q1-Q3).
 *
 * It answers "are we better than last year, and where?" in the order the
 * governing council asks: the year in one sentence; four figures, each a link
 * to the papers it counts; what to settle before the pack goes; which
 * departments need a push and which are rising; five years side by side; the
 * department table. Then the artefact: an A4 PDF with the college header and
 * an Excel whose sheets NAAC 3.3.1 and the pack can take as they are. Every
 * figure is computed on the server (core/services/principal_brief.py), so the
 * page, the PDF and the Excel cannot disagree.
 */

export function YearBrief() {
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const q = useApi<Brief>(["reports-brief", year], `/api/reports/brief${year ? `?year=${year}` : ""}`)
  const b = q.data
  const href = (fmt: "pdf" | "xlsx") => `/api/reports/brief/export?fmt=${fmt}${b ? `&year=${b.year}` : ""}`
  const toSettle = b ? b.pack.filter((c) => !c.ok).length : 0
  const t = b?.totals
  const { hash } = useLocation()
  // A link to a part of the page (#pack, #departments) has to scroll once the parts exist.
  useEffect(() => {
    if (b && hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [b, hash])

  return (
    <div className="page space-y-10">
      <PrintStamp title="Research publications and incentive spend" scope={b ? `${b.year}, FY ${b.financial_year}` : ""} />
      <PageHeader
        title="The year in brief"
        sub="Are we better than last year, and where? The page the governing council reads."
        action={
          <Button kind="primary" asChild className="print:hidden">
            <a href={href("pdf")} download>
              <FileText />
              Download council PDF
            </a>
          </Button>
        }
      />

      <div className="-mt-6 flex flex-wrap items-end gap-3 print:hidden">
        <div className="w-36">
          <ColumnLabel className="mb-1 block">Year</ColumnLabel>
          <Combobox
            aria-label="Year"
            value={b ? String(b.year) : year || null}
            onChange={(v) => setParams(v ? { year: v } : {})}
            options={(b?.years_available ?? []).map((y) => ({ value: String(y), label: String(y) }))}
          />
        </div>
        <Button asChild>
          <a href={href("xlsx")} download>
            <Download />
            Download Excel with NAAC 3.3.1
          </a>
        </Button>
        <PrintButton />
      </div>

      {q.isError ? (
        <ErrorState title="The brief could not be loaded" message="Try again in a moment." onRetry={() => q.refetch()} />
      ) : !b || !t ? (
        <div className="space-y-6">
          <Skeleton className="h-20 w-full max-w-3xl" />
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          <Lead>{b.headline}</Lead>

          <Answer
            items={[
              {
                value: n(t.papers),
                label: b.partial
                  ? `papers in ${b.year} so far; ${n(t.papers_prev)} in all of ${b.year - 1}`
                  : `papers in ${b.year}, ${change(t.papers, t.papers_prev)}`,
                to: papersUrl({ year: b.year }),
                tone: b.partial ? "neutral" : tone(t.papers, t.papers_prev),
              },
              {
                value: n(t.per_teacher),
                label: b.partial
                  ? `papers per teacher; ${n(t.per_teacher_prev)} in all of ${b.year - 1}`
                  : `papers per teacher, ${change(t.per_teacher, t.per_teacher_prev)}`,
                to: "#departments",
                tone: b.partial ? "neutral" : tone(t.per_teacher, t.per_teacher_prev),
              },
              {
                value: t.top_quartile_share == null ? "Not recorded" : `${t.top_quartile_share}%`,
                label: `in Q1 or Q2 journals, of the ${n(t.quartile_known)} papers with a quartile recorded`,
                to: papersUrl({ year: b.year, quartile: "top" }),
              },
              {
                value: rupees(t.paid),
                label: t.budget
                  ? `paid in FY ${b.financial_year}, ${t.budget_used}% of the ${rupees(t.budget)} budget`
                  : `paid in FY ${b.financial_year}; no budget is set for it`,
                to: "/budget",
              },
            ]}
          />

          <Section
            id="pack"
            title="Before you hand this over"
            action={<span className="text-fg-muted">{toSettle === 0 ? "Nothing to settle" : `${toSettle} to settle`}</span>}
            className="print:hidden"
          >
            <PackChecks checks={b.pack} />
          </Section>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
            <Section
              title="Departments that need a push"
              sub="Three teachers or more, worst first. Open one to see its people."
            >
              <PushList
                rows={b.push}
                year={b.year}
                empty="No department stands out as behind, on papers per teacher or on change since last year."
              />
            </Section>
            <Section title="Departments to praise" sub="The biggest gain on last year, from five papers or more.">
              <RisingList rows={b.rising} year={b.year} />
            </Section>
          </div>

          <Section
            title="Five years, side by side"
            sub="Earlier years are divided by today's roll of teachers, because no headcount history is kept."
          >
            <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-3">
              <YearBars
                title="Papers published"
                rows={b.trend}
                value={(x) => x.papers}
                label={(x) => n(x.papers)}
                axis={(x) => String(x.year)}
                highlight={b.year}
              />
              <YearBars
                title="Papers per teacher"
                rows={b.trend}
                value={(x) => x.per_teacher ?? 0}
                label={(x) => n(x.per_teacher)}
                axis={(x) => String(x.year)}
                highlight={b.year}
              />
              <YearBars
                title="Incentives paid (₹ lakh), by financial year"
                rows={b.trend}
                value={(x) => x.paid}
                label={(x) => (x.paid / 100000).toFixed(1)}
                axis={(x) => x.financial_year}
                highlight={b.year}
                tone="bg-fg"
              />
            </div>
          </Section>

          <Section id="departments" title="Every department, per teacher" className="scroll-mt-6">
            <DeptTable b={b} />
            {b.unassigned_papers > 0 && (
              <Sub className="mt-2 text-sm">
                <Link
                  to={papersUrl({ year: b.year, department: "Department not recorded" })}
                  className="text-accent underline-offset-4 hover:underline"
                >
                  {n(b.unassigned_papers)} papers of {b.year}
                </Link>{" "}
                carry no department, so no row above holds them.
              </Sub>
            )}
          </Section>

          <Section title="NAAC metric 3.3.1">
            <p className="max-w-prose text-base text-fg">
              {n(b.naac_331.papers)} papers from {b.naac_331.from} to {b.naac_331.to} over {b.naac_331.teachers} teachers:{" "}
              <strong>{n(b.naac_331.per_teacher)} per teacher</strong>, band {b.naac_331.band} of 4 on NAAC&apos;s scale (10
              or more is 4, 5 to 10 is 3, 3 to 5 is 2, under 3 is 1). NAAC counts UGC-CARE journals only, so this is the
              ceiling until that list is checked.{" "}
              <Link to="/accreditation" className="text-accent underline-offset-4 hover:underline print:hidden">
                Open the NAAC and NIRF tables
              </Link>
            </p>
          </Section>

          <Section title="Where the numbers come from">
            <ul className="max-w-prose list-disc space-y-1 pl-5 text-sm text-fg-muted">
              {b.notes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  )
}
