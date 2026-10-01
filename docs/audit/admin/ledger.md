# Ledger (`/ledger`)

## Who and why
Finance, the Director, the research cell and the super admin read it; only a super admin can change it. "How much has been paid, to whom and when, and does the ledger agree with the paid claims?" Monthly, and after every import.

## What it showed before
![before](shots/ledger-before-1440.png)

Checked against the real data (3,043 ledger rows, 81 paid claims):
- The one figure and a sentence were the answer, and it was a real answer to "how much". It did not answer "does it agree with the claims?". That was only visible on Faults ("Paid with no ledger row", 1) and Data health, with no list to work from.
- Nothing said that 2,963 of the 3,043 rows have no claim behind them. They are the payment history carried in from the old workbook, but an admin could not tell that from the page, and could not find the few that are the payment behind a claim that lost its amount.
- 16 of those rows name the same paper as a paid claim with an amount of ₹0. The real amount was already in the ledger, and the claim never got it.
- The list existed twice in the markup (a table for wide screens, a card list for phones) and the department block had a third layout. On a phone the first screen was a huge total and a chart.
- The header carried a text button ("47 possible duplicates to review") beside the title, and the Export button sat in the filter row.
- Blank voucher and month cells said "Not recorded" (already right).

## What changed
- Title, one sentence, and one action (Export CSV; it says how many rows when a filter is on).
- **The answer:** the total paid, people paid, **paid claims the ledger does not match** (1) and **ledger payments with no claim** (2,963), each a link to its list. Zero says what it means ("The ledger agrees with every paid claim"). The counts come from one service (`core/services/ledger_checks.py`) that Faults and Data health can share.
- Four views under the answer: All payments, Paid not in the ledger (1), Amounts that do not match (0), No claim (2,963). The payment list is the default, so the daily use is unchanged.
- **Paid with no ledger row / amounts that do not match:** a table of the claim, the person, what the claim says and what the ledger holds, and one button that says what it writes: "Add ₹5,000 to the ledger". A claim with no amount is sent to Fix imported claims instead. The confirmation says "This writes one new row of ₹5,000. Nothing is edited or deleted", asks why, and writes an audit entry.
- **Ledger rows with no claim:** searchable, 50 to a page; a row whose title matches a paid claim offers "Link to ERP-PROCESSED-700" with a confirmation that names the amount, the voucher and the claim ("No amount changes"). Everything else reads "History from before this system".
- Fix imported claims now shows "The ledger already has a ₹600 payment with this title, voucher 1802, March 2026. Use it and link it", and saves by linking that row (so the same money is not counted twice). Those claims are listed first.
- One table for payments (stacked labelled rows on a phone), not two lists. The month chart, the month numbers and the department split sit below the list.

## Evidence after
- `shots/ledger-after-1440.png`, `shots/ledger-nolink-1440.png`, `shots/ledger-after-390.png`. No sideways scroll.
- Tests: `src/pages/ledger.test.tsx` (real counts; adds the missing row only after saying what it will write), `backend/core/test_admin_b.py::LedgerChecksTests` (counts, add the missing row, no amount goes to data fixes, link an orphan row, use the ledger payment in a data fix without double counting, only a super admin writes).
- API: `/api/admin/ledger/checks` 30 ms; `/api/admin/ledger/problems?kind=no-claim` 120 ms for a page of 50.
