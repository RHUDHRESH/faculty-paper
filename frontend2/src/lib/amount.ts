import { money } from "@/ui/paper"

/**
 * A claim amount as the desk should read it. A zero or missing amount on a claim
 * brought across from the old ERP means the old system never recorded one, so
 * it reads "Not recorded", never a rupee zero. Any other claim keeps the plain
 * money line (a missing amount there is also "Not recorded", from `money`).
 */

export const NOT_RECORDED = "Not recorded"
export const NOT_RECORDED_TITLE = "The old system did not record an amount."

/** Claim numbers that start with ERP came across from the old system. */
export function isOldSystemClaim(claimNo: string | null | undefined): boolean {
  return /^ERP-/i.test((claimNo ?? "").trim())
}

/** True when the amount is zero or missing on an old-system claim. */
export function amountUnrecorded(amount: number | null | undefined, claimNo: string | null | undefined): boolean {
  return (amount == null || amount === 0) && isOldSystemClaim(claimNo)
}

export function amountLabel(amount: number | null | undefined, claimNo: string | null | undefined): string {
  return amountUnrecorded(amount, claimNo) ? NOT_RECORDED : money(amount)
}
