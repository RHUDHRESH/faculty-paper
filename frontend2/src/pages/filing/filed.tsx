import { Link } from "react-router-dom"
import { ArrowRight, Check, FilePlusCorner } from "lucide-react"

import { Button } from "@/ui/button"
import { CopyButton } from "@/ui/copy"
import { confirmations, type Ticks } from "@/ui/eligibility"
import { money, StageTrack, stageOf } from "@/ui/paper"
import { Picture } from "@/ui/picture"

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
 * Step 7 (docs/ux/04): the receipt after filing. A proud moment: the picture,
 * the ticket, what was filed, the estimate, the three confirmations with their
 * times and what happens next. Faculty never see which desk holds the paper,
 * so nothing here names one.
 */
export function FiledReceipt({
  claim,
  estimate,
  countOnly,
  ticks,
  minReferences,
  unclaimedLeft,
  firstClaim = false,
}: {
  claim: FiledClaim
  estimate: number | null
  countOnly: boolean
  ticks: Ticks
  minReferences: number
  /** Papers on my record still without a claim, after this one; null if unknown. */
  unclaimedLeft: number | null
  /** The first claim this person has ever filed: the bigger celebration. */
  firstClaim?: boolean
}) {
  const stage = stageOf(claim.status || "SUBMITTED")
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
          <p className="mt-2 text-fg-muted">Keep the ticket number. It is how you and the college refer to this claim.</p>
          {claim.ticket_number ? (
            <div className="mt-5 inline-flex items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-3">
              <span className="text-sm text-fg-muted">Ticket</span>
              <span className="font-mono text-2xl font-semibold tracking-wide sm:text-3xl" data-testid="filed-ticket">
                {claim.ticket_number}
              </span>
              <CopyButton value={claim.ticket_number} label="Copy ticket number" />
            </div>
          ) : (
            <p className="mt-4 text-sm text-fg-muted">The ticket number will appear on the paper's page.</p>
          )}
        </div>

        <StageTrack stage={stage} />

        <dl className="divide-y divide-line border-y border-line text-sm">
          <div className="py-4">
            <dt className="text-fg-muted">What you filed</dt>
            <dd className="mt-1 font-medium text-fg">{claim.paper_title || "Untitled paper"}</dd>
            {(claim.journal_title || claim.doi) && (
              <dd className="text-fg-muted">{[claim.journal_title, claim.doi].filter(Boolean).join(" · ")}</dd>
            )}
          </div>
          <div className="py-4">
            <dt className="text-fg-muted">Estimated payout</dt>
            <dd className="mt-1 text-xl font-semibold tabular">
              {countOnly ? "Counted only, no payment" : estimate != null ? money(estimate) : "Worked out on review"}
            </dd>
            {!countOnly && <dd className="text-xs text-fg-muted">An estimate. The amount is fixed when the claim is checked.</dd>}
          </div>
          <div className="py-4">
            <dt className="text-fg-muted">What you confirmed</dt>
            <dd>
              <ul className="mt-2 space-y-2">
                {confirmations(minReferences).map((c) => (
                  <li key={c.id} className="flex gap-2.5" data-condition={c.id}>
                    {ticks[c.id] ? (
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-positive" strokeWidth={2.25} />
                    ) : (
                      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full border border-edge" />
                    )}
                    <span>
                      <span className="font-medium text-fg">{c.label}</span>
                      <span className="block text-xs text-fg-muted">
                        {ticks[c.id] ? `Confirmed ${fmt(ticks[c.id])}` : "Not confirmed"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-fg-muted">These are stored with the claim.</p>
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
