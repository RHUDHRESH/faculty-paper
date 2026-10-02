import { useEffect, useRef, useState } from "react"

import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { paperTitle, unshout } from "@/lib/names"
import { CHAIN, useApiMutation } from "@/lib/query"
import { BudgetStrip, budgetLine, claimsWord } from "@/pages/budget-strip"
import { useBudgetNow } from "@/pages/pay-parts"
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
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import type { ClaimThreshold } from "@/ui/research-threshold"
import { Details } from "@/ui/section"
import { Callout } from "@/ui/state"
import { toast } from "@/ui/toast"

/**
 * The three ways the Director's desk acts on the Principal's approvals:
 * authorise one claim, authorise a batch, and (a super admin standing in only)
 * send one back. Used by the Home, the Authorisations queue and the review
 * workspace, so the three cannot word a decision differently.
 *
 * The same rule runs through all of them: **the amount on the screen is the
 * amount authorised**. If the figure moved between the screen being drawn and
 * the click, the server answers 409 with the recomputed amount in its message;
 * that number is read back out and shown beside the old one, and confirming
 * again is always a fresh click at the new figure, never automatic. The server
 * also locks the authorised amount, so Finance pays this and nothing else
 * (docs/ops/safeguards.md).
 *
 * What the Director weighs is the budget, so every dialog carries the budget
 * strip: what authorising does to the year, in the figure and in the bar,
 * before the button is pressed (docs/ux/28, target T2). The button repeats the
 * rupees, and the dialog opens with the button focused so Enter confirms:
 * `a`, then Enter.
 */

export type AuthClaim = ClaimThreshold & {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  status?: string
  remuneration: number | null
  quartile?: string | null
  calc_error: string | null
  cleared_by_name?: string | null
  principal_approved_by_name: string | null
  principal_approved_at: string | null
  waiting_days: number | null
}

/** What the money screens refresh after a decision: the chain, the year, the thread. */
export const MONEY_KEYS: unknown[][] = [...CHAIN, ["budgets"], ["track"], ["payouts", "months"]]

type BulkResult = {
  approved: number
  total: number
  skipped: { id: string; reason: string }[]
}

// `_guard_recomputed_amount` writes the recomputed figure into its own 409
// message ("The recomputed amount is ₹52,377.50. ..."), so the fresh number
// is read straight back out of it rather than re-fetching the claim.
function parseAmountFromMessage(message: string): number | null {
  const m = message.match(/₹([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number.parseFloat(m[1].replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

/** What the research threshold took off this claim, in one clause, or null. */
export function thresholdClause(c: ClaimThreshold): string | null {
  const absorbed = c.threshold_absorbed ?? 0
  const full = c.threshold_full_amount ?? 0
  if (!(absorbed > 0.005 && full > 0)) return null
  return absorbed >= full - 0.005
    ? `Nothing to pay: ${money(full)} counts against the research threshold`
    : `${money(absorbed)} of ${money(full)} is held back by the research threshold`
}

const approvedOn = (iso: string | null | undefined) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

/* -------------------------------------------------------------------------- */
/* One claim                                                                  */
/* -------------------------------------------------------------------------- */

export function AuthoriseDialog({
  claim,
  onClose,
  onDone,
}: {
  claim: Pick<
    AuthClaim,
    | "id"
    | "ticket_number"
    | "paper_title"
    | "owner_name"
    | "owner_department"
    | "owner_photo_url"
    | "remuneration"
    | "principal_approved_by_name"
    | "principal_approved_at"
  > &
    ClaimThreshold
  onClose: () => void
  /** After the claim is authorised (the workspace opens the next one). */
  onDone?: () => void
}) {
  const budget = useBudgetNow()
  const [amount, setAmount] = useState<number | null>(claim.remuneration)
  const [phase, setPhase] = useState<"ready" | "changed">("ready")
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const authorise = useApiMutation<{ note?: string; expected_amount: number }, { remuneration: number | null }>(
    `/api/claims/${claim.id}/director-approve`,
    { invalidates: [...MONEY_KEYS, ["claim", claim.id], ["review-workspace", claim.id]] }
  )

  // Enter confirms once the figure is on screen: a, then Enter.
  useEffect(() => {
    if (phase === "ready") confirmRef.current?.focus()
  }, [phase])

  async function confirm() {
    if (amount == null) return
    setBusy(true)
    try {
      const result = await authorise.mutateAsync({ note: note.trim() || undefined, expected_amount: amount })
      toast.stamp(
        "Authorised",
        `${money(result.remuneration)} released to Finance${claim.ticket_number ? ` for ${claim.ticket_number}` : ""}.`
      )
      onClose()
      onDone?.()
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

  const held = thresholdClause(claim)
  const when = approvedOn(claim.principal_approved_at)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm" onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus() }}>
        <DialogHeader>
          <DialogTitle>Authorise this claim?</DialogTitle>
          <DialogDescription className="flex items-center gap-2.5">
            <Avatar
              size="sm"
              person={{
                name: claim.owner_name,
                initials: initialsOf(claim.owner_name),
                photo_url: claim.owner_photo_url ?? null,
              }}
            />
            <span className="min-w-0 truncate">
              {claim.owner_name}
              {claim.owner_department ? ` · ${claim.owner_department}` : ""}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {phase === "changed" ? (
            <Callout tone="caution" title="The amount changed while this was open">
              <p className="mt-1">{changedMessage}</p>
              <p className="mt-2">Nothing has been authorised. Check the new figure and confirm again if it is right.</p>
            </Callout>
          ) : (
            <>
              <div>
                <p className="figure text-figure tabular">{money(amount)}</p>
                <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{unshout(paperTitle(claim.paper_title))}</p>
                {held && <p className="mt-1 text-sm text-caution">{held}</p>}
              </div>
              <div className="space-y-2">
                <p className="text-base">{budgetLine(budget.data, "authorising", false) ?? " "}</p>
                <BudgetStrip budget={budget.data?.college} batch={amount ?? 0} batchLabel="This claim" compact />
              </div>
              <Details label="a note" className="-mt-1">
                <Field label="Note" hint="Optional. Kept on the claim history.">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
                </Field>
              </Details>
              {when && (
                <p className="text-sm text-fg-subtle">
                  Approved by {claim.principal_approved_by_name || "the Principal"} on {when}.
                </p>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button kind="primary" onClick={continueWithNewAmount}>
              Show me the new amount
            </Button>
          ) : (
            <Button ref={confirmRef} kind="primary" disabled={busy || amount == null} onClick={() => void confirm()}>
              {busy ? "Authorising…" : `Authorise ${money(amount)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Sending it back                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Back to the Principal, not to the claimant, and for a super admin standing
 * in only: the chain past the Principal is forward-only, so the Director has
 * no send-back and the server refuses one. What is being queried is the
 * approval, so it returns to whoever gave it; the server withdraws that
 * approval along with the status.
 */
export function SendBackDialog({
  claim,
  onClose,
  onDone,
}: {
  claim: Pick<AuthClaim, "id" | "ticket_number" | "owner_name" | "remuneration">
  onClose: () => void
  onDone?: () => void
}) {
  const [note, setNote] = useState("")
  const reject = useApiMutation<{ note: string }, unknown>(`/api/claims/${claim.id}/director-reject`, {
    invalidates: [...MONEY_KEYS, ["claim", claim.id], ["review-workspace", claim.id]],
  })
  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 5

  async function submit() {
    try {
      await reject.mutateAsync({ note: trimmed })
      toast.ok(`Sent back. The Principal will see why${claim.ticket_number ? ` on ${claim.ticket_number}` : ""}.`)
      onClose()
      onDone?.()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Send this claim back?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {money(claim.remuneration)}. It returns to the Principal, not to the claimant.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field
            label="Reason"
            hint="The Principal reads this. Say what needs revisiting."
            error={tooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Takes the department past its allocation for the quarter"
              autoFocus
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={trimmed.length < 5 || reject.isPending} onClick={() => void submit()}>
            {reject.isPending ? "Sending back…" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* A batch                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A batch that fails as a unit is a batch nobody dares run, so the server
 * authorises row by row and returns what it skipped and why. Those reasons are
 * listed individually: "Authorised 12 of 15" with no word on the other three
 * is how three claims get forgotten.
 */
export function BulkAuthoriseDialog({
  claims,
  onClose,
  onDone,
}: {
  claims: Pick<AuthClaim, "id" | "owner_name" | "owner_department" | "owner_photo_url" | "remuneration" | "paper_title">[]
  onClose: () => void
  onDone: () => void
}) {
  const budget = useBudgetNow()
  const [note, setNote] = useState("")
  const [result, setResult] = useState<BulkResult | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const bulk = useApiMutation<{ claim_ids: string[]; note?: string }, BulkResult>("/api/director/bulk-approve", {
    invalidates: MONEY_KEYS,
  })

  useEffect(() => {
    if (!result) confirmRef.current?.focus()
  }, [result])

  const total = claims.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const byDept = Object.entries(
    claims.reduce<Record<string, { count: number; amount: number }>>((acc, c) => {
      const k = c.owner_department || "No department"
      acc[k] = { count: (acc[k]?.count ?? 0) + 1, amount: (acc[k]?.amount ?? 0) + (c.remuneration || 0) }
      return acc
    }, {})
  ).sort((a, b) => b[1].amount - a[1].amount)

  async function submit() {
    try {
      const res = await bulk.mutateAsync({ claim_ids: claims.map((c) => c.id), note: note.trim() || undefined })
      setResult(res)
      if (res.approved > 0) {
        toast.stamp("Authorised", `${claimsWord(res.approved)}, ${money(res.total)}, released to Finance.`)
        onDone()
      }
      if (res.skipped.length === 0) onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus() }}>
        <DialogHeader>
          <DialogTitle>{result ? "What happened" : `Authorise ${claimsWord(claims.length)}?`}</DialogTitle>
          <DialogDescription>
            {result
              ? `${formatCount(result.approved)} authorised, ${formatCount(result.skipped.length)} skipped.`
              : `Released to Finance for payment, across ${formatCount(byDept.length)} ${byDept.length === 1 ? "department" : "departments"}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {result ? (
            result.skipped.length > 0 && (
              <div className="space-y-3">
                <Callout tone="caution" title={`${formatCount(result.skipped.length)} were not authorised`}>
                  Each one is listed below with its reason. They are still in the queue.
                </Callout>
                <ul className="space-y-1 text-sm">
                  {result.skipped.map((s) => (
                    <li key={s.id} className="rounded-control bg-sunken px-3 py-2">
                      {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <>
              <div>
                <p className="figure text-figure tabular">{money(total)}</p>
                <p className="mt-1 text-sm text-fg-muted">across {claimsWord(claims.length)}</p>
              </div>
              <div className="space-y-2">
                <p className="text-base">{budgetLine(budget.data, "authorising", claims.length !== 1) ?? " "}</p>
                <BudgetStrip budget={budget.data?.college} batch={total} compact />
              </div>
              <Details label="the claims" count={claims.length}>
                <ul className="max-h-56 divide-y divide-line overflow-y-auto text-sm">
                  {claims.map((c) => (
                    <li key={c.id} className="flex items-center gap-2.5 py-2">
                      <Avatar
                        size="sm"
                        person={{
                          name: c.owner_name,
                          initials: initialsOf(c.owner_name),
                          photo_url: c.owner_photo_url ?? null,
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {c.owner_name}
                        <span className="text-fg-subtle"> · {c.owner_department || "No department"}</span>
                      </span>
                      <span className="shrink-0 tabular">{money(c.remuneration)}</span>
                    </li>
                  ))}
                </ul>
                {byDept.length > 1 && (
                  <ul className="mt-3 divide-y divide-line border-t border-line text-sm">
                    {byDept.map(([d, v]) => (
                      <li key={d} className="flex justify-between gap-3 py-1.5">
                        <span className="min-w-0 truncate">
                          {d} <span className="text-fg-subtle">· {v.count}</span>
                        </span>
                        <span className="shrink-0 tabular">{money(v.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Details>
              <Details label="a note" className={cn("-mt-2")}>
                <Field label="Note" hint="Optional. Kept on every claim in the batch.">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
                </Field>
              </Details>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={bulk.isPending}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button ref={confirmRef} kind="primary" disabled={bulk.isPending} onClick={() => void submit()}>
              {bulk.isPending ? "Authorising…" : `Authorise ${money(total)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
