# Audit: Track

Route `/track`. `frontend2/src/pages/track.tsx`, `track-why.tsx`, `track-data.ts`; API `backend/core/api/track.py`.

## 1. Who and why
The office, Principal, Director and Finance (and a head of department, money-blind) open it to see the whole journey: how many claims are at each step, how long they have sat, and what they come to. The admin's jobs are "find any claim" and "explain why a claim was paid what it was".

## 2. What it showed before
Screenshot: `img/track-before-1440.png`. Checked against the real copy (95 claims, 81 paid).

| Element | Problem |
|---|---|
| Table columns after Claimant | In the shot only "Claim no." and "Claimant" read as headings; the rest were lost in a header row hidden from screen readers (`aria-hidden`). Rebuilt on the kit table so every column is a real heading. |
| Paid rows: amount cell | Blank on 72 of 81. The accounts sheet paid 11 of those nothing on purpose ("counted only"); the other 61 have a lost figure. A blank says neither. |
| "6 days" on every paid row | Days in a stage means nothing once a claim is paid, and 6 is the days since the import. |
| A claim titled "Untitled" with "- - -" under it | The old ERP left "-" in title, journal and quartile. |
| Claimant "Not Found" | The import could not match the person; it read as a name. |
| ERP-RAW-3, ERP-PROCESSED-10 | Unexplained codes. |
| 69 old-ERP claims with holes | Not visible from Track. |
| "Why is this the amount?" | Not answerable anywhere without opening the claim and reading the working. |
| Empty table cells, "Also look at" links | Fine; kept. |
| Stage board, filters | Clear; kept. Board radius aligned to the kit's panel radius. |

## 3. What changes
- Kit `Table`: every column has a heading (Claim no., Claimant, Paper, Where it stands, Time in stage, Amount); on a phone the rows stack and keep their labels.
- **Amount** says why it is empty, in two short lines: "₹0, counted only" (the accounts sheet paid nothing on purpose, so it adds up to the Paid total) or "Not recorded, in the old ERP" (a figure was lost); "₹0, inside the research threshold" or "Not priced yet" for live claims. The Why sheet explains the counted-only case in words.
- **Time** on a paid row reads "Paid 24 Sep" for a claim paid here and "Paid Sep 2026" for an imported one (its `paid_at` is the import day, so the month paid is used).
- Placeholder title, journal and claimant read "Title not recorded", "Journal not recorded" and "Claimant not identified" instead of "Untitled" and dashes.
- A one-paragraph legend appears above the table when a page has ERP- numbers; the claim number also has a hover note.
- Old-ERP claims that need a fix get a "Needs fixing" chip. A line under the board says how many and links to `/track?fix=1` (only those) and to `/data/fixes` (Admin B's fix list).
- **Why this amount** (a link under every amount; `?why=<claim id>` is shareable): a side sheet with the amount, the policy version (and whether it is still in force), each term of the working, the high-value threshold, and the ledger rows with their total. An old-ERP claim shows the working copied from its accounts sheet; without one it says so.
- Role rules unchanged: a head of department gets no amount, no explainer and no fix list.

## 4. Evidence after
- Screenshots: `img/track-after-1280.png`, `img/track-after-1440.png`, `img/track-after-390.png`, `img/track-why-1440.png`. The table fits its box at 1280 and 1440 (checked: table width equals container width, no scroll); on a phone it stacks.
- Tests: `frontend2/src/pages/track.test.tsx` ("Track, for the office"); `backend/core/test_admin_a.py` (`TrackAmounts`, `WhyThisAmount`, `DataFixes`).
- API: `/api/track` 45 ms (was 42 ms; the fix flags add one small query); `/api/claims/<id>/why-amount` about 25 ms.
