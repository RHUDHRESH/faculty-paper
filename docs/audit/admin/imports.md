# Imports (`/imports`)

## Who and why
The super admin (and the research cell), weekly, and in bursts after each new workbook: "I have a file. What will it change, and did it land?"

## What it showed before
![before](shots/imports-before-1440.png)

- One page 6,100 px tall at 1440 px, with ten importers open at once: roster, payment history, ERP workbook, project teams, Scopus IDs, Scopus profiles, college website, verification queue, publication record, full restore. The one you wanted was somewhere down the scroll.
- The answer to "did my import land?" was a panel of eight figures (roster, accounts, papers, paid, prior payments, ledger rows, SCImago, SNIP) under a two-line intro and above ten forms. It was not a link to anything, and it said "counts only" and sent you elsewhere for when.
- The intro was a paragraph with " — " fragments. Most sections opened with two or three coloured callouts before the file box: a box inside a section that is itself a panel.
- "Which columns are read" was a callout with a run of `code` names on every importer.
- The file boxes and their confirmations did not say how big the change was. The roster confirmation said "Every row … whose staff id is already held" without saying how many rows were in the file. The workbook confirmation said what it would do and never what was in the database now. Payment history, which appends and doubles on a second run, had no confirmation at all.
- The job box said "Running, probably".
- Blank cells were "—".

## What changed
- One line saying what the page is for and one button (Recount).
- **The answer:** four figures, each a link (432 on the roster, 96 papers, 81 paid, 2,963 earlier payments), then "Last import: … 28 Sep 2026 by …", links to the audit log and to jobs. The other four counts are one step away under "Show every count (8)".
- **The work:** three groups of one-line rows: Load a file (ERP workbook, payment history, faculty roster), Fill in what the workbook does not carry (Scopus IDs, Scopus profiles, project teams, college website), Check what came in (papers waiting for Scopus, refresh the publication record). Each row says what it is for and what is loaded from it now ("96 papers, 81 paid"). A row opens its form in place, or from a link (`/imports?open=workbook`). Restore for a new installation is below the fold.
- **Detail on demand:** each "which columns are read" callout is now "Show which columns are read". The overwrite warning stays a callout on the form, because it must be read before the file is chosen.
- **Confirms with counts:** the roster says how many rows the file has and how many the roster holds; the workbook names the file, its size and the year and lists what the database holds now (including the SCImago and SNIP rows it would delete); payment history now asks, and says it holds N now and will hold N plus the file's rows.
- Copy: no " — " in what I touched, "In progress, probably" for the job, missing cells read "Not recorded" from the kit table.

## Evidence after
- `shots/imports-after-1440.png` (all closed), `shots/imports-open-390.png` (two open, phone). No sideways scroll at either width.
- Tests: `src/pages/imports.test.tsx` (7, including "answers first and opens each importer only on request"). Clarity baseline: imports.tsx internal-word 1 to 0.
