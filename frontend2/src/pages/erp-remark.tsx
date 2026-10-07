import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { paperTitle } from "@/lib/names"
import { Button } from "@/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Avatar, initialsOf } from "@/ui/person"
import { Details } from "@/ui/section"
import { InlineError } from "@/ui/state"
import { toast } from "@/ui/toast"

/**
 * Put the old-ERP claims that were wrongly marked Paid back to "approved,
 * amount to be worked out", so they enter the normal monthly run (docs/ux/29,
 * section 7).
 *
 * The accounts sheet never priced or paid these; the import marked them Paid.
 * The server decides which claims change (`core/services/erp_remark.py`), the
 * preview lists exactly those and the ones held back for the research cell,
 * the apply carries the preview's signature so a stale list is refused, and
 * the whole run is audit-logged and can be undone.
 */

type Who = { id?: string; name: string; staff_id?: string | null; photo_url?: string | null }
type Row = {
  claim_id: string
  claim_no: string | null
  claimant: Who | null
  title: string | null
  status_before?: string
  status_after?: string
  reason?: string
}
type Preview = {
  will_change: Row[]
  held: Row[]
  counts: { will_change: number; held_repeat: number; held_rejected: number; already_done: number }
  signature: string
  after_status_label: string
}
type Batch = { batch_id: string; at: string; by: string | null; changed: number; undone: boolean }

const KEY = ["admin", "erp-remark"] as const

function People({ rows, why = false }: { rows: Row[]; why?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.claim_id} className="flex items-center gap-3 py-2">
          <Avatar
            size="sm"
            person={{
              name: r.claimant?.name ?? "",
              initials: initialsOf(r.claimant?.name),
              photo_url: r.claimant?.photo_url ?? null,
            }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{paperTitle(r.title)}</p>
            <p className="truncate text-xs text-fg-muted">
              {r.claimant?.name ?? "Claimant not identified"}
              {r.claim_no ? ` · ${r.claim_no}` : ""}
            </p>
          </div>
          {why && r.reason ? <span className="max-w-[16rem] shrink-0 text-right text-xs text-fg-muted max-sm:hidden">{r.reason}</span> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * The panel at the top of "Fix imported claims". Silent when there is nothing
 * to re-mark and nothing to undo.
 */
export function ErpRemark() {
  const qc = useQueryClient()
  const preview = useApi<Preview>([...KEY, "preview"], "/api/admin/erp-remark/preview")
  const batches = useApi<{ batches: Batch[] }>([...KEY, "batches"], "/api/admin/erp-remark/batches")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const p = preview.data
  const last = batches.data?.batches.find((b) => !b.undone)
  const n = p?.counts.will_change ?? 0
  const held = (p?.counts.held_repeat ?? 0) + (p?.counts.held_rejected ?? 0)

  if (preview.isError) {
    return <InlineError message="Could not check the claims marked Paid in error." onRetry={() => void preview.refetch()} />
  }
  if (!p || (n === 0 && !last)) return null

  async function refresh() {
    await Promise.all([qc.invalidateQueries({ queryKey: KEY }), qc.invalidateQueries({ queryKey: ["admin"] })])
  }

  async function apply() {
    if (!p) return
    setBusy(true)
    try {
      const out = await api<{ batch_id: string; changed: number }>("/api/admin/erp-remark/apply", {
        method: "POST",
        json: { signature: p.signature, confirm: true },
      })
      setOpen(false)
      await refresh()
      toast.undoable(`Re-marked ${out.changed.toLocaleString("en-IN")} claims`, () => void undo(out.batch_id))
    } catch (err) {
      toast.fail(err, "Could not re-mark the claims. Nothing was changed.")
    } finally {
      setBusy(false)
    }
  }

  async function undo(batchId: string) {
    setBusy(true)
    try {
      const out = await api<{ restored: number }>("/api/admin/erp-remark/undo", { method: "POST", json: { batch_id: batchId } })
      await refresh()
      toast.ok(`Restored ${out.restored.toLocaleString("en-IN")} claims to Paid`)
    } catch (err) {
      toast.fail(err, "Could not undo. Nothing was changed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="remark-title" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-line py-4">
      <div className="min-w-0 flex-1 basis-72">
        <h2 id="remark-title" className="text-base font-medium">
          {n > 0
            ? `${n.toLocaleString("en-IN")} ${n === 1 ? "claim is" : "claims are"} marked Paid but were never priced`
            : "Claims were re-marked from Paid"}
        </h2>
        <p className="mt-0.5 text-sm text-fg-muted">
          {n > 0
            ? `Put ${n === 1 ? "it" : "them"} back to Checked: the Principal approves an amount, the Director authorises it and Finance pays it in the run.${held ? ` ${held.toLocaleString("en-IN")} stay held for the research office.` : ""}`
            : `Last run: ${last?.changed.toLocaleString("en-IN")} claims. You can put them back.`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {last && (
          <Button kind="quiet" disabled={busy} onClick={() => void undo(last.batch_id)}>
            Undo the last re-mark
          </Button>
        )}
        {n > 0 && (
          <Button kind="primary" onClick={() => setOpen(true)}>
            Preview {n.toLocaleString("en-IN")} {n === 1 ? "claim" : "claims"}
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              Re-mark {n.toLocaleString("en-IN")} {n === 1 ? "claim" : "claims"}
            </DialogTitle>
            <DialogDescription>
              From Paid to Checked, waiting for the Principal. Nothing is paid or removed, and you can undo it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <People rows={p.will_change} />
            {p.held.length > 0 && (
              <Details count={p.held.length} label="held for the research office">
                <People rows={p.held} why />
              </Details>
            )}
          </DialogBody>
          <DialogFooter>
            <Button kind="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button kind="primary" disabled={busy} onClick={() => void apply()}>
              Re-mark {n.toLocaleString("en-IN")} {n === 1 ? "claim" : "claims"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
