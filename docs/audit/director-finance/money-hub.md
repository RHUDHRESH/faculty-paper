# Audit: Money hub (`/money`), Director and Finance

## Who and why
Either officer, to answer "where do we stand this year, and where is the paper
for the month?" (D3, F7). Reached from the sidebar door "Money". Everyone else
who has the hub (Principal, research cell, super admin) keeps the shared hub.

## What it showed before
Screenshot: `D:\Faculty Paper\scratch\dirfin\shots\before_finance_d_money.png` (`_m_` for 390 px).

| Part | Problem |
| --- | --- |
| Answer | None. A title and a list of four pages, two thirds of the screen empty. |
| Rows | Each row said only what the page is for; nothing said what was behind it (how much is left, which month is newest). |
| Groups | "Spending" and "The rules" side by side with a rule under each title; Finance's own desk (Payments, Paid) was not on it at all, and the Director's Authorisations neither. |
| Icons | Two different glyphs for "Ledger" and "Budget" with no words in the row to tell a first-time reader which is the rupee record. |

## What changed
1. `MoneyDesk` (`money-desk.tsx`) replaces the hub for the Director and Finance only. `MoneyHub` in `hub.tsx` delegates in three lines; the shared hub is untouched for everybody else.
2. **Answer**: Paid in the financial year (to the Ledger), Approved not yet paid (to Budget), Left in the budget (red "Over the budget" with the word when it is), Paid this month.
3. Rows are grouped by job, from the same catalogue as the sidebar and Ctrl K: **Your desk** (Payments and Paid for Finance; Authorisations for the Director), **The month and the year** (Statements, Ledger, Budget), **The rules** (Policy).
4. A live line under each row: "5 ready to pay, ₹1,40,480", "3 waiting, ₹90,000", "Newest: Sep 2026, ₹2,37,690 in 9 payments", "₹12,00,000 left of ₹20,00,000 for 2026-27".
5. No new route; nothing to add to the palette (`npm run audit` route check unchanged).

## Evidence after
Screenshots: `shots\m1_finance_d_money.png`, `m1_finance_m_money.png`, `m1_director_d_money.png`, `m1_director_m_money.png` (no horizontal scroll at 390 px).
Tests: `src/pages/money-desk.test.tsx` (2); `src/pages/track.test.tsx` ("gives Finance the Money hub, with no admin counts asked for") still passes.
