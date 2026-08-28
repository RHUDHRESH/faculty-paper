import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useApi, useApiMutation } from "@/lib/query"
import { AttachmentGallery, type Attachment } from "@/ui/attachments"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import {
  categoryLabel,
  money,
  payoutWorking,
  PayoutWorking,
  StageTrack,
  stageOf,
} from "@/ui/paper"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonText } from "@/ui/state"
import { ColumnLabel, Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * One paper, in full — what a claimant or an approver opens a ticket number
 * to find out.
 *
 * Four questions, answered in the order somebody actually asks them: where
 * it is, who is holding it and how long it has been there; if it came back,
 * what to fix; why the amount is what it is, with the working shown rather
 * than only the total; and what has happened to it. A rejected ticket puts
 * its reason before anything else — the old app buried a sent-back reason
 * under the amount and the stage, and the one sentence somebody arrived for
 * was the last thing they read, if they found it at all.
 *
 * The test this page has to pass: somebody who has waited three weeks for
 * ₹50,000 should be able to read it once and know where their money is, what
 * it will be, and what — if anything — they have to do. Everything here that
 * says a figure also says where the figure came from and whether anybody has
 * checked it, because an unchecked SNIP is the ordinary reason a claim comes
 * back and it is not the claimant's job to guess that from the word
 * "manually".
 */

type DuplicateMatch = {
  source?: string | null
  id?: string | null
  title?: string | null
  amount?: number | null
  reference?: string | null
  who?: string | null
  when?: string | null
}

type ClaimAction = {
  id: string
  action: string
  from_status: string | null
  to_status: string
  note: string | null
  actor_name: string
  created_at: string
}

type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  doi: string | null
  issn: string | null
  publication_year: number | null
  publication_date: string | null
  publication_type: string | null
  status: string
  status_note: string | null
  owner_id: string
  owner_name: string
  owner_email: string
  owner_department: string | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  qf_amount: number | null
  base_amount: number | null
  author_point: number | null
  remuneration_category: string | null
  remuneration_note: string | null
  snip: number | null
  snip_source: "SCOPUS" | "SNIP_DUMP" | "MANUAL" | null
  self_reported_snip: number | null
  quartile: string | null
  quartile_source: "SCIMAGO" | "MANUAL" | null
  self_reported_quartile: string | null
  manual_verified_by_name: string | null
  manual_verification_note: string | null
  scimago_sjr: number | null
  scimago_dataset_year: number | null
  author_position: number | null
  total_authors: number | null
  authors_json: string | null
  attachments: Attachment[]
  duplicate_warning: boolean
  duplicate_matches_json: string | null
  override_duplicate: boolean | null
  override_reason: string | null
  override_by_name: string | null
  calc_error: string | null
  created_at: string | null
  updated_at: string | null
  submitted_at: string | null
  // The dates the ticket itself carries. Most paid tickets in this system
  // were imported from the college's earlier records and have no recorded
  // steps at all, so these are the only account of what happened to them.
  cleared_at: string | null
  cleared_by_name: string | null
  principal_approved_at: string | null
  principal_approved_by_name: string | null
  director_approved_at: string | null
  director_approved_by_name: string | null
  paid_at: string | null
  actions?: ClaimAction[]
  team: Team | null
}

type Team = {
  code: string
  title: string | null
  department: string | null
  academic_year: string | null
  mentor_name: string | null
  members: TeamMember[]
}

type TeamMember = {
  name: string
  register_number: string | null
  programme: string | null
  year_of_study: string | null
  mentor_name: string | null
}

type Note = {
  id: string
  body: string
  author_name: string | null
  author_role: string | null
  created_at: string
  resolved_at: string | null
  resolved_by_name: string | null
}

export function PaperDetail() {
  const { id } = useParams<{ id: string }>()
  const { me } = useAuth()
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)

  const {
    data: claim,
    isLoading,
    error,
    refetch,
  } = useApi<Claim>(["claim", id], `/api/claims/${id}`, { enabled: !!id })

  const withdraw = useApiMutation<Record<string, never>, Claim>(
    `/api/claims/${id}/withdraw`,
    { invalidates: [["claim", id], ["my-claims"]] }
  )

  if (isLoading) {
    return (
      <div className="page space-y-8 py-8">
        <Skeleton className="h-4 w-24" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-2/3 max-w-md" />
          <Skeleton className="h-4 w-48" />
        </div>
        <SkeletonText lines={4} />
      </div>
    )
  }

  if (error) {
    if (error.status === 403) {
      return (
        <div className="page py-8">
          {/* The server's own sentence when it sent one. The only 403 this
              endpoint returns is the head-of-department refusal, which
              explains where their answer actually lives — and a page that
              overwrites it with "this paper is not yours" sends a head to
              argue about ownership they never claimed. */}
          <ErrorState
            title="You cannot open this ticket"
            message={
              error.message ||
              "You can only open a paper you filed, or one waiting in a queue you handle."
            }
          />
        </div>
      )
    }
    if (error.status === 404) {
      return (
        <div className="page py-8">
          <ErrorState
            title="This paper does not exist"
            message="It may have been withdrawn, or the link is wrong."
          />
        </div>
      )
    }
    return (
      <div className="page py-8">
        <ErrorState onRetry={() => void refetch()} />
      </div>
    )
  }

  if (!claim) {
    return (
      <div className="page py-8">
        <EmptyState title="Nothing here" message="This paper has no record to show." />
      </div>
    )
  }

  const stage = stageOf(claim.status)
  const isOwner = !!me && me.id === claim.owner_id
  const canWithdraw = isOwner && claim.status === "SUBMITTED"
  // A sent-back paper is editable, not just a draft.
  //
  // The brief this page was first built against said DRAFT only, and that was
  // wrong: the server accepts a PATCH on both, and `stageOf("REJECTED")` tells
  // the reader in as many words to "edit the details and file it again". Take
  // the button away and the page spends a paragraph explaining what to fix and
  // then offers no way to fix it — which is where the old app left people, and
  // the reason they emailed the research cell instead.
  const canEdit = isOwner && (claim.status === "DRAFT" || claim.status === "REJECTED")
  const duplicateMatches = parseJsonArray<DuplicateMatch>(claim.duplicate_matches_json)
  const lastRejection = [...(claim.actions || [])]
    .reverse()
    .find((a) => a.action === "REJECT" || a.action === "PRINCIPAL_SEND_BACK")

  // A note is not only attached to a REJECTED paper.
  //
  // When the Principal sends a ticket back, the server writes their reason to
  // `status_note` and returns the claim to SUBMITTED — back to the research
  // cell, not to the claimant. Keying this block on `status === "REJECTED"`
  // therefore hid it completely: the Principal is *required* to give a reason,
  // and nobody could read it anywhere. The ticket simply reappeared in the
  // clearing queue with no explanation attached.
  const sentBackByPrincipal = lastRejection?.action === "PRINCIPAL_SEND_BACK"
  const showSendBack = Boolean(
    claim.status_note && (claim.status === "REJECTED" || sentBackByPrincipal)
  )

  const settled = claim.status === "PAID"
  const working = payoutWorking(claim)
  // Which of the two figures the amount rests on were typed in rather than
  // matched against a published dataset. Both are grounds for the research
  // cell to change the amount, so the reader is told before they plan on it.
  // A value the research cell verified by hand on purpose is not the same
  // thing as one nobody has looked at, so `manual_verified_by_name` takes the
  // warning away: somebody with the authority to check it has checked it.
  const handEntered = claim.manual_verified_by_name
    ? []
    : [
        claim.snip_source === "MANUAL" ? "the SNIP" : null,
        claim.quartile_source === "MANUAL" ? "the quartile" : null,
      ].filter((v): v is string => v !== null)
  const dates = ticketDates(claim)
  const waiting = waitingLine(claim)
  const provenance = provenanceLines(claim)

  return (
    <div className="page space-y-10 py-8">
      {/* The one sentence a sent-back paper's owner came here for, before
          anything else — including the back link. */}
      {showSendBack && (
        <Callout
          tone="critical"
          title={
            sentBackByPrincipal && claim.status !== "REJECTED"
              ? "The Principal sent this back to the research cell"
              : "Sent back — what to fix"
          }
        >
          <p>{claim.status_note}</p>
          {lastRejection && (
            <p className="mt-1.5 text-sm text-fg-muted">
              {lastRejection.actor_name} · {formatDateTime(lastRejection.created_at)}
            </p>
          )}
        </Callout>
      )}

      <Link
        to="/papers"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        My papers
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <PageTitle className="break-words">{claim.paper_title || "Untitled"}</PageTitle>
            <Sub className="mt-1">
              {claim.ticket_number ? `Ticket ${claim.ticket_number}` : "Not yet filed"}
              {claim.journal_title ? ` · ${claim.journal_title}` : ""}
            </Sub>
          </div>
          {(canEdit || canWithdraw) && (
            <div className="flex shrink-0 items-center gap-2">
              {canEdit && (
                <Button kind="default" asChild>
                  <Link to={`/papers/${claim.id}/edit`}>Edit</Link>
                </Button>
              )}
              {canWithdraw && (
                <Button kind="quiet" onClick={() => setConfirmWithdraw(true)}>
                  Withdraw
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="w-full max-w-md space-y-2">
          <p className="text-base font-medium">{stage.label}</p>
          <StageTrack stage={stage} />
          {/* Who is holding it, said after the picture rather than instead of
              it. This was the only answer the page gave. */}
          <p className="text-sm text-fg-muted">{stage.who}</p>
          {/* The question somebody who has waited three weeks actually opens
              this page with. The page carried the dates in its payload and
              printed none of them anywhere above the history, so "how long
              has this been sitting there" had no answer on the screen. */}
          {waiting && <Meta className="block">{waiting}</Meta>}
        </div>
      </header>

      {claim.duplicate_warning && (
        <Callout tone="critical" title="This paper may already have been paid">
          <p>Check the matches below before this goes any further.</p>
          {duplicateMatches.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {duplicateMatches.map((m, i) => (
                <li key={m.id ?? i} className="text-sm">
                  {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"}
                  {m.amount != null && <> — {money(m.amount)}</>}
                </li>
              ))}
            </ul>
          )}
          {claim.override_duplicate && (
            <p className="mt-2 text-sm">
              Overridden{claim.override_by_name ? ` by ${claim.override_by_name}` : ""}
              {claim.override_reason ? `: ${claim.override_reason}` : "."}
            </p>
          )}
        </Callout>
      )}

      <section className="space-y-4">
        <SectionTitle>
          {isOwner
            ? settled
              ? "What you were paid"
              : "What you will be paid"
            : settled
              ? "What was paid"
              : "What this pays"}
        </SectionTitle>

        {/* The page's one lead surface. Of the four questions this screen
            answers, this is the one nobody scrolls past, and until it had a
            ground of its own the amount sat on the same white as the ISSN. */}
        <div className="panel-lead space-y-4 p-4 sm:p-5">
          <div>
            {/* A figure this size with no caption reads as a promise, and it
                is not one until the Director has authorised it. */}
            {!claim.calc_error && (
              <p className="text-sm text-fg-muted">{amountCaption(claim, settled)}</p>
            )}
            {claim.calc_error ? (
              <p className="text-lg font-medium text-critical">
                No amount could be worked out for this paper
              </p>
            ) : (
              <Figure className="mt-0.5 block text-3xl">{money(claim.remuneration)}</Figure>
            )}
            {categoryLabel(claim.remuneration_category) && (
              <p className="mt-1 text-sm text-fg-muted">
                {categoryLabel(claim.remuneration_category)}
              </p>
            )}
          </div>

          {claim.calc_error ? null : working.length > 0 ? (
            <div className="space-y-2 border-t border-line pt-4">
              <ColumnLabel>How that is worked out</ColumnLabel>
              <PayoutWorking facts={claim} />
              {claim.remuneration_category === "I" && (
                // The old page printed `[(SNIP × 55,000) + QFA] × APP` and
                // expanded neither initialism anywhere on the screen. The sum
                // above is now the explanation; this stays only so an approver
                // holding the policy document can see the two match, and it
                // names both symbols where it uses them.
                <p className="pt-1 text-xs text-fg-subtle">
                  The policy writes this as [(SNIP × rate per point) + QFA] × APP,
                  where QFA is the quartile incentive and APP the author-position
                  share.
                </p>
              )}
            </div>
          ) : (
            <p className="border-t border-line pt-4 text-sm text-fg-muted">
              {noWorkingReason(claim, settled)}
            </p>
          )}
        </div>

        {claim.calc_error && (
          <Callout tone="critical" title="This amount could not be worked out">
            {claim.calc_error}
          </Callout>
        )}

        {/* Unmissable on purpose — this is the one fact that changes what a
            reader should do with the number above. */}
        {claim.remuneration_is_estimate ? (
          <Callout tone="caution" title="This is an estimate, not a decision">
            It is worked out from the SNIP and quartile reported on the form, not
            from figures anyone has checked. The research cell matches both
            against Scopus and Scimago when they look at the ticket, and the
            amount changes if either turns out to be different.
          </Callout>
        ) : handEntered.length > 0 && !settled ? (
          // "Entered manually" appeared twice on the old page as a bare phrase
          // with nothing to say why a reader should care. It means the figure
          // was typed in rather than matched against the published data — the
          // single most common reason a claim comes back — so it is said in
          // those words, once, where it changes what the reader should expect.
          <Callout
            tone="caution"
            title={`${capitalise(sentenceList(handEntered))} ${
              handEntered.length === 1 ? "was" : "were"
            } typed in by hand`}
          >
            Nobody has matched {handEntered.length === 1 ? "it" : "them"} against
            the published Scopus and Scimago data yet, and the amount above rests
            on {handEntered.length === 1 ? "it" : "them"} being right. The research
            cell checks {handEntered.length === 1 ? "it" : "both"} before the
            ticket moves on, and the amount changes if the published value turns
            out to be different. Nothing for you to do unless somebody asks you
            for the journal's page.
          </Callout>
        ) : null}

        <div className="space-y-1.5">
          {provenance.map((line) => (
            <p key={line} className="text-sm text-fg-muted">
              {line}
            </p>
          ))}
          {claim.manual_verified_by_name && (
            <p className="text-sm text-fg-muted">
              Checked by hand by {claim.manual_verified_by_name}
              {claim.manual_verification_note ? `: ${claim.manual_verification_note}` : "."}
            </p>
          )}
          {claim.remuneration_note && (
            <p className="text-sm text-fg-muted">{claim.remuneration_note}</p>
          )}
        </div>
      </section>

      <section className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
        <div className="space-y-3">
          <SectionTitle>The paper</SectionTitle>
          <dl className="space-y-2 text-sm">
            <DetailRow label="Journal" value={claim.journal_title} />
            <DetailRow
              label="DOI"
              value={
                claim.doi ? (
                  <a
                    href={`https://doi.org/${claim.doi}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline-offset-4 hover:underline"
                  >
                    {claim.doi}
                  </a>
                ) : null
              }
            />
            <DetailRow label="ISSN" value={claim.issn} />
            <DetailRow label="Published" value={formatPubDate(claim)} />
            <DetailRow label="Type" value={claim.publication_type} />
            {/* Names only. "Position 1 of 1" used to appear here as well as
                under the author-position share, and of the two places the
                share is the one where it is doing work: it is the reason that
                number is what it is. Repeated here it read as a second,
                unrelated fact about the paper. */}
            <DetailRow label="Authors" value={authorNames(claim)} />
          </dl>
        </div>
      </section>

      {/* Its own full-width section rather than half of the grid above. It
          used to be a column of text links beside the journal details, which
          is the size a list of filenames needs and nothing like the size
          evidence needs: a thumbnail an approver can recognise, and a
          reference's number and title beside it, do not fit in half a
          column. */}
      <section className="space-y-3">
        <SectionTitle>Attachments</SectionTitle>
        <AttachmentGallery
          files={claim.attachments}
          emptyLabel={
            <>
              No files are attached to this ticket.
              {canEdit
                ? " Use Edit to add the published paper and the pages showing your SEC-affiliated references."
                : ""}
            </>
          }
        />
      </section>

      {claim.team ? <TeamPanel team={claim.team} /> : null}

      <Notes claimId={claim.id} />

      <section className="space-y-3">
        <SectionTitle>History</SectionTitle>
        {claim.actions && claim.actions.length > 0 ? (
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
        ) : dates.length > 0 ? (
          // Not "No history recorded". Almost every settled ticket in this
          // system was brought across from the college's earlier records
          // rather than filed here, so it genuinely has no recorded steps —
          // but it does carry its own dates, and printing nothing while
          // holding the date it was paid is the page keeping a secret it does
          // not have.
          <>
            <p className="text-sm text-fg-muted">
              No step-by-step record was kept for this ticket — it did not travel
              through this system one desk at a time. These are the dates the
              ticket itself carries, and they are all that is known about it.
            </p>
            <ul className="space-y-3 border-l border-line pl-4">
              {dates.map((d) => (
                <li key={d.label} className="text-sm">
                  <p>{d.label}</p>
                  <Meta>{[d.who, formatDateTime(d.at)].filter(Boolean).join(" · ")}</Meta>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            Nothing has happened to this ticket yet. From the moment you file it,
            every step — who moved it, when, and anything they wrote — is listed
            here.
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        title="Withdraw this paper?"
        description={`It goes back to a draft so you can fix it.${
          claim.ticket_number ? ` Ticket ${claim.ticket_number} stays the same.` : ""
        }`}
        confirmLabel="Withdraw"
        onConfirm={async () => {
          try {
            await withdraw.mutateAsync({})
            toast.ok(
              claim.ticket_number
                ? `Withdrawn — ticket ${claim.ticket_number} is back in your drafts`
                : "Withdrawn — it is back in your drafts"
            )
          } catch (err) {
            toast.fail(err)
          }
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Small pieces                                                             */
/* ------------------------------------------------------------------------ */

function DetailRow({ label, value }: { label: string; value: React.ReactNode | null | undefined }) {
  if (value === null || value === undefined || value === "") return null
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  )
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

/**
 * The caption over the headline figure.
 *
 * A number this size with no caption is read as a promise. It is not one
 * until the Director has authorised it, and a claimant who plans around an
 * amount that four desks can still change has been misled by the page rather
 * than by anybody in the chain.
 */
function amountCaption(c: Claim, settled: boolean): string {
  if (settled) return c.paid_at ? `Paid on ${formatDate(c.paid_at)}` : "Paid"
  if (c.status === "DRAFT") return "Estimated — this has not been filed yet"
  if (c.status === "REJECTED") return "Worked out before it came back to you"
  if (c.status === "DIRECTOR_APPROVED" || c.status === "FINANCE_APPROVED") {
    return "Authorised — this is what Finance will pay"
  }
  return "If it is approved exactly as filed"
}

/**
 * Why there is no sum to show, said rather than left as five em dashes.
 *
 * Most settled tickets here predate the system and were loaded from the
 * college's payment records: they carry a total and none of the figures that
 * produced it. The old page rendered that as "SNIP —, Quartile —, QF amount
 * —, Base amount —, Author point —", which reads as five things the page
 * failed to load rather than as a payment made before any of this existed.
 */
function noWorkingReason(c: Claim, settled: boolean): string {
  if (settled) {
    return (
      "This payment was brought across from the college's own records when " +
      "this system replaced them. The amount is what was actually paid; the " +
      "figures it was worked out from were never recorded here."
    )
  }
  if (c.remuneration == null) {
    return "The amount has not been worked out yet. The research cell prices a ticket when they check it."
  }
  return "The figures behind this amount are not on record."
}

/**
 * Where the two figures the money rests on came from, in one sentence.
 *
 * They used to be two tiny notes reading "Entered manually", a phrase that
 * says what somebody did and nothing about what it means for the reader. What
 * it means is that the value was never matched against Scopus, the SNIP
 * dataset or Scimago — which is the most ordinary reason a claim is sent back
 * — and a claimant is entitled to know which of their figures is load-bearing
 * and unchecked.
 */
function provenanceLines(c: Claim): string[] {
  const lines: string[] = []
  // Somebody in the research cell signing for a hand-entered value is a
  // different situation from a value nobody has looked at, and saying "nobody
  // has matched it" a line above "checked by hand by Priya" would have the
  // page contradicting itself.
  const signedFor = !!c.manual_verified_by_name

  if (c.snip != null) {
    const snip = `SNIP ${c.snip.toFixed(3)}`
    if (c.snip_source === "SCOPUS") lines.push(`${snip}, confirmed by Scopus.`)
    else if (c.snip_source === "SNIP_DUMP") {
      lines.push(`${snip}, confirmed against the published SNIP dataset.`)
    } else if (c.snip_source === "MANUAL") {
      lines.push(
        signedFor
          ? `${snip} was entered by hand rather than matched to the published SNIP dataset.`
          : `${snip} was typed in by hand — nobody has matched it to the published SNIP dataset.`
      )
    } else lines.push(`${snip}.`)
  }

  if (c.quartile) {
    if (c.quartile_source === "SCIMAGO") {
      lines.push(
        c.scimago_sjr != null
          ? `Quartile ${c.quartile}, from Scimago (SJR ${c.scimago_sjr}${
              c.scimago_dataset_year ? `, ${c.scimago_dataset_year} data` : ""
            }).`
          : `Quartile ${c.quartile}, confirmed by Scimago.`
      )
    } else if (c.quartile_source === "MANUAL") {
      lines.push(
        signedFor
          ? `Quartile ${c.quartile} was entered by hand rather than read off Scimago.`
          : `Quartile ${c.quartile} was typed in by hand — it has not been confirmed against Scimago.`
      )
    } else {
      lines.push(`Quartile ${c.quartile}.`)
    }
  }

  // Only worth saying when it differs from the figure actually used: a
  // self-reported value the research cell agreed with is not news, and
  // repeating it beside the identical verified one implies a disagreement.
  if (c.self_reported_snip != null && c.self_reported_snip !== c.snip) {
    lines.push(`You reported a SNIP of ${c.self_reported_snip}; the figure above is the one being used.`)
  }
  if (c.self_reported_quartile != null && c.self_reported_quartile !== c.quartile) {
    lines.push(`You reported ${c.self_reported_quartile}; the quartile above is the one being used.`)
  }

  return lines
}

/** "a", "a and b", "a, b and c" — a list a person would read out loud. */
function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] || ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * How long this has been where it is.
 *
 * The single most common thing a claimant wants from this page after the
 * amount, and the page held every date it needed in its payload and printed
 * none of them above the history.
 */
function waitingLine(c: Claim): string | null {
  if (c.status === "DRAFT") return null
  if (c.status === "PAID") return c.paid_at ? `Paid on ${formatDate(c.paid_at)}` : null
  if (!c.submitted_at) return null
  const days = daysSince(c.submitted_at)
  if (days == null) return `Filed on ${formatDate(c.submitted_at)}`
  const ago =
    days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  return `Filed on ${formatDate(c.submitted_at)} — ${ago}`
}

function daysSince(iso: string): number | null {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

type TicketDate = { label: string; who: string | null; at: string }

/**
 * The account a ticket can give of itself when nothing was recorded about it.
 *
 * `claim.actions` is empty for every ticket loaded from the college's earlier
 * records, and for anything created outside the submit path — which between
 * them is the overwhelming majority of settled tickets. The claim still
 * carries `submitted_at`, `cleared_at`, `principal_approved_at`,
 * `director_approved_at` and `paid_at`, so there is something true to show,
 * and dates that coincide exactly are the import stamping one moment on
 * several columns rather than several things happening at once.
 */
function ticketDates(c: Claim): TicketDate[] {
  const all: TicketDate[] = [
    { label: "Filed", who: null, at: c.submitted_at || "" },
    { label: "Checked by the research cell", who: c.cleared_by_name, at: c.cleared_at || "" },
    {
      label: "Approved by the Principal",
      who: c.principal_approved_by_name,
      at: c.principal_approved_at || "",
    },
    {
      label: "Authorised by the Director",
      who: c.director_approved_by_name,
      at: c.director_approved_at || "",
    },
    { label: "Paid", who: null, at: c.paid_at || "" },
  ].filter((d) => d.at && !Number.isNaN(new Date(d.at).getTime()))

  // Later wins: an imported row carries the same instant in `submitted_at`
  // and `paid_at`, and listing "Filed" and "Paid" a line apart at the very
  // same second invites the reader to believe something that did not happen.
  const kept = all.filter((d, i) => !all.some((o, j) => j > i && o.at === d.at))
  return kept.reverse()
}

function authorNames(c: Claim): string | null {
  const arr = parseJsonArray<unknown>(c.authors_json)
  if (!arr.length) return null
  const names = arr
    .map((a) => (typeof a === "string" ? a : (a as { name?: string })?.name))
    .filter((n): n is string => !!n)
  return names.length ? names.join(", ") : null
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

function formatPubDate(c: Claim): string | null {
  if (c.publication_date) {
    const d = new Date(c.publication_date)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    }
  }
  return c.publication_year ? String(c.publication_year) : null
}

// Codes written by `_transition()` and a handful of direct `ClaimAction`
// creations in `backend/core/api.py` — read there, not guessed, so a code
// this page does not recognise falls back to a humanised version of itself
// rather than a blank line in the history.
function actionSentence(a: ClaimAction): string {
  const who = a.actor_name
  const base = (() => {
    switch (a.action) {
      case "CREATE_DRAFT":
        return `${who} started this draft`
      case "ADMIN_CREATE":
        return `${who} created this on the author's behalf`
      case "SUBMIT":
        return `${who} filed it`
      case "CONTEST_FORWARD":
        return `${who} filed it, flagging it for review`
      case "RESUBMIT":
        return `${who} filed it again`
      case "WITHDRAW":
        return `${who} withdrew it to fix it`
      case "CLEAR":
        return `${who} checked it and sent it to the Principal`
      case "PRINCIPAL_APPROVE":
        return `${who} approved it`
      case "PRINCIPAL_SEND_BACK":
        return `${who} sent it back to the research cell`
      case "SECOND_APPROVE":
        return `${who} gave the second approval`
      case "MARK_PAID":
        return `${who} marked it paid`
      case "VOID_PAYMENT":
        return `${who} voided the payment`
      case "REJECT":
        return `${who} sent it back`
      case "STATUS_OVERRIDE":
        return `${who} moved it to ${humanizeStatus(a.to_status)} directly`
      case "VERIFY":
        return `${who} verified it`
      case "MANUAL_VERIFY":
        return `${who} verified it manually`
      case "PACK_CORRECT":
        return `${who} corrected a field`
      case "ADMIN_EDIT":
        return `${who} edited it`
      case "REASSIGN":
        return `${who} reassigned it`
      default:
        return `${who} ${a.action.replace(/_/g, " ").toLowerCase()}`
    }
  })()
  return a.note ? `${base} — ${a.note}` : base
}

function humanizeStatus(s: string): string {
  return s.replace(/_/g, " ").toLowerCase()
}


/**
 * The team behind a student-project claim.
 *
 * A student is a name and a register number here, not an account -- they do
 * not sign in and they are not paid. The reason to show them anyway is that an
 * incentive claimed on a student project is claimed on their work, and a
 * ticket naming only the person who filed it reads as though it were theirs
 * alone. Whoever approves it should be able to see who else is on it without
 * opening the roster in another system.
 */
function TeamPanel({ team }: { team: Team }) {
  return (
    <section className="space-y-3">
      <SectionTitle>Team</SectionTitle>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <DetailRow label="Code" value={team.code} />
        <DetailRow label="Project" value={team.title} />
        <DetailRow label="Department" value={team.department} />
        <DetailRow label="Academic year" value={team.academic_year} />
        <DetailRow label="Mentor" value={team.mentor_name} />
      </dl>

      {team.members.length === 0 ? (
        // Not an empty state. A team with no students on it is a roster that
        // was never filled in, and saying so is more use than a shrug.
        <Callout tone="caution" title="No students are listed on this team">
          The team exists but its roster is empty, so there is nothing here to
          show whose project this is.
        </Callout>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {team.members.map((m) => (
            <li key={`${m.register_number || ""}-${m.name}`} className="row px-1 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{m.name}</span>
                <Meta className="block truncate">
                  {[m.register_number, m.programme, m.year_of_study]
                    .filter(Boolean)
                    .join(" · ") || "No register number recorded"}
                </Meta>
              </span>
              {/* Only when it differs from the team's, which is the whole
                  reason a student carries a mentor of their own. */}
              {m.mentor_name && m.mentor_name !== team.mentor_name ? (
                <Meta className="shrink-0">Mentor: {m.mentor_name}</Meta>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Notes raised on this ticket, between the principal and the research cell.
 *
 * Attached to the ticket rather than sent as a message, deliberately: a mail
 * about a claim arrives in one person's inbox and dies there, while a note on
 * the claim is in front of whoever picks it up next.
 *
 * The claimant never sees this and neither does finance, so for them it
 * renders nothing at all -- including no heading, because an empty section
 * labelled "Notes" only raises the question of whose notes are being kept
 * from them.
 */
function Notes({ claimId }: { claimId: string }) {
  const { me } = useAuth()
  const [body, setBody] = useState("")

  const isAdmin = ADMIN_ROLES.includes(me?.role || "")
  const mayRead = me?.role === "PRINCIPAL" || isAdmin

  const { data, isLoading, error, refetch } = useApi<{ results: Note[] }>(
    ["claim-notes", claimId],
    `/api/claims/${claimId}/notes`,
    { enabled: mayRead }
  )

  const add = useApiMutation<{ body: string }, { ok: boolean }>(
    `/api/claims/${claimId}/notes`,
    { invalidates: [["claim-notes", claimId]] }
  )

  if (!mayRead) return null

  const notes = data?.results || []

  return (
    <section className="space-y-3">
      <SectionTitle>Notes on this ticket</SectionTitle>

      {isLoading ? (
        <SkeletonText lines={2} />
      ) : error ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : notes.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing has been raised on this ticket.</p>
      ) : (
        <ul className="space-y-3 border-l border-line pl-4">
          {notes.map((n) => (
            <li key={n.id} className="text-sm">
              <p className={n.resolved_at ? "text-fg-muted line-through" : ""}>{n.body}</p>
              <Meta>
                {[
                  n.author_name || "Somebody",
                  n.author_role ? roleLabel(n.author_role) : null,
                  formatDateTime(n.created_at),
                  n.resolved_at
                    ? `closed by ${n.resolved_by_name || "the research cell"}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Meta>
              {isAdmin && !n.resolved_at ? (
                <ResolveNote noteId={n.id} claimId={claimId} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          const text = body.trim()
          if (text.length < 3) return
          add.mutate(
            { body: text },
            {
              onSuccess: () => {
                setBody("")
                toast.ok("Note added to the ticket")
              },
              onError: (err: unknown) => toast.fail(err),
            }
          )
        }}
      >
        <textarea
          className="field min-h-20 w-full"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Raise something about this ticket"
          aria-label="Note on this ticket"
        />
        <Button type="submit" disabled={body.trim().length < 3 || add.isPending}>
          {add.isPending ? "Adding…" : "Add note"}
        </Button>
      </form>
    </section>
  )
}

function ResolveNote({ noteId, claimId }: { noteId: string; claimId: string }) {
  const resolve = useApiMutation<Record<string, never>, { ok: boolean }>(
    `/api/claims/notes/${noteId}/resolve`,
    { invalidates: [["claim-notes", claimId]] }
  )
  return (
    <Button
      kind="quiet"
      size="sm"
      className="mt-1"
      disabled={resolve.isPending}
      onClick={() =>
        resolve.mutate(
          {},
          {
            onSuccess: () => toast.ok("Note closed"),
            onError: (err: unknown) => toast.fail(err),
          }
        )
      }
    >
      {resolve.isPending ? "Closing…" : "Mark as dealt with"}
    </Button>
  )
}

/** Who may read and write ticket notes. Mirrors `_may_read_notes`. */
const ADMIN_ROLES = ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"]

function roleLabel(role: string) {
  return (
    {
      SUPER_ADMIN: "Administrator",
      RESEARCH_CELL: "Research cell",
      RESEARCH_COORDINATOR: "Research coordinator",
      PRINCIPAL: "Principal",
    }[role] || role.toLowerCase().replace(/_/g, " ")
  )
}
