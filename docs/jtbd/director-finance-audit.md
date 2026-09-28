# Audit: what the Director and Finance touch, against their jobs

Jobs are in `director-finance.md` (D1 to D5, F1 to F6). Audited 2026-09-28 on
`seed_demo` data (27 claims at every stage, 252 imported ledger rows from
April 2024, three college budgets, four claims carrying a duplicate flag).
"Before" screenshots: `shots/director-finance/before-*.png`.

## Flag visibility (checked by request, not by reading)

Signed in as each role, every endpoint their screens call was fetched and
searched for the seeded flag text, `duplicate_warning: true` and a non-empty
`flags` list: `/director/queue`, `/admin/payouts` (authorised and paid),
`/admin/ledger`, `/budgets`, `/reports`, `/dashboard`, `/admin/audit`,
`/claims`, and `/claims/{id}` for all four flagged claims (cleared, approved,
authorised, paid). No claim flag reached either role.

**One leak found:** `/admin/ledger` marks a row `DUPLICATE` when its title is
on the same-person duplicates list, and returns `duplicates_open`; the Ledger
screen then shows "On the duplicates list" and a "possible duplicates to
review" banner. A duplicate finding is a flag. (An older test asserted Finance
sees the marker; that contradicts the rule and was changed.)

## Page by page

| Page | Serves | Works | Gap |
|------|--------|-------|-----|
| Director home | D1, D3 | Queue, amount waiting, budget left after it, largest amounts, college totals from the ledger | None blocking |
| Authorisations | D1 | Queue with amounts, ages, department filter, budget panel, bulk authorise with a confirmation summary that re-reads a changed amount | None blocking |
| Finance home | F1, F5 | Payable count and sum, blocked count, this and last month paid, budget | None blocking |
| Payments | F1 | Pay one or a batch; confirm dialog shows the recomputed amount; a second-signature block says what is missing, not why | None blocking |
| Payments, Paid | F2, F4 | Paid claims grouped by payout month, CSV export, voucher, super-admin-only undo | **G2** month totals add only the 50 rows on the page, so a month split over two pages shows a partial total; it lists app claims only, so its month total disagrees with the Ledger's for any month with imported rows. "Print register" prints the browser page: no college header, no total in words, no signature block |
| Ledger | D3, F3, F4 | All payments, month chart, department split, server-side totals, CSV | **G1** duplicate markers leak (above). **G3** no reconciliation: nothing shows whether each paid ticket has one ledger row for the same amount, which rows are ERP imports, which are reversals |
| Budget | D3, F5 | Allocated, paid, committed, left, by department | **G4** one bar for the year; nothing shows spend month by month against the allocation, which is how the burn is judged |
| Reports | D3 | Paid and awaiting totals from the ledger, charts, downloads | **G5** "258 claims · typically ₹48,400 each": the count is ledger payments but the "typical" figure is the median of app claims only (₹48,400 against a ledger median near ₹15,000). **G6** the month axis reads "2024-04" |
| Monthly runs (/batches) | none | Not theirs: it is the Scopus verification run, office only | None; not a payout batch despite the name |
| My papers / File a paper | D5, F6 | Same as any claimant; never in their own queue | None |

## Missing artefacts

- **G7 Monthly payout statement (D2, F2, F4).** Nothing produces the A4
  document a Director signs: college header, month, one row per payment,
  department subtotals, the total in figures and in words, signature block.
- **G8 Bank / accounts file (F2).** No file shaped for a bulk NEFT upload or
  a payroll import. The app holds no account numbers or IFSC codes, so the
  honest file carries staff id, name, department, amount, voucher and a
  narration, with account and IFSC columns left for Accounts to fill from the
  payroll master (assumption A2).
- **G9 Seed data.** No `seed_demo` existed; screens could not be judged on
  realistic volumes.

## Out of scope, noted

- TDS: not computed (assumption A1).
- Phones: no horizontal scroll on any page above at 390 px.

## Fixed on `audit/director-finance`

- G1: `/admin/ledger` returns no duplicate markers or open count to the Director and Finance (test: `test_ledger_page`).
- G2: Paid shows each month's whole total from the ledger beside the page's rows, with a link to the month's statement.
- G3, G7, G8: new **Monthly statements** page (`/statements`) with the month total from the ledger (checked against `college_totals.payments`), department subtotals, total in words, reconciliation (matched tickets, ERP-import rows, reversals, paid tickets with no ledger row), the A4 PDF statement with a signature block, and the bank/accounts CSV (API `core/api/payout_statements.py`; tests `test_payout_statement`).
- G4: Budget and Statements show the financial year's spend by month, with the running total against the allocation.
- G5, G6: Reports reads its "typical" figure from the ledger payments it counts, and labels the month axis "Apr 2024".
- G9: `manage.py seed_demo`.

Remaining: bank account and IFSC are not held (A2); TDS is not computed (A1).
