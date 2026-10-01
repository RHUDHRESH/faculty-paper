import { Link } from "react-router-dom"

import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/ui/sheet"
import { InlineError, SkeletonText } from "@/ui/state"
import { ColumnLabel, Meta } from "@/ui/text"

/**
 * "Why this amount": the answer to the question Finance and faculty both ask,
 * for any claim, without leaving Track.
 *
 * It reads what was stored when the claim was priced (the policy version, the
 * SNIP, the quartile, the author's share) and the ledger rows that paid it, so
 * it explains the amount that was decided and not one worked out again today.
 * An old-ERP claim that came in with an amount and no working says so instead
 * of showing an invented sum.
 */

type Why = {
  id: string
  ticket_number: string | null
  paper_title: string | null
  owner_name: string
  amount: number | null
  amount_note: string | null
  priced: boolean
  message: string | null
  policy: { name: string; version: number | null; in_force_now: boolean; effective_from: string | null } | null
  terms: { label: string; detail: string; amount: number | null }[]
  quota: { applied: boolean; note: string | null } | null
  note: string | null
  threshold: { limit: number; over: boolean; detail: string } | null
  ledger: { month: string | null; voucher: string | null; amount: number; kind: string }[]
  ledger_total: number
}

function monthName(ym: string | null): string {
  if (!ym) return "No month"
  const [y, m] = ym.split("-").map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}

export function WhyAmountSheet({
  claimId,
  openHref,
  onClose,
}: {
  claimId: string | null
  /** Where "Open the claim" goes for this reader. */
  openHref: string | null
  onClose: () => void
}) {
  const q = useApi<Why>(["claim", claimId, "why-amount"], `/api/claims/${claimId}/why-amount`, {
    enabled: !!claimId,
  })
  const d = q.data

  return (
    <Sheet open={!!claimId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="why-desc" className="sm:w-[30rem]">
        <SheetHeader>
          <SheetTitle>Why this amount</SheetTitle>
          <SheetDescription id="why-desc">
            {d
              ? [d.ticket_number ?? "No claim number", paperTitle(d.paper_title), d.owner_name].join(" · ")
              : "How the amount on this claim was worked out."}
          </SheetDescription>
        </SheetHeader>

        <SheetBody className="space-y-6">
          {q.isError ? (
            <InlineError
              message={q.error?.status === 404 ? "This claim could not be found." : "Could not load the working."}
              onRetry={() => void q.refetch()}
            />
          ) : !d ? (
            <SkeletonText lines={5} />
          ) : (
            <>
              <div>
                <Meta className="block">Amount</Meta>
                <p className="text-3xl font-semibold tabular" data-testid="why-amount">
                  {d.amount != null ? money(d.amount) : d.amount_note ?? "Not recorded"}
                </p>
                {d.policy && (
                  <Meta className="mt-1 block">
                    Priced under {d.policy.name}
                    {d.policy.in_force_now ? ", the policy in force now." : ". This is not the policy in force now."}
                  </Meta>
                )}
              </div>

              {!d.priced && d.message && <p className="text-base text-fg-muted">{d.message}</p>}

              {d.terms.length > 0 && (
                <section aria-label="How it was worked out" className="space-y-2">
                  <ColumnLabel className="block">How it was worked out</ColumnLabel>
                  <dl className="divide-y divide-line border-y border-line">
                    {d.terms.map((t) => (
                      <div key={t.label} className="flex items-baseline justify-between gap-4 py-2.5">
                        <dt className="min-w-0">
                          <span className="block text-sm font-medium">{t.label}</span>
                          <span className="block text-pretty text-sm text-fg-muted">{t.detail}</span>
                        </dt>
                        <dd className="shrink-0 text-sm tabular">{t.amount != null ? money(t.amount) : ""}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {d.quota && (
                <p className="text-sm text-fg-muted">
                  Inside the research quota, so the amount payable is nil. {d.quota.note}
                </p>
              )}
              {d.note && <p className="text-pretty text-sm text-fg-muted">{d.note}</p>}
              {d.threshold && <p className="text-pretty text-sm text-fg-muted">{d.threshold.detail}</p>}

              <section aria-label="Ledger rows" className="space-y-2">
                <ColumnLabel className="block">What the ledger says</ColumnLabel>
                {d.ledger.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    {d.amount != null && d.amount > 0
                      ? "No ledger row is on record for this claim."
                      : "Nothing has been paid, so there is no ledger row."}
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-fg-muted">
                        <th scope="col" className="py-1.5 pr-3 font-medium">Month paid</th>
                        <th scope="col" className="py-1.5 pr-3 font-medium">Voucher</th>
                        <th scope="col" className="py-1.5 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line border-y border-line">
                      {d.ledger.map((r, i) => (
                        <tr key={i}>
                          <td className="py-2 pr-3">{monthName(r.month)}</td>
                          <td className="py-2 pr-3">{r.voucher ?? "No voucher recorded"}</td>
                          <td className="py-2 text-right tabular">{money(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={2} className="py-2 text-left font-medium">Total in the ledger</th>
                        <td className="py-2 text-right font-medium tabular">{money(d.ledger_total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </section>
            </>
          )}
        </SheetBody>

        <SheetFooter>
          {openHref && (
            <Button kind="default" size="sm" asChild>
              <Link to={openHref}>Open the claim</Link>
            </Button>
          )}
          <Button kind="quiet" size="sm" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
