# Faculty: Payment statement (`/papers/statement`)

`frontend2/src/pages/my-record.tsx` (`PaymentStatement`); data `GET /api/me/payments/statement`. Job 3 in docs/jtbd/faculty.md.

## 1. Who and why
A faculty member once a year (tax return, Form 16 check) and whenever they wonder "was that paper's money actually paid?". The question is "how much did the college pay me in FY 2025-26, for which papers, in which month". They print it or take the spreadsheet to their accountant.

## 2. What it showed before
Screenshots: `img/before_d_papers_statement.png`, `img/before_m_papers_statement.png`.

| Element | Problem |
|---|---|
| Back link plus breadcrumb, `mx-auto max-w-4xl`, plain `text-2xl` title | Same problems as the appraisal list. |
| Financial year as a `<select>` "All years" with totals in the options | The year totals, which are the answer to the job, were hidden inside a closed dropdown. |
| Sentence "All years: ₹3,96,703.75 across 89 payments." | The answer in small text. |
| "Voucher" column reading "Not recorded" on every row | 89 rows saying the same thing. For this person the college never recorded a voucher. A column that is empty everywhere is noise, and on a phone it was hidden anyway. |
| "All years" as one long run of 89 rows | No subtotal per financial year, which is what a tax return needs. |
| Print and Spreadsheet as small quiet buttons | Print is the point of the page. |
| Paper with no title imported from the ledger | An empty cell. |
| Phone: a hand-built table that scrolled | Cells jammed; the month and the paper ran together. |

Checked against data: the total ₹3,96,703.75 and 89 payments equal `/api/me/payments` and the record page's "in all"; the year totals add up to the total. The ledger holds 105 rows for this person: 89 with an amount (the payments) and 16 recorded at nothing (shown as "No incentive payable" on the record page). My papers counts papers (119 Paid), the statement counts payments (89); the page says "payments" everywhere.

## 3. What changes
- Standard header: title, one line of purpose, one primary action ("Print or save as PDF").
- Financial years are a row of choices, each with its total ("2025-26 ₹1,73,692"); the year totals are visible without opening anything.
- The answer: the total for the year chosen (or all years), the number of payments, and the latest payment month (or the amount the research threshold kept back, when there is one).
- "All years" is grouped by financial year, each with its subtotal and count. Money is whole rupees unless paise exist (`money()`).
- The voucher column appears only when at least one payment has a voucher; otherwise one footnote says the college did not record voucher numbers.
- A paper with no title reads "Paper title not recorded".
- On a phone each payment is a stacked row: month, paper, amount. Print is unchanged (the college stamp, the grouped table, the total).
- The research threshold card stays above the list for research faculty (`ui/research-threshold`).

## 4. Evidence after
- Screenshots: `img/after-statement-1440.png`, `img/after-statement-390.png` (no horizontal scroll at 390).
- Tests: the money and grouping run through `money()` and `formatCount()`; page assertions in `frontend2/src/pages/my-record.page.test.tsx` (year totals up front, grouping, voucher column only when recorded, one primary action).
- API: `/api/me/payments/statement` 45 ms; unchanged.
