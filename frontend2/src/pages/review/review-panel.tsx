import { Link } from "react-router-dom"
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react"

import type { Role } from "@/app/auth"
import { paperTitle } from "@/lib/names"
import { cn } from "@/lib/cn"
import { PaperLinks } from "@/pages/claim-context"
import { ClaimFlagsPanel, useClaimReview } from "@/pages/claim-review"
import { ClaimOfficeThread } from "@/pages/clearing-thread"
import { SchemeRules, WatchCallout } from "@/pages/clearing-desk"
import { HoldNote } from "@/ui/desk-actions"
import { categoryLabel, money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { PastCases } from "@/ui/past-cases"
import { MarkList, type ChecklistKey, type ChecklistState } from "@/ui/review-marks"
import { Callout } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"

import { Checklist } from "./checklist"
import { claimDiff, type DiffRow } from "./claim-diff"
import { actionSentence, formatDateTime } from "./history"
import type { WorkspaceClaim } from "./types"

/**
 * Everything the reviewer needs to judge one claim, in the order they judge
 * it: who filed it, what they claimed against what the record says, what they
 * confirmed, then the reviewer's own checklist and marks, and last the
 * background (flags, past cases, history).
 *
 * It only reads from the claim it is given. The one request that produced
 * the claim (`/api/claims/{id}/workspace`) also filled the flags' cache, so
 * this panel opens with nothing left to load.
 */

type Extras = {
  /** The reviewer's own claim: no flags, and the server says so too. */
  own: boolean
  /** The flags section is shown only to the desks that may see flags. */
  showFlags: boolean
}

export function ReviewPanel({
  claim,
  role,
  checklist,
  onChecklist,
  extras,
}: {
  claim: WorkspaceClaim
  role: Role | undefined
  checklist: ChecklistState
  onChecklist: (key: ChecklistKey, change: { status?: "ok" | "issue" | "needs_info" | null; note?: string }) => void
  extras: Extras
}) {
  const rows = claimDiff(claim)
  const issues = verificationIssues(claim)
  const duplicateMatches = parseJson<DuplicateMatch[]>(claim.duplicate_matches_json, [])
  const review = useClaimReview(claim.id, extras.showFlags && !extras.own)

  // A row that disagrees with the record is the checklist's first suggestion
  // for what to look at; it is a hint under the row, never an answer.
  const hints: Partial<Record<ChecklistKey, string>> = {}
  for (const r of rows) {
    if (!r.differs || !r.why) continue
    const key = HINT_KEY[r.key]
    if (key && !hints[key]) hints[key] = r.why
  }
  if (claim.duplicate_warning) hints.duplicate = "The record shows this paper may already have been paid."

  return (
    <div className="space-y-7 px-4 py-4">
      <div className="space-y-3 empty:hidden">
        <HoldNote claim={claim} />
        {claim.status_note && !/^Imported from/i.test(claim.status_note) && (
          <Callout tone="caution" title="Sent back to this desk">
            <p>{claim.status_note}</p>
          </Callout>
        )}
        {claim.journal_watch && <WatchCallout watch={claim.journal_watch} />}
        {claim.duplicate_warning && (
          <Callout tone="critical" title="This paper may already have been paid">
            {duplicateMatches.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {duplicateMatches.map((m, i) => (
                  <li key={m.id ?? i} className="text-sm">
                    {m.source === "claim" && m.id ? (
                      <Link to={`/papers/${m.id}`} className="underline underline-offset-2">
                        {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "The other claim"}
                      </Link>
                    ) : (
                      [m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"
                    )}
                    {m.amount != null && <> · {money(m.amount)}</>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Check the payment history before this goes any further.</p>
            )}
            {claim.override_duplicate && (
              <p className="mt-1.5 text-sm">
                Overridden{claim.override_by_name ? ` by ${claim.override_by_name}` : ""}
                {claim.override_reason ? `: ${claim.override_reason}` : "."}
              </p>
            )}
          </Callout>
        )}
      </div>

      <section aria-label="Claimant" className="space-y-2">
        <div className="flex items-center gap-3">
          <Avatar
            person={{ name: claim.owner_name, initials: initialsOf(claim.owner_name), photo_url: claim.owner_photo_url ?? null }}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium">{claim.owner_name}</p>
            <Meta className="block break-words">{[claim.owner_department, claim.owner_email].filter(Boolean).join(" · ")}</Meta>
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
              {claim.owner_id && (
                <Link to={`/u/${claim.owner_id}`} className="text-accent underline-offset-2 hover:underline">
                  Profile
                </Link>
              )}
              <a href="#past-cases" className="text-accent underline-offset-2 hover:underline">
                Past cases
              </a>
            </p>
          </div>
        </div>
        <p className="break-words text-sm text-fg-muted">
          <span className="text-fg">{paperTitle(claim.paper_title)}</span>
          {claim.journal_title ? ` · ${claim.journal_title}` : ""}
          {claim.publication_year ? ` · ${claim.publication_year}` : ""}
        </p>
        <PaperLinks doi={claim.doi} eid={claim.eid} scopusUrl={claim.scopus_url} />
        <ClaimOfficeThread claimId={claim.id} />
      </section>

      <section aria-labelledby="rv-diff" className="space-y-2">
        <SectionTitle>
          <span id="rv-diff">Claimed and on record</span>
        </SectionTitle>
        <DiffTable rows={rows} />
        {claim.verification_ok === false && issues.length > 0 && (
          <ul className="space-y-1 text-sm text-critical">
            {issues.map((issue, i) => (
              <li key={i} className="flex gap-1.5">
                <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {issue}
              </li>
            ))}
          </ul>
        )}
        {claim.verification_ok === true && (
          <p className="flex items-center gap-1.5 text-sm text-positive">
            <CheckCircle2 className="size-3.5" aria-hidden /> The automatic checks found no issues.
          </p>
        )}
        {claim.verification_ok == null && <p className="text-sm text-fg-muted">The automatic checks have not run on this claim.</p>}
      </section>

      <section aria-labelledby="rv-amount" className="space-y-2">
        <SectionTitle>
          <span id="rv-amount">The incentive</span>
        </SectionTitle>
        <p className="tabular text-2xl font-semibold">{claim.calc_error ? "No amount" : money(claim.remuneration)}</p>
        {claim.remuneration_category && <p className="text-sm text-fg-muted">{categoryLabel(claim.remuneration_category)}</p>}
        {claim.calc_error && (
          <Callout tone="critical" title="This amount could not be worked out">
            {claim.calc_error}
          </Callout>
        )}
        {claim.remuneration_is_estimate && !claim.calc_error && (
          <Callout tone="caution" title="This is an estimate">
            It rests on figures the claimant reported, not confirmed ones.
          </Callout>
        )}
        <SchemeRules c={claim} />
      </section>

      <section aria-labelledby="rv-confirm" className="space-y-2">
        <SectionTitle>
          <span id="rv-confirm">What the claimant confirmed</span>
        </SectionTitle>
        {!claim.confirmations || claim.confirmations.length === 0 ? (
          <p className="text-sm text-fg-muted">No confirmations on record for this claim.</p>
        ) : (
          <ul className="space-y-2">
            {claim.confirmations.map((cf) => (
              <li key={cf.id} className="flex gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-pretty">{cf.text}</span>
                  <Meta className="block">
                    Ticked {formatDateTime(cf.ticked_at)}
                    {cf.user_name ? ` by ${cf.user_name}` : ""}
                  </Meta>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="rv-checklist" className="space-y-2">
        <SectionTitle>
          <span id="rv-checklist">Your checklist</span>
        </SectionTitle>
        <Checklist state={checklist} onChange={onChecklist} hints={hints} />
      </section>

      <section aria-labelledby="rv-marks" className="space-y-2">
        <SectionTitle>
          <span id="rv-marks">Marks on the document</span>
        </SectionTitle>
        <MarkList claimId={claim.id} />
      </section>

      {extras.showFlags && !extras.own && (
        <ClaimFlagsPanel
          claimId={claim.id}
          review={review.data}
          loading={review.isLoading}
          failed={review.isError}
          onRetry={() => void review.refetch()}
        />
      )}

      <section id="past-cases" aria-labelledby="rv-past" className="scroll-mt-4 space-y-2">
        <SectionTitle>
          <span id="rv-past">Past cases</span>
        </SectionTitle>
        <PastCases claimId={claim.id} role={role} />
      </section>

      <section aria-labelledby="rv-history" className="space-y-2">
        <SectionTitle>
          <span id="rv-history">History</span>
        </SectionTitle>
        {!claim.actions || claim.actions.length === 0 ? (
          <p className="text-sm text-fg-muted">No history recorded.</p>
        ) : (
          <ul className="space-y-3 border-l border-line pl-4">
            {[...claim.actions].reverse().map((a) => (
              <li key={a.id} className="text-sm">
                <p>{actionSentence(a)}</p>
                <Meta>
                  {a.actor_name} · {formatDateTime(a.created_at)}
                </Meta>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** Which checklist row a record difference belongs to. */
const HINT_KEY: Record<string, ChecklistKey | undefined> = {
  snip: "quartile",
  quartile: "quartile",
  author_position: "author_position",
  affiliation: "affiliation",
  doi: "indexing",
  issn: "indexing",
  indexing: "indexing",
}

type DuplicateMatch = {
  source?: string | null
  id?: string | null
  amount?: number | null
  reference?: string | null
  who?: string | null
  when?: string | null
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw) as T
    return v ?? fallback
  } catch {
    return fallback
  }
}

function verificationIssues(c: WorkspaceClaim): string[] {
  const snap = parseJson<{ issues?: unknown }>(c.verification_snapshot_json, {})
  return Array.isArray(snap.issues) ? snap.issues.filter((i): i is string => typeof i === "string") : []
}

/** The claim against the record. A row the record disagrees with is red in
 *  words as well as colour, and says why in a sentence beneath it. */
function DiffTable({ rows }: { rows: DiffRow[] }) {
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <thead>
        <tr className="text-left text-xs text-fg-muted">
          <th scope="col" className="w-[28%] py-1 pr-2 font-normal">
            Figure
          </th>
          <th scope="col" className="py-1 pr-2 font-normal">
            Claimant says
          </th>
          <th scope="col" className="py-1 font-normal">
            Record says
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={cn("border-t border-line align-top", r.differs && "bg-critical-wash")}>
            <th scope="row" className="py-1.5 pl-1.5 pr-2 text-left font-normal text-fg-muted">
              {r.label}
            </th>
            <td className="break-words py-1.5 pr-2 tabular">{r.claimed}</td>
            <td className={cn("break-words py-1.5 pr-1.5 tabular", r.differs && "font-medium text-critical")}>
              {r.differs && <AlertTriangle className="mr-1 inline size-3.5 align-text-bottom" aria-hidden />}
              {r.record}
              {r.differs && <span className="sr-only"> (differs from the claim)</span>}
              {r.differs && r.why && <span className="mt-0.5 block text-xs font-normal">{r.why}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
