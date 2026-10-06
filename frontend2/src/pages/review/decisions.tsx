import { useEffect, useRef, useState } from "react"

import { useQueryClient } from "@tanstack/react-query"

import { api, ApiError } from "@/lib/api"
import { CHAIN, useApiMutation } from "@/lib/query"
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
import { ReasonChips, rememberReason } from "@/ui/reasons"
import { Callout } from "@/ui/state"
import { toast } from "@/ui/toast"

import { useAuth } from "@/app/auth"

import { AiReasonDraft } from "./ai-precheck"
import type { WorkspaceClaim } from "./types"
import { unshout } from "@/lib/names"

/**
 * The dialogs behind the decision bar: clear, send back, hold.
 *
 * They call the same endpoints, in the same order, as the side sheet they
 * replace. What they must not lose is the amount guard: clearing recalculates
 * first, confirms at that figure, and if the server answers 409 (the figure
 * moved) names both figures and waits for a fresh click. Resending the old
 * number automatically is how a stale amount gets paid.
 */

/** What every decision refreshes: the queues, this claim's bundle, and the
 *  keys the older screens read the claim under. */
export function decisionKeys(claimId: string): unknown[][] {
  return [...CHAIN, ["claim", claimId], ["review-workspace", claimId], ["claim-review", claimId]]
}

type Recalc = {
  remuneration: number | null
  calc_error: string | null
}

/* -------------------------------------------------------------------------- */
/* Clear                                                                      */
/* -------------------------------------------------------------------------- */

export function ClearDialog({
  claim,
  open,
  onOpenChange,
  isSuperAdmin,
  onDone,
}: {
  claim: WorkspaceClaim
  open: boolean
  onOpenChange: (open: boolean) => void
  isSuperAdmin: boolean
  onDone: () => void
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "changed">("loading")
  const [amount, setAmount] = useState<number | null>(null)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [is502, setIs502] = useState(false)
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const recalc = useApiMutation<{ skip_external?: boolean }, Recalc>(`/api/claims/${claim.id}/recalculate`, {
    // Recalculating saves the fresh figures even if this dialog is then
    // cancelled, so nothing underneath may go on showing the old ones.
    invalidates: decisionKeys(claim.id),
  })
  const clear = useApiMutation<{ note?: string; expected_amount?: number }, { remuneration: number | null }>(
    `/api/claims/${claim.id}/clear`,
    { invalidates: decisionKeys(claim.id) }
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

  // Enter confirms once the figure has been checked: c, then Enter.
  useEffect(() => {
    if (open && phase === "ready") confirmRef.current?.focus()
  }, [open, phase])

  async function confirmClear() {
    if (amount == null) return
    setBusy(true)
    setConfirmedAmount(amount)
    try {
      const result = await clear.mutateAsync({ note: note.trim() || undefined, expected_amount: amount })
      toast.stamp("Cleared", `${money(result.remuneration)} sent to the Principal${claim.ticket_number ? `. ${claim.ticket_number}` : ""}.`)
      onOpenChange(false)
      onDone()
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
          <DialogTitle>Clear this claim?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {unshout(claim.paper_title)}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {phase === "loading" && <p className="text-sm text-fg-muted">Checking the figure against Scopus…</p>}

          {phase === "error" && is502 && (
            <Callout tone="critical" title="Scopus could not be reached">
              <p>The amount was not refreshed. Nothing has been cleared.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button kind="default" size="sm" onClick={() => void runRecalc(false)}>
                  Try again
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
              <p className="figure text-figure tabular">{money(amount)}</p>
              <p className="text-sm text-fg-muted">
                This clears {money(amount)} and sends the claim to the Principal to approve. It leaves this queue.
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
              <p className="mt-2">Nothing has been cleared. Work the amount out again to see the new figure, then confirm.</p>
            </Callout>
          )}
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button kind="primary" onClick={() => void runRecalc()}>
              Work it out again
            </Button>
          ) : (
            <Button ref={confirmRef} kind="primary" disabled={phase !== "ready" || amount == null || busy} onClick={() => void confirmClear()}>
              {busy ? "Clearing…" : `Clear ${amount != null ? money(amount) : ""}`.trim()}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Send back                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send the claim back to the claimant with a reason.
 *
 * The reason starts as whatever the reviewer has already written down on the
 * document and the checklist (`composeSendBackReason`), so a claim with three
 * marked problems does not make them type the three problems again. It stays
 * editable, and the claimant sees it exactly as it stands when they press
 * the button.
 */
export function SendBackDialog({
  claim,
  open,
  onOpenChange,
  prefill,
  onDone,
}: {
  claim: WorkspaceClaim
  open: boolean
  onOpenChange: (open: boolean) => void
  prefill: string
  onDone: () => void
}) {
  const { me } = useAuth()
  const [note, setNote] = useState("")
  const send = useApiMutation<{ note: string }, unknown>(`/api/claims/${claim.id}/reject`, {
    invalidates: decisionKeys(claim.id),
  })

  useEffect(() => {
    if (open) setNote(prefill)
    // The prefill is read once, as the dialog opens. Marks added while it is
    // open must not overwrite a sentence somebody is in the middle of editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10

  async function submit() {
    try {
      await send.mutateAsync({ note: trimmed })
      rememberReason(trimmed)
      toast.ok(`Sent back${claim.ticket_number ? `. ${claim.ticket_number}` : ""}`)
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
          <DialogTitle>Send this claim back?</DialogTitle>
          <DialogDescription>{unshout(claim.paper_title)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field
            label="Reason"
            hint={
              prefill
                ? "Written from your marks and checklist. The claimant sees this exactly as it stands here. Ctrl and Enter send it."
                : "The claimant sees this sentence first, at the top of their paper. Say what to fix."
            }
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && trimmed.length >= 10 && !send.isPending) {
                  e.preventDefault()
                  void submit()
                }
              }}
              rows={5}
              placeholder="What needs to change before this can be filed again"
            />
          </Field>
          <div className="mt-3 space-y-3">
            <AiReasonDraft
              claimId={claim.id}
              version={claim.updated_at}
              role={me?.role}
              onUse={(t) => setNote((n) => (n.trim() ? `${n.trim()}\n\n${t}` : t))}
            />
            <ReasonChips onPick={(t) => setNote((n) => (n.trim() ? `${n.trim()} ${t}` : t))} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={trimmed.length < 10 || send.isPending} onClick={() => void submit()}>
            {send.isPending ? "Sending…" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Hold                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Hold a claim at this desk, with a reason. A hold is the one decision the
 * server lets a person take back, so its toast carries an Undo that resumes
 * the claim; the others (clear, send back, reject) have no way back and say
 * so by not offering one.
 */
export function HoldDialog({
  claim,
  open,
  onOpenChange,
  onDone,
}: {
  claim: WorkspaceClaim
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [reason, setReason] = useState("")
  const hold = useApiMutation<{ reason: string }, unknown>(`/api/claims/${claim.id}/hold`, {
    invalidates: decisionKeys(claim.id),
  })
  const qc = useQueryClient()

  useEffect(() => {
    if (open) setReason("")
  }, [open])

  const trimmed = reason.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10

  async function submit() {
    try {
      await hold.mutateAsync({ reason: trimmed })
      // The undo outlives this claim: the next one opens as soon as the hold
      // lands. So it names the claim it was made for, by id, rather than
      // asking a hook that will by then point at whichever claim is open.
      const heldId = claim.id
      toast.undoable(`Held${claim.ticket_number ? `. ${claim.ticket_number}` : ""}`, () => {
        api(`/api/claims/${heldId}/resume`, { method: "POST", json: {} })
          .then(() => {
            for (const key of decisionKeys(heldId)) void qc.invalidateQueries({ queryKey: key })
            toast.ok("Resumed")
          })
          .catch((err: unknown) => toast.fail(err))
      })
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
          <DialogTitle>Hold this claim?</DialogTitle>
          <DialogDescription>{unshout(claim.paper_title)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field
            label="Reason"
            hint="It stays at this desk until somebody resumes it. The claimant is told it is on hold."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={hold.isPending}>
            Cancel
          </Button>
          <Button kind="default" disabled={trimmed.length < 10 || hold.isPending} onClick={() => void submit()}>
            {hold.isPending ? "Holding…" : "Hold"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
