# Data (`/data`)

## Who and why
The super admin or research cell, occasionally: "A figure looks odd. Show me the row behind it." A narrow lane lets a super admin correct reference data (journal tables, roster, budgets, standing) with a reason, and delete a row that carries no payment.

## What it showed before
![before](shots/data-before-1440.png)

- A red callout at the top explained what can be changed, with " — " fragments, before the list of 21 tables.
- No way to find a table other than reading the groups.
- No sentence saying how much is here or how many tables can be corrected.
- The list had a rule above and below each group.
- A table's page opened with a "back" button above the title, and a missing value read "—".
- "Empty the system" sat at the foot of the page. It already asks for a typed phrase and shows what will be lost (payments, ledger rows) before it runs; that stays.

## What changed
- One line saying what the page is for, then one sentence for the answer: "21 tables holding 71,900 rows. 6 can be corrected here; the rest can only be read." The explanation of what can be changed is "Show what can be changed here" (the server text no longer has dashes).
- "Find a table" filters the groups as you type; a search with no result says so and offers "Clear the search".
- One hairline between tables; one primary button style; the table page has one action, "All tables".
- A missing value reads "Not recorded".
- Left on purpose: cells show the value as stored (for example PAID, ERP-PROCESSED-270), because this page exists to show the stored row. Nothing here is written for a faculty member.
- Edits and deletes are unchanged: a reason is required, each is audited on its own, the audit log itself cannot be edited or deleted.

## Evidence after
- `shots/data-after-1440.png`, `shots/data-table-after-1440.png`, `shots/data-after-390.png`. No sideways scroll.
- Tests: `src/pages/data.test.tsx`.
