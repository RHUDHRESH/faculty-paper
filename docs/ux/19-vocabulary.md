# 19. Vocabulary

One word per idea, in plain Indian English a faculty member already uses.
When writing any string (JSX, toast, dialog, CSV header, email, API error),
use the left column. Never the right.

| Concept | Say | Not |
|---|---|---|
| The published work | paper | publication, article (except "the article itself" meaning the PDF) |
| What a faculty member files for money | claim | ticket, filing, application |
| Its number | Claim no. FP-2026-000001; "claim number" in sentences | ticket number, ticket ID |
| The money | incentive (the amount is "the amount") | payout, remuneration, reward |
| Monthly paper to Finance | payment statement | payout statement |
| Month the money went out | month paid | payout month |
| Research cell's step (staff button) | Clear → "Cleared" | verify, approve, check (as a button) |
| Same step, as faculty see it | Checked / Being checked | cleared, verified |
| Hand-entered SNIP / quartile | confirm figures → "Figures confirmed" | verify, verified values |
| Principal | Approve → "Approved" | sanction, OK |
| Director | Authorise → "Authorised" (British spelling) | authorize, approve |
| Finance | Mark paid / Pay → "Paid" | settle, disburse |
| Returned for changes | Send back → "Sent back" | return, returned, rejected |
| Final refusal, staff button | Reject → "Rejected" | reject outright (in toasts) |
| Final refusal, as faculty see it | Not accepted | rejected |
| The office, staff-facing | research cell | research office, research supervisor |
| The office, faculty-facing | the college (who holds it); research office (who to ask) | research cell, any named desk or person |
| Department | department | dept, Dept |
| The index | Scopus | SCOPUS, scopus |
| Money | ₹1,09,265 via `money()` (en-IN grouping) | Rs., INR 109265, 109,265 |

## Rules

1. A button's verb is its toast's verb and its dialog's verb: "Send back" / "Send this claim back?" / "Sent back".
2. Sentence case. No ALL CAPS, no internal codes (CLEARED, PRINCIPAL_APPROVED, SUBMITTED) ever shown. An unknown status reads "In progress".
3. No " — " fragments in toasts and API errors: two short sentences instead ("Cleared. 3 claims sent to the Principal").
4. Faculty-facing text never names the desk or person holding a claim. It says the step: "Being checked by the college", "Checked. Waiting to be approved", "Approved. Waiting to be authorised", "Authorised. The payment is being made".
5. Code identifiers (`ticket_number`, `remuneration`, `/api/admin/payouts`, status enums) keep their names; only the words people read change.
