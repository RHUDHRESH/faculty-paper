# Audit: Monthly statements and the bank file (`/statements`)

## Who and why
The Director signs the month's payment statement (D2). Finance sends the bank
file and reconciles the month against the ledger (F3, F4). Opened once a month
by each, and by an auditor's request.

## What it showed before
Screenshots: `D:\Faculty Paper\scratch\dirfin\shots\s0_finance_d_statements.png` (7,300 px tall), `before_finance_m_statements.png`.

| Part | Problem |
| --- | --- |
| Top | A year chart ("FY 2026-27: spend against the budget", 720 px of SVG) above the month's total: the Budget page's answer on the Statements page, pushing the month below the fold. |
| Total | A 36 px serif figure, the words, three buttons, and two sentences of small print. No statement of whether the file equals the statement. |
| Against the ledger | Four boxed figures ("80 of 80 match", "₹0 / 0 rows", "₹0 / 0 voided", "Ledger total"), each with a note line; then a caution box whose issue line was plain text, not a link to the claim. |
| By department | Twenty departments, seventeen of them at ₹0, each with a bar. |
| Every payment | 89 rows for a month with 9 payments: 80 were claims the old ERP closed at ₹0, in the month the import landed. "Title not recorded", "None" vouchers and "ERP-PROCESSED-n" with no explanation. A hand-built table with a border ring, a Total row inside a heavy rule. |
| Downloads | "Bank and accounts file (CSV)" named for an audience, not a file; the reader could not tell it added to the same total. |
| Errors | A failed statement showed a skeleton forever (no error branch for the statement request). |
| Director | Saw the same page minus the CSV button, with no cue why. |

## What changed
1. `PageHeader` with the month picker in the action slot; the year chart is gone (a sentence and a link to Budget replace it; `BudgetBurn` stays exported for the Budget page).
2. **Answer**: Paid in the month (₹, links to the ledger for the month), Payments, People paid, and the ledger check ("Agrees with the ledger: Yes", or "Lines to explain before signing: N" linking to the list below). Words in figures below.
3. Downloads: "Statement to sign (PDF)" primary; "Bank file (CSV)" for Finance only, with the sentence "The bank file has 9 rows adding to ₹2,37,690, the same as this statement" plus the account and IFSC note; "Open in the ledger".
4. **Against the ledger** as four label and value lines with one hairline between; the ERP-without-a-month explanation; issues are listed with the claim number as a link, the two amounts, and who fixes it.
5. By department shows departments with money and says how many have only ₹0 claims.
6. **Every payment** is a `Table` of the payments (heading on every column, amounts right-aligned, the research threshold held back shown under the amount, "Where it was recorded" in words). The total is one line. Claims closed at ₹0 sit behind "Show claims closed at ₹0 (80)". ERP legend once.
7. Errors: a failed months or statement request is named with Try again.

## Backend
Statement rows carry `held_back` (the research threshold's part of that claim); tested in `core/test_payments_desk.py`.

## Evidence after
Screenshots: `shots\s1_finance_d_statements.png`, `s1_finance_m_statements.png`, `s1_director_*` (Director: no bank file).
Tests: `src/pages/statements.test.tsx` (4), `core.test_payout_statement` unchanged and passing.
