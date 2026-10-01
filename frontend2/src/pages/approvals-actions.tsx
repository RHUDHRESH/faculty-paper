import type { ClaimThreshold } from "@/ui/research-threshold"
import { useEffect, useState } from "react"

import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Textarea } from "@/ui/field"
import { Callout, SkeletonText } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { money } from "@/ui/paper"
import { toast } from "@/ui/toast"
import { unshout } from "@/lib/names"

/**
 * The parts of the Principal's old side sheet that carry rules: the approve
 * dialog with its "the figure moved" handling, the send-back dialog, the
 * research cell's flags, and the shapes of a queue row. The rows now open the
 * full-page review (`/review/:id?queue=approvals`); these stay, exported, for
 * that workspace to reuse.
 */

export type Attachment = {
  id: string
  kind: string
  url: string
  filename: string
  size_bytes: number | null
}

export type DuplicateMatch = {
  source?: string | null
  id?: string | null
  title?: string | null
  amount?: number | null
  reference?: string | null
  who?: string | null
  when?: string | null
}

export type ClaimAction = {
  id: string
  action: string
  from_status: string | null
  to_status: string
  note: string | null
  actor_name: string
  created_at: string
}

/** What every row of the queue carries, plus the second-signature fields
 *  that make this desk's job different from the research cell's. */
export type QueueClaim = ClaimThreshold & {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_email: string
  owner_department: string | null
  remuneration: number | null
  remuneration_is_estimate: boolean
  qf_amount: number | null
  base_amount: number | null
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
  attachments: Attachment[]
  duplicate_warning: boolean
  duplicate_matches_json: string | null
  override_duplicate: boolean | null
  override_reason: string | null
  override_by_name: string | null
  verification_ok: boolean | null
  verification_snapshot_json: string | null
  calc_error: string | null
  waiting_days: number | null
  status: string
  cleared_by_name: string | null
  cleared_at: string | null
  needs_second_approval: boolean
  second_approved_by_name: string | null
  second_approved_at: string | null
  owner_photo_url?: string | null
  owner_initials?: string | null
  /** Unresolved research-cell flags; only on queue rows. */
  open_flags?: number
  on_hold?: boolean | null
}

export type ClaimFlag = {
  id: string
  kind_label: string
  note: string
  open: boolean
  raised_by_name: string | null
  raised_at: string | null
  resolved_by_name: string | null
  resolution_note: string | null
}

export type ClaimDetail = QueueClaim & {
  actions?: ClaimAction[]
  on_hold?: boolean | null
  hold_reason?: string | null
}

export type QueuePayload = {
  total: number
  limit: number
  offset: number
  results: QueueClaim[]
  totals: { count: number; amount: number; longest_wait_days: number | null }
  departments: string[]
}

export type BulkApproveResult = {
  approved: number
  total: number
  skipped: { id: string; reason: string }[]
}

/** What the research cell doubted about this paper. The Principal judges the
 *  paper, so sees these (`rbac.can_review_flags`); the Director and Finance
 *  never do. Open flags first; resolved ones say who settled them. */
export function FlagsSection({ claimId }: { claimId: string }) {
  const { data, isLoading, isError } = useApi<{ flags: ClaimFlag[] }>(
    ["claim-review", claimId],
    `/api/claims/${claimId}/review`
  )
  const flags = data?.flags ?? []
  const open = flags.filter((f) => f.open)
  const settled = flags.filter((f) => !f.open)
  return (
    <section className="space-y-2">
      <SectionTitle>Flags from the research cell</SectionTitle>
      {isLoading ? (
        <SkeletonText lines={2} />
      ) : isError ? (
        <p className="text-sm text-fg-muted">Could not load the flags. Open /flags to check before approving.</p>
      ) : flags.length === 0 ? (
        <p className="text-sm text-fg-muted">None raised. The research cell cleared it without a doubt on record.</p>
      ) : (
        <ul className="space-y-3">
          {[...open, ...settled].map((f) => (
            <li key={f.id} className="text-sm">
              <p className={cn("font-medium", f.open ? "text-caution" : "text-fg-muted")}>
                {f.kind_label}
                {f.open ? ", still open" : ", resolved"}
              </p>
              <p className="break-words">{f.note}</p>
              <Meta className="block">
                {f.raised_by_name || "Raised automatically"}
                {f.raised_at ? ` · ${formatDateTime(f.raised_at)}` : ""}
                {!f.open && f.resolved_by_name ? ` · settled by ${f.resolved_by_name}` : ""}
                {!f.open && f.resolution_note ? `: ${f.resolution_note}` : ""}
              </Meta>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="tabular text-sm">{value}</p>
      {note && <p className="text-xs text-fg-subtle">{note}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Approve — confirm at the figure shown, and re-confirm if it moved        */
/* ------------------------------------------------------------------------ */

/**
 * The one dialog that turns a cleared ticket into money Finance can pay.
 *
 * `principal-approve` recomputes from stored, already-verified values only
 * — never Scopus — so there is no external call to wait on and no outage to
 * retry. The only failure worth guarding is the figure moving between the
 * screen being drawn and the click: the server answers 409 with the
 * recomputed amount in its own message, and this dialog reads that number
 * back out rather than silently resending the stale one. Confirming a second
 * time is always a fresh, explicit click at the new figure — never automatic.
 */
export function ApproveDialog({
  claim,
  open,
  onOpenChange,
  me,
  onApproved,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  me: { name: string } | null
  onApproved: () => void
}) {
  const [amount, setAmount] = useState<number | null>(claim.remuneration)
  const [phase, setPhase] = useState<"ready" | "changed">("ready")
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setAmount(claim.remuneration)
      setPhase("ready")
      setChangedMessage(null)
      setNote("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const approve = useApiMutation<{ note?: string; expected_amount: number }, ClaimDetail>(
    `/api/claims/${claim.id}/principal-approve`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  async function confirmApprove() {
    if (amount == null) return
    setBusy(true)
    setConfirmedAmount(amount)
    try {
      const result = await approve.mutateAsync({ note: note.trim() || undefined, expected_amount: amount })
      toast.stamp(
        "Approved",
        `${money(result.remuneration)} sent to the Director${claim.ticket_number ? ` for ${claim.ticket_number}` : ""}.`
      )
      onOpenChange(false)
      onApproved()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setChangedMessage(err.message)
        setPhase("changed")
      } else {
        toast.fail(err)
      }
    } finally {
      setBusy(false)
    }
  }

  function continueWithNewAmount() {
    const parsed = changedMessage ? parseAmountFromMessage(changedMessage) : null
    if (parsed != null) setAmount(parsed)
    setPhase("ready")
    setChangedMessage(null)
  }

  const selfCleared = !!me && !!claim.cleared_by_name && me.name === claim.cleared_by_name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Approve this spend?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {unshout(claim.paper_title)}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {phase === "ready" && claim.calc_error ? (
            <Callout tone="critical" title="This amount could not be worked out">
              {claim.calc_error} Nothing has been approved.
            </Callout>
          ) : phase === "ready" ? (
            <>
              <p className="text-2xl font-semibold tabular">{money(amount)}</p>
              {/* What confirming does, in the dialog rather than only in the
                  toast afterwards — by then it has already happened. */}
              <p className="text-sm text-fg-muted">
                This sends {money(amount)} to the Director to authorise, then Finance pays it. You cannot
                take it back from here once it has gone.
              </p>
              {claim.needs_second_approval && (
                <Callout tone="caution" title="Needs a second, different signature">
                  Cleared by {claim.cleared_by_name || "someone else"}. Approving here also serves as the second
                  signature{selfCleared ? ", but not from you, since you cleared it yourself" : ""}.
                </Callout>
              )}
              <Field label="Note (optional)">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </Field>
            </>
          ) : (
            <Callout tone="caution" title="The figure changed since this screen was drawn">
              <p>You confirmed {money(confirmedAmount)}.</p>
              <p className="mt-1">{changedMessage}</p>
              <p className="mt-2">Nothing has been approved. Review the new figure and confirm again.</p>
            </Callout>
          )}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button kind="primary" onClick={continueWithNewAmount}>
              Show the new figure
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={amount == null || !!claim.calc_error || busy}
              onClick={() => void confirmApprove()}
            >
              {busy ? "Approving…" : `Approve ${amount != null ? money(amount) : "…"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Reject — sends the ticket back to the research cell, with a reason       */
/* ------------------------------------------------------------------------ */

export function RejectDialog({
  claim,
  open,
  onOpenChange,
  onRejected,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onRejected: () => void
}) {
  const [note, setNote] = useState("")
  const reject = useApiMutation<{ note: string }, ClaimDetail>(`/api/claims/${claim.id}/principal-reject`, {
    invalidates: [...CHAIN, ["claim", claim.id]],
  })

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const trimmed = note.trim()
  // Matches the backend's own minimum on this endpoint — five characters is
  // enough to catch an empty click, not enough to force an essay.
  const tooShort = trimmed.length > 0 && trimmed.length < 5
  const canSubmit = trimmed.length >= 5

  async function submit() {
    try {
      await reject.mutateAsync({ note: trimmed })
      toast.ok(`Sent back to the research cell${claim.ticket_number ? `: ${claim.ticket_number}` : ""}`)
      onOpenChange(false)
      onRejected()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Send back to the research cell?</DialogTitle>
          <DialogDescription>{unshout(claim.paper_title)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field
            label="Reason"
            hint="Goes back to the research cell to fix, with this note attached. Say what to check again."
            error={tooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What needs a second look before this can be approved"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={!canSubmit || reject.isPending} onClick={() => void submit()}>
            {reject.isPending ? "Sending…" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export function parseJsonObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null
  } catch {
    return null
  }
}

// `_guard_recomputed_amount` writes the recomputed figure into its own 409
// message ("The recomputed amount is ₹52,377.50. ..."), so the fresh number
// can be read straight back out of it rather than re-fetching the claim,
// which — inside the same rolled-back transaction — would still show the
// stale one.
export function parseAmountFromMessage(message: string): number | null {
  const m = message.match(/₹([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number.parseFloat(m[1].replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

// Machine-confirmed and self-reported are said differently on purpose — a
// reader must be able to tell what Scopus verified from what the claimant
// typed, since only one of those is grounds to change the amount.
export function snipNote(c: ClaimDetail): string | undefined {
  const parts: string[] = []
  if (c.snip_source === "SCOPUS") parts.push("Confirmed by Scopus")
  else if (c.snip_source === "SNIP_DUMP") parts.push("Confirmed from the SNIP dataset")
  else if (c.snip_source === "MANUAL") parts.push("Entered manually")
  if (c.self_reported_snip != null && c.self_reported_snip !== c.snip) {
    parts.push(`Self-reported: ${c.self_reported_snip}`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

export function quartileNote(c: ClaimDetail): string | undefined {
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

export function formatDateTime(iso: string | null | undefined): string {
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

// Same codes `_transition()` writes in backend/core/api.py — read there, not
// guessed, so a code this sheet does not recognise still falls back to a
// humanised version of itself rather than a blank line in the history.
export function actionSentence(a: ClaimAction): string {
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
        return `${who} moved it to ${a.to_status.replace(/_/g, " ").toLowerCase()} directly`
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
  return a.note ? `${base}: ${a.note}` : base
}
