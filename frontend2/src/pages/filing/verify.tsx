import { LoaderCircle, ShieldCheck } from "lucide-react"

import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { Callout, InlineError } from "@/ui/state"
import { Meta } from "@/ui/text"

import { CheckRow, type CheckState } from "./bits"
import type { LookupMetrics } from "./lookup"
import type { FormState, VerifyResult } from "./types"

/**
 * The pre-submission check: the facts the claim rules turn on that the
 * claimant cannot see from the form -- is the article indexed, is it on their
 * own author profile, has it been paid for before.
 *
 * `ok: false` means the index did not answer, not that it answered no, and
 * the two reasons it may not have are different sentences: this server has no
 * Scopus connection at all (production today -- the research cell confirms
 * indexing by hand, and filing asks for a one-line note), or it has one and
 * Scopus is down. Drawing either as "not indexed, not linked" would be four
 * accusations about a paper that is fine. Only the payment history, which is
 * a question about our own database, is always answered.
 */
export function VerifyPanel({
  form,
  result,
  busy,
  error,
  metrics,
  onRun,
  onGoToProfile,
}: {
  form: FormState
  result: VerifyResult | null
  busy: boolean
  error: string | null
  /** The journal's figures from our own tables, via the paper lookup. */
  metrics: LookupMetrics | null
  onRun: () => void
  onGoToProfile: () => void
}) {
  const haveAuthorId = Boolean(form.scopusAuthorUrl.trim())
  const reached = Boolean(result?.ok)
  const notConnected = result?.scopus_status === "not_configured"

  const indexed: CheckState = !result || !reached ? "unknown" : result.scopus.indexed ? "pass" : "fail"
  const linked: CheckState =
    !result || !reached
      ? "unknown"
      : !result.scopus.indexed
        ? "fail"
        : result.scopus.linked
          ? "pass"
          : haveAuthorId
            ? "fail"
            : "unknown"
  const standingIssues = (reached && result?.standing?.issues) || []

  return (
    <div className="space-y-4">
      {busy && !result && (
        <p className="flex items-center gap-1.5 text-base text-fg-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Checking the index, the journal and the payment history…
        </p>
      )}

      {error && !busy && <InlineError message={error} onRetry={onRun} />}

      {result && !reached && notConnected && (
        <Callout tone="info" title="Scopus is not connected on this server">
          So whether the paper is indexed and on your Scopus profile is checked by the research
          cell after you file. When you file you will be asked for a one-line note for them — that
          is expected, not a problem with your paper.
        </Callout>
      )}
      {result && !reached && !notConnected && (
        <Callout tone="caution" title="Scopus did not answer, so it could not be checked">
          {result.scopus.message || "The index is unreachable at the moment."} That is a fault at
          their end and says nothing about your paper. Filing is unaffected — try again in a
          minute, or carry on and let the research cell check it.
        </Callout>
      )}

      {result && (
        <ul className="divide-y divide-line border-y border-line">
          {reached && (
            <>
              <CheckRow
                state={indexed}
                label={result.scopus.indexed ? "Indexed in Scopus" : "Not found in Scopus"}
                detail={
                  result.scopus.indexed
                    ? result.scopus.message
                    : "A claim filed before the article is indexed cannot be processed. File again once the record appears."
                }
              />
              <CheckRow
                state={linked}
                label={
                  linked === "pass"
                    ? "On your Scopus author profile"
                    : linked === "unknown"
                      ? "Author profile not checked"
                      : "Not on your Scopus author profile"
                }
                detail={
                  linked === "unknown" ? (
                    <>
                      There is no Scopus author link on this claim to check against.{" "}
                      <button
                        type="button"
                        onClick={onGoToProfile}
                        className="font-medium text-accent underline underline-offset-2"
                      >
                        Add it
                      </button>{" "}
                      and this runs again.
                    </>
                  ) : linked === "fail" && result.scopus.indexed ? (
                    "Merge or link the article to your correct author ID with the Scopus Author Feedback Wizard before you file, or correct the profile link on this claim."
                  ) : linked === "fail" ? (
                    "There is nothing to link to yet — the row above is the reason. This settles itself when the article is indexed."
                  ) : null
                }
              />
              <CheckRow
                state={result.scimago.found ? "pass" : "unknown"}
                label={
                  result.scimago.found
                    ? `Quartile ${result.scimago.quartile || "unranked"} in Scimago`
                    : "Quartile not found automatically"
                }
                detail={
                  result.scimago.found
                    ? result.scimago.sjr != null
                      ? `SJR ${result.scimago.sjr}`
                      : null
                    : result.scimago.message ||
                      "Declare the quartile yourself — filing is refused without one unless you send a note."
                }
              />
              <CheckRow
                state={result.snip != null ? "pass" : "unknown"}
                label={result.snip != null ? `SNIP ${result.snip}` : "SNIP not found automatically"}
                detail={
                  result.snip == null
                    ? "Enter the SNIP printed on the journal's own Scopus page. It is one of the two terms the amount is worked out from."
                    : null
                }
              />
              {standingIssues.length > 0 && (
                <CheckRow
                  state="fail"
                  label="The journal has been removed from a recognised list"
                  detail={standingIssues.join(" · ")}
                />
              )}
            </>
          )}
          {/* Without Scopus the journal's figures still come from our own
              tables, so they are shown rather than left as "not checked". */}
          {!reached && metrics?.found && (
            <CheckRow
              state={metrics.quartile || metrics.snip != null ? "pass" : "unknown"}
              label={[
                metrics.quartile ? `Quartile ${metrics.quartile}` : null,
                metrics.snip != null ? `SNIP ${metrics.snip}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Journal found, with no figures"}
              detail={`From our SCImago and SNIP tables${metrics.dataset_year ? ` (${metrics.dataset_year})` : ""}, matched by ${metrics.matched_by === "title" ? "name" : "ISSN"}.`}
            />
          )}
          <CheckRow
            state={result.paid.warning ? "fail" : "pass"}
            label={
              result.paid.warning
                ? "A previous claim or payment matches this article"
                : "No previous payment found for this article"
            }
            detail={
              result.paid.warning
                ? "One incentive claim per article. Check the matches below — you can still file once you have."
                : null
            }
          />
        </ul>
      )}

      {result?.paid.warning && result.paid.matches.length > 0 && (
        <Callout tone="critical" title="This may already have been paid for">
          <ul className="mt-1 space-y-1.5">
            {result.paid.matches.slice(0, 5).map((m, i) => (
              <li key={i} className="text-sm">
                <span className="block break-words">{m.title || "Untitled"}</span>
                <span className="block text-fg-muted">
                  {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"}
                  {m.amount != null && <> — {money(m.amount)}</>}
                </span>
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button kind="default" onClick={onRun} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
          {busy ? "Checking…" : result || error ? "Check again" : "Run the check"}
        </Button>
        <Meta>Nothing here stops you filing. It is what the research cell checks after you do.</Meta>
      </div>
    </div>
  )
}
