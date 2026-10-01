# Data health (`/data/health`)

## Who and why
The super admin, weekly and after every import: "Does the record contradict itself, and could I restore from a backup if I had to?"

## What it showed before
![before](shots/data-health-before-1440.png)

On the real local data (17 checks found something, 16 found nothing):
- The page did not use the shared page column (`mx-auto max-w-4xl`), so it sat at a different width from every other admin view.
- The three tiles (6 errors, 8 warnings, 3 notes) were not links and were boxes in a page of boxes. Nothing said how old the last backup was, which is the other half of the question.
- All 33 checks were listed, 16 of them as a grey tick with no news. The rows that mattered were interleaved with them.
- A bare severity badge ("81", "257") and no words: colour alone carried error, warning or note.
- The "Fix" button did not say what it would fix. The confirm said "This changes stored records" with no count.
- Most findings had no way to the fix (paid with no ledger row, papers recorded twice): the help text said "on Record quality" but there was no link.
- "Run badges now" sat beside "Run now" though it has nothing to do with the record.
- The backup warning was a red box; the list used a card and a divider for one file.

## What changed
- Title, one question as the sub line, one primary action ("Check now").
- The answer, four figures that link: 6 errors, 8 warnings, 3 notes, and **1 day since the last backup** (red at 2 days or more, "None yet" if there is no backup).
- Only checks that found something are listed, grouped, with the count in full, a word (Error, Warning, Note) beside the colour, and the button that goes to the fix: "Fix imported claims", "Open record quality", "Open author matches". The one automatic fix keeps its own name ("Move web addresses out of journal names").
- Every fix confirms with the number: "This changes 51 stored records. Each change is written to the audit log with your name."
- The 16 clean checks are one line: "Show the checks that found nothing (16)".
- Backups are a table (Backup, Made, Size, Download) with an empty state that says what to do. The off-server warning stays, in words.
- "Award badges now" moved under "Show other tools".

## Evidence after
- `shots/data-health-after-1440.png`, `shots/data-health-after-390.png`. No sideways scroll.
- Tests: `src/pages/data-health.test.tsx` (real counts, clean checks folded, no-backup state, fix confirm names the count).
- API: `GET /api/admin/data-health` 630 ms on the real data (cached report; unchanged).
