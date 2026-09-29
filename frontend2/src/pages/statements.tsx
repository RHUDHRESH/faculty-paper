import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CheckCircle2, Download, FileText } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { PrintStamp } from "@/pages/reports-print"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Combobox } from "@/ui/combobox"
import { money } from "@/ui/paper"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * One payout month, as the Director signs it and Finance reconciles it.
 *
 * Every figure is the server's, read from the payments ledger
 * (`core/services/payout_statement.py`), so this page, the Ledger and Reports
 * agree about a month by construction. Nothing on it is a flag: the Director
 * and Finance are never shown one.
 */

export type StatementMonth = { month: string; label: string; amount: number; count: number }

type Row = {
  source: "app" | "import" | "claim_only"
  ledger_id: string | null
  claim_id: string | null
  ticket: string | null
  staff_id: string | null
  name: string
  department: string
  paper_title: string
  journal: string
  voucher: string | null
  amount: number
  authorised_on: string | null
  paid_on: string | null
}

type Issue = { ticket: string | null; claim_id: string; ledger: number; claim: number; problem: string }

type Statement = {
  month: string
  label: string
  college: string
  count: number
  people: number
  total: number
  ledger_total: number
  total_in_words: string
  by_department: { department: string; amount: number; count: number }[]
  rows: Row[]
  reconciliation: {
    app_tickets: number
    matched: number
    imported: { count: number; amount: number }
    reversals: { count: number; amount: number }
    month_not_recorded: number
    issues: Issue[]
    balanced: boolean
  }
}

export type FinancialYear = {
  financial_year: string
  allocation: number | null
  paid: number
  committed: number
  months: { month: string; label: string; amount: number; cumulative: number }[]
}

const SOURCE: Record<Row["source"], string> = {
  app: "Paid here",
  import: "ERP import",
  claim_only: "No ledger row",
}

export function Statements() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports
  const [params, setParams] = useSearchParams()

  const months = useApi<{ months: StatementMonth[] }>(["payouts", "months"], "/api/payouts/months", {
    enabled: allowed,
  })
  const list = months.data?.months ?? []
  const month = params.get("month") || list[0]?.month || ""
  const st = useApi<Statement>(["payouts", "statement", month], `/api/payouts/statement?month=${month}`, {
    enabled: allowed && !!month,
  })
  const fy = useApi<FinancialYear>(["payouts", "fy"], "/api/payouts/financial-year", { enabled: allowed })

  const options = useMemo(
    () => list.map((m) => ({ value: m.month, label: m.label, hint: `${money(m.amount)} · ${m.count}` })),
    [list]
  )

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="Monthly statements show what each person was paid. Finance, the Director and the Principal can read them."
        />
      </div>
    )
  }

  const s = st.data
  const pick = (m: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("month", m)
      return next
    })

  return (
    <div className="page space-y-8">
      <PrintStamp title="Monthly payout statement" scope={s?.label ?? ""} />
      <header className="page-head flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <PageTitle>Monthly statements</PageTitle>
          <Sub className="mt-1">
            One payout month: what went out, to whom, whether it agrees with the ledger, and the
            papers to sign and send to the bank.
          </Sub>
        </div>
        <div className="block print:hidden">
          <ColumnLabel className="mb-1 block">Payout month</ColumnLabel>
          <Combobox
            value={month}
            onChange={(v) => v && pick(v)}
            options={options}
            placeholder={months.isLoading ? "Loading…" : "Choose a month"}
            aria-label="Payout month"
            className="w-56 max-w-full"
          />
        </div>
      </header>

      {fy.data && <BudgetBurn fy={fy.data} />}

      {months.isError ? (
        <ErrorState title="Could not load the months" message="Try again in a moment." />
      ) : !months.isLoading && list.length === 0 ? (
        <EmptyState
          illustration="empty-no-payouts"
          title="Nothing paid yet"
          message="A month appears here once its first payment is on the ledger. Payments are made under Payments."
        />
      ) : !s ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          <section className="space-y-4" aria-label={`Statement for ${s.label}`}>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <p className="tabular font-serif text-4xl">{money(s.total)}</p>
              <Meta>
                paid in {s.label}, {s.count.toLocaleString("en-IN")} {s.count === 1 ? "payment" : "payments"} to{" "}
                {s.people.toLocaleString("en-IN")} {s.people === 1 ? "person" : "people"}
              </Meta>
            </div>
            <p className="text-sm text-fg-muted">{s.total_in_words}</p>
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button kind="primary" size="md" asChild>
                <a href={`/api/payouts/statement.pdf?month=${s.month}`} download>
                  <FileText />
                  Statement to sign (PDF)
                </a>
              </Button>
              {(me?.role === "FINANCE" || me?.role === "SUPER_ADMIN") && (
                <Button kind="default" size="md" asChild>
                  <a href={`/api/payouts/statement.csv?month=${s.month}`} download>
                    <Download />
                    Bank and accounts file (CSV)
                  </a>
                </Button>
              )}
              <Button kind="quiet" size="md" asChild>
                <Link to={`/ledger?month=${s.month}`}>Open in the ledger</Link>
              </Button>
            </div>
            <p className="text-sm text-fg-muted">
              The bank file leaves account number and IFSC for Accounts to fill from the payroll
              master; this app does not hold bank details. Tax is deducted through payroll.
            </p>
          </section>

          <Reconciliation s={s} />

          <section className="space-y-3">
            <SectionTitle>By department</SectionTitle>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-3 sm:grid-cols-2">
              {s.by_department.map((d) => (
                <li key={d.department} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{d.department}</span>
                    <span className="tabular">{money(d.amount)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-hover">
                    <div
                      className="h-1.5 rounded-full bg-accent"
                      style={{ width: `${s.total > 0 ? Math.max(2, (d.amount / s.total) * 100) : 0}%` }}
                    />
                  </div>
                  <Meta>
                    {d.count} {d.count === 1 ? "payment" : "payments"}
                  </Meta>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3">
            <SectionTitle>Every payment in {s.label}</SectionTitle>
            <ul className="space-y-2 md:hidden">
              {s.rows.map((r, i) => (
                <li key={r.ledger_id ?? r.claim_id ?? i} className="rounded-lg p-3 ring-1 ring-inset ring-edge">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 break-words">{r.name}</span>
                    <span className={cn("tabular shrink-0", r.amount < 0 && "text-critical")}>{money(r.amount)}</span>
                  </div>
                  <Meta className="block">
                    {r.staff_id || "No staff id"} · {r.department} · {r.voucher || "No voucher"}
                  </Meta>
                  <div className="mt-1 line-clamp-2 text-sm">{r.paper_title || "Title not recorded"}</div>
                  <Chip tone={r.source === "claim_only" ? "caution" : "neutral"}>{SOURCE[r.source]}</Chip>
                </li>
              ))}
              <li className="flex justify-between px-3 font-semibold">
                <span>Total</span>
                <span className="tabular">{money(s.total)}</span>
              </li>
            </ul>
            <div tabIndex={0} role="region" aria-label="Statement" className="hidden overflow-x-auto rounded-xl ring-1 ring-edge md:block">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-hover/60 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium text-fg-muted">Paid to</th>
                    <th className="px-3 py-2 font-medium text-fg-muted">Paper</th>
                    <th className="px-3 py-2 font-medium text-fg-muted">Voucher</th>
                    <th className="px-3 py-2 font-medium text-fg-muted">From</th>
                    <th className="px-3 py-2 text-right font-medium text-fg-muted">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r, i) => (
                    <tr key={r.ledger_id ?? r.claim_id ?? i} className="border-t border-line align-top">
                      <td className="px-3 py-2">
                        <div>{r.name}</div>
                        <Meta>
                          {r.staff_id || "No staff id"} · {r.department}
                        </Meta>
                      </td>
                      <td className="px-3 py-2">
                        <div className="line-clamp-2">{r.paper_title || "Title not recorded"}</div>
                        {r.ticket && (
                          <Meta>
                            {r.ticket}
                            {r.authorised_on ? ` · authorised ${fmtDate(r.authorised_on)}` : ""}
                          </Meta>
                        )}
                      </td>
                      <td className="px-3 py-2 text-fg-muted">{r.voucher || "None"}</td>
                      <td className="px-3 py-2">
                        <Chip tone={r.source === "claim_only" ? "caution" : "neutral"}>{SOURCE[r.source]}</Chip>
                      </td>
                      <td className={cn("tabular px-3 py-2 text-right", r.amount < 0 && "text-critical")}>
                        {money(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-fg/30 font-semibold">
                    <td className="px-3 py-2" colSpan={4}>
                      Total
                    </td>
                    <td className="tabular px-3 py-2 text-right">{money(s.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function Reconciliation({ s }: { s: Statement }) {
  const r = s.reconciliation
  const agrees = Math.abs(s.total - s.ledger_total) < 0.5
  return (
    <section className="space-y-3">
      <SectionTitle>Against the ledger</SectionTitle>
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Tickets paid here" value={`${r.matched} of ${r.app_tickets} match`} note="Same amount on the ticket and its ledger row" />
        <Fact label="From the ERP import" value={money(r.imported.amount)} note={`${r.imported.count} rows with no ticket in this app`} />
        <Fact label="Reversals" value={money(r.reversals.amount)} note={`${r.reversals.count} voided payments, netted in the total`} />
        <Fact label="Ledger total" value={money(s.ledger_total)} note={agrees ? "Agrees with this statement" : "Differs from this statement"} />
      </dl>
      {r.balanced ? (
        <p className="flex items-center gap-2 text-sm text-positive">
          <CheckCircle2 className="size-4" aria-hidden />
          Every ticket paid in {s.label} has one ledger row for the same amount.
        </p>
      ) : (
        <div className="space-y-2 rounded-xl bg-caution-wash p-4">
          <p className="font-medium">
            {r.issues.length} {r.issues.length === 1 ? "line needs" : "lines need"} explaining before this month is signed
          </p>
          <ul className="space-y-1 text-sm">
            {r.issues.map((i) => (
              <li key={i.claim_id} className="flex flex-wrap justify-between gap-x-4">
                <span>
                  {i.ticket || "Ticket"}: {i.problem}
                </span>
                <span className="tabular text-fg-muted">
                  ticket {money(i.claim)} · ledger {money(i.ledger)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-fg-muted">A super admin corrects the ledger; Finance cannot undo a payment.</p>
        </div>
      )}
    </section>
  )
}

function Fact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 border-t border-line pt-3">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="tabular mt-1 text-xl">{value}</dd>
      <dd className="text-sm text-fg-muted">{note}</dd>
    </div>
  )
}

/**
 * Month by month spend for the financial year against the college allocation:
 * bars for each month's payments, a line for the running total, and the
 * allocation as a ceiling. Drawn in SVG, scaled to its box.
 */
export function BudgetBurn({ fy }: { fy: FinancialYear }) {
  const W = 720
  const H = 200
  const pad = { l: 8, r: 8, t: 14, b: 26 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const alloc = fy.allocation ?? 0
  const top = Math.max(alloc, fy.paid + fy.committed, ...fy.months.map((m) => m.cumulative), 1)
  const y = (v: number) => pad.t + ih - (v / top) * ih
  const step = iw / fy.months.length
  const today = new Date().toISOString().slice(0, 7)
  const line = fy.months
    .filter((m) => m.month <= today)
    .map((m, i) => `${i ? "L" : "M"}${pad.l + step * i + step / 2},${y(m.cumulative)}`)
    .join(" ")
  const left = alloc - fy.paid - fy.committed
  return (
    <section className="space-y-3" aria-label={`Budget against spend, FY ${fy.financial_year}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>FY {fy.financial_year}: spend against the budget</SectionTitle>
        <Meta>
          {fy.allocation != null
            ? `${money(fy.paid)} paid and ${money(fy.committed)} committed of ${money(alloc)}; ${
                left >= 0 ? `${money(left)} left` : `${money(-left)} over`
              }`
            : `${money(fy.paid)} paid; no college allocation set for this year`}
        </Meta>
      </div>
      <div tabIndex={0} role="region" aria-label="Months" className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[36rem]" role="img"
        aria-label={`Paid each month from April; running total ${money(fy.paid)}${fy.allocation != null ? ` against ${money(alloc)}` : ""}.`}>
        {fy.allocation != null && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(alloc)} y2={y(alloc)} stroke="var(--color-critical)" strokeDasharray="4 4" />
            <text x={W - pad.r} y={y(alloc) - 4} textAnchor="end" className="fill-fg-muted text-[11px]">
              Allocation {money(alloc)}
            </text>
          </g>
        )}
        {fy.months.map((m, i) => (
          <g key={m.month}>
            <rect
              x={pad.l + step * i + step * 0.2}
              y={y(m.amount)}
              width={step * 0.6}
              height={Math.max(0, pad.t + ih - y(m.amount))}
              rx={2}
              fill="var(--color-accent)"
              opacity={0.55}
            >
              <title>{`${m.label}: ${money(m.amount)} paid, ${money(m.cumulative)} so far`}</title>
            </rect>
            <text x={pad.l + step * i + step / 2} y={H - 8} textAnchor="middle" className="fill-fg-muted text-[11px]">
              {m.label}
            </text>
          </g>
        ))}
        <path d={line} fill="none" stroke="var(--color-fg)" strokeWidth={1.5} />
      </svg>
      </div>
      <Meta>Bars: paid that month. Line: paid so far this year.</Meta>
    </section>
  )
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
