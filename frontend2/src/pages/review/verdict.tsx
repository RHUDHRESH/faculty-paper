import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { cn } from "@/lib/cn"
import { categoryLabel, money } from "@/ui/paper"
import { Callout } from "@/ui/state"

import type { DiffRow } from "./claim-diff"
import type { WorkspaceClaim } from "./types"

/**
 * The answer at the top of the review panel: can this claim go?
 *
 * Without it the reviewer reads a table of eight rows and builds the verdict
 * in their head, for every claim. Here the page says it: "Nothing to look
 * at." or "2 things to look at.", each with its reason in a phrase, and the
 * amount as the one figure. The detail stays in the tabs below; this only
 * summarises what the record, the checks and the flags already say.
 */

export type VerdictState = "clear" | "look" | "unchecked"

export function verdictOf(claim: WorkspaceClaim, rows: DiffRow[]): { state: VerdictState; reasons: string[] } {
  const reasons: string[] = []
  for (const r of rows) {
    if (r.differs) reasons.push(r.why ? `${r.label}: ${r.why}` : `${r.label} differs from the record`)
  }
  if (claim.verification_ok === false && reasons.length === 0) reasons.push("The automatic checks failed")
  if (claim.duplicate_warning) reasons.push("May already have been paid")
  if (claim.journal_watch) reasons.push("The journal is on the watch-list")
  if (claim.contest_forward) reasons.push("The claimant contested an earlier decision")
  if (claim.calc_error) reasons.push("The amount could not be worked out")
  if (claim.on_hold) reasons.push("On hold")
  if (reasons.length > 0) return { state: "look", reasons }
  if (claim.verification_ok == null) return { state: "unchecked", reasons: [] }
  return { state: "clear", reasons: [] }
}

export function Verdict({ claim, rows }: { claim: WorkspaceClaim; rows: DiffRow[] }) {
  const { state, reasons } = verdictOf(claim, rows)
  const n = reasons.length
  return (
    <section aria-label="Verdict" className="space-y-4">
      <div role="status">
        <p
          className={cn(
            "display text-display text-balance",
            state === "look" ? "text-fg" : state === "clear" ? "text-fg" : "text-fg-muted"
          )}
        >
          {state === "clear" && "Nothing to look at."}
          {state === "unchecked" && "Not checked yet."}
          {state === "look" && (n === 1 ? "One thing to look at." : `${n} things to look at.`)}
        </p>
        {state === "clear" && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-positive">
            <CheckCircle2 className="size-4" aria-hidden /> Every check passed.
          </p>
        )}
        {state === "unchecked" && (
          <p className="mt-1 text-sm text-fg-muted">The automatic checks have not run on this claim.</p>
        )}
        {state === "look" && (
          <ul className="mt-2 space-y-1">
            {reasons.map((r) => (
              <li key={r} className="flex gap-1.5 text-sm text-fg">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden />
                <span className="text-pretty">{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="figure text-figure tabular">{claim.calc_error ? "No amount" : money(claim.remuneration)}</p>
        <p className="mt-0.5 text-sm text-fg-muted">
          {claim.remuneration_category ? categoryLabel(claim.remuneration_category) : "The incentive"}
          {claim.remuneration_is_estimate && !claim.calc_error ? ". An estimate: it rests on figures the claimant reported." : ""}
        </p>
        {claim.calc_error && (
          <Callout tone="critical" title="This amount could not be worked out">
            {claim.calc_error}
          </Callout>
        )}
      </div>
    </section>
  )
}
