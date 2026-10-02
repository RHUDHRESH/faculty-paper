import { useRef, useState } from "react"

import { paperTitle } from "@/lib/names"
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
import { Meta } from "@/ui/text"
import type { QueueClaim } from "@/pages/clearing-actions"

/**
 * The one question before a claim leaves the desk, for one claim or for a
 * batch. The same dialog serves `c` on a row and `a` then `c` on the ready
 * lane, so the clerk learns one thing.
 *
 * The confirm button takes focus when the dialog opens, so `Enter` confirms:
 * clearing a ready claim is `c`, `Enter`. That is safe because nothing is
 * decided by the keystroke alone: the server checks every claim again as it
 * clears and skips one whose amount has moved, and the dialog says so.
 */

/** Why a claim in the batch is worth a second look, in the desk's words. */
export type BatchNote = { id: string; note: string }

export function ClearConfirmDialog({
  open,
  onOpenChange,
  rows,
  notes = [],
  leftOut,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: QueueClaim[]
  /** Claims in the batch that the desk may want to weigh before confirming. */
  notes?: BatchNote[]
  /** Claims in view that are not part of this batch, by reason. */
  leftOut?: { count: number; reasons: { label: string; count: number }[] }
  onConfirm: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const total = rows.reduce((s, r) => s + (r.remuneration || 0), 0)
  const one = rows.length === 1 ? rows[0] : null
  const unpriced = rows.filter((r) => r.remuneration == null).length

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size={one ? "sm" : "md"}
        onOpenAutoFocus={(e) => {
          // Focus the button that says what will happen, not the Cancel
          // beside it: Enter is the answer to the question on screen.
          e.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{one ? "Clear this claim?" : `Clear ${rows.length} claims?`}</DialogTitle>
          <DialogDescription>
            {one
              ? "It goes to the Principal to approve and leaves this queue."
              : "They go to the Principal to approve and leave this queue."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {one ? (
            <div className="flex items-start gap-3">
              <Avatar person={{ name: one.owner_name, initials: initialsOf(one.owner_name), photo_url: one.owner_photo_url ?? null }} size="md" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{one.owner_name}</p>
                <p className="text-pretty text-sm text-fg-muted">{paperTitle(one.paper_title)}</p>
                <Meta className="mt-0.5 block tabular">{one.ticket_number || "No claim no."}</Meta>
              </div>
            </div>
          ) : (
            <ul aria-label="Claims in this batch" className="max-h-56 divide-y divide-line overflow-y-auto border-y border-line">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2">
                  <Avatar person={{ name: r.owner_name, initials: initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {r.owner_name}
                    <span className="text-fg-muted"> · {r.ticket_number || "No claim no."}</span>
                  </span>
                  <span className="tabular shrink-0 text-sm">{r.remuneration == null ? "No amount" : money(r.remuneration)}</span>
                </li>
              ))}
            </ul>
          )}

          <div>
            <p className="figure text-figure tabular">{money(total)}</p>
            {!one && (
              <p className="mt-1 text-sm text-fg-muted">
                across {rows.length} claims{unpriced > 0 ? `, ${unpriced} without an amount` : ""}
              </p>
            )}
          </div>

          {notes.length > 0 && (
            <div className="rounded-control bg-caution-wash px-3 py-2 text-sm">
              <p className="font-medium text-caution">
                {notes.length === 1 ? "One claim is" : `${notes.length} claims are`} not marked ready
              </p>
              <ul className="mt-1 space-y-0.5 text-fg">
                {notes.slice(0, 5).map((n) => (
                  <li key={n.id}>{n.note}</li>
                ))}
                {notes.length > 5 && <li className="text-fg-muted">and {notes.length - 5} more</li>}
              </ul>
            </div>
          )}

          {leftOut && leftOut.count > 0 && (
            <div className="text-sm">
              <p className="font-medium">{leftOut.count} left for you to look at</p>
              <p className="text-fg-muted">{leftOut.reasons.map((x) => `${x.count} ${x.label}`).join(", ")}.</p>
            </div>
          )}

          <p className="text-xs text-fg-muted">
            Each claim is checked again as it clears. One whose amount has moved is skipped, not cleared at the wrong number.
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
            {busy ? "Clearing…" : one ? `Clear ${money(total)}` : `Clear ${rows.length} for ${money(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
