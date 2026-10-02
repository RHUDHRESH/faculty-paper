import { useState } from "react"

import { useAuth } from "@/app/auth"
import { CHAIN, useApiMutation } from "@/lib/query"
import { money } from "@/ui/paper"
import { SkippedDialog } from "@/ui/queue"
import { toast } from "@/ui/toast"
import { ApproveDialog, RejectDialog } from "@/pages/approvals-actions"
import type { BulkApproveResult, QueueClaim } from "@/pages/approvals-actions"
import { ApproveConfirmDialog, type LeftOut } from "@/pages/principal/approve-confirm"
import { notReady } from "@/pages/principal/ready"

/**
 * Every way the Principal decides a claim from a list, in one place, so Home
 * and Approvals do the same thing the same way: approve a batch (one
 * confirmation, then the Stamp), approve one claim (at the figure shown, and
 * re-confirmed if it moved), or send one back with a reason of its own.
 *
 * It returns the dialogs to draw (`node`) and the three verbs. A batch that
 * is not wholly approved says, claim by claim, what was skipped and why.
 */
export function useApprovals(options: { rows?: QueueClaim[]; onApproved?: (ids: string[]) => void } = {}) {
  const { me } = useAuth()
  const [batch, setBatch] = useState<QueueClaim[] | null>(null)
  const [one, setOne] = useState<{ claim: QueueClaim; mode: "approve" | "send-back" } | null>(null)
  const [result, setResult] = useState<{ result: BulkApproveResult; lookup: Map<string, QueueClaim> } | null>(null)

  const bulk = useApiMutation<{ claim_ids: string[]; note?: string }, BulkApproveResult>("/api/principal/bulk-approve", {
    invalidates: [...CHAIN],
  })

  /** What a batch leaves out of the claims in view, by reason. */
  function leftOutOf(inBatch: QueueClaim[]): LeftOut | undefined {
    const pool = options.rows
    if (!pool) return undefined
    const ids = new Set(inBatch.map((c) => c.id))
    const rest = pool.filter((c) => !ids.has(c.id))
    const tally = new Map<string, number>()
    for (const c of rest) {
      for (const w of notReady(c)) {
        const why = w.replace(/^\d+ open flags$/i, "Open flag")
        tally.set(why, (tally.get(why) ?? 0) + 1)
      }
    }
    return { count: rest.length, reasons: [...tally].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })) }
  }

  async function run(rows: QueueClaim[]) {
    const ids = rows.map((c) => c.id)
    const lookup = new Map(rows.map((c) => [c.id, c]))
    try {
      const res = await bulk.mutateAsync({ claim_ids: ids })
      const skipped = new Set(res.skipped.map((s) => s.id))
      const done = rows.filter((c) => !skipped.has(c.id))
      const sum = done.reduce((s, c) => s + (c.remuneration || 0), 0)
      if (res.approved > 0) {
        toast.stamp(
          "Approved",
          res.approved === 1
            ? `${money(sum)} sent to the Director${done[0]?.ticket_number ? `. ${done[0].ticket_number}` : ""}.`
            : `${res.approved} claims, ${money(sum)}, sent to the Director.`
        )
        options.onApproved?.(done.map((c) => c.id))
      }
      if (res.skipped.length > 0) setResult({ result: res, lookup })
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  const node = (
    <>
      <ApproveConfirmDialog
        open={batch != null}
        onOpenChange={(o) => !o && setBatch(null)}
        rows={batch ?? []}
        leftOut={batch && batch.length > 1 ? leftOutOf(batch) : undefined}
        onConfirm={() => run(batch ?? [])}
      />
      {one?.mode === "approve" && (
        <ApproveDialog
          claim={one.claim}
          open
          onOpenChange={(o) => !o && setOne(null)}
          me={me}
          onApproved={() => {
            options.onApproved?.([one.claim.id])
            setOne(null)
          }}
        />
      )}
      {one?.mode === "send-back" && (
        <RejectDialog
          claim={one.claim}
          open
          onOpenChange={(o) => !o && setOne(null)}
          onRejected={() => setOne(null)}
        />
      )}
      {result && (
        <SkippedDialog
          title={`Approved ${result.result.approved} of ${result.result.approved + result.result.skipped.length}`}
          description={`${money(result.result.total)} sent to the Director. The rest were skipped, each for its own reason below. Nothing was approved at a wrong figure.`}
          skipped={result.result.skipped}
          lookup={result.lookup}
          onClose={() => setResult(null)}
        />
      )}
    </>
  )

  return {
    node,
    /** Approve these, after one confirmation. */
    approveBatch: (rows: QueueClaim[]) => rows.length > 0 && setBatch(rows),
    /** Approve one claim at the figure shown. */
    approveOne: (claim: QueueClaim) => setOne({ claim, mode: "approve" }),
    /** Send one claim back to the research cell, with a reason. */
    sendBack: (claim: QueueClaim) => setOne({ claim, mode: "send-back" }),
    busy: bulk.isPending,
  }
}
