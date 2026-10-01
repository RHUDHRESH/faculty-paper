import { Link, useSearchParams } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { CheckTab } from "@/pages/calculator-check"
import { ManyTab } from "@/pages/calculator-many"
import { PriceTab } from "@/pages/calculator-price"
import { PageHeader } from "@/ui/page-header"
import { ErrorState } from "@/ui/state"

/**
 * The incentive calculator (docs/ux/23): how much a paper should pay, and
 * whether what was recorded agrees.
 *
 * Three tabs, three questions. Price a paper: what does this pay? Check a
 * claim: what should this claim have been paid? Check many: which claims are
 * not what the formula says? The server does every sum, with the function the
 * claims themselves are priced with, and nothing here changes a claim.
 *
 * For the research cell, the coordinator, a super admin, the Principal, the
 * Director and Finance. A head of department and a faculty member are not
 * shown it: the head is not shown money, and faculty already have the
 * estimate in filing.
 */

const TABS = [
  { id: "price", label: "Price a paper" },
  { id: "claim", label: "Check a claim" },
  { id: "many", label: "Check many" },
] as const
type Tab = (typeof TABS)[number]["id"]

const SUB: Record<Tab, string> = {
  price: "Enter a paper's details to see what it pays, and how that was worked out.",
  claim: "Enter a claim number to see what was recorded, what the formula gives, and what was paid.",
  many: "Every approved, authorised and paid claim, checked against the price it was made under.",
}

export function Calculator() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const raw = params.get("tab")
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : "price"
  const allowed = !!me && me.role !== "HOD" && me.role !== "FACULTY"

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="The incentive calculator is for the research cell, the Principal, the Director and Finance. When you file a paper, the form shows the estimate."
        />
        <p className="mt-4 text-sm">
          <Link to="/" className="underline underline-offset-2">
            Back to your home
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="page space-y-8">
      <PageHeader title="Incentive calculator" sub={SUB[tab]} />

      <div role="tablist" aria-label="Incentive calculator" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setParams(t.id === "price" ? {} : { tab: t.id }, { replace: true })}
            className={cn(
              "-mb-px h-10 border-b-2 px-3 text-sm transition-colors duration-[var(--dur-1)] ease-out max-sm:h-11",
              tab === t.id ? "border-accent font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "price" && <PriceTab />}
        {tab === "claim" && <CheckTab />}
        {tab === "many" && <ManyTab />}
      </div>
    </div>
  )
}
