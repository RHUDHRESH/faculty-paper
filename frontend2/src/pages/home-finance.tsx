import { Link } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { greeting, YourPapers } from "@/pages/home-staff"
import { HomeTrack } from "@/pages/home-track"
import { MonthPaperwork } from "@/pages/month-paperwork"
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
import type { StatementMonth } from "@/pages/statements"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Details, Rows, Section } from "@/ui/section"
import { InlineError } from "@/ui/state"
import { Meta } from "@/ui/text"

/**
 * Finance's first screen: what to pay today, and what the month still needs.
 *
 * It answers one question and then gets out of the way. The four figures are
 * the whole payable queue (the server adds them up, not the page in view), the
 * list is the claims that have waited longest with the research threshold
 * beside each amount, and the month's paper (bank file, statement, ledger
 * check) is one row away. Every figure is the one the screen it links to
 * shows, from the same request, so the Home never disagrees with Payments.
 *
 * It says nothing about flags: Finance is contest-blind (`core.visibility`).
 */
export function FinanceHome() {
  const { me } = useAuth()
  const payable = useApi<PayoutsPage>(payableKey(0), payablePath(0))
  const budget = useBudgetNow()
  const months = useApi<{ months: StatementMonth[] }>(["payouts", "months"], "/api/payouts/months")

  const rows = payable.data?.results ?? []
  const totals: PayableTotals | null = payable.data
    ? isPayableTotals(payable.data.totals)
      ? payable.data.totals
      : payableTotalsOf(rows)
    : null
  const ready = rows.filter(isPayable).sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))
  const nowMonth = new Date().toISOString().slice(0, 7)
  const paidThisMonth = months.data?.months.find((m) => m.month === nowMonth)
  const remaining = budget.data?.college.remaining ?? null
  const over = remaining != null && remaining < 0

  return (
    <div className="page space-y-10">
      <PageHeader
        title={greeting(me?.name)}
        sub="What to pay today, and what this month still needs."
        action={
          totals && totals.ready_count > 0 ? (
            <Button kind="primary" size="lg" asChild>
              <Link to="/payments">
                Pay {formatCount(totals.ready_count)} {totals.ready_count === 1 ? "claim" : "claims"} · {money(totals.ready_amount)}
              </Link>
            </Button>
          ) : undefined
        }
        spot="spot-payouts"
      />

      {payable.isError ? (
        <InlineError message="Could not load the payable queue." onRetry={() => void payable.refetch()} />
      ) : (
        <>
          <div className="space-y-3">
            <Answer
              items={[
                {
                  label: "Ready to pay",
                  value: totals ? totals.ready_count : null,
                  zero: "Nothing is ready to pay",
                  to: "/payments#ready",
                },
                { label: "Comes to", value: totals ? money(totals.ready_amount) : null, to: "/payments" },
                {
                  label: "Held up, needs a second approver",
                  value: totals ? totals.held_count : null,
                  zero: "Nothing is held up",
                  tone: "caution",
                  to: totals?.held_count ? "/payments#held" : undefined,
                },
                budget.isError
                  ? { label: "Paid this month", value: paidThisMonth ? money(paidThisMonth.amount) : money(0), to: "/payments/done" }
                  : {
                      label: over ? "Over the budget once these are paid" : "Left in the budget once these are paid",
                      value: !budget.data ? null : remaining == null ? "Not set" : money(Math.abs(remaining)),
                      tone: over ? "critical" : undefined,
                      to: "/budget",
                    },
              ]}
            />
            {totals && totals.held_back_count > 0 && (
              <p className="max-w-prose text-sm text-fg-muted">
                The research threshold holds back {money(totals.held_back)} on {formatCount(totals.held_back_count)}{" "}
                {totals.held_back_count === 1 ? "claim" : "claims"} in this queue. Each shows it beside its amount.
              </p>
            )}
          </div>

          <Section
            title="Next to pay"
            sub={totals && totals.ready_count > ready.length ? `The ${ready.length} that have waited longest.` : undefined}
            action={
              <Link to="/payments" className="text-accent underline-offset-4 hover:underline">
                {totals && totals.count > 0 ? `All ${formatCount(totals.count)} in Payments` : "Payments"}
              </Link>
            }
          >
            {!payable.data ? (
              <div className="h-40 animate-pulse rounded-panel bg-sunken" />
            ) : ready.length === 0 ? (
              <div className="space-y-4">
                <p className="text-base text-fg-muted">
                  Nothing is ready to pay. A claim appears here the moment the Director authorises it.
                </p>
                <ComingUp desk="finance" align="start" />
              </div>
            ) : (
              <Rows>
                {ready.slice(0, 6).map((c) => (
                  <PayRow key={c.id} c={c} />
                ))}
              </Rows>
            )}
            {totals && totals.held_count > 0 && (
              <p className="mt-3 text-sm text-fg-muted">
                {formatCount(totals.held_count)} authorised {totals.held_count === 1 ? "claim is" : "claims are"} held up
                and cannot be paid yet.{" "}
                <Link to="/payments#held" className="text-accent underline-offset-4 hover:underline">
                  See why
                </Link>
              </p>
            )}
            {payable.data && payable.data.total > PAYABLE_LIMIT && (
              <Meta className="mt-2 block">The list shows the first {PAYABLE_LIMIT}; the figures above cover all of them.</Meta>
            )}
          </Section>
        </>
      )}

      <MonthPaperwork title="This month's paper" />

      <Details label="where every claim is" className="border-t border-line pt-6">
        <div className="mt-3">
          <HomeTrack heading="Every claim, by stage" />
        </div>
      </Details>

      <YourPapers />
    </div>
  )
}

function PayRow({ c }: { c: PayoutClaim }) {
  return (
    <li className="flex items-center gap-3 py-3 sm:gap-4">
      <Avatar
        size="md"
        person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
      />
      <div className="min-w-0 flex-1">
        <Link
          to={`/papers/${c.id}`}
          className="block truncate text-base font-medium underline-offset-4 hover:underline"
        >
          {paperTitle(c.paper_title)}
        </Link>
        <Meta className="block truncate">{[c.owner_name, c.owner_department].filter(Boolean).join(" · ")}</Meta>
        <div className="sm:hidden">
          <AmountCell c={c} className="text-left" />
        </div>
      </div>
      <div className="hidden w-56 shrink-0 sm:block">
        <AmountCell c={c} />
      </div>
      <span className="hidden w-16 shrink-0 text-right text-sm tabular text-fg-muted sm:block">
        {waitingLabel(c.waiting_days)}
      </span>
      <Button size="sm" asChild>
        <Link to="/payments" aria-label={`Pay: ${paperTitle(c.paper_title)}`}>
          Pay
        </Link>
      </Button>
    </li>
  )
}
