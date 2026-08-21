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
  CLEAR: "checked the ticket and passed it to the Principal",
  APPROVE: "checked the ticket and passed it to the Principal",
  PRINCIPAL_APPROVE: "approved the spend and released it to Finance",
  PRINCIPAL_SEND_BACK: "sent the ticket back to the research cell",
  SECOND_APPROVE: "gave the second approval for this high-value claim",
  MARK_PAID: "marked the payment as processed",
  VOID_PAYMENT: "voided the payment",
  REJECT: "sent the ticket back for changes",
  STATUS_OVERRIDE: "moved the ticket with an admin override",
  CONTEST_FORWARD: "forwarded the ticket despite verification issues",
  // The retired HoD and research-approve steps. Every ticket filed before the
  // change still carries these, so leaving them out rendered real history as
  // "Demo HOD hod approve". PRINCIPAL_APPROVE is deliberately not here: it is
  // the live approval step now, and describing it as a relic made the one
  // action that releases money read like history.
  HOD_APPROVE: "approved the ticket (under the earlier HoD step)",
  RESEARCH_APPROVE: "checked the ticket (under the earlier research step)",
  FINANCE_APPROVE: "approved the payment (under the earlier Finance step)",
  UNPAY: "reversed the payment",
}

export function actionSentence(code: string): string {
  const known = ACTION_SENTENCES[code]
  if (known) return known
  // Unknown code: read it as a phrase rather than shouting the constant, but
  // keep it recognisable so an operator can still match it to the audit log.
  return `recorded "${code.replaceAll("_", " ").toLowerCase()}"`
}
