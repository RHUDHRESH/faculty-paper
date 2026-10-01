# Fix imported claims (`/data/fixes`), new

## Who and why
The super admin, after each import and until the list is empty: "Which claims from the old ERP are wrong, and can I put each right without leaving this page?" Admin A's Home and Track link here.

## What existed before
Nothing. The Faults screen counted "Paid, but for nothing" (61) and "In review with no quartile" (13) but had no way to fix them. The only tool was `POST /api/admin/claims/{id}/edit`, which had no screen and cannot set a quartile.

Counted on the real local data:
- 61 paid claims with no amount (72 have ₹0, 11 of those are marked "only for count" on purpose and are left out).
- 1 claim with no real title ("-").
- 21 claims with no quartile (13 still in review, 8 paid).
- 74 different claims in all (some have two gaps).
- 60 of the 61 have a ledger row of ₹0. One (ERP-PROCESSED-120) has no ledger row at all.

## One service, one set of numbers (after merging Admin A)
`core.services.data_fixes` (Admin A) decides which claims are wrong and counts them; the fix page, Home, Admin, Track and Faults all read it, and the page is `GET /api/admin/data-fixes` (kinds `paid_no_amount`, `untitled`, `no_quartile`, `no_claimant`, plus `?stage=review`). It counts only claims that carry an ERP number and leaves conference papers out of "no quartile", so on the local data the figures are 60 paid with no amount, 1 with no real title, 13 with no quartile (8 still in review), 2 with the claimant not identified, 68 claims in all. `core.services.claim_fixes` adds what the page needs per row and writes a fix. The fourth kind has a field for the right account's email and moves the claim (and its ledger rows) to that person.

## What it does
- The answer: four figures, each a link to the list behind it (61 / 1 / 21 / 74), and a line saying 13 quartile gaps are still in review and block clearing.
- One row per claim with only the boxes that claim needs: **Amount paid**, **Paper title**, **Quartile**.
  - The amount shows what the policy would pay, as an "Use it" button. It is a hint and is never applied on its own.
  - "No payment was due" for papers processed only for count.
  - The quartile box shows what the claimant wrote.
- One field, "Where the corrections come from", is kept with every change (required, 10+ characters).
- Save writes through `core/services/data_fixes.apply_fix`:
  - changes the claim (title, quartile as a hand-confirmed value, settled amount);
  - writes the balancing ledger row for a settled amount (the ledger is append-only);
  - writes an audit entry `CLAIM_DATA_FIX` with before, after and reason;
  - answers whether the ledger now agrees, and the page says so ("Saved amount ₹15,000. The ledger agrees.").
- **The ledger already has it:** 16 of the claims with no amount name the same paper as a payment sitting in the ledger with no claim (the accounts workbook recorded what was paid; the claim never got it). The row says "The ledger already has a ₹600 payment with this title, voucher 1802, March 2026. Use it and link it". Saving fills the amount and links that payment to the claim, so the ledger agrees without adding a second row for the same money. Those claims are listed first.
- The row moves to "Fixed just now". "Show change history" on every row reads the audit log in words: who, when, from what to what, and the reason.
- Only a super admin can save; the research cell can read the list. Refusals are plain sentences.

## Evidence after
- `shots/data-fixes-after-1440.png`, `shots/data-fixes-saved-1440.png` (after saving ERP-PROCESSED-270 at ₹15,000 in a scratch copy of the real data).
- Tests: `backend/core/test_admin_b.py` (12: counts, one row per claim, ledger row written, no-ledger claim gets one, title and quartile keep the amount, no payment due, refusals, roles, history in words), `src/pages/data-fixes.test.tsx`.
- API: `GET /api/admin/data-fixes` 320 ms on 74 rows including policy hints.
