/** Human sentences for the ClaimAction codes the server records.
 *
 * Reviewers used to see raw codes ("CLEAR · Admin · 12/3"), and faculty saw
 * no history at all — the claimant could not tell who cleared their ticket
 * or when.
 */
const ACTION_SENTENCES: Record<string, string> = {
  CREATE_DRAFT: "started this draft",
  ADMIN_CREATE: "filed this claim on the faculty member's behalf",
  SUBMIT: "submitted the ticket",
  RESUBMIT: "edited and resubmitted the ticket",
  WITHDRAW: "withdrew the ticket back to draft",
  VERIFY: "ran verification",
  VERIFY_BATCH: "ran verification (batch)",
  MANUAL_VERIFY: "entered manually verified values",
  CLEAR: "cleared the ticket and sent it to Finance",
  APPROVE: "cleared the ticket and sent it to Finance",
  SECOND_APPROVE: "gave the second approval for this high-value claim",
  MARK_PAID: "marked the payment as processed",
  VOID_PAYMENT: "voided the payment",
  REJECT: "sent the ticket back for changes",
  STATUS_OVERRIDE: "moved the ticket with an admin override",
  CONTEST_FORWARD: "forwarded the ticket despite verification issues",
}

export function actionSentence(code: string): string {
  return ACTION_SENTENCES[code] || code.replaceAll("_", " ").toLowerCase()
}
