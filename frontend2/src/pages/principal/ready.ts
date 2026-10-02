import { thresholdFlag } from "@/ui/research-threshold"
import type { QueueClaim } from "@/pages/approvals-actions"

/**
 * What makes a cleared claim ready for the Principal to approve without
 * reading it twice: nothing is on hold, no flag is open, no possible
 * duplicate, and an amount has been worked out. (A claim that needs a second
 * signature is still ready: her approval is that signature, unless she cleared
 * it herself, which the server refuses.)
 *
 * Each reason is a phrase the lane shows in words, so a claim that needs her
 * eyes says why on its own row (docs/ux/27).
 */
export function notReady(c: QueueClaim): string[] {
  const why: string[] = []
  if (c.on_hold) why.push("On hold")
  if ((c.open_flags ?? 0) > 0) why.push(c.open_flags === 1 ? "Open flag" : `${c.open_flags} open flags`)
  if (c.duplicate_warning) why.push("Possible duplicate")
  if (c.calc_error || c.remuneration == null) why.push("No amount")
  return why
}

export const isReady = (c: QueueClaim) => notReady(c).length === 0

/** Things worth knowing about a claim that do not stop it being ready. */
export function notes(c: QueueClaim): string[] {
  const out: string[] = []
  if (c.needs_second_approval) out.push("Your approval is the second signature")
  const t = thresholdFlag(c)
  if (t) out.push(t)
  if (c.owner_threshold_unset) out.push("Research faculty, threshold not set")
  if (!c.calc_error && c.remuneration_is_estimate) out.push("Estimate")
  return out
}
