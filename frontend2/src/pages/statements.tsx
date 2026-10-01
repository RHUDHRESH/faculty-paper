import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CheckCircle2, Download, FileText } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { ErpLegend } from "@/pages/pay-parts"
import { PrintStamp } from "@/pages/reports-print"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Combobox } from "@/ui/combobox"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Details, Section } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { ColumnLabel, Meta, SectionTitle } from "@/ui/text"
import { unshout } from "@/lib/names"

/**
 * One payment month, as the Director signs it and Finance reconciles it.
 *
 * Every figure is the server's, read from the payments ledger
 * (`core/services/payout_statement.py`), so this page, the Ledger and Reports
 * agree about a month by construction. Nothing on it is a flag: the Director
 * and Finance are never shown one.
 *
 * The list is the payments. Claims the old ERP closed at ₹0 (there can be
 * eighty of them in the month an import landed) are counted and one click
 * away, not printed between the payments a signer has to read.
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
  held_back?: number
}

type Issue = { ticket: string | null; claim_id: string; ledger: number; claim: number; problem: string }

export type Statement = {
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
  import: "From the old ERP",
  claim_only: "No ledger row",
}

export function Statements() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports
  const isFinance = me?.role === "FINANCE" || me?.role === "SUPER_ADMIN"
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

  const paidRows = s ? s.rows.filter((r) => Math.abs(r.amount) > 0.005) : []
  const zeroRows = s ? s.rows.filter((r) => Math.abs(r.amount) <= 0.005) : []
  const departments = s ? s.by_department.filter((d) => Math.abs(d.amount) > 0.005) : []
  const zeroDepartments = s ? s.by_department.length - departments.length : 0
  const agrees = s ? Math.abs(s.total - s.ledger_total) < 0.5 && s.reconciliation.balanced : false
  const toExplain = s ? s.reconciliation.issues.length + (s && Math.abs(s.total - s.ledger_total) >= 0.5 ? 1 : 0) : 0

  const columns: Column<Row>[] = [
    {
      key: "who",
      header: "Paid to",
      className: "w-64",
      cell: (r) => (
        <div>
          <span className="block">{r.name}</span>
          <Meta className="block">{[r.staff_id, r.department].filter(Boolean).join(" · ") || "Staff id not recorded"}</Meta>
        </div>
      ),
    },
    {
      key: "paper",
      header: "Paper",
      cell: (r) => (
        <div className="min-w-0">
          {r.claim_id ? (
            <Link to={`/papers/${r.claim_id}`} className="line-clamp-2 underline-offset-4 hover:underline">
              {unshout(r.paper_title) || "Title not recorded"}
            </Link>
          ) : (
            <span className="line-clamp-2">{unshout(r.paper_title) || "Title not recorded"}</span>
          )}
          {r.ticket && (
            <Meta className="block">
              {r.ticket}
              {r.authorised_on ? ` · authorised ${fmtDate(r.authorised_on)}` : ""}
            </Meta>
          )}
        </div>
      ),
    },
    { key: "voucher", header: "Voucher", className: "w-36 break-all", empty: "None", cell: (r) => r.voucher },
    {
      key: "source",
      header: "Where it was recorded",
      className: "w-40",
      cell: (r) => <Chip tone={r.source === "claim_only" ? "caution" : "neutral"}>{SOURCE[r.source]}</Chip>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      className: "w-52",
      cell: (r) => (
        <div className={cn(r.amount < 0 && "text-critical")}>
          <span>{money(r.amount)}</span>
          {(r.held_back ?? 0) > 0.005 && (
            <Meta className="block">{money(r.held_back)} held back by the research threshold</Meta>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="page space-y-10">
      <PrintStamp title="Monthly payment statement" scope={s?.label ?? ""} />
      <PageHeader
        title="Monthly statements"
        sub={
          isFinance
            ? "Does this month's statement agree with the ledger, and is it ready to sign and send to the bank?"
            : "Does this month's statement agree with the ledger, and is it ready to sign?"
        }
        action={
          <div className="print:hidden">
            <ColumnLabel className="mb-1 block">Month paid</ColumnLabel>
            <Combobox
              value={month}
              onChange={(v) => v && pick(v)}
              options={options}
              placeholder={months.isLoading ? "Loading…" : "Choose a month"}
              aria-label="Month paid"
              className="w-56 max-w-full"
            />
          </div>
        }
        spot="spot-payouts"
      />

      {months.isError ? (
        <ErrorState what="the months" message="The server did not answer. No payment has been changed." onRetry={() => void months.refetch()} />
      ) : !months.isLoading && list.length === 0 ? (
        <EmptyState
          illustration="empty-no-payouts"
          title="Nothing paid yet"
          message="A month appears here once its first payment is on the ledger. Payments are made under Payments."
          action={
            isFinance ? (
              <Button kind="default" size="sm" asChild>
                <Link to="/payments">Go to payments</Link>
              </Button>
            ) : undefined
          }
        />
      ) : st.isError ? (
        <ErrorState
          what="this statement"
          message="The server did not answer. Nothing has been changed."
          onRetry={() => void st.refetch()}
        />
      ) : !s ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          <section className="space-y-4" aria-label={`Statement for ${s.label}`}>
            <Answer
              items={[
                { label: `Paid in ${s.label}`, value: money(s.total), to: `/ledger?month=${s.month}` },
                { label: s.count === 1 ? "Payment" : "Payments", value: s.count, zero: "No payments this month" },
                { label: s.people === 1 ? "Person paid" : "People paid", value: s.people, zero: "Nobody was paid" },
                {
                  label: agrees ? "Agrees with the ledger" : toExplain === 1 ? "Line to explain before signing" : "Lines to explain before signing",
                  value: agrees ? "Yes" : toExplain,
                  tone: agrees ? "positive" : "caution",
                  to: agrees ? undefined : "#ledger-check",
                },
              ]}
            />
            <p className="text-sm text-fg-muted">{s.total_in_words}</p>
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button kind="primary" size="md" asChild>
                <a href={`/api/payouts/statement.pdf?month=${s.month}`} download>
                  <FileText />
                  Statement to sign (PDF)
                </a>
              </Button>
              {isFinance && (
                <Button kind="default" size="md" asChild>
                  <a href={`/api/payouts/statement.csv?month=${s.month}`} download>
                    <Download />
                    Bank file (CSV)
                  </a>
                </Button>
              )}
              <Button kind="quiet" size="md" asChild>
                <Link to={`/ledger?month=${s.month}`}>Open in the ledger</Link>
              </Button>
            </div>
            {isFinance && (
              <p className="max-w-prose text-sm text-fg-muted">
                The bank file has {formatCount(s.count)} {s.count === 1 ? "row" : "rows"} adding to {money(s.total)},
                the same as this statement. Account number and IFSC are left empty for Accounts to fill from the
                payroll master; this app holds no bank details. Tax is deducted through payroll.
              </p>
            )}
          </section>

          <Section id="ledger-check" title="Against the ledger" className="scroll-mt-4">
            <dl className="divide-y divide-line text-sm">
              <Fact
                label="Claims paid here"
                value={`${formatCount(s.reconciliation.matched)} of ${formatCount(s.reconciliation.app_tickets)} have one ledger row for the same amount`}
              />
              <Fact
                label="From the old ERP"
                value={`${money(s.reconciliation.imported.amount)} in ${formatCount(s.reconciliation.imported.count)} ${s.reconciliation.imported.count === 1 ? "row" : "rows"} with no claim in this app`}
              />
              <Fact
                label="Reversed"
                value={`${money(s.reconciliation.reversals.amount)} in ${formatCount(s.reconciliation.reversals.count)} voided ${s.reconciliation.reversals.count === 1 ? "payment" : "payments"}, netted in the total`}
              />
              <Fact
                label="Ledger total"
                value={`${money(s.ledger_total)}. ${Math.abs(s.total - s.ledger_total) < 0.5 ? "Agrees with this statement." : "Differs from this statement."}`}
              />
            </dl>
            {s.reconciliation.month_not_recorded > 0 && (
              <p className="mt-3 max-w-prose text-sm text-fg-muted">
                {formatCount(s.reconciliation.month_not_recorded)} of these came from the old ERP without a month, so they
                sit in the month they were imported.
              </p>
            )}
            {s.reconciliation.balanced ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-positive">
                <CheckCircle2 className="size-4" aria-hidden />
                Every claim paid in {s.label} has one ledger row for the same amount.
              </p>
            ) : (
              <div className="mt-3 space-y-2 rounded-panel bg-caution-wash p-4">
                <p className="font-medium">
                  {formatCount(s.reconciliation.issues.length)}{" "}
                  {s.reconciliation.issues.length === 1 ? "line needs" : "lines need"} explaining before this month is
                  signed
                </p>
                <ul className="space-y-1 text-sm">
                  {s.reconciliation.issues.map((i) => (
                    <li key={i.claim_id} className="flex flex-wrap justify-between gap-x-4">
                      <span>
                        <Link to={`/papers/${i.claim_id}`} className="underline underline-offset-4">
                          {i.ticket || "Claim"}
                        </Link>
                        : {i.problem}
                      </span>
                      <span className="tabular text-fg-muted">
                        claim {money(i.claim)} · ledger {money(i.ledger)}
                      </span>
                    </li>
                  ))}
                </ul>
                {me?.role === "SUPER_ADMIN" ? (
                  <p className="text-sm text-fg-muted">
                    <Link to="/ledger?problem=no-ledger" className="underline underline-offset-4">
                      Open the ledger checks
                    </Link>{" "}
                    to add the missing ledger row or link a payment to its claim.
                  </p>
                ) : (
                  <p className="text-sm text-fg-muted">
                    A super admin corrects the ledger; Finance cannot undo a payment. Ask them, naming the claim number.
                  </p>
                )}
              </div>
            )}
          </Section>

          {departments.length > 0 && (
            <Section title="By department">
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-3 sm:grid-cols-2">
                {departments.map((d) => (
                  <li key={d.department} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate">{d.department}</span>
                      <span className="tabular">{money(d.amount)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-hover" aria-hidden>
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
              {zeroDepartments > 0 && (
                <Meta className="mt-3 block">
                  {formatCount(zeroDepartments)} more {zeroDepartments === 1 ? "department has" : "departments have"} only
                  claims closed at ₹0.
                </Meta>
              )}
            </Section>
          )}

          <Section title={`Every payment in ${s.label}`}>
            <Table
              rows={paidRows}
              columns={columns}
              getKey={(r) => r.ledger_id ?? r.claim_id ?? `${r.ticket}-${r.name}`}
              minWidth="60rem"
              caption={`Payments made in ${s.label}`}
              maxHeight="none"
              empty={{
                title: "No money was paid this month",
                message: "Claims closed at ₹0 are listed below, and are not in the bank file.",
              }}
            />
            <div className="mt-2 flex justify-between gap-4 px-3 font-semibold">
              <span>Total</span>
              <span className="tabular">{money(s.total)}</span>
            </div>
            <div className="mt-2">
              <ErpLegend rows={s.rows.map((r) => ({ ticket_number: r.ticket }))} />
            </div>
            {zeroRows.length > 0 && (
              <Details
                count={zeroRows.length}
                label="claims closed at ₹0"
                className="mt-4"
              >
                <ul className="max-h-96 divide-y divide-line overflow-auto rounded-panel ring-1 ring-inset ring-edge">
                  {zeroRows.map((r, i) => (
                    <li key={r.ledger_id ?? r.claim_id ?? i} className="flex flex-wrap justify-between gap-x-4 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 basis-64">
                        {r.name}: {unshout(r.paper_title) || "Title not recorded"}
                      </span>
                      <Meta>{r.ticket || "No claim number"}</Meta>
                    </li>
                  ))}
                </ul>
              </Details>
            )}
          </Section>

          {fy.data && (
            <div className="space-y-3">
              <p className="text-sm text-fg-muted">
                For FY {fy.data.financial_year}, {money(fy.data.paid)} is paid
                {fy.data.allocation != null ? ` of ${money(fy.data.allocation)} allocated` : "; no allocation is set"}.{" "}
                <Link to="/budget" className="text-accent underline-offset-4 hover:underline">
                  See the budget
                </Link>
              </p>
              <Details label="the year's spending against the budget">
                <BudgetBurn fy={fy.data} />
              </Details>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2.5">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="tabular max-w-prose text-right">{value}</dd>
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
