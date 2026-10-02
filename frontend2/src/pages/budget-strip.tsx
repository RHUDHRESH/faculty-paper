import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { money } from "@/ui/paper"
import type { BudgetNow } from "@/pages/pay-parts"

/**
 * What this does to the year's budget, drawn once and used wherever a money
 * decision is made: the Director's Home, the Authorisations queue, the confirm
 * dialogs, the review workspace's bar, and Finance's Home and Payments.
 *
 * One bar the width of the allocation, split in the order the money moves:
 * **Paid** (navy), **Also committed** (a lighter navy: claims checked or
 * approved or authorised that are not this batch), **This batch** (clay: the
 * one thing the reader is about to act on) and **Left** (the empty track).
 * The batch is already inside the college's "committed" figure (the Budget
 * page counts everything from Cleared on), so it is carved out of that part,
 * never added to it: authorising does not spend money, it releases money the
 * budget already counts. The sentence above the bar is the caller's; the bar
 * and its four labels are this component's, and they never disagree because
 * they are the same four numbers.
 *
 * When the allocation is passed, the bar fills and a crimson tick marks where
 * the allocation ended, with the over-run in words ("Over by ₹1,91,046");
 * colour is never the only signal. When no allocation is set there is nothing
 * to measure against, and the strip says so in one line instead of a full
 * bar that would read as "all spent".
 *
 * Direct labels, no legend (DESIGN.md, Charts): each of the four figures
 * carries the same coloured cap as its segment.
 */
export type StripBudget = Pick<BudgetNow["college"], "allocated" | "spent" | "committed">

export function stripParts(b: StripBudget, batch: number) {
  const allocated = b.allocated
  const batchPart = Math.max(0, Math.min(batch, b.committed))
  const other = Math.max(0, b.committed - batchPart)
  const used = b.spent + b.committed
  const left = allocated == null ? null : allocated - used
  const over = left != null && left < 0
  const scale = Math.max(allocated ?? 0, used, 1)
  return { allocated, spent: b.spent, other, batch: batchPart, used, left, over, scale }
}

const pct = (n: number, scale: number) => `${Math.max(0, Math.min(100, (n / scale) * 100)).toFixed(2)}%`

const SEG = {
  paid: "bg-navy",
  other: "bg-navy/35",
  batch: "bg-accent",
} as const

export function BudgetStrip({
  budget,
  batch,
  batchLabel = "This batch",
  compact = false,
  labels = "all",
  className,
}: {
  budget: StripBudget | undefined
  /** The rupees the reader is about to act on. Already counted as committed. */
  batch: number
  batchLabel?: string
  /** A thin bar and no labels, for a dialog or the workspace bar. */
  compact?: boolean
  /** "wide" keeps the four labels off a phone, where the sentence above says the one that matters. */
  labels?: "all" | "wide"
  className?: string
}) {
  if (!budget) {
    return <div aria-hidden className={cn("h-2.5 w-full animate-pulse rounded-full bg-sunken", className)} />
  }
  const p = stripParts(budget, batch)
  if (p.allocated == null) return null

  const aria =
    `Budget: ${money(p.spent)} paid, ${money(p.other)} also committed, ${money(p.batch)} ${batchLabel.toLowerCase()}, ` +
    (p.over ? `over the allocation of ${money(p.allocated)} by ${money(Math.abs(p.left ?? 0))}` : `${money(p.left)} left of ${money(p.allocated)}`)

  return (
    <div className={cn("w-full", className)}>
      <div
        role="img"
        aria-label={aria}
        className={cn("relative flex w-full overflow-hidden rounded-full bg-sunken ring-1 ring-inset ring-edge", compact ? "h-2" : "h-3")}
      >
        <span className={cn("block h-full", SEG.paid)} style={{ width: pct(p.spent, p.scale) }} />
        <span className={cn("block h-full", SEG.other)} style={{ width: pct(p.other, p.scale) }} />
        <span className={cn("block h-full", SEG.batch)} style={{ width: pct(p.batch, p.scale) }} />
        {p.over && (
          <span
            aria-hidden
            className="absolute inset-y-0 w-0.5 bg-critical"
            style={{ left: pct(p.allocated, p.scale) }}
          />
        )}
      </div>
      {!compact && (
        <dl className={cn("mt-3 grid-cols-2 gap-x-6 gap-y-3", p.batch > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3", labels === "wide" ? "hidden sm:grid" : "grid")}>
          <Label cap={SEG.paid} term="Paid" value={money(p.spent)} />
          <Label cap={SEG.other} term="Also committed" value={money(p.other)} />
          {p.batch > 0 && <Label cap={SEG.batch} term={batchLabel} value={money(p.batch)} />}
          {p.over ? (
            <Label cap="bg-critical" term="Over the allocation by" value={money(Math.abs(p.left ?? 0))} tone="critical" />
          ) : (
            <Label cap="bg-edge" term="Left" value={money(p.left)} />
          )}
        </dl>
      )}
    </div>
  )
}

function Label({ cap, term, value, tone }: { cap: string; term: string; value: string; tone?: "critical" }) {
  return (
    <div className="min-w-0">
      <span aria-hidden className={cn("mb-1.5 block h-1 w-6 rounded-full", cap)} />
      <dt className="text-sm text-fg-muted">{term}</dt>
      <dd className={cn("tabular text-base font-medium", tone === "critical" && "text-critical")}>{value}</dd>
    </div>
  )
}

/**
 * The one sentence for the strip, said the same way everywhere.
 *
 *   authorise:  "Authorising them leaves ₹X in the 2026-27 budget."
 *   pay:        "Paying them leaves ₹X in the 2026-27 budget."
 *
 * Counted the way the Budget page counts: allocation minus what is paid minus
 * everything committed, the batch included. Over the allocation it says so and
 * by how much; with no allocation it says there is nothing to weigh against.
 */
export function budgetLine(
  b: Pick<BudgetNow, "financial_year" | "college"> | undefined,
  verb: "authorising" | "paying",
  plural = true
): string | null {
  if (!b) return null
  const it = plural ? "them" : "it"
  const left = b.college.allocated == null ? null : b.college.allocated - b.college.spent - b.college.committed
  if (left == null) return `No budget is set for ${b.financial_year}, so there is nothing to weigh ${it} against.`
  const Verb = verb[0].toUpperCase() + verb.slice(1)
  return left < 0
    ? `${Verb} ${it} takes the ${b.financial_year} budget ${money(Math.abs(left))} over.`
    : `${Verb} ${it} leaves ${money(left)} in the ${b.financial_year} budget.`
}

/** "6 claims", "1 claim", for a sentence. */
export const claimsWord = (n: number) => `${formatCount(n)} ${n === 1 ? "claim" : "claims"}`
