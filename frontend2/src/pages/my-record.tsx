import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Copy, Download, Printer } from "lucide-react"

import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Select } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { ThresholdCard, type ThresholdSummary } from "@/ui/research-threshold"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"
import { PrintStamp } from "@/pages/reports-print"
import { ChoiceChips, typeLabel } from "@/pages/record-bits"
import type { RecordPaper } from "@/pages/papers"
import { unshout } from "@/lib/names"

/**
 * Two documents a faculty member is asked for every year and used to build by
 * hand: the publication list the appraisal (API/PBAS) and CAS promotion forms
 * want, and a statement of incentive money received, for income tax.
 * Both print to PDF from the browser and download as a spreadsheet.
 */

type Payload = {
  user: { id: string; name: string }
  publications: RecordPaper[]
}

export function authorRole(p: RecordPaper): string {
  if (!p.author_position) return "Author"
  if (p.author_position === 1) return p.total_authors === 1 ? "Sole author" : "First author"
  if (!p.total_authors || p.total_authors < p.author_position) return `Co-author (author ${p.author_position})`
  return `Co-author (${p.author_position} of ${p.total_authors})`
}

/**
 * A journal paper, for the appraisal and for supervisor eligibility. A
 * preprint, a conference paper, a book chapter and a Zenodo upload are not
 * journal papers, and counting them made a teacher with 2 journal papers read
 * "12 in journals" on a form that a committee reads. A paper whose type is not
 * recorded is not counted: the list is a claim on a form, so it errs low.
 */
export function isJournal(p: RecordPaper): boolean {
  const t = p.type ?? ""
  return /article|journal|review/i.test(t) && !/conference|proceeding|preprint|book|chapter/i.test(t)
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function appraisalCsv(name: string, rows: RecordPaper[]): string {
  const head = [
    "S.No", "Title", "Authors (in order)", "Journal / conference", "Year", "Type",
    "Indexed in", "Quartile", "DOI", "Your role", "Corresponding author", "Citations",
  ]
  const body = rows.map((p, i) =>
    [
      i + 1, p.title, p.authors.map((a) => a.name).join("; "), p.venue, p.year, typeLabel(p.type),
      p.scopus_indexed ? "Scopus" : "", p.quartile ?? "", p.doi ? `https://doi.org/${p.doi}` : "", authorRole(p),
      p.corresponding_author == null ? "" : p.corresponding_author ? "Yes" : "No", p.citations ?? "",
    ].map(csvCell).join(",")
  )
  return [`Publication list,${csvCell(name)}`, "", head.join(","), ...body].join("\n")
}

function save(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** "2021 to 2025", "2024", or "" when the list is empty (no stray "· 0" in the header). */
export function appraisalScope(from: number, to: number): string {
  if (!from || !to) return ""
  return from === to ? String(from) : `${from} to ${to}`
}

export type Tally = { all: number; journals: number; first: number; q1: number; q2: number; scopus: number }

export function tallyOf(rows: RecordPaper[]): Tally {
  return {
    all: rows.length,
    journals: rows.filter(isJournal).length,
    first: rows.filter((p) => p.author_position === 1).length,
    q1: rows.filter((p) => p.quartile === "Q1").length,
    q2: rows.filter((p) => p.quartile === "Q2").length,
    scopus: rows.filter((p) => p.scopus_indexed).length,
  }
}

const papers = (n: number) => `${formatCount(n)} ${n === 1 ? "paper" : "papers"}`

/**
 * The paragraph a teacher pastes into the appraisal form's research section.
 * Every figure in it is counted from the list below it, so the paragraph and
 * the list cannot disagree.
 */
export function appraisalParagraph(name: string, scope: string, t: Tally): string {
  if (t.all === 0) return ""
  const when = scope.includes(" to ") ? `Between ${scope.replace(" to ", " and ")}` : `In ${scope}`
  const other = t.all - t.journals
  const parts = [
    `${when}, ${name} published ${papers(t.all)}: ${formatCount(t.journals)} in journals and ${formatCount(other)} in conference proceedings or other venues.`,
    `${formatCount(t.first)} ${t.first === 1 ? "is" : "are"} as first author`,
  ]
  const sentence2 = `${parts[1]}, ${formatCount(t.q1)} appeared in Q1 and ${formatCount(t.q2)} in Q2 journals, and ${formatCount(t.scopus)} ${t.scopus === 1 ? "is" : "are"} indexed in Scopus.`
  return `${parts[0]} ${sentence2}`
}

export function AppraisalList() {
  const [params, setParams] = useSearchParams()
  const q = useApi<Payload>(["my-publications", "appraisal"], "/api/me/publications?sort=year")
  const all = q.data?.publications ?? []
  const years = useMemo(
    () => [...new Set(all.map((p) => p.year).filter((y): y is number => y != null))].sort((a, b) => b - a),
    [all]
  )
  const from = Number(params.get("from")) || years[years.length - 1] || 0
  const to = Number(params.get("to")) || years[0] || 0
  const journalsOnly = params.get("journals") === "1"
  const rows = all
    .filter((p) => p.year != null && p.year >= from && p.year <= to)
    .filter((p) => !journalsOnly || isJournal(p))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title))
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    if (v) n.set(k, v)
    else n.delete(k)
    setParams(n, { replace: true })
  }
  const name = q.data?.user.name ?? ""
  const scope = appraisalScope(from, to)
  const tally = tallyOf(rows)
  const paragraph = appraisalParagraph(name, scope, tally)

  return (
    <div className="page space-y-8 print:space-y-4">
      <PrintStamp title={`Publication list of ${name}`} scope={scope} />
      <PageHeader
        className="print:hidden"
        title="Publication list for appraisal"
        sub="Your papers, laid out for appraisal and promotion forms."
        action={
          all.length > 0 ? (
            <Button kind="primary" onClick={() => window.print()}>
              <Printer />
              Print or save as PDF
            </Button>
          ) : undefined
        }
      />

      {q.isError ? (
        <ErrorState what="your papers" onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <SkeletonRows rows={6} />
      ) : all.length === 0 ? (
        <EmptyState
          title="No papers on your record yet"
          message="Pull your papers from Scopus, then come back to print the list."
          action={
            <Button kind="primary" asChild>
              <Link to="/papers">Go to My papers</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 print:hidden">
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              From
              <Select aria-label="From year" className="w-auto" value={from} onChange={(e) => set("from", e.target.value)}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              to
              <Select aria-label="To year" className="w-auto" value={to} onChange={(e) => set("to", e.target.value)}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </label>
            <label className="flex min-h-9 items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={journalsOnly} onChange={(e) => set("journals", e.target.checked ? "1" : "")} />
              Journal papers only
            </label>
            <Button
              kind="default"
              className="sm:ml-auto"
              onClick={() => save(`publications-${scope.replace(/ /g, "")}.csv`, appraisalCsv(name, rows), "text/csv")}
            >
              <Download />
              Download spreadsheet
            </Button>
          </div>

          <Answer
            className="print:hidden"
            items={[
              { value: tally.all, label: `papers in ${scope}`, zero: "No papers in these years" },
              { value: tally.journals, label: "in journals", zero: "None in journals" },
              { value: tally.first, label: "as first author", zero: "None as first author" },
              { value: tally.q1 + tally.q2, label: "in Q1 or Q2 journals", zero: "None in Q1 or Q2" },
            ]}
          />

          {paragraph && (
            <section aria-label="Paragraph for your form" className="well space-y-2 p-4 print:hidden">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-fg">For your form</h2>
                <Button
                  kind="quiet"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(paragraph)
                    toast.ok("Paragraph copied.")
                  }}
                >
                  <Copy />
                  Copy paragraph
                </Button>
              </div>
              <p className="max-w-prose text-pretty text-base text-fg" data-testid="appraisal-summary">
                {paragraph}
              </p>
            </section>
          )}

          {rows.length === 0 ? (
            <EmptyState
              title="Nothing in these years"
              message="Choose a wider range of years, or turn off the journal filter."
              action={<Button onClick={() => setParams(new URLSearchParams(), { replace: true })}>Show all years</Button>}
            />
          ) : (
            <ol aria-label="Publications" className="divide-y divide-line">
              {rows.map((p, i) => (
                <li key={p.id} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2 py-3.5 text-sm break-inside-avoid">
                  <span className="tabular text-fg-muted">{i + 1}.</span>
                  <div className="min-w-0 space-y-0.5">
                    <p>
                      {p.authors.map((a, j) => (
                        <span key={j} className={a.user_id === q.data?.user.id ? "font-semibold" : undefined}>
                          {j > 0 && ", "}
                          {a.name}
                        </span>
                      ))}
                      {p.authors.length === 0 && name}. ({p.year}).
                    </p>
                    <p className="text-base font-medium text-fg break-words">{unshout(p.title)}</p>
                    <p className="text-fg-muted break-words">
                      <em>{unshout(p.venue) || "Venue not recorded"}</em>
                      {typeLabel(p.type) ? ` · ${typeLabel(p.type)}` : ""}
                      {p.scopus_indexed ? " · Scopus indexed" : ""}
                      {p.quartile ? ` · ${p.quartile}` : ""}
                    </p>
                    <p className="text-fg-muted break-all">
                      {authorRole(p)}
                      {p.corresponding_author ? " · Corresponding author" : ""}
                      {p.citations != null ? ` · ${p.citations} citation${p.citations === 1 ? "" : "s"}` : ""}
                      {p.doi ? ` · doi.org/${p.doi}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-fg-subtle">
            Your name is in bold. Points per paper differ between colleges and between the UGC and AICTE
            rules, so this list gives the facts and leaves the scoring to your appraisal form.
          </p>
        </>
      )}
    </div>
  )
}

type Statement = {
  name: string
  staff_id: string | null
  fy: number | null
  fy_label: string | null
  years: { fy: number; label: string; total: number }[]
  total: number
  count: number
  rows: {
    payout_month: string
    financial_year: string
    paper_title: string | null
    journal_title: string | null
    amount: number
    voucher_number: string | null
    claim_id: string | null
    /** Part of this claim that counted against the research threshold. */
    held_back?: number
  }[]
  /** What the research threshold kept back from the claims in this scope. */
  held_back?: number
  research?: ThresholdSummary
}

function monthName(ym: string, month: "long" | "short" = "long"): string {
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month, year: "numeric" })
}

export function PaymentStatement() {
  const [params, setParams] = useSearchParams()
  const fy = params.get("fy") ?? ""
  const q = useApi<Statement>(["my-payments", "statement", fy], `/api/me/payments/statement${fy ? `?fy=${fy}` : ""}`)
  const d = q.data
  const scope = d?.fy_label ? `Financial year ${d.fy_label} (April to March)` : "All years"
  const hasVoucher = d?.rows.some((r) => r.voucher_number) ?? false
  const groups = useMemo(() => {
    const g = new Map<string, NonNullable<typeof d>["rows"]>()
    for (const r of d?.rows ?? []) g.set(r.financial_year, [...(g.get(r.financial_year) ?? []), r])
    return [...g]
  }, [d])
  const latest = d?.rows.reduce((m, r) => (r.payout_month > m ? r.payout_month : m), "") ?? ""
  const csv = `/api/me/payments/statement?format=csv${fy ? `&fy=${fy}` : ""}`

  return (
    <div className="page space-y-8 print:space-y-4">
      <PrintStamp title={`Incentive payment statement of ${d?.name ?? ""}${d?.staff_id ? ` (${d.staff_id})` : ""}`} scope={scope} />
      <PageHeader
        className="print:hidden"
        title="Payment statement"
        sub="Paid to you, by financial year (April to March)."
        action={
          d && d.years.length > 0 ? (
            <Button kind="primary" onClick={() => window.print()}>
              <Printer />
              Print or save as PDF
            </Button>
          ) : undefined
        }
      />

      {d?.research && <ThresholdCard s={d.research} link={false} className="print:hidden" />}

      {q.isError ? (
        <ErrorState what="your payment statement" onRetry={() => q.refetch()} />
      ) : q.isPending || !d ? (
        <SkeletonRows rows={5} />
      ) : d.years.length === 0 ? (
        <EmptyState
          title="No payments on record yet"
          message={
            d.research?.research
              ? "Once an incentive is paid, it appears here with the month it was paid. Claims inside your research threshold pay nothing and are not payments."
              : "Once a paper is paid, it appears here with the month it was paid."
          }
          action={
            <Button asChild>
              <Link to="/papers">See my papers</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 print:hidden">
            <ChoiceChips
              label="Financial year"
              value={fy}
              onChange={(v) => {
                const n = new URLSearchParams(params)
                if (v) n.set("fy", v)
                else n.delete("fy")
                setParams(n, { replace: true })
              }}
              options={[
                { id: "", label: "All years" },
                ...d.years.map((y) => ({ id: String(y.fy), label: y.label, count: money(y.total) })),
              ]}
            />
            <Button kind="default" asChild>
              <a href={csv} download>
                <Download />
                Download spreadsheet
              </a>
            </Button>
          </div>

          <Answer
              items={[
                { value: money(d.total), label: d.fy_label ? `paid in ${d.fy_label}` : "paid in all years", tone: "positive" },
                { value: d.count, label: d.count === 1 ? "payment" : "payments" },
                ...((d.held_back ?? 0) > 0
                  ? [{ value: money(d.held_back), label: "kept back by your research threshold" }]
                  : latest
                    ? [{ value: monthName(latest, "short"), label: "latest payment" }]
                    : []),
              ]}
          />
          <p className="sr-only" data-testid="statement-total">
            {scope}: {money(d.total)} across {d.count} payment{d.count === 1 ? "" : "s"}.
          </p>
          {(d.held_back ?? 0) > 0 && (
            <p className="hidden text-sm text-fg-muted print:block" data-testid="statement-held-back">
              Your research threshold kept back {money(d.held_back)} of the incentives in this period, so it was not paid.
            </p>
          )}

          <table className="w-full text-sm">
            <caption className="sr-only">{scope}: payments by month</caption>
            <thead className="max-sm:sr-only">
              <tr className="border-b border-edge text-left text-fg-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Month paid</th>
                <th scope="col" className="py-2 pr-3 font-medium">Paper</th>
                {hasVoucher && <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">Voucher</th>}
                <th scope="col" className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            {groups.map(([label, list]) => (
              <tbody key={label} className="divide-y divide-line">
                {!d.fy_label && (
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={hasVoucher ? 4 : 3}
                      className="pt-6 pb-2 text-left text-base font-semibold text-fg"
                    >
                      Financial year {label}
                      <span className="ml-2 font-normal tabular text-fg-muted">
                        {money(list.reduce((s, r) => s + r.amount, 0))}, {formatCount(list.length)}{" "}
                        {list.length === 1 ? "payment" : "payments"}
                      </span>
                    </th>
                  </tr>
                )}
                {list.map((r, i) => (
                  <tr key={i} className="align-top max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:py-2.5">
                    <td className="py-2.5 pr-3 whitespace-nowrap text-fg-muted max-sm:col-span-2 max-sm:py-0 max-sm:text-xs">
                      {monthName(r.payout_month)}
                    </td>
                    <td className="py-2.5 pr-3 break-words max-sm:py-0">
                      {r.claim_id ? (
                        <Link className="hover:underline" to={`/papers/${r.claim_id}`}>
                          {unshout(r.paper_title) || "Paper title not recorded"}
                        </Link>
                      ) : (
                        (r.paper_title ?? "Paper title not recorded")
                      )}
                      {r.journal_title && /[p{L}p{N}]/u.test(r.journal_title) && (
                        <div className="text-fg-muted">{unshout(r.journal_title)}</div>
                      )}
                      {(r.held_back ?? 0) > 0 && (
                        <div className="text-fg-muted">{money(r.held_back)} of this claim was inside your research threshold.</div>
                      )}
                    </td>
                    {hasVoucher && (
                      <td className="hidden py-2.5 pr-3 sm:table-cell">
                        {r.voucher_number ?? <span className="text-fg-subtle">Not recorded</span>}
                      </td>
                    )}
                    <td className="py-2.5 text-right font-medium tabular whitespace-nowrap max-sm:py-0">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot>
              <tr className="border-t border-edge">
                <th scope="row" colSpan={hasVoucher ? 3 : 2} className="hidden py-3 text-left font-semibold sm:table-cell">
                  Total, {d.fy_label ? d.fy_label : "all years"}
                </th>
                <td className="py-3 text-right text-base font-semibold tabular max-sm:text-left" colSpan={1}>
                  <span className="sm:hidden">Total </span>
                  {money(d.total)}
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="text-xs text-fg-subtle">
            From the college accounts ledger. Tax deducted, if any, is on your Form 16, not here.
            {!hasVoucher && " The college did not record voucher numbers for these payments."}
          </p>
        </>
      )}
    </div>
  )
}

