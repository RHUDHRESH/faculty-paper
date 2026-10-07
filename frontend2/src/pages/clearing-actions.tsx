import type { WithAssignee } from "@/ui/assignee"
import type { ClaimThreshold } from "@/ui/research-threshold"
import { useEffect, useState } from "react"
import { Paperclip } from "lucide-react"

import { useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { CHAIN, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { ReasonChips, rememberReason } from "@/ui/reasons"
import { Callout } from "@/ui/state"
import { SectionTitle } from "@/ui/text"
import { money } from "@/ui/paper"
import { toast } from "@/ui/toast"
import { recordPosition } from "@/pages/clearing-position"
import type { DeskFields } from "@/pages/clearing-desk"
import { unshout } from "@/lib/names"

/**
 * The actions and detail parts that used to live in the clearing queue's side
 * sheet: clear, send back, confirm figures, second signature, override.
 * The queue rows open the full-page review (`/review/:id`); these stay here,
 * exported, for that workspace to reuse rather than rewrite.
 */

/* ------------------------------------------------------------------------ */
/* Types — read out of claim_to_dict() in backend/core/api.py               */
/* ------------------------------------------------------------------------ */

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

/** What every row of the queue carries — `claim_to_dict()` returns the full
 *  record for each row, so the fields the list needs and the fields the
 *  sheet needs live on the same shape; only `actions` (the history) is
 *  missing until `GET /api/claims/{id}` is fetched for the open ticket. */
export type QueueClaim = ClaimThreshold & WithAssignee & {
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
  owner_name: string
  owner_email: string
  owner_id?: string
  owner_photo_url?: string | null
  owner_initials?: string | null
  on_hold?: boolean | null
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
  record_author_position?: number | null
  record_total_authors?: number | null
  record_has_authors?: boolean
  affiliation_ok?: boolean | null
  authors_json: string | null
  attachments: Attachment[]
  duplicate_warning: boolean
  contest_forward?: boolean | null
  duplicate_matches_json: string | null
  override_duplicate: boolean | null
  override_reason: string | null
  override_by_name: string | null
  verification_ok: boolean | null
  verification_snapshot_json: string | null
  calc_error: string | null
  waiting_days: number | null
} & Omit<DeskFields, "publication_year" | "verification_ok" | "duplicate_warning" | "calc_error" | "remuneration" | "waiting_days">

// `status_note` carries the Principal's reason when a ticket is returned to
// this queue. It is on the claim payload but was not in the queue row type.
export type ClaimDetail = QueueClaim & {
  actions?: ClaimAction[]
  status_note?: string | null
  //: Both come from `claim_to_dict`, which the sheet fetches in full — the
  //: queue row this type was widened from simply does not carry them.
  needs_second_approval?: boolean
  cleared_by_name?: string | null
  on_hold?: boolean | null
  hold_reason?: string | null
  confirmations?: Confirmation[]
}

export type Confirmation = {
  id: string
  text: string
  ticked_at: string
  user_name: string | null
}

export type RecalcResult = {
  remuneration: number | null
  previous: number | null
  changed: boolean
  base_amount: number | null
  qf_amount: number | null
  remuneration_category: string | null
  remuneration_note: string | null
  calc_error: string | null
}

export type BulkClearResult = {
  cleared: number
  skipped: { id: string; reason: string }[]
}


/** The claimant's own figures beside what the record says. */
export function ClaimedVsRecord({ claim: c }: { claim: ClaimDetail }) {
  const pos =
    c.author_position != null
      ? `${ordinal(c.author_position)}${c.total_authors ? ` of ${c.total_authors}` : ""}`
      : "Not recorded"
  const posRec = recordPosition(c)
  const rows: { label: string; claimed: string; record: string; differs: boolean }[] = [
    {
      label: "SNIP",
      claimed: c.self_reported_snip != null ? String(c.self_reported_snip) : "Not given",
      record: c.snip != null ? c.snip.toFixed(3) : "Not found",
      differs: c.self_reported_snip != null && c.snip != null && Math.abs(c.self_reported_snip - c.snip) > 0.0005,
    },
    {
      label: "Quartile",
      claimed: c.self_reported_quartile || "Not given",
      record: c.quartile || "Not found",
      differs: !!c.self_reported_quartile && !!c.quartile && c.self_reported_quartile !== c.quartile,
    },
    { label: "Author position", claimed: pos, record: posRec.text, differs: posRec.differs },
    {
      label: "Affiliation",
      claimed: "This college",
      record:
        c.affiliation_ok === true
          ? "This college is on the paper"
          : c.affiliation_ok === false
            ? "This college is not on the paper"
            : "Not checked",
      differs: c.affiliation_ok === false,
    },
  ]
  return (
    <section className="space-y-2">
      <SectionTitle>Claimed and on record</SectionTitle>
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-fg-muted">
            <th scope="col" className="w-1/4 py-1 pr-2 font-normal">Figure</th>
            <th scope="col" className="py-1 pr-2 font-normal">Claimant says</th>
            <th scope="col" className="py-1 font-normal">Record says</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-line align-top">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-fg-muted">{r.label}</th>
              <td className="break-words py-1.5 pr-2 tabular">{r.claimed}</td>
              <td className={cn("break-words py-1.5 tabular", r.differs && "font-medium text-critical")}>
                {r.record}
                {r.differs && <span className="sr-only"> (differs from the claim)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

/** An attachment, openable in place: PDFs and images preview inline. */
export function AttachmentRow({ a }: { a: Attachment }) {
  const [show, setShow] = useState(false)
  const lower = a.filename.toLowerCase()
  const kind = lower.endsWith(".pdf") ? "pdf" : /\.(png|jpe?g|gif|webp)$/.test(lower) ? "image" : null
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Paperclip className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1 break-all text-sm">{a.filename}</span>
        {kind && (
          <Button kind="quiet" size="sm" aria-expanded={show} onClick={() => setShow((v) => !v)}>
            {show ? "Hide" : "View here"}
          </Button>
        )}
        <a href={a.url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2">
          Open in a new tab
        </a>
      </div>
      {show && kind === "pdf" && (
        <iframe title={a.filename} src={a.url} className="mt-2 h-[28rem] w-full rounded-md ring-1 ring-line" />
      )}
      {show && kind === "image" && <img src={a.url} alt={a.filename} className="mt-2 max-w-full rounded-md" />}
    </li>
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
/* Clear — recalculate, confirm at that figure, and re-confirm if it moved  */
/* ------------------------------------------------------------------------ */

/**
 * The one dialog money actually moves through.
 *
 * Opening it always recalculates first, so the amount on screen is never
 * older than this dialog. If clearing then answers 409 — the figure moved
 * again between that recalculation and the click — this does not retry with
 * the old number or the new one on its own; it names both, says plainly why,
 * and waits for a fresh, explicit "Clear" click. Resending the stale amount
 * automatically is the exact failure this guard exists to prevent.
 */
export function ClearDialog({
  claim,
  open,
  onOpenChange,
  isSuperAdmin,
  onCleared,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  isSuperAdmin: boolean
  onCleared: () => void
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "changed">("loading")
  const [amount, setAmount] = useState<number | null>(null)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [is502, setIs502] = useState(false)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const recalc = useApiMutation<{ skip_external?: boolean }, RecalcResult>(
    `/api/claims/${claim.id}/recalculate`,
    // Recalculating persists the fresh verified values even if this dialog
    // is then cancelled, so the list and the sheet underneath must not go on
    // showing the figure from before this call.
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )
  const clear = useApiMutation<{ note?: string; expected_amount?: number }, ClaimDetail>(
    `/api/claims/${claim.id}/clear`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  async function runRecalc(skipExternal = false) {
    setPhase("loading")
    setIs502(false)
    try {
      const r = await recalc.mutateAsync({ skip_external: skipExternal })
      setAmount(r.remuneration)
      setCalcError(r.calc_error)
      setPhase(r.calc_error ? "error" : "ready")
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        setIs502(true)
        setPhase("error")
      } else {
        toast.fail(err)
        onOpenChange(false)
      }
    }
  }

  useEffect(() => {
    if (open) {
      setNote("")
      setChangedMessage(null)
      void runRecalc()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function confirmClear() {
    if (amount == null) return
    setBusy(true)
    setConfirmedAmount(amount)
    try {
      const result = await clear.mutateAsync({ note: note.trim() || undefined, expected_amount: amount })
      toast.stamp(
        "Cleared",
        `${money(result.remuneration)} sent to the Principal${claim.ticket_number ? ` for ${claim.ticket_number}` : ""}.`
      )
      onOpenChange(false)
      onCleared()
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Clear this ticket?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {unshout(claim.paper_title)}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {phase === "loading" && (
            <p className="text-sm text-fg-muted">Checking the figure against Scopus…</p>
          )}

          {phase === "error" && is502 && (
            <Callout tone="critical" title="Scopus could not be reached">
              <p>The amount was not refreshed. Nothing has been cleared.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button kind="default" size="sm" onClick={() => void runRecalc(false)}>
                  Retry
                </Button>
                {isSuperAdmin && (
                  <Button kind="quiet" size="sm" onClick={() => void runRecalc(true)}>
                    Use stored values instead
                  </Button>
                )}
              </div>
            </Callout>
          )}

          {phase === "error" && !is502 && (
            <Callout tone="critical" title="This amount could not be worked out">
              {calcError || "Nothing has been cleared."}
            </Callout>
          )}

          {phase === "ready" && (
            <>
              <p className="text-2xl font-semibold tabular">{money(amount)}</p>
              {/* What confirming does, in the dialog rather than only in the
                  toast afterwards — by then it has already happened. */}
              <p className="text-sm text-fg-muted">
                This clears {money(amount)} and sends the claim to the Principal to approve. It
                leaves this queue.
              </p>
              <Field label="Note (optional)">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </Field>
            </>
          )}

          {phase === "changed" && (
            <Callout tone="caution" title="The figure changed since this screen was drawn">
              <p>You confirmed {money(confirmedAmount)}.</p>
              <p className="mt-1">{changedMessage}</p>
              <p className="mt-2">Nothing has been cleared. Recalculate to see the new figure and confirm again.</p>
            </Callout>
          )}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button kind="primary" onClick={() => void runRecalc()}>
              Recalculate
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={phase !== "ready" || amount == null || busy}
              onClick={() => void confirmClear()}
            >
              {busy ? "Clearing…" : `Clear — ${amount != null ? money(amount) : "…"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Reject                                                                    */
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
  const reject = useApiMutation<{ note: string }, ClaimDetail>(`/api/claims/${claim.id}/reject`, {
    invalidates: [...CHAIN, ["claim", claim.id]],
  })

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10
  const canSubmit = trimmed.length >= 10

  async function submit() {
    try {
      await reject.mutateAsync({ note: trimmed })
      rememberReason(trimmed)
      toast.ok(`Sent back${claim.ticket_number ? `. ${claim.ticket_number}` : ""}`)
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
          <DialogTitle>Send this claim back?</DialogTitle>
          <DialogDescription>{unshout(claim.paper_title)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field
            label="Reason"
            hint="The claimant sees this sentence first, at the top of their paper — say what to fix."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What needs to change before this can be filed again"
            />
          </Field>
          <div className="mt-3">
            <ReasonChips onPick={(t) => setNote((n) => (n.trim() ? `${n.trim()} ${t}` : t))} />
          </div>
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
        return `${who} sent it back to the research office`
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
  return a.note ? `${base} — ${a.note}` : base
}


/* ------------------------------------------------------------------------ */
/* The three actions that had no control                                    */
/* ------------------------------------------------------------------------ */

//: Statuses the ERP import writes that nothing in the live chain can act on.
export const LEGACY_STATUSES = ["HOD_APPROVED", "RESEARCH_APPROVED", "FINANCE_APPROVED"]

export const QUARTILES = ["Q1", "Q2", "Q3", "Q4"]

/**
 * Manual verification — the lane for a paper Scopus and Scimago cannot confirm.
 *
 * Without it the amount is either computed from the claimant's own declaration
 * or not computed at all, so a perfectly good paper in a journal our reference
 * data does not recognise sits unpriced forever. The note is mandatory on the
 * server because somebody is typing a number that decides a payment, and a
 * year later the only account of why is this sentence.
 */
export function ManualVerifyDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [snip, setSnip] = useState("")
  const [quartile, setQuartile] = useState("")
  const [note, setNote] = useState("")

  useEffect(() => {
    if (!open) return
    setSnip(claim.snip != null ? String(claim.snip) : "")
    setQuartile(claim.quartile || "")
    setNote("")
  }, [open, claim])

  const save = useApiMutation<
    { snip?: number; quartile?: string; note: string },
    unknown
  >(`/api/admin/claims/${claim.id}/set-verified`, {
    invalidates: [...CHAIN, ["claim", claim.id]],
  })

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10
  const parsedSnip = Number.parseFloat(snip)
  const snipBad = snip.trim() !== "" && !Number.isFinite(parsedSnip)
  const canSubmit = trimmed.length >= 10 && !snipBad && !save.isPending

  async function submit() {
    try {
      await save.mutateAsync({
        snip: snip.trim() === "" ? undefined : parsedSnip,
        quartile: quartile || undefined,
        note: trimmed,
      })
      toast.ok("Figures confirmed. The amount has been worked out again")
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Enter confirmed figures</DialogTitle>
          <DialogDescription>
            For a journal the index cannot confirm. What you enter is treated as
            verified and the amount is worked out from it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="This replaces the claimant's own declaration">
            Values entered here are marked MANUAL and survive re-verification, so they
            decide the payment from now on.
          </Callout>

          <div className="grid grid-cols-2 gap-3">
            <Field label="SNIP" error={snipBad ? "That is not a number." : undefined}>
              <Input value={snip} onChange={(e) => setSnip(e.target.value)} placeholder="1.205" />
            </Field>
            <Field label="Quartile">
              <Combobox
                value={quartile}
                onChange={setQuartile}
                options={[
                  { value: "", label: "Leave as it is" },
                  ...QUARTILES.map((q) => ({ value: q, label: q })),
                ]}
              />
            </Field>
          </div>

          <Field
            label="Where these came from"
            hint="A citation somebody auditing this can follow. At least 10 characters."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="SNIP 1.205 from the 2025 CWTS list; the journal is not in our Scimago dump"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : "Record and recalculate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The second signature on a high-value claim.
 *
 * It had no control anywhere in this app, so a claim over the threshold could
 * never receive one and Finance refused it forever — the queue looked like
 * work and was a dead end. The server refuses the signature if it comes from
 * whoever cleared the ticket, which is the entire point of asking for it.
 */
export function SecondSignatureDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { me } = useAuth()
  const [note, setNote] = useState("")

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const sign = useApiMutation<{ note?: string; expected_amount?: number }, unknown>(
    `/api/claims/${claim.id}/second-approve`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  const selfCleared = Boolean(
    me?.name && claim.cleared_by_name && me.name === claim.cleared_by_name
  )

  async function submit() {
    try {
      await sign.mutateAsync({
        note: note.trim() || undefined,
        expected_amount: claim.remuneration ?? undefined,
      })
      toast.ok(`Second signature recorded. ${money(claim.remuneration)} can now be paid`)
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add the second signature</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {money(claim.remuneration)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {selfCleared ? (
            <Callout tone="critical" title="You cleared this claim">
              The second signature has to come from somebody else — that is the whole
              reason it is asked for. The server will refuse it from you.
            </Callout>
          ) : (
            <Callout tone="info" title="What this does">
              It confirms the amount as a second, different pair of eyes. Finance cannot
              pay this claim until somebody other than {claim.cleared_by_name || "whoever cleared it"} has.
            </Callout>
          )}

          <Field label="Note" hint="Optional — what you checked.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={sign.isPending}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={selfCleared || sign.isPending}
            onClick={() => void submit()}
          >
            {sign.isPending ? "Signing…" : `Sign — ${money(claim.remuneration)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Unsticking a ticket stranded on a retired ERP status.
 *
 * The import wrote statuses like HOD_APPROVED that nothing in the live chain
 * can act on — such a ticket could not be cleared, paid, or even sent back.
 * The Faults screen has been naming this as the fix while offering no way to
 * do it.
 */
export function OverrideStatusDialog({
  claim,
  open,
  onOpenChange,
  onDone,
}: {
  claim: ClaimDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [to, setTo] = useState("SUBMITTED")
  const [note, setNote] = useState("")

  useEffect(() => {
    if (!open) return
    setTo("SUBMITTED")
    setNote("")
  }, [open])

  const override = useApiMutation<{ to_status: string; note: string }, unknown>(
    `/api/admin/claims/${claim.id}/override-status`,
    { invalidates: [...CHAIN, ["claim", claim.id], ["admin", "faults"]] }
  )

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10

  async function submit() {
    try {
      await override.mutateAsync({ to_status: to, note: trimmed })
      toast.ok(`Moved to ${to.replace(/_/g, " ").toLowerCase()}. It can be worked on again`)
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Move this off a retired status</DialogTitle>
          <DialogDescription>
            It is on {claim.status.replace(/_/g, " ").toLowerCase()}, which the current
            chain has no step for.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="Cleared is not a shortcut to paid">
            Moving it to Cleared puts it back in the chain at the checking step — it still
            has to be approved and authorised before Finance can pay it, and the amount is
            recomputed rather than taken from the import.
          </Callout>

          <Field label="Move it to">
            <Combobox
              value={to}
              onChange={setTo}
              options={[
                { value: "SUBMITTED", label: "Filed — back in the clearing queue" },
                { value: "CLEARED", label: "Checked — waiting on the Principal" },
                { value: "REJECTED", label: "Sent back to the claimant" },
              ]}
            />
          </Field>

          <Field
            label="Why"
            hint="Recorded against your name. At least 10 characters."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Imported from the ERP on a status this chain retired; putting it back for checking"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={override.isPending}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={trimmed.length < 10 || override.isPending}
            onClick={() => void submit()}
          >
            {override.isPending ? "Moving…" : "Move it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
