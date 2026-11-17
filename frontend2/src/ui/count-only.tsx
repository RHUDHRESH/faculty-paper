import { useEffect, useState } from "react"
import { Ellipsis } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { CHAIN, useApiMutation } from "@/lib/query"
import { unshout } from "@/lib/names"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { useIsOwnClaim } from "@/ui/desk-actions"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Radio, Textarea } from "@/ui/field"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { toast } from "@/ui/toast"

/**
 * "Accept for count only": a reviewer decides the paper is counted for the
 * college and no incentive is paid. Server: POST /api/claims/{id}/count-only
 * (backend/core/services/count_only.py).
 *
 * It is a secondary action, so it lives in a row's More menu, never beside the
 * primary button. Who may do it mirrors the server: the research cell's roles
 * while a claim waits to be cleared, the Principal once it is cleared, the
 * Director once the Principal has approved it, and a super admin at all three.
 * Never on a claim you filed yourself.
 */

export type CountOnlyStage = "SUBMITTED" | "CLEARED" | "PRINCIPAL_APPROVED"

/** `services.count_only.may_accept`. */
export function canAcceptForCountOnly(role: Role | undefined, status: string | null | undefined): boolean {
  if (!role) return false
  if (role === "SUPER_ADMIN") return status === "SUBMITTED" || status === "CLEARED" || status === "PRINCIPAL_APPROVED"
  if (status === "SUBMITTED") return role === "RESEARCH_CELL" || role === "RESEARCH_COORDINATOR"
  if (status === "CLEARED") return role === "PRINCIPAL"
  if (status === "PRINCIPAL_APPROVED") return role === "DIRECTOR"
  return false
}

export type CountOnlyClaim = {
  id: string
  paper_title?: string | null
  ticket_number?: string | null
  owner_email?: string | null
  status?: string | null
  claim_reason?: string | null
}

export const COUNT_ONLY_REASONS = [
  { value: "student_publication", label: "Student publication" },
  { value: "no_sec_citation", label: "Does not cite SEC-affiliated articles" },
  { value: "other", label: "Other reason" },
] as const

type Reason = (typeof COUNT_ONLY_REASONS)[number]["value"]

/** The "Count only" badge a row or a heading wears once a paper is counted and not paid. */
export function CountOnlyBadge({ claim, className }: { claim: { claim_reason?: string | null }; className?: string }) {
  if (claim.claim_reason !== "COUNT_ONLY") return null
  return (
    <Chip tone="neutral" className={className} title="Counted for the college. No incentive is paid.">
      Count only
    </Chip>
  )
}

export function CountOnlyDialog({
  claim,
  open,
  onOpenChange,
  onDone,
  invalidates,
}: {
  claim: CountOnlyClaim
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
  /** Query keys to refetch; defaults to the desk lists and this claim. */
  invalidates?: unknown[][]
}) {
  const [reason, setReason] = useState<Reason>("student_publication")
  const [note, setNote] = useState("")
  const run = useApiMutation<{ reason: Reason; note?: string }, unknown>(`/api/claims/${claim.id}/count-only`, {
    invalidates: invalidates ?? [...CHAIN, ["claim", claim.id]],
  })

  useEffect(() => {
    if (!open) return
    setReason("student_publication")
    setNote("")
  }, [open])

  const trimmed = note.trim()
  const needsNote = reason === "other"
  const ready = !run.isPending && (!needsNote || trimmed.length > 0)

  async function submit() {
    try {
      await run.mutateAsync(needsNote ? { reason, note: trimmed } : { reason })
      toast.ok("Recorded for count only")
      onOpenChange(false)
      onDone?.()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Accept for count only?</DialogTitle>
          <DialogDescription>
            {unshout(claim.paper_title)}
            {claim.ticket_number ? `, ${claim.ticket_number}` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <fieldset className="space-y-2.5">
            <legend className="mb-2 text-sm font-medium">Why is it counted only?</legend>
            {COUNT_ONLY_REASONS.map((r) => (
              <Radio
                key={r.value}
                name={`count-only-${claim.id}`}
                label={r.label}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
              />
            ))}
          </fieldset>
          {needsNote && (
            <Field label="Say why" hint="The claimant is told this reason.">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={200} />
            </Field>
          )}
          <p className="text-sm text-fg-muted">The paper is counted for the college. No incentive is paid.</p>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready} onClick={() => void submit()}>
            {run.isPending ? "Working…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The row's More menu. Renders nothing where the signed-in person may not
 * accept this claim for count only (wrong role, wrong step, their own claim,
 * or already count only), so a desk without the action shows no empty menu.
 */
export function CountOnlyRowMenu({ claim, stage }: { claim: CountOnlyClaim; stage: CountOnlyStage }) {
  const { me } = useAuth()
  const own = useIsOwnClaim(claim)
  const [open, setOpen] = useState(false)
  if (own || claim.claim_reason === "COUNT_ONLY" || !canAcceptForCountOnly(me?.role, claim.status ?? stage)) return null
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button kind="quiet" size="icon" aria-label={`More actions for ${unshout(claim.paper_title) || claim.ticket_number || "this claim"}`}>
            <Ellipsis />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-[14rem]">
          <MenuItem onSelect={() => setOpen(true)}>Accept for count only</MenuItem>
        </MenuContent>
      </Menu>
      <CountOnlyDialog claim={claim} open={open} onOpenChange={setOpen} />
    </>
  )
}
