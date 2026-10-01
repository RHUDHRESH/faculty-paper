# Audit: Paid (`/payments/done`), Finance and super admin

## Who and why
Finance after a run ("did it all go, with vouchers?") and when the auditor asks
for a payment (F4, F5, F6). The super admin also uses it to undo a payment made
in error. It is the register of payments made through this app; the Ledger is
the register of every payment including the ERP history.

## What it showed before
Screenshots: `shots\before_finance_d_payments_done.png`, `before_finance_m_payments_done.png`.

| Part | Problem |
| --- | --- |
| Header | A back arrow, the title, a three-sentence sub, four buttons (Export CSV, Print register, Monthly statements, Refresh) of one weight. |
| Answer | None. What went out this month was inside a grey group row. |
| Search | Filtered only the fifty rows on the page ("Searches the 50 payments on this page"): a voucher on page two was invisible. |
| Month grouping | "September 2026 50 claims on this page · the month on the ledger: ₹2,37,690 in 9 payments" put two different counts in one line and a page total of ₹0. |
| Callout | A red-ish "Finance cannot undo a payment" box always above the table. |
| Rows | Voucher "None" for every ERP-carried claim, ₹0 amounts with no explanation, "ERP-PROCESSED-890" with no legend. No sign whether the payment agreed with the ledger. |
| Undo (super admin) | Confirm said "the claim returns to Checked, waiting on the Principal" (it returns to Cleared) and did not say the rupees, the month total or the voucher. |
| Empty | One state for "nothing paid yet" and another for "search found nothing" but neither offered an action. |

## What changed
1. `PageHeader` and one action, "Monthly statements". The back arrow is the breadcrumb (Payments / Paid).
2. **Answer**: Paid this month, Paid last month (each a link to that month), Paid in the financial year (to the Ledger), Claims paid in this app.
3. **Server-side search and month filter** (`q`, `month` on `/api/admin/payouts`): a name, staff id, claim number or voucher finds the payment wherever it is. "Clear filters" appears when either is set. Picking a month shows its ledger total with links to its statement and ledger.
4. A `Table`: Paid to, Paper, Voucher, Paid on (with the month paid), Amount with the research threshold beside it, and **On the ledger** ("Matches", or "Ledger shows ₹X" in amber).
5. Finance sees one plain sentence about undoing; only the super admin gets an Undo button.
6. **Undo confirms with rupees**: the amount, "1 payment", the voucher and paid time, the −₹ row it writes, how the month total moves ("The September 2026 total falls from ₹2,37,690 to ₹2,17,690"), and where the claim goes (back to Cleared, to be approved and authorised again). Button "Undo ₹20,000", toast "Undone".
7. Two empty states, each with an action.
8. Export CSV exports the current filter (all pages), with a "held back by research threshold" column. Print keeps the register stamp.

## Evidence after
Screenshots: `shots\a1_finance_d_payments_done.png` and after the width fix `b_*` (1440, 390).
Tests: `src/pages/payments-done.test.tsx`; backend `core/test_payments_desk.py`.
