import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowLeft, Download } from "lucide-react"

import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { PrintButton, PrintStamp } from "@/pages/reports-print"
import type { RecordPaper } from "@/pages/papers"

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

function isJournal(p: RecordPaper): boolean {
  return !/conference|proceeding|book|chapter/i.test(p.type ?? "")
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
      i + 1, p.title, p.authors.map((a) => a.name).join("; "), p.venue, p.year, p.type,
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

const selectClass =
  "h-9 rounded-md bg-surface px-2 text-sm text-fg ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent outline-none"

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
  const [journalsOnly, setJournalsOnly] = useState(false)
  const rows = all
    .filter((p) => p.year != null && p.year >= from && p.year <= to)
    .filter((p) => !journalsOnly || isJournal(p))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title))
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    n.set(k, v)
    setParams(n, { replace: true })
  }
  const name = q.data?.user.name ?? ""
  const scope = from === to ? String(from) : `${from} to ${to}`
  const tally = {
    journals: rows.filter(isJournal).length,
    first: rows.filter((p) => p.author_position === 1).length,
    q1: rows.filter((p) => p.quartile === "Q1").length,
    q2: rows.filter((p) => p.quartile === "Q2").length,
  }

  return (
    <div className="page mx-auto max-w-5xl space-y-5 py-6 print:py-0">
      <PrintStamp title={`Publication list of ${name}`} scope={scope} />
      <div className="print:hidden">
        <Link to="/papers" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden /> My papers
        </Link>
        <h1 className="mt-2 font-serif text-2xl text-ink">Publication list for appraisal</h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Laid out the way appraisal (API/PBAS) and CAS promotion forms ask: authors in order, venue,
          indexing, quartile, DOI and your role. Print it to PDF or download it as a spreadsheet.
        </p>
      </div>

      {q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <SkeletonRows rows={6} />
      ) : all.length === 0 ? (
        <EmptyState title="No publications on your record yet" message="Pull your papers from Scopus on your profile, then come back." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <label className="flex items-center gap-1 text-sm text-fg-muted">
              From
              <select aria-label="From year" className={selectClass} value={from} onChange={(e) => set("from", e.target.value)}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1 text-sm text-fg-muted">
              to
              <select aria-label="To year" className={selectClass} value={to} onChange={(e) => set("to", e.target.value)}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={journalsOnly} onChange={(e) => setJournalsOnly(e.target.checked)} />
              Journal papers only
            </label>
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Button kind="quiet" size="sm" onClick={() => save(`publications-${scope.replace(/ /g, "")}.csv`, appraisalCsv(name, rows), "text/csv")}>
                <Download /> Spreadsheet
              </Button>
              <PrintButton />
            </div>
          </div>

          <p className="text-sm text-fg" data-testid="appraisal-summary">
            {rows.length} publication{rows.length === 1 ? "" : "s"} in {scope}: {tally.journals} in journals,{" "}
            {tally.first} as first author, {tally.q1} in Q1 and {tally.q2} in Q2 journals.
          </p>

          {rows.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing in these years.</p>
          ) : (
            <ol className="space-y-3">
              {rows.map((p, i) => (
                <li key={p.id} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 border-b border-line pb-3 text-sm break-inside-avoid">
                  <span className="tabular-nums text-fg-muted">{i + 1}.</span>
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
                    <p className="font-medium text-ink break-words">{p.title}</p>
                    <p className="text-fg-muted break-words">
                      <em>{p.venue ?? "Venue not recorded"}</em>
                      {p.type ? ` · ${p.type}` : ""}
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
  }[]
}

function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}

export function PaymentStatement() {
  const [params, setParams] = useSearchParams()
  const fy = params.get("fy") ?? ""
  const q = useApi<Statement>(["my-payments", "statement", fy], `/api/me/payments/statement${fy ? `?fy=${fy}` : ""}`)
  const d = q.data
  const scope = d?.fy_label ? `Financial year ${d.fy_label} (April to March)` : "All years"

  return (
    <div className="page mx-auto max-w-4xl space-y-5 py-6 print:py-0">
      <PrintStamp title={`Incentive payment statement of ${d?.name ?? ""}${d?.staff_id ? ` (${d.staff_id})` : ""}`} scope={scope} />
      <div className="print:hidden">
        <Link to="/papers" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden /> My papers
        </Link>
        <h1 className="mt-2 font-serif text-2xl text-ink">My payment statement</h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Every publication incentive the college has paid you, from the accounts ledger, by financial year
          for your income tax return.
        </p>
      </div>

      {q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : q.isPending || !d ? (
        <SkeletonRows rows={5} />
      ) : d.years.length === 0 ? (
        <EmptyState title="No payments on record yet" message="Once a paper is paid, it appears here with the month and voucher." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <label className="flex items-center gap-1 text-sm text-fg-muted">
              Financial year
              <select
                aria-label="Financial year"
                className={selectClass}
                value={fy}
                onChange={(e) => {
                  const n = new URLSearchParams(params)
                  if (e.target.value) n.set("fy", e.target.value)
                  else n.delete("fy")
                  setParams(n, { replace: true })
                }}
              >
                <option value="">All years</option>
                {d.years.map((y) => (
                  <option key={y.fy} value={y.fy}>
                    {y.label} ({money(y.total)})
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Button kind="quiet" size="sm" asChild>
                <a href={`/api/me/payments/statement?format=csv${fy ? `&fy=${fy}` : ""}`} download>
                  <Download /> Spreadsheet
                </a>
              </Button>
              <PrintButton />
            </div>
          </div>

          <p className="text-sm text-fg" data-testid="statement-total">
            {scope}: <strong className="tabular-nums">{money(d.total)}</strong> across {d.count} payment
            {d.count === 1 ? "" : "s"}.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-fg-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">Month paid</th>
                  <th className="py-2 pr-3 font-medium">Paper</th>
                  <th className="hidden py-2 pr-3 font-medium sm:table-cell">Voucher</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r, i) => (
                  <tr key={i} className="border-b border-line align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{monthName(r.payout_month)}</td>
                    <td className="py-2 pr-3 break-words">
                      {r.claim_id ? <Link className="hover:underline" to={`/papers/${r.claim_id}`}>{r.paper_title}</Link> : r.paper_title}
                      {r.journal_title && <div className="text-fg-muted">{r.journal_title}</div>}
                    </td>
                    <td className="hidden py-2 pr-3 sm:table-cell">{r.voucher_number ?? "Not recorded"}</td>
                    <td className="py-2 text-right tabular-nums whitespace-nowrap">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="py-2 font-medium sm:hidden">Total</td>
                  <td colSpan={3} className="hidden py-2 font-medium sm:table-cell">Total</td>
                  <td className="py-2 text-right font-semibold tabular-nums">{money(d.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-fg-subtle">
            From the college accounts ledger. Tax deducted, if any, is on your Form 16, not here.
          </p>
        </>
      )}
    </div>
  )
}
