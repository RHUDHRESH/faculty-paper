import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { longDate, type ClaimThreshold } from "@/ui/research-threshold"
import { Meta } from "@/ui/text"

/**
 * The pieces the Director's and Finance's money screens share.
 *
 * One definition of a payable claim, of the month it is paid in, and of how
 * the research threshold shows next to an amount, so the Payments queue, the
 * Paid register, the Finance home and the Director's home cannot say three
 * different things about the same rupees. None of it names a flag: these two
 * roles are contest-blind (`core.visibility`), so the type has no field for
 * one.
 */

/** A claim as `/api/admin/payouts` sends it (`claim_to_dict` plus the ledger). */
export type PayoutClaim = ClaimThreshold & {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_id?: string | null
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  staff_id?: string | null
  payout_month?: string | null
  director_approved_at?: string | null
  director_approved_by_name?: string | null
  principal_approved_at: string | null
  principal_approved_by_name: string | null
  cleared_by_name: string | null
  second_approved_by_name: string | null
  remuneration: number | null
  calc_error: string | null
  voucher_number: string | null
  paid_at: string | null
  needs_second_approval: boolean
  waiting_days: number | null
  /** Net on the ledger for this claim: 0 before it is paid. */
  ledger_paid?: number
  ledger_rows?: number
}

export type PayableTotals = {
  count: number
  amount: number
  ready_count: number
  ready_amount: number
  held_count: number
  held_amount: number
  no_amount_count: number
  held_back: number
  held_back_count: number
  zero_count: number
}

export type PaidTotals = { count: number; amount: number }

export type PayoutsPage<T = PayableTotals | PaidTotals> = {
  total: number
  limit: number
  offset: number
  totals?: T | null
  results: PayoutClaim[]
}

/** The whole payable queue in one request. The endpoint's ceiling is 200. */
export const PAYABLE_LIMIT = 200
export const payableKey = (page: number) => ["payouts", "DIRECTOR_APPROVED", page] as const
export const payablePath = (page: number) =>
  `/api/admin/payouts?status=DIRECTOR_APPROVED&limit=${PAYABLE_LIMIT}&offset=${page * PAYABLE_LIMIT}`

export function isPayable(c: PayoutClaim): boolean {
  return !c.needs_second_approval && !c.calc_error
}

/** When the numbers are missing (an older server, a test), add up the rows in hand. */
export function payableTotalsOf(rows: PayoutClaim[]): PayableTotals {
  const ready = rows.filter(isPayable)
  const held = rows.filter((c) => !isPayable(c))
  const sum = (xs: PayoutClaim[]) => xs.reduce((s, c) => s + (c.remuneration || 0), 0)
  const absorbing = rows.filter((c) => (c.threshold_absorbed ?? 0) > 0.005)
  return {
    count: rows.length,
    amount: sum(rows),
    ready_count: ready.length,
    ready_amount: sum(ready),
    held_count: held.length,
    held_amount: sum(held),
    no_amount_count: rows.filter((c) => c.calc_error).length,
    held_back: absorbing.reduce((s, c) => s + (c.threshold_absorbed || 0), 0),
    held_back_count: absorbing.length,
    zero_count: ready.filter((c) => (c.remuneration || 0) <= 0.005).length,
  }
}

export function isPayableTotals(t: PayableTotals | PaidTotals | null | undefined): t is PayableTotals {
  return !!t && "ready_count" in t
}

/* ------------------------------------------------------------------------ */
/* Months                                                                    */
/* ------------------------------------------------------------------------ */

/** "2026-09": the month the Director set, else the month it was paid, else
 *  the month it will be paid in if it is paid today. */
export function monthKey(c: PayoutClaim, fallback?: string): string {
  if (c.payout_month) return c.payout_month.slice(0, 7)
  const iso = c.paid_at
  if (iso) return iso.slice(0, 7)
  return fallback ?? thisMonthKey()
}

export function thisMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

export function monthLabel(key: string, short = false): string {
  const [y, m] = key.split("-").map(Number)
  if (!y || !m) return "Month not recorded"
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: short ? "short" : "long", year: "numeric" })
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
}

export function waitingLabel(days: number | null | undefined): string {
  if (days == null) return ""
  if (days <= 0) return "Today"
  return `${days} ${days === 1 ? "day" : "days"}`
}

/* ------------------------------------------------------------------------ */
/* Cells                                                                     */
/* ------------------------------------------------------------------------ */

const ERP_NUMBER = /^ERP-/i

/** True for a claim number that came across from the old ERP, not one filed here. */
export function isErpNumber(no: string | null | undefined): boolean {
  return !!no && ERP_NUMBER.test(no)
}

export function ClaimNo({ no }: { no: string | null }) {
  if (!no) return <span className="text-fg-subtle">No claim number yet</span>
  return isErpNumber(no) ? (
    <span title="Carried over from the old ERP">{no}</span>
  ) : (
    <span>{no}</span>
  )
}

/** One sentence, once per view, for anyone who meets an ERP claim number. */
export function ErpLegend({ rows }: { rows: { ticket_number: string | null }[] }) {
  if (!rows.some((r) => isErpNumber(r.ticket_number))) return null
  return (
    <Meta className="block">
      A claim number that begins ERP- was carried over from the old ERP, not filed in this app.
    </Meta>
  )
}

export function Claimant({ c, size = "sm" }: { c: PayoutClaim; size?: "sm" | "md" }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar
        size={size}
        person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
      />
      <div className="min-w-0">
        <span className="block truncate">{c.owner_name}</span>
        <Meta className="block truncate">
          {[c.staff_id ? `Staff id ${c.staff_id}` : null, c.owner_department].filter(Boolean).join(" · ") ||
            "Staff id not recorded"}
        </Meta>
      </div>
    </div>
  )
}

export function PaperCell({ c, journal = true }: { c: PayoutClaim; journal?: boolean }) {
  return (
    <div className="min-w-0">
      <Link
        to={`/papers/${c.id}`}
        className="block break-words text-base underline-offset-4 hover:underline"
      >
        {paperTitle(c.paper_title)}
      </Link>
      <Meta className="block break-words">
        <ClaimNo no={c.ticket_number} />
        {journal && c.journal_title ? ` · ${c.journal_title}` : ""}
      </Meta>
    </div>
  )
}

/**
 * The amount to pay, and, where the research threshold takes part of it, the
 * policy amount and the part held back, on the same cell. The rupees paid are
 * the figure; the threshold is why they are less than the policy says, so it
 * sits beside them and not on another page.
 */
export function AmountCell({
  c,
  className,
}: {
  c: ClaimThreshold & { calc_error?: string | null }
  className?: string
}) {
  if (c.calc_error) {
    return (
      <div className={cn("text-right", className)}>
        <span className="text-critical">No amount</span>
        <Meta className="block">Could not be calculated</Meta>
      </div>
    )
  }
  const absorbed = c.threshold_absorbed ?? 0
  const full = c.threshold_full_amount ?? 0
  const has = absorbed > 0.005 && full > 0
  const inside = has && absorbed >= full - 0.005
  return (
    <div className={cn("text-right", className)}>
      <span className="tabular">{money(c.remuneration)}</span>
      {has && (
        <Meta className="block">
          {inside
            ? `Nothing to pay: ${money(full)} counts against the research threshold`
            : `of ${money(full)}; ${money(absorbed)} held back by the research threshold`}
        </Meta>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Budget                                                                    */
/* ------------------------------------------------------------------------ */

export type BudgetNow = {
  financial_year: string
  college: { allocated: number | null; spent: number; committed: number; remaining: number | null }
}

/** The year's position, from the same request the Home and the Budget page use. */
export function useBudgetNow(enabled = true) {
  return useApi<BudgetNow>(["budgets", ""], "/api/budgets", { enabled })
}

/** What the money means for the year, in one sentence. */
export function budgetSentence(b: BudgetNow | undefined, amount: number, verb = "paying"): string | null {
  if (!b) return null
  const left = b.college.remaining
  if (left == null) return `No allocation is set for ${b.financial_year}, so there is nothing to measure ${money(amount)} against.`
  return left < 0
    ? `The budget for ${b.financial_year} is over by ${money(Math.abs(left))} once these are counted.`
    : `After ${verb} ${money(amount)}, ${money(left)} is left of the budget for ${b.financial_year}.`
}

export { longDate }
