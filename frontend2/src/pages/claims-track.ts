/**
 * What a claimant is told about one of their own claims, as plain sentences.
 *
 * Everything here works from the claimant's copy of a claim, which carries a
 * `faculty_stage` and no raw status, and it never says which desk or person
 * holds the claim: only the stage, the days since filing, and what is asked
 * of the claimant. The words follow docs/ux/19-vocabulary.md.
 */
import { claimStatus, stageName } from "@/ui/journey"

export type TrackClaim = {
  status?: string | null
  faculty_stage?: string | null
  submitted_at?: string | null
  days_waiting?: number | null
  ticket_number?: string | null
  remuneration?: number | null
  remuneration_is_estimate?: boolean
  calc_error?: string | null
  /** What the research threshold took of the amount (research faculty only). */
  threshold_absorbed?: number | null
  /** "2026-09", when the money went out. */
  payout_month?: string | null
  paid_at?: string | null
}

/** The stage, in the college's words: "Being checked", never "Under review". */
export function stageWord(c: TrackClaim): string {
  const raw = c.faculty_stage || fallbackStage(claimStatus(c))
  return stageName(raw)
}

function fallbackStage(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft"
    case "PAID":
      return "Paid"
    case "DIRECTOR_APPROVED":
    case "FINANCE_APPROVED":
      return "Approved for payment"
    case "REJECTED":
      return "Sent back"
    default:
      return "Being checked"
  }
}

/** Whole days since filing, or null while it is a draft. */
export function daysSinceFiling(c: TrackClaim, now: Date = new Date()): number | null {
  if (stageWord(c) === "Draft" || stageWord(c) === "Withdrawn") return null
  if (c.submitted_at) {
    const t = new Date(c.submitted_at).getTime()
    if (!Number.isNaN(t)) return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
  }
  return c.days_waiting ?? null
}

export function filedSentence(c: TrackClaim, now: Date = new Date()): string {
  const stage = stageWord(c)
  if (stage === "Draft") return "Not filed yet"
  if (stage === "Withdrawn") return "Withdrawn. Back in your drafts"
  const days = daysSinceFiling(c, now)
  if (days == null) return "Filing date not recorded"
  if (days === 0) return "Filed today"
  if (days === 1) return "Filed yesterday"
  return `Filed ${days} days ago`
}

/** Longer than this with nobody having moved it is worth asking about. */
export const SLOW_DAYS = 14

/** The one sentence: what is needed from the claimant. */
export function needFromYou(c: TrackClaim, now: Date = new Date()): { text: string; action: boolean } {
  switch (stageWord(c)) {
    case "Draft":
      return { text: "Finish your draft and file it.", action: true }
    case "Withdrawn":
      return { text: "Fix what you wanted to change, then file it again.", action: true }
    case "Sent back":
      return { text: "Fix what was sent back, then send it again.", action: true }
    case "Not accepted":
      return { text: "Nothing. This claim was not accepted, and the reason is on the claim page.", action: false }
    case "Paid":
      return { text: "Nothing. It is in your payment statement.", action: false }
    case "Approved for payment":
      return { text: "Nothing. It is approved, and we'll tell you when it is paid.", action: false }
    default: {
      const days = daysSinceFiling(c, now)
      if (days != null && days > SLOW_DAYS) {
        return {
          text: "Nothing. It is taking longer than usual, so ask the research office if you need an update.",
          action: false,
        }
      }
      return { text: "Nothing. We'll tell you when it moves.", action: false }
    }
  }
}

/** "2026-09" to "September 2026". Null for anything else. */
export function monthLabel(ym: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(ym || "")
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return new Date(Date.UTC(Number(m[1]), month - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

/** The month a paid claim's money went out: the payout month, else the day it was paid. */
export function monthPaid(c: TrackClaim): string | null {
  if (stageWord(c) !== "Paid") return null
  return monthLabel(c.payout_month) ?? monthLabel(c.paid_at ? String(c.paid_at).slice(0, 7) : null)
}

/** The Indian financial year (April to March) a "2026-09" month falls in, named by its first year. */
export function financialYearOf(ym: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(ym || "")
  if (!m) return null
  const year = Number(m[1])
  return Number(m[2]) >= 4 ? year : year - 1
}

/** Where a paid claim's line sits in the payment statement. */
export function statementLink(c: TrackClaim): string {
  const ym = c.payout_month || (c.paid_at ? String(c.paid_at).slice(0, 7) : null)
  const fy = financialYearOf(ym)
  return fy == null ? "/papers/statement" : `/papers/statement?fy=${fy}`
}

export type AmountView = {
  /** "Expected" until it is paid, "Paid" after. */
  caption: string
  /** The figure, or null when there is honestly nothing to show. */
  amount: number | null
  /** Why there is no figure, or what kind of figure this is. */
  note: string | null
}

/** The amount, and which kind of amount it is: an estimate until paid. */
export function amountView(c: TrackClaim): AmountView {
  const paid = stageWord(c) === "Paid"
  const caption = paid ? "Paid" : "Expected"
  if (c.calc_error) return { caption, amount: null, note: "Could not be worked out" }
  // A draft has no amount worked out yet, whatever the calculator returns for its half-filled form.
  const draft = stageWord(c) === "Draft" || stageWord(c) === "Withdrawn"
  if (c.remuneration == null || draft || (c.remuneration === 0 && c.remuneration_is_estimate)) {
    return { caption, amount: null, note: "Not worked out yet" }
  }
  if (c.remuneration === 0) {
    // Nothing to pay because the yearly threshold took it all: say that, not "no payment due".
    if (!paid && (c.threshold_absorbed ?? 0) > 0) return { caption, amount: 0, note: "Inside your research threshold" }
    return { caption, amount: 0, note: paid ? "Amount not on record" : "No payment due" }
  }
  if (paid) return { caption, amount: c.remuneration, note: null }
  return { caption, amount: c.remuneration, note: "An estimate until it is paid" }
}

/** `GET /api/me/next-payout`: the college's payout rhythm. */
export type PayoutOutlook = {
  pattern: "monthly" | "most_months" | "none"
  last_run: string | null
  next_run: string | null
  next_run_label: string | null
  filing_cutoff_day: number | null
  /** The whole pattern in one plain sentence, written by the server. */
  sentence: string
}

/**
 * When the money for this claim is expected, in one sentence, from the
 * college's payout pattern. Nothing is promised: the month is the next run,
 * and only an approved claim is said to be in it.
 */
export function payoutLine(c: TrackClaim, outlook: PayoutOutlook | null | undefined): string | null {
  const stage = stageWord(c)
  if (stage === "Paid") {
    const month = monthPaid(c)
    return month ? `Paid in ${month}.` : "Paid."
  }
  if (stage === "Not accepted" || stage === "Withdrawn" || stage === "Draft") return null
  const next = outlook?.next_run_label
  if (stage === "Sent back") {
    return "It joins a payment run once you send it again and it is approved."
  }
  if (!next) return "The research office can tell you when the next payment run is."
  if (stage === "Approved for payment") return `Approved. It goes out in the next payment run, expected in ${next}.`
  return `If it is approved, the next payment run is expected in ${next}.`
}
