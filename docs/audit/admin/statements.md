# Monthly statements (`/statements`)

## Who and why
The Director signs, Finance sends the bank file, the super admin checks: "Does this month's statement agree with the ledger, and is it ready to sign?" Monthly.

## What it showed before
![before](shots/statements-before-1440.png)

On the real data for September 2026: 80 claims, one of them paid with no ledger row.
- The first thing on the page was the year's spend chart, not the month. The chart is useful, but it does not answer the month's question.
- The answer to "does it agree?" was a section under the fold (Against the ledger). The month's total was a serif number with a sentence, and the reconciliation result (1 line to explain) was not in the answer at all.
- Two different layouts for the same list of 80 payments (cards on a phone, a hand-built table on a computer), with a rule above and below and a total row in a footer.
- "Rupees Two Lakh … only" was the only place the amount in words appeared and it was in small grey text.
- An unexplained line ("Paid ticket with no ledger row, claim ₹0, ledger ₹0") had no way to the fix.

## What changed
- One question as the sub line, and the month picker at the top right.
- The answer: paid in the month, payments, people paid, and either "Agrees. With the ledger. Ready to sign" or "1 line to explain before signing" (a link down to the explanation).
- Sign and send stay together under the answer: "Statement to sign (PDF)" (the one primary action), the bank file for Finance and the super admin, "Open in the ledger".
- The reconciliation says, for a super admin, where to fix it: "Open the ledger checks" (the new paid-with-no-ledger-row list).
- The payments are one table (stacked labelled rows on a phone) with a total line, and missing titles and vouchers read "Title not recorded" and "None".
- The year's spend against the budget is one click away ("Show the year's spending against the budget"), because the Budget page is where that is read.

## Evidence after
- `shots/statements-after-1440.png`, `shots/statements-after-390.png`. No sideways scroll.
- Tests: `src/pages/statements.test.tsx` (2).
- API: unchanged.
