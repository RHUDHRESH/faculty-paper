# Audit: Payments (`/payments`), Finance

## Who and why
Finance opens it on pay days: the monthly run and a few off-cycle payments.
The job (docs/jtbd/director-finance.md F1, F2, F3): decide what goes into the
run, pay each claim once at the right amount with a voucher, and leave with
the bank file. Nobody pays their own paper. Never shown: flags, the
watch-list, duplicate findings, contest notes.

## What it showed before
Screenshots: `D:\Faculty Paper\scratch\dirfin\shots\before_finance_d_payments.png`,
`before_finance_m_payments.png` (1440 and 390 px).

| Part | Problem |
| --- | --- |
| Header | Title, a two-sentence sub, a second paragraph ("Your own papers…"), two buttons ("Already paid", "Refresh") of equal weight. |
| Answer | None. The total, the count and the budget were not on the page; the only totals were per month, printed inside grey group rows, and were a page total (fifty rows), not the queue. |
| Group rows | "September 2026 3 claims ₹84,480" included a ₹0 claim. No sign of what the money does to the budget. |
| Table | Hand-built, a Waiting column left-aligned as text, Amount not marked as a number for the phone. Month groups instead of a column. |
| Research threshold | A red chip "Inside research threshold" (colour is for errors) and a ₹0 amount with no words beside it. "Part inside research threshold" said nothing about how much. |
| Held claims | A "Needs a second approver" chip and disabled Pay button and checkbox inside the same list, so a queue full of un-payable rows read as work. |
| Pay dialog | "Voucher number (optional)" only. Nothing said this claim was not paid before, or who authorised it. |
| Batch dialog | Prefix and next-number tools first, a "Download payment list" button that produced a second, different bank-shaped file, a table with its own ring border, no check that a voucher number was used for two people. After paying, the dialog closed and the reader had to remember where the bank file lived. It also read "Paid 2 of 0" in the result: the count came from the selection, which paying had emptied. |
| Divider | Ring around the table and a ring around the batch table inside a dialog, plus a full-width rule inside the tinted header. |
| Buttons | "Mark N paid" vs "Pay" vs "Pay — ₹52,377.50" (three verbs, a dash fragment). |
| Empty | Fine ("Nothing waiting on Finance"). |
| Error | Fine; kept its wording. |

## What changed
1. `PageHeader` with the one line, and one action: "See what has been paid". "Refresh" is gone; the list refetches when the window regains focus.
2. **Answer strip**: Ready to pay (count), Comes to (₹), Held up (count, "Nothing is held up"), Left in the budget once these are paid (₹, or "Over the budget…" in red with the word). All are whole-queue figures from the server (`totals` on `/api/admin/payouts`), not the fifty rows in view. Held up and the budget link to the list and the Budget page.
3. **Research threshold, per claim and in total.** Beside every amount: "of ₹17,600; ₹10,000 held back by the research threshold", or "Nothing to pay: ₹15,620 counts against the research threshold". One sentence under the Answer totals it for the queue. No red chip.
4. **Ready to pay** is a `Table` (heading on every column, sortable Waiting and Amount, number right-aligned, stacked labelled rows on a phone). **Held up** is its own list below, with the reason ("Needs a second approver, someone other than X. The research cell or a super admin can give it") and no checkbox or dead Pay button. The reason never says why a second signature is wanted (that would be a flag).
5. **Pay dialog**: the amount large, the threshold sentence, and three checks in words with a tick or a warning icon: not paid before (from the ledger), the chain complete with who and when, second approver if any. If the ledger already holds the claim, the warning says so and Pay is disabled. A live voucher check warns when the number is on the ledger for a different person (one voucher for one person's several claims is allowed).
6. **Batch dialog**: count, total and month first; the two checks; the threshold and ₹0 notes; voucher numbering under "Show voucher numbering"; the batch table with the voucher input and the threshold beside each amount. The confirm button is "Pay 12 claims, ₹3,15,370". After it: "Paid 12 of 12", and for each month paid the bank file (CSV), the statement to sign (PDF) and a link to the statement. The second bank-shaped file is gone.
7. One verb: Pay / "Pay this claim?" / "Paid ₹7,600 to …". Dash fragments removed.
8. `Details`: "Show how a payment is checked" holds the four rules (once, recomputed, not your own, undone by a super admin).
9. A claim number that begins ERP- gets a one-line legend once, and a hover title.

## Backend
`/api/admin/payouts` returns `totals` (whole queue) and `ledger_paid`/`ledger_rows` per claim, and accepts `q` and `month`. `core/services/payments_desk.py`, tested in `core/test_payments_desk.py`.

## Evidence after
Screenshots: `shots\a2_pay_d_page.png`, `a2_pay_d_single.png`, `a2_pay_d_bulk.png`, `a2_pay_m_*.png` (no horizontal scroll at 390 px).
Tests: `src/pages/payments.test.tsx` (12), including "shows the research threshold on the claim it reduces", "names the duplicate-payment check", "refuses to pay a claim the ledger already holds", "confirms a batch with counts and totals, then points at the bank file", and the existing double-click and stale-amount guards.
