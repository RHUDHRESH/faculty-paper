"use client"

import { useState } from "react"
import { AlertTriangle, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * The two irreversible things, and the friction they deserve.
 *
 * This database holds 3,236 settled publications and ₹2.76 crore paid to real
 * people. A delete has no undo, so the dialogs below are deliberately slower
 * than the rest of the app: they say what will go, they require a reason in
 * words, and the wipe requires its phrase typed out in full.
 *
 * None of that is the protection. The protection is on the server — a paid
 * claim, a ledger row and the audit log are refused there whatever arrives.
 * This just means the refusals are rare enough to be meaningful.
 */

export function DeleteRowDialog({
  row,
  table,
  tableName,
  onClose,
  onDeleted,
}: {
  row: Record<string, unknown> | null
  table: string
  tableName: string
  onClose: () => void
  onDeleted: () => void
}) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  if (!row) return null
  const id = String(row.id ?? "")

  async function remove() {
    setBusy(true)
    try {
      await api(`/api/admin/data/${tableName}/row/${id}`, {
        method: "DELETE",
        json: { reason },
      })
      toast.success("Deleted — recorded in the audit log")
      setReason("")
      onDeleted()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete that")
    } finally {
      setBusy(false)
    }
  }

  // The first few fields, so the reader sees what this row is rather than
  // an id they cannot recognise.
  const preview = Object.entries(row)
    .filter(([k, v]) => k !== "id" && v !== null && v !== "" && typeof v !== "object")
    .slice(0, 4)

  return (
    <Dialog open onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-left">
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
            Delete this row from {table}?
          </DialogTitle>
          <DialogDescription className="text-left">
            This cannot be undone. The row is removed and the audit log keeps a
            note of what it was.
          </DialogDescription>
        </DialogHeader>

        <dl className="divide-y divide-border rounded-[var(--radius)] border border-border">
          {preview.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[10rem_1fr] gap-3 px-3 py-2">
              <dt className="truncate text-xs text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words text-sm">{String(v)}</dd>
            </div>
          ))}
        </dl>

        <div className="space-y-1.5">
          <Label htmlFor="delete-reason">Why is this being deleted?</Label>
          <Input
            id="delete-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. duplicate row created by a failed import"
          />
          <p className="text-xs text-muted-foreground">
            Anything carrying a payment — a paid publication, a ledger entry, the
            audit log itself — is refused by the server whatever is typed here.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={remove}
            disabled={busy || reason.trim().length < 10}
          >
            <Trash2 className="size-4" />
            {busy ? "Deleting…" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type WipePreview = {
  counts: Record<string, number>
  total_rows: number
  paid_claims: number
  paid_amount: number
  phrase: string
  kept: string[]
}

export function WipeEverythingDialog({
  open,
  onClose,
  onWiped,
}: {
  open: boolean
  onClose: () => void
  onWiped: () => void
}) {
  const [confirm, setConfirm] = useState("")
  const [reason, setReason] = useState("")
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)

  const { data, isLoading } = useApiQuery<WipePreview>(
    ["wipe-preview"],
    "/api/admin/wipe/preview",
    { enabled: open }
  )

  if (!open) return null

  const phrase = data?.phrase || "DELETE EVERYTHING"
  const needsPaymentConsent = !!data?.paid_claims
  const ready =
    confirm.trim() === phrase &&
    reason.trim().length >= 10 &&
    (!needsPaymentConsent || accepted)

  async function wipe() {
    setBusy(true)
    try {
      const res = await api<{ total: number }>("/api/admin/wipe", {
        method: "POST",
        json: {
          confirm: confirm.trim(),
          reason,
          // Sent back so the server can refuse if the system changed while
          // this dialog was open.
          expect_rows: data?.total_rows,
          i_understand_payments_will_be_lost: accepted,
        },
      })
      toast.success(`Emptied — ${res.total.toLocaleString()} rows removed`)
      setConfirm("")
      setReason("")
      setAccepted(false)
      onWiped()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not empty the system")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-left text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
            Empty this system
          </DialogTitle>
          <DialogDescription className="text-left">
            Every publication, payment record and attachment is removed. There is
            no undo and no backup taken by this action.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Counting what is here…
          </p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-[var(--radius)] border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">
                {data.total_rows.toLocaleString()} rows will be destroyed
              </p>
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {Object.entries(data.counts)
                  .filter(([, n]) => n > 0)
                  .map(([name, n]) => (
                    <li key={name} className="flex justify-between gap-3">
                      <span>{name}</span>
                      <span className="tabular-nums">{n.toLocaleString()}</span>
                    </li>
                  ))}
              </ul>
            </div>

            <div className="rounded-[var(--radius)] border border-border p-4">
              <p className="text-xs font-medium">What survives</p>
              <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                {data.kept.map((k) => (
                  <li key={k}>· {k}</li>
                ))}
              </ul>
            </div>

            {needsPaymentConsent ? (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius)] border border-warning/40 bg-warning/10 p-3">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span className="text-xs text-warning-foreground">
                  I understand this destroys the record of{" "}
                  <strong>{data.paid_claims.toLocaleString()} settled payments</strong>{" "}
                  totalling{" "}
                  <strong>₹{data.paid_amount.toLocaleString("en-IN")}</strong> that
                  were actually made.
                </span>
              </label>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="wipe-reason">Why is the system being emptied?</Label>
              <Input
                id="wipe-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. clearing test data before the live import"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wipe-confirm">
                Type <span className="font-mono font-semibold">{phrase}</span> to confirm
              </Label>
              <Input
                id="wipe-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  "font-mono",
                  confirm && confirm.trim() !== phrase && "border-destructive"
                )}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={wipe} disabled={busy || !ready}>
            <Trash2 className="size-4" />
            {busy ? "Emptying…" : "Empty the system"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
