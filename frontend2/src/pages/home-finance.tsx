import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { BudgetStrip, budgetLine, claimsWord } from "@/pages/budget-strip"
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
import { AnswerLine, AnswerWord, tieNumbers } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { waitTone } from "@/ui/queue"
import { Section } from "@/ui/section"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta } from "@/ui/text"

/**
 * Finance's first screen (docs/ux/28): what to pay today, and what this
 * month still needs.
 *
 * One sentence says how many claims are ready and what they come to; the line
 * under it, and the strip beneath, say what paying them does to the year's
 * budget. The one primary button opens the whole run in place (a dialog, not
 * a trip to Payments); each row has its own Pay. The Thread shows where every
 * claim is, with "Your desk" at Authorised, and the month's paper (bank file
 * released or not, statement to sign, agrees with the ledger) is one row.
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

  return (
    <div className="page space-y-14">
      <PageHeader
        title={greeting(me?.name, me?.placeholder)}
        action={
          totals && n > 0 ? (
            allFetched ? (
              <Button kind="primary" size="lg" onClick={() => setRun(true)}>
                Pay all {formatCount(n)} · {money(totals.ready_amount)}
              </Button>
            ) : (
              <Button kind="primary" size="lg" asChild>
                <Link to="/payments">
                  Pay {formatCount(n)} {n === 1 ? "claim" : "claims"} · {money(totals.ready_amount)}
                </Link>
              </Button>
            )
          ) : undefined
        }
        spot="spot-payouts"
      />

      {payable.isError ? (
        <InlineError message="Could not load the payable queue." onRetry={() => void payable.refetch()} />
      ) : (
        <>
          <div className="space-y-5">
            <AnswerLine>
              {!totals ? (
                "What to pay today."
              ) : n === 0 ? (
                tieNumbers(
                  totals.held_count > 0
                    ? `Nothing is ready to pay. ${claimsWord(totals.held_count)} ${totals.held_count === 1 ? "is" : "are"} held up.`
                    : "Nothing is ready to pay."
                )
              ) : (
                <>
                  {tieNumbers(`${claimsWord(n)}, ${money(totals.ready_amount)}, ${n === 1 ? "is" : "are"}`)}{" "}
                  <AnswerWord tone="clay">ready to pay</AnswerWord>.
                </>
              )}
            </AnswerLine>
            {n > 0 && (
              <div className="max-w-2xl space-y-3">
                <p className="text-lead text-fg-muted" data-testid="paying-means">
                  {budgetLine(budget.data, "paying", n !== 1) ?? " "}
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
          </div>

          <Section
            title="Next to pay"
            action={
              <Button kind="default" size="sm" asChild>
                <Link to="/payments">
                  {totals && totals.count > 0 ? `All ${formatCount(totals.count)} in Payments` : "Payments"}
                </Link>
              </Button>
            }
          >
            {!payable.data ? (
              <Skeleton className="h-40 w-full" />
            ) : ready.length === 0 ? (
              <div className="space-y-4">
                <p className="text-base text-fg-muted">A claim appears here the moment the Director authorises it.</p>
                <ComingUp desk="finance" align="start" />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {ready.slice(0, 6).map((c) => (
                  <PayRow key={c.id} c={c} onPay={() => setPayId(c.id)} />
                ))}
              </ul>
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

function PayRow({ c, onPay }: { c: PayoutClaim; onPay: () => void }) {
  const navigate = useNavigate()
  return (
    <li
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return
        navigate(`/papers/${c.id}`)
      }}
      className="flex cursor-pointer items-center gap-3 px-1 py-3 hover:bg-hover sm:gap-4"
    >
      <Avatar
        size="md"
        person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium">{c.owner_name}</span>
          {c.owner_department && <span className="text-fg-muted"> · {c.owner_department}</span>}
        </p>
        <Link to={`/papers/${c.id}`} className="block truncate text-base underline-offset-4 hover:underline">
          {paperTitle(c.paper_title)}
        </Link>
        <div className="sm:hidden">
          <AmountCell c={c} className="text-left" />
        </div>
      </div>
      <div className="hidden w-56 shrink-0 sm:block">
        <AmountCell c={c} />
      </div>
      <span className={cn("hidden w-16 shrink-0 text-right text-sm tabular text-fg-muted sm:block", waitTone(c.waiting_days) && "text-caution")}>
        {waitingLabel(c.waiting_days)}
      </span>
      <Button size="sm" onClick={onPay} aria-label={`Pay: ${paperTitle(c.paper_title)}`}>
        Pay
      </Button>
    </li>
  )
}
