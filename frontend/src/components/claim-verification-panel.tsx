import { useState } from "react"
import { toast } from "sonner"
import { CircleCheck, CircleHelp, CircleX, ShieldCheck } from "lucide-react"

import { Callout } from "@/components/form/fields"
import { Money } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type VerifyResult = {
  ok: boolean
  scopus: { indexed: boolean; linked: boolean; message?: string | null }
  scimago: {
    found: boolean
    quartile?: string | null
    sjr?: number | null
    official_url?: string | null
    message?: string | null
  }
  paid: { warning: boolean; matches: Array<{ title?: string | null; amount?: number | null }> }
  snip?: number | null
  engineering_class?: string | null
}

type CheckState = "pass" | "fail" | "unknown"

const STATE_STYLES: Record<CheckState, { Icon: typeof CircleCheck; className: string }> = {
  pass: { Icon: CircleCheck, className: "text-success" },
  fail: { Icon: CircleX, className: "text-destructive" },
  unknown: { Icon: CircleHelp, className: "text-muted-foreground" },
}

function CheckRow({
  state,
  label,
  detail,
}: {
  state: CheckState
  label: string
  detail?: React.ReactNode
}) {
  const { Icon, className } = STATE_STYLES[state]
  return (
    <li className="flex gap-2.5 px-4 py-2.5">
      <Icon aria-hidden className={cn("mt-px size-4 shrink-0", className)} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {detail ? <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p> : null}
      </div>
      <span className="sr-only">
        {state === "pass" ? "Passed" : state === "fail" ? "Failed" : "Not determined"}
      </span>
    </li>
  )
}

/**
 * Pre-submission check against the same sources the server verifies with.
 *
 * The claim rules turn on three facts the claimant cannot see from the form —
 * is it indexed, is it on their own author profile, has it been paid before —
 * and each one sends a filed ticket back. Better to fail here than at clearing.
 */
export function ClaimVerificationPanel({
  title,
  issn,
  scopusAuthorUrl,
  staffId,
  excludeClaimId,
}: {
  title: string
  issn?: string
  scopusAuthorUrl?: string
  staffId?: string
  excludeClaimId?: string | null
}) {
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    if (!title.trim()) {
      toast.error("Enter the paper title first")
      return
    }
    setBusy(true)
    try {
      const res = await api<VerifyResult>("/api/lookup/verify", {
        method: "POST",
        json: {
          title: title.trim(),
          issn: issn || null,
          scopus_author_url: scopusAuthorUrl || null,
          staff_id: staffId || null,
          exclude_claim_id: excludeClaimId || null,
        },
      })
      setResult(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification is unavailable right now")
    } finally {
      setBusy(false)
    }
  }

  const indexed: CheckState = !result ? "unknown" : result.scopus.indexed ? "pass" : "fail"
  const linked: CheckState = !result
    ? "unknown"
    : !result.scopus.indexed
      ? "fail"
      : result.scopus.linked
        ? "pass"
        : scopusAuthorUrl
          ? "fail"
          : "unknown"

  return (
    <section className="rounded-xl border border-border">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Pre-submission verification</p>
          <p className="text-xs text-muted-foreground">
            Checks Scopus indexing, author linkage, quartile, and prior payments.
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={run}>
          <ShieldCheck className="size-3.5" />
          {busy ? "Checking…" : result ? "Check again" : "Verify now"}
        </Button>
      </header>

      {!result ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          Not checked yet. This is the same check the system runs when you submit — running it now
          means a mismatch costs you a minute rather than a rejected ticket.
        </p>
      ) : (
        <div className="divide-y divide-border">
          <ul className="divide-y divide-border">
            <CheckRow
              state={indexed}
              label={result.scopus.indexed ? "Indexed in Scopus" : "Not found in Scopus"}
              detail={
                result.scopus.indexed
                  ? result.scopus.message
                  : "Submissions made before indexing are not processed — file again once the article appears."
              }
            />
            <CheckRow
              state={linked}
              label={
                linked === "pass"
                  ? "Linked to your Scopus author profile"
                  : linked === "unknown"
                    ? "Author linkage not checked"
                    : "Not linked to your author profile"
              }
              detail={
                linked === "unknown"
                  ? "Add your Scopus author link to your profile so this can be checked."
                  : linked === "fail" && result.scopus.indexed
                    ? "Use the Scopus Author Feedback Wizard to merge or link the article to your correct ID before submitting."
                    : null
              }
            />
            <CheckRow
              state={result.scimago.found ? "pass" : "unknown"}
              label={
                result.scimago.found
                  ? `Quartile ${result.scimago.quartile || "—"} from Scimago`
                  : "Quartile not found automatically"
              }
              detail={
                result.scimago.found
                  ? result.scimago.sjr != null
                    ? `SJR ${result.scimago.sjr}`
                    : null
                  : result.scimago.message || "Select the quartile yourself on the Claim step."
              }
            />
            <CheckRow
              state={result.snip != null ? "pass" : "unknown"}
              label={result.snip != null ? `SNIP ${result.snip}` : "SNIP not found automatically"}
              detail={
                result.snip == null ? "Enter the SNIP printed on the journal's Scopus page." : null
              }
            />
            <CheckRow
              state={result.paid.warning ? "fail" : "pass"}
              label={
                result.paid.warning
                  ? "A prior claim or payment matches this article"
                  : "No previous claim found for this article"
              }
              detail={
                result.paid.warning
                  ? "Only one incentive claim is allowed per article. Check the matches below before submitting."
                  : null
              }
            />
          </ul>

          {result.paid.warning ? (
            <div className="px-4 py-3">
              <Callout tone="danger" title="Possible duplicate claim">
                <ul className="mt-1 space-y-1">
                  {result.paid.matches.slice(0, 5).map((m, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">{m.title || "Untitled"}</span>
                      {m.amount != null ? (
                        <span className="shrink-0 tabular-nums">
                          <Money value={m.amount} />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Callout>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
