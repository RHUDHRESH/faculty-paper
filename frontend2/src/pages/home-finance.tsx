import { useState } from "react"
import { Link } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { BudgetStrip, budgetLine } from "@/pages/budget-strip"
import { ComingUpEvents } from "@/pages/home-events"
import { greeting, YourPapers } from "@/pages/home-staff"
import { MonthPaperwork } from "@/pages/month-paperwork"
import { MoneyThread } from "@/pages/money-thread"
import { BulkPayDialog, SinglePayDialog } from "@/pages/pay-dialogs"
import {
  AmountCell,
  isPayable,
  isPayableTotals,
  payableKey,
  payablePath,
  payableTotalsOf,
  PAYABLE_LIMIT,
  useBudgetNow,
  waitingLabel,
  type PayableTotals,
  type PayoutClaim,
  type PayoutsPage,
} from "@/pages/pay-parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { waitTone } from "@/ui/queue"
import { Section } from "@/ui/section"
import { InlineError, Skeleton } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"

/**
 * Finance's first screen (docs/ux/28): what to pay today, and what this
 * month still needs.
 *
 * Three figures (ready to pay, what they come to, held up) answer it; the
 * line under them says what paying does to the year's budget. The one primary
 * button opens the whole run in place (a dialog, not a trip to Payments); the
 * table lists the claims next to pay, each with its own Pay. The stage counts
 * show where every claim is, with "Your desk" at Authorised, and the month's
 * paper (bank file released or not, statement to sign, agrees with the ledger)
 * is one row.
 *
 * Every figure is the one the screen it leads to shows, from the same request,
 * so the Home never disagrees with Payments. It says nothing about flags:
 * Finance is contest-blind (`core.visibility`).
 */
export function FinanceHome() {
  const { me } = useAuth()
  const payable = useApi<PayoutsPage>(payableKey(0), payablePath(0))
  const budget = useBudgetNow()
  const [run, setRun] = useState(false)
  const [payId, setPayId] = useState<string | null>(null)

  const rows = payable.data?.results ?? []
  const totals: PayableTotals | null = payable.data
    ? isPayableTotals(payable.data.totals)
      ? payable.data.totals
      : payableTotalsOf(rows)
    : null
  const ready = rows.filter(isPayable).sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))
  const n = totals?.ready_count ?? 0
  const allFetched = !!payable.data && payable.data.results.length >= payable.data.total
  const payClaim = payId ? (rows.find((c) => c.id === payId) ?? null) : null

  const columns: Column<PayoutClaim>[] = [
    {
      key: "paper",
      header: "Claim",
      exportValue: (c) => paperTitle(c.paper_title),
      cell: (c) => (
        <Link to={`/papers/${c.id}`} className="font-medium text-fg underline-offset-4 hover:underline">
          {paperTitle(c.paper_title)}
        </Link>
      ),
    },
    {
      key: "owner",
      header: "Claimant",
      exportValue: (c) => [c.owner_name, c.owner_department].filter(Boolean).join(", "),
      cell: (c) => [c.owner_name, c.owner_department].filter(Boolean).join(", "),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      exportKind: "money",
      exportValue: (c) => c.remuneration ?? null,
      cell: (c) => <AmountCell c={c} />,
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      exportValue: (c) => c.waiting_days ?? null,
      cell: (c) => <span className={cn(waitTone(c.waiting_days) && "text-caution")}>{waitingLabel(c.waiting_days)}</span>,
    },
    {
      key: "action",
      header: "Action",
      label: "Pay",
      cell: (c) => (
        <Button size="sm" onClick={() => setPayId(c.id)} aria-label={`Pay: ${paperTitle(c.paper_title)}`}>
          Pay
        </Button>
      ),
    },
  ]

  return (
    <div className="page space-y-8">
      <PageHeader
        title={greeting(me?.name, me?.placeholder)}
        sub="The claims the Director authorised, ready for you to pay."
        action={
          totals && n > 0 ? (
            allFetched ? (
              <Button kind="primary" onClick={() => setRun(true)}>
                Pay all {formatCount(n)} · {money(totals.ready_amount)}
              </Button>
            ) : (
              <Button kind="primary" asChild>
                <Link to="/payments">
                  Pay {formatCount(n)} {n === 1 ? "claim" : "claims"} · {money(totals.ready_amount)}
                </Link>
              </Button>
            )
          ) : undefined
        }
      />

      {payable.isError ? (
        <InlineError message="Could not load the payable queue." onRetry={() => void payable.refetch()} />
      ) : (
        <>
          <Answer
            items={[
              { value: totals ? n : undefined, label: "Ready to pay", zero: "Nothing is ready to pay", to: "/payments" },
              { value: totals ? money(totals.ready_amount) : undefined, label: "Amount ready", to: "/payments" },
              {
                value: totals?.held_count,
                label: "Authorised but held up",
                zero: "Nothing is held up",
                to: "/payments#held",
                tone: "caution",
              },
            ]}
          />

          {n > 0 && (
            <div className="max-w-2xl space-y-3">
              <p className="text-sm text-fg-muted" data-testid="paying-means">
                {budgetLine(budget.data, "paying", n !== 1) ?? " "}
              </p>
              <BudgetStrip budget={budget.data?.college} batch={totals?.ready_amount ?? 0} batchLabel="This run" labels="wide" />
              {totals && totals.held_back_count > 0 && (
                <p className="text-sm text-fg-muted">
                  The research threshold holds back {money(totals.held_back)} on {formatCount(totals.held_back_count)}{" "}
                  {totals.held_back_count === 1 ? "claim" : "claims"}; each shows it beside its amount.
                </p>
              )}
            </div>
          )}

          <Section
            title="Next to pay"
            action={
              <Link to="/payments" className="text-sm text-accent underline-offset-4 hover:underline">
                {totals && totals.count > 0 ? `View all ${formatCount(totals.count)} in Payments` : "View all in Payments"}
              </Link>
            }
          >
            {!payable.data ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <Table
                rows={ready.slice(0, 10)}
                columns={columns}
                getKey={(c) => c.id}
                tools={{ id: "finance-home", title: "Next to pay" }}
                empty={
                  <div className="space-y-4 py-4">
                    <p className="text-base text-fg-muted">A claim appears here the moment the Director authorises it.</p>
                    <ComingUp desk="finance" align="start" />
                  </div>
                }
              />
            )}
            {totals && totals.held_count > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-fg-muted">
                <span>
                  {formatCount(totals.held_count)} authorised {totals.held_count === 1 ? "claim is" : "claims are"} held up
                  and cannot be paid yet.
                </span>
                <Button kind="default" size="sm" asChild>
                  <Link to="/payments#held">See why</Link>
                </Button>
              </div>
            )}
            {payable.data && payable.data.total > PAYABLE_LIMIT && (
              <Meta className="mt-2 block">The list shows the first {PAYABLE_LIMIT}; the figures above cover all of them.</Meta>
            )}
          </Section>
        </>
      )}

      <Section title="Where every claim is">
        <MoneyThread />
      </Section>

      <MonthPaperwork title="This month's paper" />

      <ComingUpEvents />

      <YourPapers />

      {payClaim && (
        <SinglePayDialog
          claim={payClaim}
          open={!!payId}
          onOpenChange={(o) => !o && setPayId(null)}
          onPaid={() => void payable.refetch()}
        />
      )}
      <BulkPayDialog open={run} onOpenChange={setRun} rows={ready} onDone={() => void payable.refetch()} />
    </div>
  )
}
