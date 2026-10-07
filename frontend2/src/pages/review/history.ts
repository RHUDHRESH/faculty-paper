import type { ClaimAction } from "./types"

/**
 * One line of a claim's history in words. The codes are the ones
 * `_transition()` writes in backend/core/api; a code this does not know is
 * humanised rather than left blank, so a new action is never an empty line.
 * This is the staff view, so it names who did what.
 */
export function actionSentence(a: ClaimAction): string {
  const who = a.actor_name
  const base = (() => {
    switch (a.action) {
      case "CREATE_DRAFT":
        return `${who} started this draft`
      case "ADMIN_CREATE":
        return `${who} created this on the author's behalf`
      case "SUBMIT":
        return `${who} filed it`
      case "CONTEST_FORWARD":
        return `${who} filed it, flagging it for review`
      case "RESUBMIT":
        return `${who} filed it again`
      case "WITHDRAW":
        return `${who} withdrew it to fix it`
      case "CLEAR":
        return `${who} checked it and sent it to the Principal`
      case "PRINCIPAL_APPROVE":
        return `${who} approved it`
      case "PRINCIPAL_SEND_BACK":
        return `${who} sent it back to the research office`
      case "SECOND_APPROVE":
        return `${who} gave the second approval`
      case "MARK_PAID":
        return `${who} marked it paid`
      case "VOID_PAYMENT":
        return `${who} voided the payment`
      case "REJECT":
        return `${who} sent it back`
      case "REJECT_OUTRIGHT":
        return `${who} rejected it`
      case "HOLD":
        return `${who} put it on hold`
      case "RESUME":
        return `${who} took it off hold`
      case "STATUS_OVERRIDE":
        return `${who} moved it to ${a.to_status.replace(/_/g, " ").toLowerCase()} directly`
      case "VERIFY":
        return `${who} checked its figures`
      case "MANUAL_VERIFY":
        return `${who} confirmed its figures by hand`
      case "PACK_CORRECT":
        return `${who} corrected a field`
      case "ADMIN_EDIT":
        return `${who} edited it`
      case "REASSIGN":
        return `${who} reassigned it`
      default:
        return `${who} ${a.action.replace(/_/g, " ").toLowerCase()}`
    }
  })()
  return a.note ? `${base}: ${a.note}` : base
}

/** "30 Sep 2026, 2:05 pm" in the reader's own zone, or empty for no date. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
