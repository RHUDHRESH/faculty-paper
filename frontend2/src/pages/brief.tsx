import { useEffect } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Download, FileText } from "lucide-react"

import { useApi } from "@/lib/query"
import { AnswerLine } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import { PageHeader } from "@/ui/page-header"
import { Details } from "@/ui/section"
import { ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { PrintButton } from "@/pages/reports-print"
import {
  type Brief,
  change,
  columnsFor,
  DeptTable,
  n,
  NoHeads,
  PackChecks,
  papersUrl,
  PushList,
  RisingList,
  rupees,
} from "@/pages/principal-parts"
import { Part, Sheet } from "@/pages/principal/doc"
import { FiveYears } from "@/pages/principal/five-years"
import { asOf, packHref } from "@/pages/principal/year-column"

export type { Brief }

/**
 * The year brief (docs/ux/27, concept A): the Principal's first report, set as
 * the document the governing council reads and the PDF prints.
 *
 * In the order the council asks: the finding in the biggest type; this year
 * against last, with the base of every figure said and every figure a link to
 * the papers it counts; five years as honest columns; where to look (who needs
 * a push, who is rising, and who to call about each); every department per
 * teacher; NAAC 3.3.1. What to settle before it goes, and where each figure
 * comes from, are one step away, not in the way. Everything is computed on the
 * server (core/services/principal_brief.py), so the page, the PDF and the
 * Excel cannot disagree.
 */

/** "up 13.8%" in words, or "the same", or nothing for a part year. */
const pct = (v: number | null | undefined) => (v == null ? "Not recorded" : `${v}%`)
const signed = (v: number | null | undefined) => (v == null ? "New this year" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%`)

/** A caption for the papers chart, only when the five full years tell one plain story. */
function paperStory(b: Brief): string | undefined {
  const full = b.trend.filter((t) => !(b.partial && t.year === b.year))
  if (full.length < 3) return undefined
  const up = full.every((t, i) => i === 0 || t.papers > full[i - 1].papers)
  return up ? `Papers have grown every year since ${full[0].year}.` : undefined
}

export function YearBrief() {
  const [params, setParams] = useSearchParams()
  const year = params.get("year") ?? ""
  const q = useApi<Brief>(["reports-brief", year], `/api/reports/brief${year ? `?year=${year}` : ""}`)
  const b = q.data
  const toSettle = b ? b.pack.filter((c) => !c.ok).length : 0
  const t = b?.totals
  const { hash } = useLocation()
  // A link to a part of the page (#pack, #departments) has to scroll once the parts exist.
  useEffect(() => {
    if (b && hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [b, hash])

  return (
    <div className="page space-y-8">
      <PageHeader
        title="The year in brief"
        action={
          <Button kind="primary" asChild className="print:hidden">
            <a href={packHref(b?.year)} download>
              <FileText />
              Download the council pack
            </a>
          </Button>
        }
      />

      <div className="-mt-4 flex flex-wrap items-end gap-3 print:hidden">
        <div className="w-36">
          <Combobox
            aria-label="Year"
            value={b ? String(b.year) : year || null}
            onChange={(v) => setParams(v ? { year: v } : {})}
            options={(b?.years_available ?? []).map((y) => ({ value: String(y), label: String(y) }))}
          />
        </div>
        <Button kind="default" asChild>
          <a href={`/api/reports/brief/export?fmt=xlsx${b ? `&year=${b.year}` : ""}`} download>
            <Download />
            Excel for NAAC 3.3.1
          </a>
        </Button>
        <PrintButton />
      </div>

      {q.isError ? (
        <ErrorState title="The brief could not be loaded" message="Try again in a moment." onRetry={() => q.refetch()} />
      ) : !b || !t ? (
        <div className="space-y-6">
          <Skeleton className="h-40 w-full max-w-3xl" />
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <>
          <section id="pack" className="scroll-mt-6 print:hidden">
            <Details
              count={toSettle}
              label={toSettle === 0 ? "the checks before it goes (all ready)" : "things to settle before it goes"}
              defaultOpen={hash === "#pack"}
            >
              <PackChecks checks={b.pack} />
            </Details>
          </section>

          <Sheet
            title="Research publications and incentive spend"
            scope={`Calendar year ${b.year}${b.partial ? " to date" : ""} · FY ${b.financial_year}`}
          >
            <div className="space-y-5">
              {b.caveat && <p className="text-sm text-fg-muted">{b.caveat}</p>}
              <AnswerLine className="max-w-[24ch] sm:max-w-[28ch]">{b.finding ?? b.headline}</AnswerLine>
              <p className="max-w-[40rem] text-lead text-fg-muted">
                {[b.context, b.detail].filter(Boolean).join(" ")}
              </p>
            </div>

            <Part title={b.partial ? `${b.year} so far, and last year in full` : "This year against last"}>
              <table className="w-full max-w-3xl border-collapse text-base">
                <thead>
                  <tr className="border-b border-fg text-left text-sm text-fg-muted">
                    <th className="py-2 pr-4 font-medium">
                      <span className="sr-only">Measure</span>
                    </th>
                    <th className="px-3 py-2 text-right font-medium">{b.year}{b.partial ? " to date" : ""}</th>
                    <th className="px-3 py-2 text-right font-medium">{b.year - 1}</th>
                    <th className="py-2 pl-3 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody className="[&_td]:border-b [&_td]:border-line [&_td]:py-2.5 [&_th]:border-b [&_th]:border-line [&_th]:py-2.5 tabular">
                  <tr>
                    <th className="pr-4 text-left font-normal">Papers published</th>
                    <td className="px-3 text-right font-medium">
                      <Link to={papersUrl({ year: b.year })} className="underline-offset-4 hover:underline">
                        {n(t.papers)}
                      </Link>
                    </td>
                    <td className="px-3 text-right">{n(t.papers_prev)}</td>
                    <td className="pl-3 text-right text-fg-muted">{b.partial ? "Not compared" : signed(t.change)}</td>
                  </tr>
                  <tr>
                    <th className="pr-4 text-left font-normal">Papers per teacher</th>
                    <td className="px-3 text-right font-medium">{n(t.per_teacher)}</td>
                    <td className="px-3 text-right">{n(t.per_teacher_prev)}</td>
                    <td className="pl-3 text-right text-fg-muted">
                      {b.partial ? "Not compared" : change(t.per_teacher, t.per_teacher_prev).replace(" on last year", "")}
                    </td>
                  </tr>
                  <tr>
                    <th className="pr-4 text-left font-normal">
                      In Q1 or Q2 journals
                      <span className="block text-sm text-fg-muted">of the {n(t.quartile_known)} papers with a quartile recorded</span>
                    </th>
                    <td className="px-3 text-right font-medium">
                      <Link to={papersUrl({ year: b.year, quartile: "top" })} className="underline-offset-4 hover:underline">
                        {pct(t.top_quartile_share)}
                      </Link>
                    </td>
                    <td className="px-3 text-right">{pct(t.top_quartile_share_prev)}</td>
                    <td className="pl-3" />
                  </tr>
                  <tr>
                    <th className="pr-4 text-left font-normal">Incentives paid, FY {b.financial_year}</th>
                    <td className="px-3 text-right font-medium">{rupees(t.paid)}</td>
                    <td className="px-3 text-right">{rupees(t.paid_prev)}</td>
                    <td className="pl-3 text-right text-fg-muted">{b.partial ? "Part year" : signed(t.paid_prev ? Math.round(((t.paid - t.paid_prev) * 1000) / t.paid_prev) / 10 : null)}</td>
                  </tr>
                  <tr>
                    <th className="pr-4 text-left font-normal">Budget</th>
                    <td className="px-3 text-right font-medium" colSpan={3}>
                      {t.budget ? (
                        <>
                          {rupees(t.budget)}, {t.budget_used}% used
                        </>
                      ) : (
                        <span className="font-normal text-fg-muted">Not set. Finance sets it.</span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Part>

            <Part title="Five years" note="Earlier years are divided by today's roll of teachers; no headcount history is kept.">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 md:grid-cols-3">
                <FiveYears title="Papers published" columns={columnsFor(b, "papers")} current={b.year} caption={paperStory(b)} />
                <FiveYears title="Papers per teacher" columns={columnsFor(b, "per_teacher")} current={b.year} />
                <FiveYears title="Incentives paid (₹ lakh), by financial year" columns={columnsFor(b, "paid")} current={b.year} />
              </div>
              {b.running && (
                <p className="mt-4 text-sm text-fg-muted">
                  {b.running.year} is to date: {n(b.running.papers)} papers by {asOf(b.running.as_of)}. It is drawn hollow and not compared with a whole year.
                </p>
              )}
            </Part>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
              <Part title="Needs a push" note="Three teachers or more, worst first.">
                <PushList rows={b.push} year={b.year} empty="No department stands out as behind." />
                <NoHeads depts={b.push} />
              </Part>
              <Part title="Rising" note="The biggest gain on last year, from five papers.">
                <RisingList rows={b.rising} year={b.year} />
                <NoHeads depts={b.rising} />
              </Part>
            </div>

            <Part id="departments" title="Every department, per teacher" className="scroll-mt-6">
              <DeptTable b={b} />
              {b.unassigned_papers > 0 && (
                <p className="mt-3 text-sm text-fg-muted">
                  <Link
                    to={papersUrl({ year: b.year, department: "Department not recorded" })}
                    className="text-accent underline-offset-4 hover:underline"
                  >
                    {n(b.unassigned_papers)} papers of {b.year}
                  </Link>{" "}
                  carry no department, so no row above holds them.
                </p>
              )}
            </Part>

            <Part title="NAAC metric 3.3.1">
              <p className="max-w-prose text-base">
                {n(b.naac_331.papers)} papers from {b.naac_331.from} to {b.naac_331.to} over {b.naac_331.teachers} teachers:{" "}
                <strong>{n(b.naac_331.per_teacher)} per teacher</strong>, band {b.naac_331.band} of 4.{" "}
                <Link to="/accreditation" className="text-accent underline-offset-4 hover:underline print:hidden">
                  Open accreditation
                </Link>
              </p>
            </Part>

            <Details label="where the figures come from" className="print:block">
              <ul className="max-w-prose list-disc space-y-1 pl-5 pt-2 text-sm text-fg-muted">
                {b.notes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Details>
          </Sheet>
        </>
      )}
    </div>
  )
}
