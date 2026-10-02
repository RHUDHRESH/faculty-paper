import { firstName, paperTitle, unshout } from "@/lib/names"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Check, MessageCircle, Printer, Receipt } from "lucide-react"

import { cn } from "@/lib/cn"

import { useAuth } from "@/app/auth"
import { reviewsFlags } from "@/app/nav"
import { useApi, useApiMutation } from "@/lib/query"
import { ClaimFlagsPanel, FileCheckLine, useClaimReview } from "@/pages/claim-review"
import { AttachmentGallery, extensionOf, isOwnMedia, type Attachment } from "@/ui/attachments"
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
import { Journey, claimStatus, facultyStage } from "@/ui/journey"
import { CopyButton } from "@/ui/copy"
import { When } from "@/ui/when"
import { Avatar } from "@/ui/person"
import { Picture, topicPicture } from "@/ui/picture"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonText } from "@/ui/state"
import { ClaimThresholdNote } from "@/ui/research-threshold"
import { Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { PrintStamp } from "@/pages/reports-print"
import { FixView } from "@/pages/fix/fix-view"
import { useClaimantMarks } from "@/pages/fix/marks"
import { monthPaid, needFromYou, payoutLine, statementLink, type PayoutOutlook } from "@/pages/claims-track"

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
  from_status?: string | null
  to_status?: string
  note: string | null
  actor_name: string
  created_at: string
}

/**
 * A ticket brought across from the college's ERP workbook carries the
 * import's moment as its filing and payment time. These are the dates it
 * really has: the Google Form's own timestamp for a Raw_Data row, a payout
 * month somebody recorded, and the day it was brought across.
 */
type ClaimRecord = {
  imported: boolean
  /** The workbook sheet: "Raw_Data" (the Google Form's) or "Processed". */
  source: string | null
  imported_at: string | null
  filed_at: string | null
  /** "2025-03" */
  paid_month: string | null
  erp_status: string | null
}

type Claim = {
  faculty_stage?: string | null
  days_waiting?: number | null
  waiting_days?: number | null
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  doi: string | null
  issn: string | null
  publication_year: number | null
  publication_date: string | null
  publication_type: string | null
  /** Absent on a claimant's own copy: use claimStatus(). */
  status?: string
  status_note: string | null
  /** REJECTED either way; true when it cannot be fixed and sent again. */
  rejected_outright?: boolean
  /** "2026-09": the month the money went out. */
  payout_month?: string | null
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
  quota_applied?: boolean | null
  threshold_absorbed?: number | null
  threshold_full_amount?: number | null
  threshold_note?: string | null
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
  /** What the history can truthfully say (server: services/record_dates.py). */
  record?: ClaimRecord | null
  team: Team | null
  /** The three conditions as accepted at filing (services/filing_conditions.py). */
  confirmations?: ClaimConfirmation[]
}

type ClaimConfirmation = {
  id: string
  text_version: string
  text: string
  ticked_at: string
  recorded_at: string | null
  user_id: string | null
  user_name?: string | null
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
  const navigate = useNavigate()
  const { me } = useAuth()
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  // When the next payment run is, from the college's own pattern.
  const { data: outlook } = useApi<PayoutOutlook>(["next-payout"], "/api/me/next-payout", {
    staleTime: 10 * 60_000,
  })

  const {
    data: claim,
    isLoading,
    error,
    refetch,
  } = useApi<Claim>(["claim", id], `/api/claims/${id}`, { enabled: !!id })
  // Only the owner of a sent-back claim reads marks here; anyone else has the review workspace.
  const marks = useClaimantMarks(
    id,
    !!claim && !!me && me.id === claim.owner_id && claimStatus(claim) === "REJECTED",
    claim?.attachments
  )

  const withdraw = useApiMutation<Record<string, never>, Claim>(
    `/api/claims/${id}/withdraw`,
    { invalidates: [["claim", id], ["my-claims"]] }
  )

  // The desks that judge a paper also see its flags and what its files were
  // found to say. Asked for here, above the early returns, because a hook
  // cannot wait for the claim to load; the server refuses anybody else. Never
  // on the reader's own paper: an officer who files is its claimant, and the
  // doubts about it are the desk's (`rbac.is_own_claim`) -- so the request
  // waits for the claim to say whose it is.
  const reviewer = reviewsFlags(me?.role) && !!claim && claim.owner_id !== me?.id
  const review = useClaimReview(id, reviewer)
  const checksByUrl = new Map((review.data?.file_checks ?? []).map((c) => [c.url, c]))

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
            title="You cannot open this claim"
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

  const stage = stageOf(claimStatus(claim))
  const isOwner = !!me && me.id === claim.owner_id
  const canWithdraw = isOwner && claimStatus(claim) === "SUBMITTED"
  // A sent-back paper is editable, not just a draft.
  //
  // The brief this page was first built against said DRAFT only, and that was
  // wrong: the server accepts a PATCH on both, and `stageOf("REJECTED")` tells
  // the reader in as many words to "edit the details and file it again". Take
  // the button away and the page spends a paragraph explaining what to fix and
  // then offers no way to fix it — which is where the old app left people, and
  // the reason they emailed the research cell instead.
  const canEdit = isOwner && (claimStatus(claim) === "DRAFT" || claimStatus(claim) === "REJECTED")
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
  // The claimant of a sent-back claim that can still be fixed gets the fix
  // view; a claim that was not accepted keeps the plain note.
  const fixable = isOwner && claimStatus(claim) === "REJECTED" && !claim.rejected_outright
  // A Principal's send-back to the office is internal: the claimant is only
  // shown a send-back that came to them.
  const showSendBack =
    !fixable &&
    Boolean(claim.status_note && (claimStatus(claim) === "REJECTED" || (sentBackByPrincipal && !isOwner)))

  const settled = claimStatus(claim) === "PAID"
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
  const topic = topicPicture(claim.paper_title, claim.journal_title)

  return (
    <div className="page space-y-10 py-8 print:space-y-6 print:py-0">
      <PrintStamp title={`Incentive claim receipt${claim.ticket_number ? `, claim no. ${claim.ticket_number}` : ""}`} scope={`stage: ${(claim.faculty_stage || facultyStage(claimStatus(claim))).toLowerCase()}`} />
      {/* The one sentence a sent-back paper's owner came here for, before
          anything else — including the back link. */}
      {showSendBack && (
        <Callout
          tone="critical"
          title={
            sentBackByPrincipal && claimStatus(claim) !== "REJECTED"
              ? "The Principal sent this back to the research cell"
              : claim.rejected_outright
                ? "Not accepted: why"
                : "Sent back to you: what to fix"
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

      {/* The claimant's way back is their list; anybody else arrived from a
          queue, a search or the flags, so "My papers" would be wrong. */}
      {isOwner || window.history.length <= 1 ? (
        <Link
          to={isOwner ? "/papers" : "/"}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg print:hidden"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {isOwner ? "My papers" : "Home"}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg print:hidden"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back
        </button>
      )}

      <header className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <PageTitle className="break-words">{paperTitle(claim.paper_title)}</PageTitle>
            <Sub className="mt-2">
              {unshout(claim.journal_title) || "Journal not given"}
              {claim.quartile ? ` · ${claim.quartile}` : ""}
              {claim.publication_year ? ` · ${claim.publication_year}` : ""}
            </Sub>
            <p className="mt-1 flex items-center gap-1 text-sm text-fg-muted">
              {claim.ticket_number ? (
                <>
                  Claim no. {claim.ticket_number}
                  <CopyButton value={claim.ticket_number} label="claim number" />
                </>
              ) : (
                "Not filed yet"
              )}
            </p>
          </div>
          {topic && <Picture name={topic} className="hidden size-28 shrink-0 sm:block" />}
        </div>

        {/* The journey: the one bold element on the page. */}
        <div className="panel-lead space-y-3 p-4 sm:p-5">
          {isOwner ? (
            // The claimant sees how far it has come and how long it has
            // waited -- never whose desk it is on (the college's rule).
            <>
              <Journey
                stage={claim.faculty_stage || facultyStage(claimStatus(claim))}
                daysWaiting={claim.days_waiting ?? claim.waiting_days ?? null}
              />
              <div className="space-y-1 border-t border-line pt-3 text-sm">
                <p>
                  <span className="text-fg-muted">Needed from you: </span>
                  <span className={needFromYou(claim).action ? "font-medium" : undefined}>{needFromYou(claim).text}</span>
                </p>
                {payoutLine(claim, outlook) && <p className="text-fg-muted">{payoutLine(claim, outlook)}</p>}
                {settled && (
                  <p>
                    <Link
                      to={statementLink(claim)}
                      className="inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline"
                    >
                      <Receipt className="size-3.5" aria-hidden />
                      See it in your payment statement{monthPaid(claim) ? ` for ${monthPaid(claim)}` : ""}
                    </Link>
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-lg font-medium">{stage.label}</p>
              <StageTrack stage={stage} />
              <p className="text-sm text-fg-muted">{stage.who}</p>
            </>
          )}
          {waiting && (!isOwner || settled) && <Meta className="block">{waiting}</Meta>}
        </div>

        <div className="flex flex-wrap items-center gap-2 print:hidden">
          {canEdit && (
            <Button kind="primary" asChild>
              <Link to={`/papers/${claim.id}/edit`}>
                {claimStatus(claim) === "REJECTED" ? "Fix and resend" : "Continue this draft"}
              </Link>
            </Button>
          )}
          {!isOwner && !!me && claim.owner_id && (
            // Lands in the one-to-one chat with the paper attached as context.
            <Button kind="default" asChild>
              <Link to={`/messages?to=${claim.owner_id}&ctx=paper:${claim.id}`}>
                <MessageCircle />
                Message {firstName(claim.owner_name) || "the author"}
              </Link>
            </Button>
          )}
          {isOwner && settled && (
            // The ticket page is the receipt: amount, working, dates.
            <Button kind="default" onClick={() => window.print()}>
              <Printer />
              Print receipt
            </Button>
          )}
          {isOwner && claimStatus(claim) !== "DRAFT" && claimStatus(claim) !== "REJECTED" && (
            // The card says what the paper is -- never what it paid.
            <Button kind="default" asChild>
              <Link to={`/discussions?share=${claim.id}`}>Share to the feed</Link>
            </Button>
          )}
          {isOwner && claim.journal_title && claimStatus(claim) !== "DRAFT" && (
            <Button kind="quiet" asChild>
              <Link to={`/papers/new?copy=${claim.id}`}>File another in this journal</Link>
            </Button>
          )}
          {canWithdraw && (
            <Button kind="quiet" className="sm:ml-auto" onClick={() => setConfirmWithdraw(true)}>
              Withdraw
            </Button>
          )}
        </div>
      </header>

      {fixable && (
        <FixView
          claim={{ ...claim, status_note: claim.status_note }}
          marks={marks}
          onChanged={() => void refetch()}
        />
      )}

      {claim.duplicate_warning && (
        <Callout tone="critical" title="This paper may already have been paid">
          <p>Check the matches below before this goes any further.</p>
          {duplicateMatches.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {duplicateMatches.map((m, i) => (
                <li key={m.id ?? i} className="text-sm">
                  {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"}
                  {m.amount != null && <>, {money(m.amount)}</>}
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
          {settled && isOwner && (
            <div className="flex items-center gap-4 border-b border-line pb-4">
              <Picture
                name={claim.quartile === "Q1" ? "celebrate-top-quartile" : "celebrate-first-publication"}
                className="size-20 shrink-0"
              />
              <div>
                <p className="display text-xl text-positive">Paid. Well done.</p>
                <p className="text-sm text-fg-muted">
                  The college has settled this paper. Thank you for publishing it.
                </p>
              </div>
            </div>
          )}
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
              <p className="text-sm font-medium">How that is worked out</p>
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
            from figures anyone has checked. The college matches both
            against Scopus and Scimago when they look at the claim, and the
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
            on {handEntered.length === 1 ? "it" : "them"} being right. The college
            checks {handEntered.length === 1 ? "it" : "both"} before the
            claim moves on, and the amount changes if the published value turns
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
          <ClaimThresholdNote c={claim} mine={isOwner} />
        </div>
      </section>

      <section className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 sm:grid-cols-2 [&>*]:min-w-0">
        <div className="space-y-3">
          <SectionTitle>The paper</SectionTitle>
          <dl className="space-y-2 text-sm">
            <DetailRow label="Journal" value={unshout(claim.journal_title)} />
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
          </dl>
        </div>
        <AuthorList claim={claim} />
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
          annotate={
            reviewer
              ? (file) => (
                  <FileCheckLine
                    check={checksByUrl.get(file.url)}
                    readable={isOwnMedia(file.url) && extensionOf(file) === "pdf"}
                  />
                )
              : undefined
          }
          emptyLabel={
            <>
              No files are attached to this claim.
              {canEdit
                ? " Use Edit to add the published paper and the pages showing your SEC-affiliated references."
                : ""}
            </>
          }
        />
      </section>

      {claim.team ? <TeamPanel team={claim.team} /> : null}

      {claim.confirmations && claim.confirmations.length > 0 && (
        <Confirmations rows={claim.confirmations} isOwner={isOwner} />
      )}

      {reviewer && claimStatus(claim) !== "DRAFT" && (
        <ClaimFlagsPanel
          claimId={claim.id}
          review={review.data}
          loading={review.isLoading}
          failed={review.isError}
          onRetry={() => void review.refetch()}
        />
      )}

      {/* The desk's notes, which are about the claimant -- so not on the
          reader's own paper. */}
      {!isOwner && <Notes claimId={claim.id} />}

      <section className="space-y-3">
        <SectionTitle>History</SectionTitle>
        {isOwner ? (
          <ClaimantHistory claim={claim} />
        ) : claim.actions && claim.actions.length > 0 ? (
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
              {claim.record?.imported
                ? "No step-by-step record was kept for this claim. It was brought across from the college's ERP workbook, which records what was decided but not when each desk acted. These are the dates it does carry."
                : "No step-by-step record was kept for this claim. It did not travel through this system one desk at a time. These are the dates the claim itself carries, and they are all that is known about it."}
            </p>
            <ul className="space-y-3 border-l border-line pl-4">
              {dates.map((d) => (
                <li key={d.label} className="text-sm">
                  <p>{d.label}</p>
                  {!d.month && (
                    <Meta>{[d.who, formatDateTime(d.at)].filter(Boolean).join(" · ")}</Meta>
                  )}
                </li>
              ))}
            </ul>
            {claim.record?.erp_status && (
              <p className="text-sm text-fg-muted">
                The workbook's own note: “{claim.record.erp_status}”
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            Nothing has happened to this claim yet. From the moment you file it,
            every step, who moved it, when and anything they wrote, is listed
            here.
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        title="Withdraw this paper?"
        description={`It goes back to a draft so you can fix it.${
          claim.ticket_number ? ` Claim no. ${claim.ticket_number} stays the same.` : ""
        }`}
        confirmLabel="Withdraw"
        onConfirm={async () => {
          try {
            await withdraw.mutateAsync({})
            toast.ok(
              claim.ticket_number
                ? `Withdrawn. Claim no. ${claim.ticket_number} is back in your drafts`
                : "Withdrawn. It is back in your drafts"
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
  if (settled) return paidCaption(c)
  if (claimStatus(c) === "DRAFT") return "Estimated. This has not been filed yet"
  if (claimStatus(c) === "REJECTED") return "Worked out before it came back to you"
  if (claimStatus(c) === "DIRECTOR_APPROVED" || claimStatus(c) === "FINANCE_APPROVED") {
    return "Authorised. This is what will be paid"
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
    return "The amount has not been worked out yet. The college prices a claim when it checks it."
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
          : `${snip} was typed in by hand. Nobody has matched it to the published SNIP dataset.`
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
          : `Quartile ${c.quartile} was typed in by hand. It has not been confirmed against Scimago.`
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
  if (claimStatus(c) === "DRAFT") return null
  if (claimStatus(c) === "PAID") return c.paid_at || c.record?.imported ? paidCaption(c) : null
  // An imported ticket's `submitted_at` is the import's moment unless the
  // server vouches for it as a filing time.
  const filed = c.record?.imported ? c.record.filed_at : c.submitted_at
  if (!filed) return null
  const days = daysSince(filed)
  if (days == null) return `Filed on ${formatDate(filed)}`
  const ago =
    days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  return days === 0 ? "Filed today" : `Filed on ${formatDate(filed)}, ${ago}`
}

/**
 * When it was paid, as far as anybody knows. A ticket brought across from the
 * ERP was paid before this system existed, and `paid_at` on it is only the
 * moment of the import -- printing that as "Paid on 23 Sept 2026" told people
 * they had been paid on a day nothing happened.
 */
function paidCaption(c: Claim): string {
  const r = c.record
  if (r?.imported) {
    return r.paid_month
      ? `Paid in ${monthName(r.paid_month)}`
      : "Paid before this system. The college's records do not say when"
  }
  return c.paid_at ? `Paid on ${formatDate(c.paid_at)}` : "Paid"
}

/** "2025-03" -> "March 2025" */
function monthName(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00`)
  return Number.isNaN(d.getTime())
    ? ym
    : d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}

function daysSince(iso: string): number | null {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

type TicketDate = { label: string; who: string | null; at: string; month?: boolean }

/**
 * The dates an imported ticket really carries, and none of the import's
 * stamps: the day it was brought across, the Google Form's own filing time,
 * and a payout month if one was recorded.
 */
function importedDates(r: ClaimRecord): TicketDate[] {
  const out: TicketDate[] = []
  if (r.filed_at) out.push({ label: "Filed on the college's Google Form", who: null, at: r.filed_at })
  if (r.paid_month) {
    out.push({ label: `Paid in ${monthName(r.paid_month)}`, who: null, at: `${r.paid_month}-01`, month: true })
  }
  if (r.imported_at) {
    out.push({
      label: `Brought across from the ERP workbook${r.source ? ` (${r.source} sheet)` : ""}`,
      who: null,
      at: r.imported_at,
    })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

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
  if (c.record?.imported) return importedDates(c.record)
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

type AuthorRow = { name: string; college: boolean; photo_url: string | null; initials: string | null }

function authorRows(c: Claim): AuthorRow[] {
  return parseJsonArray<unknown>(c.authors_json)
    .map((a) => {
      if (typeof a === "string") return { name: a, college: false, photo_url: null, initials: null }
      const o = (a ?? {}) as { name?: string; college?: string | boolean; photo_url?: string | null; initials?: string | null }
      return {
        name: o.name ?? "",
        college: o.college === true || o.college === "yes",
        photo_url: o.photo_url ?? null,
        initials: o.initials ?? null,
      }
    })
    .filter((r) => !!r.name)
}

function initialsOf(name: string): string {
  const parts = name.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "").split(/[\s.]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

/** The authors in order; college co-authors carry a face, outside authors a name. */
function AuthorList({ claim }: { claim: Claim }) {
  const { me } = useAuth()
  // The signed-in person's own row wears their own face: the claim stores
  // names, and a name that is the viewer's is the viewer.
  const norm = (n: string | null | undefined) => (n ?? "").toLowerCase().replace(/[^a-z]/g, "")
  const rows = authorRows(claim).map((r) =>
    r.college && !r.photo_url && me?.photo_url && norm(r.name) === norm(me.name) ? { ...r, photo_url: me.photo_url } : r
  )
  if (!rows.length) return null
  return (
    <div className="space-y-3">
      <SectionTitle>Authors</SectionTitle>
      <ol className="space-y-2.5">
        {rows.map((r, i) => (
          <li key={`${r.name}-${i}`} className="flex items-center gap-3 text-sm">
            {r.college ? (
              <Avatar
                size="sm"
                person={{ name: r.name, initials: r.initials || initialsOf(r.name), photo_url: r.photo_url }}
              />
            ) : (
              <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center text-xs text-fg-subtle">
                {i + 1}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate">{r.name}</span>
              <span className="block text-xs text-fg-muted">
                {i === 0 ? "First author" : `Author ${i + 1}`}
                {r.college ? " · this college" : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const CONDITION_ORDER = ["indexed", "no-duplicate", "documents"]

/**
 * The eligibility conditions as they were accepted when this paper was filed:
 * the exact wording, its version, who ticked it and when. Read-only -- this
 * is the college's record, not something to change.
 */
function Confirmations({ rows, isOwner }: { rows: ClaimConfirmation[]; isOwner: boolean }) {
  const sorted = [...rows].sort((a, b) => CONDITION_ORDER.indexOf(a.id) - CONDITION_ORDER.indexOf(b.id))
  const who = sorted.find((r) => r.user_name)?.user_name
  const recorded = sorted.find((r) => r.recorded_at)?.recorded_at
  return (
    <section className="space-y-3" aria-labelledby="claim-confirmations">
      <SectionTitle id="claim-confirmations">{isOwner ? "What you confirmed" : "What the claimant confirmed"}</SectionTitle>
      <ul className="divide-y divide-line border-y border-line">
        {sorted.map((r) => (
          <li key={r.id} data-condition={r.id} className="flex gap-3 py-3">
            <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
            <div>
            <p className="text-sm">{r.text}</p>
            <p className="text-xs text-fg-muted">
              Confirmed {formatDateTime(r.ticked_at)}
              {r.user_name && !isOwner ? ` by ${r.user_name}` : ""} · wording version {r.text_version}
            </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">
        Stored with the claim{who && !isOwner ? ` for ${who}` : ""}
        {recorded ? ` on ${formatDateTime(recorded)}` : ""}.
      </p>
    </section>
  )
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
        return `${who} moved it to ${a.to_status ? humanizeStatus(a.to_status) : "another stage"} directly`
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
      <SectionTitle>Notes on this claim</SectionTitle>

      {isLoading ? (
        <SkeletonText lines={2} />
      ) : error ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : notes.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing has been raised on this claim.</p>
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
                toast.ok("Note added to the claim")
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
          placeholder="Raise something about this claim"
          aria-label="Note on this claim"
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

/**
 * The history a claimant is shown: what they did, what came back to them,
 * and the two outcomes that matter -- approved for payment, paid. The desks in
 * between are not named and their steps are not listed (the college's rule),
 * so the office's internal back-and-forth never reads as "stuck with X".
 */
const CLAIMANT_EVENTS: Record<string, string> = {
  CREATE_DRAFT: "You started this draft",
  ADMIN_CREATE: "The college started this on your behalf",
  SUBMIT: "You filed it",
  CONTEST_FORWARD: "You filed it, and asked for the possible match to be reviewed",
  RESUBMIT: "You filed it again",
  WITHDRAW: "You withdrew it to make changes",
  REJECT: "It was sent back to you",
  RETURN_TO_FACULTY: "It was sent back to you",
  DIRECTOR_APPROVE: "Approved for payment",
  MARK_PAID: "Paid",
  // What the server sends a claimant instead (core/visibility.py renames
  // every step somebody else took, so no desk can be read off the history).
  CREATED: "Started",
  SUBMITTED: "Filed",
  SENT_BACK: "The college sent it back",
  NOT_ACCEPTED: "The college did not accept it",
  APPROVED_FOR_PAYMENT: "Approved for payment",
  PAID: "Paid",
  PAYMENT_REVERSED: "The payment was reversed",
}

/** Steps whose note is the reason, written for the claimant to act on. */
const REASON_STEPS = new Set(["REJECT", "RETURN_TO_FACULTY", "SENT_BACK", "NOT_ACCEPTED"])

function ClaimantHistory({ claim }: { claim: Claim }) {
  if (claim.record?.imported) return <ImportedHistory claim={claim} record={claim.record} />
  const events = (claim.actions || [])
    .filter((a) => CLAIMANT_EVENTS[a.action])
    .map((a) => ({
      id: a.id,
      text: CLAIMANT_EVENTS[a.action],
      note: REASON_STEPS.has(a.action) && a.note ? (a.note as string | null) : null,
      at: a.created_at,
    }))
  if (!events.some((e) => e.text === "Approved for payment") && claim.director_approved_at) {
    events.push({ id: "approved", text: "Approved for payment", note: null, at: claim.director_approved_at })
  }
  if (!events.some((e) => e.text === "Paid") && claim.paid_at) {
    events.push({ id: "paid", text: "Paid", note: null, at: claim.paid_at })
  }
  if (!events.some((e) => /^(You filed|Filed)/.test(e.text)) && claim.submitted_at) {
    events.push({ id: "filed", text: "You filed it", note: null, at: claim.submitted_at })
  }
  events.sort((a, b) => (b.at || "").localeCompare(a.at || ""))
  if (!events.length) return <p className="text-sm text-fg-muted">Nothing has happened to it yet.</p>
  return <HistoryList events={events} />
}

/**
 * A claimant's paper that was brought across from the college's records.
 * It was filed and paid under the old process, so "You filed it yesterday"
 * -- the import's moment -- was the one thing this page must not say.
 */
function ImportedHistory({ claim, record }: { claim: Claim; record: ClaimRecord }) {
  const events: { id: string; text: string; note: string | null; at: string | null }[] = []
  if (claimStatus(claim) === "PAID") {
    events.push({
      id: "paid",
      text: record.paid_month
        ? `Paid in ${monthName(record.paid_month)}`
        : "Paid under the old process. The college's records do not say when",
      note: null,
      at: null,
    })
  }
  if (record.imported_at) {
    events.push({
      id: "imported",
      text: "Brought across from the college's records when this system replaced them",
      note: null,
      at: record.imported_at,
    })
  }
  if (record.filed_at) {
    events.push({ id: "filed", text: "You filed it on the college's Google Form", note: null, at: record.filed_at })
  }
  return <HistoryList events={events} />
}

function HistoryList({
  events,
}: {
  events: { id: string; text: string; note: string | null; at: string | null }[]
}) {
  return (
    <ul className="space-y-4 border-l border-line pl-5">
      {events.map((e) => (
        <li key={e.id} className="relative text-sm">
          <span
            aria-hidden
            className={cn(
              "absolute -left-[24.5px] top-1.5 size-2 rounded-full",
              /^Paid/.test(e.text) ? "bg-positive" : /sent it back|sent back|did not accept/.test(e.text) ? "bg-caution" : "bg-active"
            )}
          />
          <p>{e.text}</p>
          {e.note && <p className="mt-0.5 text-fg-muted">“{e.note}”</p>}
          {e.at && (
            <Meta>
              <When iso={e.at} />
            </Meta>
          )}
        </li>
      ))}
    </ul>
  )
}
