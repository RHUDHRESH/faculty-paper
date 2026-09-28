import { Link } from "react-router-dom"
import { ArrowRight, FilePlusCorner } from "lucide-react"

import { Button } from "@/ui/button"
import { CopyButton } from "@/ui/copy"
import { confirmations, type Ticks } from "@/ui/eligibility"
import { money, StageTrack, stageOf } from "@/ui/paper"
import { SharePlate } from "@/ui/share-plate"
import { Illustration } from "@/ui/illustration"

export type FiledClaim = {
  id: string
  status: string
  ticket_number: string | null
  paper_title: string | null
  journal_title: string | null
  doi: string | null
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    year: "numeric",
  })

/**
 * Step 7 (docs/ux/04): the receipt after filing. What was filed, its ticket,
 * the estimate (the claimant's own money), the three confirmations with their
 * times, and what happens next -- on the cream plate with the gold ribbon.
 */
export function FiledReceipt({
  claim,
  estimate,
  countOnly,
  ticks,
  minReferences,
  unclaimedLeft,
}: {
  claim: FiledClaim
  estimate: number | null
  countOnly: boolean
  ticks: Ticks
  minReferences: number
  /** Papers on my record still without a claim, after this one; null if unknown. */
  unclaimedLeft: number | null
}) {
  const stage = stageOf(claim.status || "SUBMITTED")
  return (
    <div className="page space-y-6 pb-16 pt-6 md:pt-8" data-testid="filed-receipt">
      <SharePlate as="section" className="space-y-6 p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <Illustration name="celebrate-first-publication" width={150} className="max-sm:hidden" />
          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="display text-2xl sm:text-3xl">Filed. It's with the research cell.</h1>
            {claim.ticket_number ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-fg-muted">Ticket</span>
                <span className="font-mono text-2xl font-semibold tracking-wide sm:text-3xl" data-testid="filed-ticket">
                  {claim.ticket_number}
                </span>
                <CopyButton value={claim.ticket_number} label="Copy ticket number" />
              </div>
            ) : (
              <p className="text-sm text-fg-muted">The ticket number will appear on the paper's page.</p>
            )}
          </div>
        </div>

        <StageTrack stage={stage} />

        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-[0.04em] text-fg-muted">What you filed</dt>
            <dd className="mt-1 font-medium">{claim.paper_title || "Untitled paper"}</dd>
            <dd className="text-fg-muted">{[claim.journal_title, claim.doi].filter(Boolean).join(" · ")}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-[0.04em] text-fg-muted">Estimated payout</dt>
            <dd className="mt-1 text-lg font-semibold tabular">
              {countOnly ? "Counted only — no payment" : estimate != null ? money(estimate) : "Worked out on review"}
            </dd>
            {!countOnly && (
              <dd className="text-xs text-fg-muted">An estimate. The amount is fixed when the research cell checks it.</dd>
            )}
          </div>
        </dl>

        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-[0.04em] text-fg-muted">What you confirmed</h2>
          <ul className="space-y-1.5">
            {confirmations(minReferences).map((c) => (
              <li key={c.id} className="text-sm" data-condition={c.id}>
                <span className="font-medium">{c.label}</span>
                <span className="block text-xs text-fg-muted">
                  {ticks[c.id] ? `Confirmed ${fmt(ticks[c.id])}` : "Not confirmed"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-fg-muted">These are stored with the claim.</p>
        </div>

        <div className="space-y-1.5">
          <h2 className="text-xs font-medium uppercase tracking-[0.04em] text-fg-muted">What happens next</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>The research cell checks the paper, your authorship and your references.</li>
            <li>It then goes for approval, and on to accounts for payment.</li>
            <li>If anything needs changing it comes back to you with a note — you will be told.</li>
          </ol>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button asChild kind="primary" size="lg"><Link to={`/papers/${claim.id}`}>
            Track it
            <ArrowRight aria-hidden />
          </Link></Button>
          {unclaimedLeft != null && unclaimedLeft > 0 && (
            <Button asChild kind="default" size="lg" className="max-sm:whitespace-normal max-sm:h-auto max-sm:py-2"><Link to="/papers/new" reloadDocument>
              <FilePlusCorner aria-hidden />
              File another from my record ({unclaimedLeft} left)
            </Link></Button>
          )}
        </div>
      </SharePlate>
    </div>
  )
}
