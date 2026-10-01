import { useEffect, useState } from "react"

import { useAuth } from "@/app/auth"
import { useApiMutation } from "@/lib/query"
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
import { money } from "@/ui/paper"
import { Callout } from "@/ui/state"
import { toast } from "@/ui/toast"

import { decisionKeys } from "./decisions"
import type { WorkspaceClaim } from "./types"

/**
 * The three desk actions that are not a decision but that a claim can be
 * stuck without: confirming figures by hand, the second signature, and
 * moving a claim off a retired status. The side sheet had all three; a
 * workspace without them would leave an unpriced or stranded claim with no
 * way forward, so they live in the decision bar's "More" menu.
 */

/** Statuses the ERP import writes that nothing in the live chain can act on. */
export const LEGACY_STATUSES = ["HOD_APPROVED", "RESEARCH_APPROVED", "FINANCE_APPROVED"]

const QUARTILES = ["Q1", "Q2", "Q3", "Q4"]

export function ManualVerifyDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: WorkspaceClaim
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

  const save = useApiMutation<{ snip?: number; quartile?: string; note: string }, unknown>(
    `/api/admin/claims/${claim.id}/set-verified`,
    { invalidates: decisionKeys(claim.id) }
  )

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
          <DialogTitle>Confirm figures</DialogTitle>
          <DialogDescription>
            For a journal the index cannot confirm. What you enter is treated as confirmed and the amount is worked out from it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="This replaces the claimant's own figures">
            Values entered here are kept when the claim is checked again, so they decide the payment from now on.
          </Callout>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <Field label="SNIP" error={snipBad ? "That is not a number." : undefined}>
              <Input value={snip} onChange={(e) => setSnip(e.target.value)} placeholder="1.205" />
            </Field>
            <Field label="Quartile">
              <Combobox
                value={quartile}
                onChange={setQuartile}
                options={[{ value: "", label: "Leave as it is" }, ...QUARTILES.map((q) => ({ value: q, label: q }))]}
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
            {save.isPending ? "Saving…" : "Confirm and work out again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SecondSignatureDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: WorkspaceClaim
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
    { invalidates: decisionKeys(claim.id) }
  )

  // The server refuses a second signature from whoever cleared the claim;
  // saying so here first spares the reader the refusal.
  const selfCleared = Boolean(me?.name && claim.cleared_by_name && me.name === claim.cleared_by_name)

  async function submit() {
    try {
      await sign.mutateAsync({ note: note.trim() || undefined, expected_amount: claim.remuneration ?? undefined })
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
              The second signature has to come from somebody else. The server will refuse it from you.
            </Callout>
          ) : (
            <Callout tone="info" title="What this does">
              It confirms the amount as a second, different pair of eyes. Finance cannot pay this claim until somebody other than{" "}
              {claim.cleared_by_name || "whoever cleared it"} has signed.
            </Callout>
          )}
          <Field label="Note" hint="Optional. What you checked.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={sign.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={selfCleared || sign.isPending} onClick={() => void submit()}>
            {sign.isPending ? "Signing…" : `Sign ${money(claim.remuneration)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function OverrideStatusDialog({
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
  const [to, setTo] = useState("SUBMITTED")
  const [note, setNote] = useState("")

  useEffect(() => {
    if (!open) return
    setTo("SUBMITTED")
    setNote("")
  }, [open])

  const override = useApiMutation<{ to_status: string; note: string }, unknown>(
    `/api/admin/claims/${claim.id}/override-status`,
    { invalidates: [...decisionKeys(claim.id), ["admin", "faults"]] }
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
            It is on {(claim.status ?? "").replace(/_/g, " ").toLowerCase()}, which the current chain has no step for.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="Cleared is not a shortcut to paid">
            Moving it to Cleared puts it back in the chain at the checking step. It still has to be approved and authorised before
            Finance can pay it, and the amount is worked out again rather than taken from the import.
          </Callout>
          <Field label="Move it to">
            <Combobox
              value={to}
              onChange={setTo}
              options={[
                { value: "SUBMITTED", label: "Filed, back in the clearing queue" },
                { value: "CLEARED", label: "Checked, waiting on the Principal" },
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
          <Button kind="primary" disabled={trimmed.length < 10 || override.isPending} onClick={() => void submit()}>
            {override.isPending ? "Moving…" : "Move it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
