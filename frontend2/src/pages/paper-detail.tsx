import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Paperclip } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { money, Stage, stageOf } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonText } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * One paper, in full — what a claimant or an approver opens a ticket number
 * to find out.
 *
 * Four questions, answered in the order somebody actually asks them: where
 * it is and who is holding it; if it came back, what to fix; why the amount
 * is what it is, with the working shown rather than only the total; and what
 * has happened to it. A rejected ticket puts its reason before anything
 * else — the old app buried a sent-back reason under the amount and the
 * stage, and the one sentence somebody arrived for was the last thing they
 * read, if they found it at all.
 */

type Attachment = {
  id: string
  kind: string
  url: string
  filename: string
  size_bytes: number | null
}

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
  actions?: ClaimAction[]
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
          <ErrorState
            title="This paper is not yours"
            message="You can only open a paper you filed, or one waiting in a queue you handle."
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

  return (
    <div className="page space-y-10 py-8">
      {/* The one sentence a sent-back paper's owner came here for, before
          anything else — including the back link. */}
      {claim.status === "REJECTED" && claim.status_note && (
        <Callout tone="critical" title="Sent back — what to fix">
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
        <div className="max-w-xs">
          <Stage stage={stage} />
        </div>
        <p className="text-sm text-fg-muted">{stage.who}</p>
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
        <SectionTitle>The payout</SectionTitle>

        <div>
          <p className="text-3xl font-semibold tabular">
            {claim.calc_error ? "—" : money(claim.remuneration)}
          </p>
          {claim.remuneration_category && (
            <p className="mt-1 text-sm text-fg-muted">{claim.remuneration_category}</p>
          )}
        </div>

        {claim.calc_error && (
          <Callout tone="critical" title="This amount could not be worked out">
            {claim.calc_error}
          </Callout>
        )}

        {/* Unmissable on purpose — this is the one fact that changes what a
            reader should do with the number above. */}
        {claim.remuneration_is_estimate && (
          <Callout tone="caution" title="This is an estimate">
            It rests on values reported by the claimant, not a verified SNIP or
            quartile. It may change once the research cell checks it.
          </Callout>
        )}

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Figure
            label="SNIP"
            value={claim.snip != null ? claim.snip.toFixed(3) : "—"}
            note={snipNote(claim)}
          />
          <Figure
            label="Quartile"
            value={claim.quartile || "—"}
            note={quartileNote(claim)}
          />
          <Figure label="QF amount" value={money(claim.qf_amount)} />
          <Figure label="Base amount" value={money(claim.base_amount)} />
          <Figure
            label="Author point"
            value={claim.author_point != null ? claim.author_point.toFixed(3) : "—"}
            note={
              claim.author_position && claim.total_authors
                ? `Position ${claim.author_position} of ${claim.total_authors}`
                : undefined
            }
          />
        </div>

        {(claim.manual_verified_by_name || claim.manual_verification_note || claim.remuneration_note) && (
          <p className="text-sm text-fg-muted">
            {claim.manual_verified_by_name && <>Manually verified by {claim.manual_verified_by_name}. </>}
            {claim.manual_verification_note}
            {claim.manual_verification_note && claim.remuneration_note ? " " : ""}
            {claim.remuneration_note}
          </p>
        )}

        <p className="text-xs text-fg-subtle">Formula: [(SNIP × 55,000) + QFA] × APP</p>
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
            <DetailRow label="Authors" value={authorNames(claim) || authorsSummary(claim)} />
          </dl>
        </div>

        <div className="space-y-3">
          <SectionTitle>Attachments</SectionTitle>
          {claim.attachments.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing attached.</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {claim.attachments.map((a) => (
                <li key={a.id} className="row">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-1 py-2"
                  >
                    <Paperclip className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{a.filename}</span>
                      <Meta className="block truncate">{attachmentKindLabel(a.kind)}</Meta>
                    </span>
                    <Meta className="shrink-0">{formatSize(a.size_bytes)}</Meta>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle>History</SectionTitle>
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

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="tabular text-base">{value}</p>
      {note && <p className="text-xs text-fg-subtle">{note}</p>}
    </div>
  )
}

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

// Machine-confirmed and self-reported are said differently on purpose — a
// reader must be able to tell what Scopus verified from what the claimant
// typed, because only one of those is grounds to change the amount.
function snipNote(c: Claim): string | undefined {
  const parts: string[] = []
  if (c.snip_source === "SCOPUS") parts.push("Confirmed by Scopus")
  else if (c.snip_source === "SNIP_DUMP") parts.push("Confirmed from the SNIP dataset")
  else if (c.snip_source === "MANUAL") parts.push("Entered manually")
  if (c.self_reported_snip != null && c.self_reported_snip !== c.snip) {
    parts.push(`Self-reported: ${c.self_reported_snip}`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

function quartileNote(c: Claim): string | undefined {
  const parts: string[] = []
  if (c.quartile_source === "SCIMAGO") {
    parts.push(
      c.scimago_sjr != null
        ? `Scimago, SJR ${c.scimago_sjr}${c.scimago_dataset_year ? ` (${c.scimago_dataset_year})` : ""}`
        : "Confirmed by Scimago"
    )
  } else if (c.quartile_source === "MANUAL") {
    parts.push("Entered manually")
  }
  if (c.self_reported_quartile != null && c.self_reported_quartile !== c.quartile) {
    parts.push(`Self-reported: ${c.self_reported_quartile}`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

function authorsSummary(c: Claim): string | null {
  if (c.author_position && c.total_authors) {
    return `Position ${c.author_position} of ${c.total_authors}`
  }
  return null
}

function authorNames(c: Claim): string | null {
  const arr = parseJsonArray<unknown>(c.authors_json)
  if (!arr.length) return null
  const names = arr
    .map((a) => (typeof a === "string" ? a : (a as { name?: string })?.name))
    .filter((n): n is string => !!n)
  return names.length ? names.join(", ") : null
}

function attachmentKindLabel(kind: string): string {
  switch (kind) {
    case "PUBLISHED_PAPER":
      return "Full-length published paper"
    case "SEC_REFERENCE":
      return "Cited reference with SEC affiliation"
    default:
      return kind.replace(/_/g, " ").toLowerCase()
  }
}

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
