import { CheckCircle2 } from "lucide-react"

import { thresholdClause } from "@/pages/authorise-dialogs"
import { categoryLabel, money, stageOf } from "@/ui/paper"
import { Callout } from "@/ui/state"

import type { WorkspaceClaim } from "./types"

/**
 * The top of the review panel for the Director: not "can this claim go" (the
 * research cell's question, with checks the Director is not shown) but the
 * Director's own: has the Principal approved it, how much will it release, and
 * what the research threshold did to that figure. The budget effect sits in the
 * decision bar below, where the button is.
 */
export function DirectorVerdict({ claim }: { claim: WorkspaceClaim }) {
  const approvedBy = (claim as { principal_approved_by_name?: string | null }).principal_approved_by_name
  const approvedAt = (claim as { principal_approved_at?: string | null }).principal_approved_at
  const when = approvedAt
    ? new Date(approvedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : null
  const status = claim.status ?? ""
  const waiting = status === "PRINCIPAL_APPROVED"
  const headline = waiting ? "Ready for your signature." : `${stageOf(status).label}.`
  const held = thresholdClause(claim)
  return (
    <section aria-label="Verdict" className="space-y-4">
      <div role="status">
        <p className="display text-display text-balance text-fg">{headline}</p>
        {waiting && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-positive">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            Approved by {approvedBy || "the Principal"}
            {when ? ` on ${when}` : ""}.
          </p>
        )}
      </div>
      <div>
        <p className="figure text-figure tabular">{claim.calc_error ? "No amount" : money(claim.remuneration)}</p>
        <p className="mt-0.5 text-sm text-fg-muted">
          {claim.remuneration_category ? categoryLabel(claim.remuneration_category) : "The incentive"}
        </p>
        {held && <p className="mt-1 text-sm text-caution">{held}.</p>}
        {claim.calc_error && (
          <Callout tone="critical" title="This amount could not be worked out">
            {claim.calc_error}
          </Callout>
        )}
      </div>
    </section>
  )
}
