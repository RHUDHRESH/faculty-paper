# Monthly runs (`/batches`, `/batches/:id`)

## Who and why
The super admin, once a month: "Did this month's Scopus sheet get read, looked up and matched to journals before anything is priced?" And, on a run, "which rows did not match?"

## What it showed before
![before](shots/batches-before-1440.png)

The local data has no run, so the list was an empty state. The run page was checked with a seeded run (12 rows, 8 matched).
- The list opened with a title and a sentence and no answer to "did last month's run happen?". Once there are runs, nothing said which one is latest or whether one failed.
- The status word "Running" (and "Running…" on the button) was a job state shown to people.
- A hand-drawn box inside the page for the upload form, with a coloured callout inside it for the column names.
- The run page drew its own "back" link (the shell now draws breadcrumbs), joined the row count, the matched count and the status with middle dots in the sub line, and put two equal buttons at the top.
- Blank cells were "—".
- **A crash:** the SNIP column called `.toFixed` on a value the server sends as text, so a run page with any matched row threw and showed nothing. Fixed.
- "Started. It runs in the background — come back…" used a dash fragment.

## What changed
- List: one question, one primary action (Upload a sheet). The answer: latest run and its date, where it stands, runs in all, failed runs. A failed run shows its error under its status.
- Upload is a section, not a box: name, file, "Show which columns are read" for the callout, "Upload the sheet".
- Run page: breadcrumbs from the shell (Admin / Monthly runs / March 2026), one primary action (Start the run, or Run again), and the answer: rows, matched, not matched (a link that filters to the unmatched rows), where the run stands. Export is a quiet link below.
- "In progress" everywhere for a run that is going. Missing quartile, SNIP and journal read "Not recorded" (from the kit table). No " — ".

## Evidence after
- `shots/batches-after-1440.png`, `shots/batch-after-1440.png`, `shots/batch-after-390.png`. No sideways scroll.
- Tests: `src/pages/batches.test.tsx` (2). Clarity baseline: batches.tsx internal-word 2 to 0.
- API: unchanged.
