import { Link } from "react-router-dom"
import { ArrowRight, FilePlusCorner } from "lucide-react"

import { Button } from "@/ui/button"
import { CopyButton } from "@/ui/copy"
import { type Ticks } from "@/ui/eligibility"
import { ClaimTrack } from "@/ui/claim-track"
import { money } from "@/ui/paper"
import { Picture } from "@/ui/picture"
import { unshout } from "@/lib/names"

export type FiledClaim = {
  id: string
  /** The claimant's copy has no raw status; the receipt is only shown once filed. */
  status?: string | null
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
 * Step 7 (docs/ux/04): the receipt after filing. A proud moment: the picture,
 * the ticket, what was filed, the estimate, the three confirmations with their
 * times and what happens next. Faculty never see which desk holds the paper,
 * so nothing here names one.
 */
export function FiledReceipt({
  claim,
  estimate,
  thresholdNote,
  countOnly,
  ticks,
  unclaimedLeft,
  firstClaim = false,
}: {
  claim: FiledClaim
  estimate: number | null
  /** Research faculty: what this claim does to the yearly threshold. */
  thresholdNote?: string | null
  countOnly: boolean
  ticks: Ticks
  /** Papers on my record still without a claim, after this one; null if unknown. */
  unclaimedLeft: number | null
  /** The first claim this person has ever filed: the bigger celebration. */
  firstClaim?: boolean
}) {
  // What the claimant is allowed to see of the chain: four stages, no desk.
  // The five-station thread is the office's picture and names steps (Approved,
  // Authorised) that tell a claimant whose desk a claim is on.
  const confirmedAt = Object.values(ticks).sort().at(-1)
  return (
    <div className="page pb-16 pt-8 md:pt-12" style={{ maxWidth: 740 }} data-testid="filed-receipt">
      <section className="space-y-8">
        <div className="text-center">
          <Picture
            name={firstClaim ? "celebrate-first-publication" : "onboard-all-set"}
            className="mx-auto h-40 w-56 sm:h-48 sm:w-72"
            eager
          />
          <h1 className="display mt-4 text-3xl sm:text-[34px]">Filed. Your claim is on its way.</h1>
          <p className="mt-2 text-fg-muted">Keep the claim number. It is how you and the college refer to this claim.</p>
          {claim.ticket_number ? (
            <div className="mt-5 inline-flex items-center gap-3 rounded-panel bg-surface px-5 py-3 ring-1 ring-edge">
              <span className="text-sm text-fg-muted">Claim no.</span>
              <span className="figure text-figure tabular" data-testid="filed-ticket">
                {claim.ticket_number}
              </span>
              <CopyButton value={claim.ticket_number} label="claim number" />
            </div>
          ) : (
            <p className="mt-4 text-sm text-fg-muted">The claim number will appear on the paper's page.</p>
          )}
        </div>

        <ClaimTrack stage="Submitted" filedOn={new Date().toISOString()} className="mx-auto max-w-lg" />

        <dl className="divide-y divide-line border-y border-line text-sm">
          <div className="py-4">
            <dt className="text-fg-muted">What you filed</dt>
            <dd className="mt-1 font-medium text-fg">{unshout(claim.paper_title) || "Untitled paper"}</dd>
            {(claim.journal_title || claim.doi) && (
              <dd className="text-fg-muted">{[claim.journal_title, claim.doi].filter(Boolean).join(" · ")}</dd>
            )}
          </div>
          <div className="py-4">
            <dt className="text-fg-muted">Estimated incentive</dt>
            <dd className="figure mt-1 text-figure tabular">
              {countOnly ? "Counted only, no payment" : estimate != null ? money(estimate) : "Worked out on review"}
            </dd>
            {!countOnly && <dd className="text-xs text-fg-muted">An estimate. The amount is fixed when the claim is checked.</dd>}
            {!countOnly && thresholdNote && (
              <dd className="mt-1 text-sm text-fg" data-testid="filed-threshold">
                {thresholdNote}
              </dd>
            )}
          </div>
          <div className="py-4" data-testid="filed-confirmed">
            <dt className="text-fg-muted">What you confirmed</dt>
            <dd className="mt-1 text-fg">
              The article is indexed, no claim was filed for it before, and the files were ready.
              <span className="block text-xs text-fg-muted">
                {confirmedAt ? `Each box ticked by you, the last at ${fmt(confirmedAt)}. ` : ""}Stored with the claim.
              </span>
            </dd>
          </div>
          <div className="py-4">
            <dt className="text-fg-muted">What happens next</dt>
            <dd>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-fg">
                <li>The college checks the paper, your authorship and your references.</li>
                <li>Once it is approved, the payment is made to you.</li>
                <li>If anything needs changing, it comes back to you with a note, and you are told.</li>
              </ol>
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild kind="primary" size="lg">
            <Link to={`/papers/${claim.id}`}>
              Track it
              <ArrowRight aria-hidden />
            </Link>
          </Button>
          {unclaimedLeft != null && unclaimedLeft > 0 && (
            <Button asChild kind="default" size="lg" className="max-sm:h-auto max-sm:whitespace-normal max-sm:py-2">
              <Link to="/papers/new" reloadDocument>
                <FilePlusCorner aria-hidden />
                File another from my record ({unclaimedLeft} left)
              </Link>
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}

/**
 * The figure the receipt shows: the server's, once it has priced the claim.
 *
 * Filing re-reads the journal's SNIP and quartile from the college's own
 * tables, so the filed claim can be worth far more (or less) than the form's
 * estimate. The receipt used to show the form's number — ₹2,500 on a claim
 * the server had priced at ₹74,500 — and the claimant's first sight of the
 * amount disagreed with every page after it.
 */
export function receiptAmount(server: number | null | undefined, estimate: number | null | undefined): number | null {
  if (typeof server === "number" && server > 0) return server
  return estimate ?? (typeof server === "number" ? server : null)
}
