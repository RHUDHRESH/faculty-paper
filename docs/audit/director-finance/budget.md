# Audit: Budget (`/budget`), as the Director and Finance read it

## Who and why
The Director before authorising ("can we afford this?") and Finance watching
the year (D3, F7). Finance can set an allocation; the Director reads. The
allocation dialogs and the department table belong to the admin helper and are
unchanged.

## What it showed before
Screenshots: `D:\Faculty Paper\scratch\dirfin\shots\before_director_d_budget.png`, `before_director_m_budget.png`.

| Part | Problem |
| --- | --- |
| Header | Hand-built header with the year picker and the primary button inside it. |
| Four figures | A local `Figure` component that repeated what the shared answer strip does; "Approved, not yet paid — the college owes this" used a dash fragment. |
| Chart | 720 px of month bars and a running line, correct, kept. |
| Departments | Twenty rows, most at ₹0; a table on a laptop and cards on a phone. Kept: admin's. |
| Not set | "Not set" in the figures plus a caution box saying the same; kept because it is the one case where the figure alone is not enough. |

## What changed (a small diff on a shared page)
1. `PageHeader`; "Set an allocation" is its one primary action and appears only for those who can set one. The year picker sits under it, outside the loading and error branches as before.
2. The four figures are the shared `Answer` strip: Allocated for the year, Paid out (links to the Ledger), Committed with what it means in words, and Left or "Over the allocation by" with the word as well as red. The unused local `Figure` is removed.
3. Nothing else changes: the used bar, the over-allocation callout, the chart, the department table and cards, the dialogs.

## Evidence after
Screenshots: `shots\l1_director_d_budget.png`, `l1_director_m_budget.png`, `l1_finance_*`.
Tests: `src/pages/money-views.test.tsx` ("answers first, with no allocation button" for the Director).
