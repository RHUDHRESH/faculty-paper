import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { pagesFor, type NavItem } from "@/app/nav"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { isPayableTotals, payableKey, payablePath, useBudgetNow, type PayoutsPage } from "@/pages/pay-parts"
import type { FinancialYear, StatementMonth } from "@/pages/statements"
import { Answer } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Rows, Section } from "@/ui/section"
import { ErrorState } from "@/ui/state"
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

const GROUPS: Record<"DIRECTOR" | "FINANCE", { title: string; blurb: string; items: string[] }[]> = {
  DIRECTOR: [
    { title: "Your desk", blurb: "What waits on your signature.", items: ["/authorisations"] },
    { title: "The month and the year", blurb: "Where the money stands, and the papers to sign.", items: ["/statements", "/budget", "/ledger"] },
    { title: "The rules", blurb: "What decides an amount, and a way to check one.", items: ["/policy", "/calculator"] },
  ],
  FINANCE: [
    { title: "Your desk", blurb: "Pay what the Director authorised, and check what has gone out.", items: ["/payments", "/payments/done"] },
    { title: "The month and the year", blurb: "The bank file, the ledger check, and the budget.", items: ["/statements", "/ledger", "/budget"] },
    { title: "The rules", blurb: "What decides an amount, and a way to check one.", items: ["/policy", "/calculator"] },
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
  const nowMonth = new Date().toISOString().slice(0, 7)
  const thisMonth = months.data?.months.find((m) => m.month === nowMonth)
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
        <ErrorState title="Not open to this account" message="Ask the research cell if you think it should be yours." />
      </div>
    )
  }

  return (
    <div className="page space-y-10">
      <PageHeader title="Money" sub="Where the year stands, and the paper for the month." spot="spot-budget" />

      <Answer
        items={[
          { label: fy.data ? `Paid in FY ${fy.data.financial_year}` : "Paid this year", value: fy.data ? money(fy.data.paid) : null, to: "/ledger" },
          {
            label: "Approved, not yet paid",
            value: fy.data ? money(fy.data.committed) : null,
            zero: "Nothing is owed",
            to: "/budget",
          },
          {
            label: over ? "Over the budget" : "Left in the budget",
            value: !budget.data ? null : remaining == null ? "Not set" : money(Math.abs(remaining)),
            tone: over ? "critical" : undefined,
            to: "/budget",
          },
          { label: "Paid this month", value: months.data ? money(thisMonth?.amount ?? 0) : null, to: `/payments/done?month=${nowMonth}` },
        ]}
      />

      {GROUPS[role].map((g) => {
        const items = g.items.map((to) => mine.get(to)).filter((p): p is NavItem => !!p)
        if (items.length === 0) return null
        return (
          <Section key={g.title} title={g.title} sub={g.blurb}>
            <Rows>
              {items.map((item) => {
                const Icon = item.icon
                const line = note(item.to)
                return (
                  <li key={item.to}>
                    <Link to={item.to} className="row group flex items-start gap-3 rounded-control px-1 py-3">
                      <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-medium">{item.label}</span>
                        {item.purpose && <Meta className="mt-0.5 block text-pretty">{item.purpose}</Meta>}
                        {line && <Meta className="mt-0.5 block text-fg">{line}</Meta>}
                      </span>
                      <ChevronRight className="mt-1 size-4 shrink-0 text-fg-subtle max-sm:hidden" aria-hidden />
                    </Link>
                  </li>
                )
              })}
            </Rows>
          </Section>
        )
      })}
    </div>
  )
}
