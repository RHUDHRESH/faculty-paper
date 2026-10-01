# Audit: Ledger (`/ledger`), as Finance and the Director read it

## Who and why
Finance for the audit pack and "did this one go out?" (F4, F6); the Director for
"what did we spend, on whom?" (D3). The super admin's use of the same page
(duplicates, corrections) is the other helper's; this card covers what the two
contest-blind roles see and the small changes made to the shared page.

## What it showed before
Screenshots: `D:\Faculty Paper\scratch\dirfin\shots\before_finance_d_ledger.png`, `before_finance_m_ledger.png`.

| Part | Problem |
| --- | --- |
| Header | Hand-built title and a two-sentence sub ("imported from the ERP", "voided by a reversing row"). |
| Total | A good answer (₹ total, span, payments, people), kept. |
| Phone | The first screen was the total and a 140 px bar chart; the list of payments began below three screens (base findings). |
| Chart | Fine on desktop (each bar filters the month, "Show the numbers" gives the table). |
| Rows | A table with headings, faces, "Not recorded" for absent months and vouchers, a `Reversal` chip. Nothing said why a payment was worth less than the policy amount for a research faculty member. |
| Flags | Correct already: the server sends no duplicate count and no duplicate marker to the Director or Finance. |
| Download | "Export everything (CSV)" or "Export 12 rows (CSV)" following the filters: correct, kept. |

## What changed (a small diff on a shared page)
1. `PageHeader` with the sub in one sentence.
2. **Research threshold on each payment**: "₹10,000 held back by the research threshold" under the amount, in the table and on the phone card. The server adds `held_back` to each ledger row that came from a claim (`_with_held_back` in `core/api/finance.py`, one query per page).
3. On a phone the monthly chart is behind "Show the monthly chart" so the list is the first thing after the filters; on a laptop it is unchanged.
4. Nothing else: the filters, the export and the department split were already right.

## Evidence after
Screenshots: `shots\l1_finance_d_ledger.png`, `l1_finance_m_ledger.png`, `l1_director_*`.
Tests: `src/pages/money-views.test.tsx` ("shows what the research threshold held back beside the payment", no duplicate or flag text); `src/pages/ledger.test.tsx` (unchanged, passing); backend `test_ledger_rows_say_what_the_threshold_held_back`.
