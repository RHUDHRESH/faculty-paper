import { useRef, useState } from "react"

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
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import type { QueueClaim } from "@/pages/approvals-actions"

/**
 * The one question before spend leaves the Principal's desk, for a batch.
 * (One claim is the `ApproveDialog` of approvals-actions.tsx, which also
 * handles the figure moving under her.)
 *
 * The confirm button takes focus when the dialog opens, so `Enter` confirms:
 * approving the ready claims is the button and then Enter. That is safe
 * because nothing is decided by the keystroke alone: every claim is checked
 * again on the server as it approves, and one whose amount has moved is
 * skipped, never approved at the wrong number. The dialog says so.
 */

export type LeftOut = { count: number; reasons: { label: string; count: number }[] }

export function ApproveConfirmDialog({
  open,
  onOpenChange,
  rows,
  leftOut,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: QueueClaim[]
  /** Claims in view that are not part of this batch, by reason. */
  leftOut?: LeftOut
  onConfirm: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const total = rows.reduce((s, r) => s + (r.remuneration || 0), 0)
  const unpriced = rows.filter((r) => r.remuneration == null).length
  const second = rows.filter((r) => r.needs_second_approval).length

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="md"
        onOpenAutoFocus={(e) => {
          // Focus the button that says what will happen, not the Cancel
          // beside it: Enter is the answer to the question on screen.
          e.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{rows.length === 1 ? "Approve this claim?" : `Approve ${rows.length} claims?`}</DialogTitle>
          <DialogDescription>
            {rows.length === 1 ? "It goes" : "They go"} to the Director to authorise, then Finance pays.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          <ul aria-label="Claims in this batch" className="max-h-56 divide-y divide-line overflow-y-auto border-y border-line">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <Avatar
                  person={{ name: r.owner_name, initials: r.owner_initials ?? initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }}
                  size="xs"
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {r.owner_name}
                  <span className="text-fg-muted"> · {r.ticket_number || "No claim no."}</span>
                </span>
                <span className="tabular shrink-0 text-sm">{r.remuneration == null ? "No amount" : money(r.remuneration)}</span>
              </li>
            ))}
          </ul>

          <div>
            <p className="figure text-figure tabular">{money(total)}</p>
            <p className="mt-1 text-sm text-fg-muted">
              across {rows.length} {rows.length === 1 ? "claim" : "claims"}
              {unpriced > 0 ? `, ${unpriced} without an amount` : ""}
            </p>
          </div>

          {second > 0 && (
            <p className="text-sm text-fg-muted">
              {second === 1 ? "One needs" : `${second} need`} a second signature. Your approval is it.
            </p>
          )}

          {leftOut && leftOut.count > 0 && (
            <div className="text-sm">
              <p className="font-medium">{leftOut.count} left for you to look at</p>
              <p className="text-fg-muted">{leftOut.reasons.map((x) => `${x.count} ${x.label.toLowerCase()}`).join(", ")}.</p>
            </div>
          )}

          <p className="text-xs text-fg-muted">
            Each claim is checked again as it is approved. One whose amount has moved is skipped, not approved at the wrong number.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            kind="primary"
            disabled={busy || rows.length === 0}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                onOpenChange(false)
              } catch {
                // The caller has already said what went wrong; the dialog stays.
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? "Approving…" : rows.length === 1 ? `Approve ${money(total)}` : `Approve ${rows.length} for ${money(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
