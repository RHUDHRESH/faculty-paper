# Audit: Finance Home (`/`)

## Who and why
Finance, first thing on a pay day and again at month end. The question: "what
do I pay today, and what does this month still need?" (F1, F3, F4.)

## What it showed before
Screenshots: `D:\Faculty Paper\scratch\dirfin\shots\before_finance_d_home.png` (and `_m_`).

| Part | Problem |
| --- | --- |
| Greeting | `HomeHead` with a 240 px picture that pushed the first figure to the fold on a laptop. |
| Figures | "Payable now / Comes to / Blocked". Summed from the first 200 rows only; above 200 it printed an info box explaining the total was partial. "Blocked: High value, needs a second signature from the office" named a cause. |
| List | `DeskQueue` (shared): amounts with no research-threshold effect, so a claim worth ₹0 after the threshold looked like an ordinary ₹0 claim. |
| Callouts | Two boxes above the list (partial total; not payable) repeating the figures. |
| "What has gone out" | One long sentence merging this month, last month, the year's paid, allocation, committed and left. No file, no link to the statement or the bank file. |
| Below | "Where everything is": stage counts and "13 claims have been in one place for over a month", which are the research cell's, not Finance's; then a "Waiting longest at the other desks" list. |
| Errors | Fine (an error, not zero). |

## What changed
1. `PageHeader`: greeting, one line, and the one primary action "Pay 5 claims · ₹1,40,480" that opens Payments.
2. **Answer**: Ready to pay, Comes to, Held up (with what that means), Left in the budget once these are paid (red with the word "Over" when it is). Whole-queue figures from the server; no partial-total box.
3. One sentence when the research threshold holds money back, and the amounts carry it in the list.
4. **Next to pay**: the six that have waited longest, face, paper, amount with the threshold, days, and a Pay button; "All 6 in Payments"; a line and link for held claims. Empty state says what appears and offers `ComingUp`.
5. **This month's paper** (new, F3 and F4): the two newest months with the bank file, the statement to sign and a link to the statement, and for the newest, whether it agrees with the ledger or how many lines need explaining.
6. "Where every claim is" is behind "Show where every claim is" and loads when opened.
7. Your own papers stay at the bottom.

## Evidence after
Screenshots: `shots\c_finance_d_home.png`, `cf_finance_m_home.png` (390 px, no horizontal scroll).
Tests: `src/pages/home-money.test.tsx` ("states the whole queue and puts the threshold beside the amount", "says a failed queue failed").
Kit/shell diff: `FinanceHome` moved out of `home-staff.tsx` into `home-finance.tsx`; `main.tsx` line 64 imports it from there.
