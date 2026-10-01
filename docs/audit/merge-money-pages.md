# Merge: Budget, Ledger and Statements for every role

Two branches rebuilt the same three routes for different readers. This card lists every feature each side promised
(from `docs/audit/director-finance/{budget,ledger,statements}.md` and `docs/audit/admin/{budget,ledger,statements}.md`)
and where it lives on the merged page. One page per route; the role decides what is shown only where the jobs differ.

## Budget (`/budget`)

| Feature | From | Who sees it | Merged as |
| --- | --- | --- | --- |
| `PageHeader`, one primary action "Set an allocation", year picker outside the loading and error branches | both | Finance, super admin, research cell get the button; the Director reads | Admin B's header (year picker and button in the action slot); button only when `manageMoney` |
| One question as the sub line | Admin | all | kept |
| Answer strip: Allocated for the year, Paid out (links to the Ledger), Committed in words, Left or "Over the allocation by" with the word as well as red; "Not set", never ₹0 | both | all | one `Answer`, the Director/Finance labels and the link to the Ledger |
| Used bar, over-allocation callout, chart, department table and cards, dialogs | shared | all (dialogs: `manageMoney`) | unchanged |
| Remove confirmation names the amount and what stays (paid, committed) | Admin | those who can remove | kept |
| "Show who changed an allocation (N)": who, which department and year, "Amount: from to", note | Admin | those who may read the audit (`viewAudit`); the server scopes it | kept, one section at the foot |
| No dashes in what people read | Admin | all | kept |

## Ledger (`/ledger`)

| Feature | From | Who sees it | Merged as |
| --- | --- | --- | --- |
| `PageHeader` with the sub in one sentence; Export CSV as the one action (says how many rows when filtered) | both | all readers | Admin B's header; the duplicates button in the header is gone |
| Answer strip: total paid (or matching the filter), people paid, paid claims the ledger does not match, ledger payments with no claim, each a link, zero says what it means | Admin | all readers | one strip |
| Totals line (span, payments, people) | Director/Finance | all | the small line under the strip |
| "N possible duplicates to review" | base | only roles the server sends `duplicates_open` to (never Director or Finance) | one link under the strip |
| Views: All payments, Paid not in the ledger, Amounts that do not match, No claim | Admin | all readers see the lists | kept |
| Fixable reconciliation: "Add ₹X to the ledger", "Link to ERP-...", confirmation that names what is written, reason, audit entry | Admin | buttons for the super admin only; others read the lists | `canFix = SUPER_ADMIN` |
| Research threshold "₹X held back" under the amount (`held_back`) | Director/Finance | all | on the payment table |
| One payments table, stacked labelled rows on a phone | Admin | all | kept (the second card list is gone) |
| Monthly chart: on a laptop shown, on a phone behind "Show the monthly chart" so the list comes first | Director/Finance | all | kept, in the All payments view |
| Filters, month bars, department split, faces, "Not recorded", reversal chip, no flags for Director/Finance | shared | all | unchanged |

## Statements (`/statements`)

| Feature | From | Who sees it | Merged as |
| --- | --- | --- | --- |
| Month picker top right; question as the sub line | both | all | sub says "and send to the bank" only for Finance and super admin |
| Answer: paid in the month (links to the ledger for the month), payments, people paid, "Agrees with the ledger" or "Lines to explain before signing" (links down) | both | all | one strip, singular and plural |
| Amount in words | Admin | all | kept, under the strip |
| "Statement to sign (PDF)" primary; "Bank file (CSV)" for Finance and super admin only; "Open in the ledger" | both | Director gets no bank file | kept |
| Bank file sentence: rows and total equal the statement; account and IFSC empty | Director/Finance | Finance, super admin | kept |
| Against the ledger as label and value lines; ERP-without-a-month note; issues with the claim number as a link and both amounts | Director/Finance | all | kept |
| Where to fix it: "Open the ledger checks" | Admin | super admin; everyone else is told to ask a super admin, naming the claim | role branch in the same paragraph |
| By department, only those with money, and how many have only ₹0 claims | Director/Finance | all | kept |
| Payments table with the research threshold under the amount; total line; ERP legend once; claims closed at ₹0 behind a disclosure | Director/Finance | all | kept |
| "Title not recorded", "None" for vouchers | Admin | all | kept |
| Year's spend against the budget: a sentence and a link to Budget, and the chart one click away | both | all | sentence and link, then "Show the year's spending against the budget" |
| Errors named with Try again | Director/Finance | all | kept |

## Tests kept

`budget.test.tsx`, `ledger.test.tsx`, `money-views.test.tsx` unchanged. `statements.test.tsx` holds the four Director/Finance cases and the
super admin cases (agrees in words, count of lines to explain and the link to the ledger checks), plus one that Finance is not sent to the checks.
Backend: `test_admin_b.py`, `test_payments_desk.py`, `test_budget_ledger.py` and the rest of the money modules.
