import { Link } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { pagesFor, type NavItem } from "@/app/nav"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { isPayableTotals, payableKey, payablePath, useBudgetNow, type PayoutsPage } from "@/pages/pay-parts"
import type { FinancialYear, StatementMonth } from "@/pages/statements"
import { BudgetStrip } from "@/pages/budget-strip"
import { AnswerLine, AnswerWord, tieNumbers } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Section } from "@/ui/section"
import { NotOpen } from "@/ui/state"
import { Meta } from "@/ui/text"

/**
 * Money, for the two people who handle it.
 *
 * The shared hub is a list of pages with a sentence each. The Director and
 * Finance come here with a question ("where do we stand, and where is the
 * paper for the month?"), so it answers it first with the year's position, and
 * then lists the pages with a live line under each (what is left, what is
 * ready, which month is newest) so a row says what is behind it before it is
 * opened. Pages come from the same catalogue as the sidebar and Ctrl K.
 */

const GROUPS: Record<"DIRECTOR" | "FINANCE", { title: string; items: string[] }[]> = {
  DIRECTOR: [
    { title: "Your desk", items: ["/authorisations"] },
    { title: "The month and the year", items: ["/statements", "/budget", "/ledger"] },
    { title: "The rules", items: ["/policy", "/calculator"] },
  ],
  FINANCE: [
    { title: "Your desk", items: ["/payments", "/payments/done"] },
    { title: "The month and the year", items: ["/statements", "/ledger", "/budget"] },
    { title: "The rules", items: ["/policy", "/calculator"] },
  ],
}

export function MoneyDesk({ role }: { role: "DIRECTOR" | "FINANCE" }) {
  const { me } = useAuth()
  const fy = useApi<FinancialYear>(["payouts", "fy"], "/api/payouts/financial-year")
  const months = useApi<{ months: StatementMonth[] }>(["payouts", "months"], "/api/payouts/months")
  const budget = useBudgetNow()
  const payable = useApi<PayoutsPage>(payableKey(0), payablePath(0), { enabled: role === "FINANCE" })
  const dirQueue = useApi<{ total: number; totals: { amount: number } }>(
    HOME_DATA.directorQueue.key,
    HOME_DATA.directorQueue.path,
    { enabled: role === "DIRECTOR" }
  )

  const mine = new Map(pagesFor(me?.role ?? role).map((p) => [p.to, p]))
  const newest = months.data?.months.find((m) => m.count > 0)
  const remaining = budget.data?.college.remaining ?? null
  const allocated = budget.data?.college.allocated ?? null
  const over = remaining != null && remaining < 0

  const totals = payable.data && isPayableTotals(payable.data.totals) ? payable.data.totals : null

  /** The live line under a row. Nothing when there is nothing true to say. */
  function note(to: string): string | null {
    switch (to) {
      case "/budget":
        return budget.data
          ? remaining == null
            ? `No allocation is set for ${budget.data.financial_year}`
            : `${money(Math.abs(remaining))} ${over ? "over" : "left"}${allocated != null ? ` of ${money(allocated)}` : ""} for ${budget.data.financial_year}`
          : null
      case "/ledger":
        return fy.data ? `${money(fy.data.paid)} paid in FY ${fy.data.financial_year}` : null
      case "/statements":
        return newest ? `Newest: ${newest.label}, ${money(newest.amount)} in ${formatCount(newest.count)} payments` : null
      case "/payments":
        return totals ? `${formatCount(totals.ready_count)} ready to pay, ${money(totals.ready_amount)}` : null
      case "/authorisations":
        return dirQueue.data
          ? dirQueue.data.total > 0
            ? `${formatCount(dirQueue.data.total)} waiting, ${money(dirQueue.data.totals.amount)}`
            : "Nothing is waiting"
          : null
      default:
        return null
    }
  }

  if (!me || !GROUPS[role]) {
    return (
      <div className="page py-8">
        <NotOpen message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  return (
    <div className="page space-y-12">
      <PageHeader title="Money" spot="spot-budget" />

      <div className="space-y-5">
        <AnswerLine>
          {!budget.data ? (
            "Where the year stands."
          ) : remaining == null ? (
            `No budget is set for ${budget.data.financial_year}.`
          ) : over ? (
            <>
              The {budget.data.financial_year} budget is <AnswerWord tone="crimson">{money(Math.abs(remaining))} over</AnswerWord>.
            </>
          ) : (
            <>
              {tieNumbers(`${money(remaining)} is`)} <AnswerWord tone="sage">left</AnswerWord> in the {budget.data.financial_year} budget.
            </>
          )}
        </AnswerLine>
        {budget.data && (
          <div className="max-w-2xl">
            <BudgetStrip budget={budget.data.college} batch={0} labels="wide" />
          </div>
        )}
      </div>

      {GROUPS[role].map((g) => {
        const items = g.items.map((to) => mine.get(to)).filter((p): p is NavItem => !!p)
        if (items.length === 0) return null
        return (
          <Section key={g.title} title={g.title}>
            <ul className="divide-y divide-line">
              {items.map((item) => {
                const Icon = item.icon
                const line = note(item.to)
                return (
                  <li key={item.to} className="flex items-center gap-3 py-3">
                    <Link to={item.to} className="row group flex min-w-0 flex-1 items-start gap-3 rounded-control px-1 py-1" title={item.purpose}>
                      <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-medium">{item.label}</span>
                        {line && <Meta className="mt-0.5 block text-fg">{line}</Meta>}
                      </span>
                    </Link>
                    <Button kind="default" size="sm" asChild>
                      <Link to={item.to} tabIndex={-1} aria-hidden>
                        Open
                      </Link>
                    </Button>
                  </li>
                )
              })}
            </ul>
          </Section>
        )
      })}
    </div>
  )
}
