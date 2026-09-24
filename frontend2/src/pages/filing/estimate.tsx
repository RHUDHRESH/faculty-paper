import { AlertTriangle, LoaderCircle } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { InlineError } from "@/ui/state"
import { ColumnLabel } from "@/ui/text"

import type { Problem } from "./readiness"
import type { CalcResult } from "./types"

type EstimateProps = {
  calc: CalcResult | null
  calcBusy: boolean
  calcFailed: boolean
  priceable: boolean
  countOnly: boolean
  problems: Problem[]
  onRetryCalc: () => void
  onGoToProblem: (p: Problem) => void
  onFileAsCount: () => void
  /** Set while the estimate assumes the policy's references will be
   *  attached on the proof step, which has not been reached yet. */
  assumedReferences?: number | null
}

function Amount({ calc, calcBusy, calcFailed, countOnly, className }: Pick<EstimateProps, "calc" | "calcBusy" | "calcFailed" | "countOnly"> & { className?: string }) {
  const amount = calc?.remuneration
  if (countOnly) return <p className={cn("text-lg font-medium", className)}>No payment claimed</p>
  if (calcFailed) return <p className={cn("text-base font-medium text-critical", className)}>Estimate unavailable</p>
  if (calcBusy && !calc) {
    return (
      <p className={cn("flex items-center gap-1.5 text-base text-fg-muted", className)}>
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Working it out
      </p>
    )
  }
  if (amount == null) return <p className={cn("text-base text-fg-muted", className)}>Not enough yet</p>
  return (
    <p className={cn("figure text-2xl", amount === 0 && "text-caution", className)}>
      {money(amount)}
      {/* On the figure itself: the ERP showed a number with no such word
          near it and people budgeted against it. */}
      <span className="ml-1.5 align-middle text-sm font-normal text-fg-muted">estimated</span>
    </p>
  )
}

/**
 * What this paper is worth, beside every step (under the step rail).
 *
 * It is the claimant's own money, so it is theirs to see throughout: "this
 * will pay ₹0 because one reference has no number" has to be visible while
 * there is still something to do about it, not after five steps.
 */
export function EstimatePanel(props: EstimateProps) {
  const { calc, calcFailed, priceable, countOnly, problems, onRetryCalc, onGoToProblem, onFileAsCount } = props
  const unpaid = problems.filter((p) => p.kind === "unpaid")
  const ready = !problems.some((p) => p.kind === "missing")
  const amount = calc?.remuneration

  return (
    <section aria-label="Payout estimate" className="space-y-2 rounded-lg bg-sunken p-3">
      <ColumnLabel className="block">{countOnly ? "Filing for the count" : "Your estimate"}</ColumnLabel>
      <Amount {...props} />
      {!countOnly && !calcFailed && (
        <p className="text-xs text-fg-muted">
          {amount === 0
            ? "As things stand this would be recorded and paid nothing."
            : amount == null
              ? priceable
                ? "Appears once the journal is priced."
                : "Appears once the journal's quartile, SNIP or indexing is in."
              : "From the figures on this form. The research cell verifies them, so it can change."}
        </p>
      )}
      {calc?.category_label && !countOnly && amount != null && (
        <p className="text-xs text-fg-muted">{calc.category_label}</p>
      )}
      {props.assumedReferences ? (
        <p className="text-xs text-fg-muted">
          Assumes the {props.assumedReferences} cited references you attach on the proof step.
        </p>
      ) : null}
      {calcFailed && !countOnly && (
        <InlineError message="The server did not answer. Filing still works." onRetry={onRetryCalc} />
      )}
      {unpaid.length > 0 && !countOnly && (
        <div className="space-y-1.5 rounded-md bg-caution-wash p-2">
          {unpaid.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => onGoToProblem(p)}
              className="block text-left text-xs font-medium underline-offset-2 hover:underline"
            >
              {p.label}
            </button>
          ))}
          <Button kind="default" size="sm" onClick={onFileAsCount}>
            File it for the record instead
          </Button>
        </div>
      )}
      <p className={cn("text-xs font-medium", ready ? "text-positive" : "text-fg-muted")}>
        {ready ? "Ready to file" : "Still a few to answer"}
      </p>
    </section>
  )
}

/**
 * The same figure on a phone, pinned under the app's header while the step
 * scrolls. One line, because at 390px anything taller is a second header.
 */
export function EstimateBar(props: EstimateProps) {
  const { calc, countOnly, problems, onGoToProblem } = props
  const unpaid = problems.filter((p) => p.kind === "unpaid")
  return (
    <section
      aria-label="Payout estimate"
      className="sticky top-12 z-20 -mx-4 flex min-h-11 items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 py-1.5 backdrop-blur sm:-mx-8 sm:px-8 md:hidden"
    >
      <span className="text-xs text-fg-muted">
        {countOnly
          ? "Filing for the count"
          : props.assumedReferences
            ? `Estimate, with ${props.assumedReferences} references`
            : "Your estimate"}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {!countOnly && calc?.remuneration === 0 && unpaid[0] && (
          <button
            type="button"
            onClick={() => onGoToProblem(unpaid[0])}
            className="inline-flex items-center gap-1 text-xs font-medium text-caution"
          >
            <AlertTriangle className="size-3.5" aria-hidden />
            Why ₹0
          </button>
        )}
        <Amount {...props} className="text-lg" />
      </span>
    </section>
  )
}
