# HOD audit against the jobs (docs/jtbd/hod.md)

Judged on branch `audit/hod` with `manage.py seed_demo` (48 CSE faculty,
~560 CSE papers 2021-2026, every stage). Before-shots: `shots/hod/before/`.
Job numbers refer to the table in hod.md.

## Home (`/`)

| Gap | Job | Severity |
|-----|-----|----------|
| Totals are all-years (508 papers). Nothing says what happened *this year* or whether that is on track. | 1, 4 | High |
| "Who has published" ranks career volume; the people who need a push are the ones missing from it. "Nothing on record" is all-time, so somebody silent since 2023 never appears. | 2 | High |
| No download; "Reports" link leads to a page the HOD cannot use for a department report. | 4, 5 | High |
| Own papers section is correct (own amounts only). | 7 | OK |

## My department (`/department`)

| Gap | Job | Severity |
|-----|-----|----------|
| Opens on "All years on record". Standing, opportunities and the people table all default to career totals. | 1, 2 | High |
| Targets show done/target with no reference to the calendar: no pace, no "behind" signal. With no target set the whole section is an empty state and the page never answers "on track?" (no comparison with last year either). | 1 | High |
| Target progress counts papers rejected outright (not accepted by the chain). Not honest. | 1, 5 | High |
| No answer to "who should write with whom"; pairing exists only as a blank Assign dialog. | 3 | High |
| Reminders are per group with a dialog; there is no one-click reminder on a person's row except for the zero-paper people. | 2 | Medium |
| People table is alphabetical, all-years, no this-year vs last-year, no photo passed (initials only even when a photo exists). | 2, 6 | Medium |
| No chart of output over time on the page; "Against the college" bar pairs are fine but the only chart. | 4 | Medium |
| No download of any kind (the `/api/hod/export` endpoint exists but is only linked from Department publications, and is a raw paper list, not a report). | 4, 5 | High |
| Incomplete-records list (missing ISSN/DOI) is good and directly serves NAAC. | 5 | OK |

## Department publications (`/publications`)

| Gap | Job | Severity |
|-----|-----|----------|
| Excel/CSV export is one flat sheet; no per-teacher summary (NAAC 3.3 is per teacher), no NAAC column shape (link to paper, link to journal), no title block. | 5 | Medium |

## Leaderboard (`/leaderboard`)

| Gap | Job | Severity |
|-----|-----|----------|
| Defaults to "this academic year" and shows 104 rows of zeros, college-wide, with the HOD's own zero row highlighted. No department filter is on by default. Not a department view. | 1, 2 | Medium (not fixed here; the leaderboard is a college page) |

## Calendar (`/calendar`)

| Gap | Job | Severity |
|-----|-----|----------|
| No department deadlines (target due dates, NBA/NAAC data freeze) appear. | 1, 5 | Low (not fixed) |

## People (`/people`)

Correctly closed to the HOD ("Not visible to this account") and not in their
navigation. Department people are reached from My department. OK.

## Money

Checked: every `/api/hod/*` response passes through `hod.without_money`.
No rupee figure appears on Home or My department outside "Your own papers".

## Fixed on this branch

1. `/api/hod/brief`: one call answering the three questions for a chosen
   year (default: current): pace against target (or against last year when
   no target is set), who needs a push (with reasons), who should write with
   whom (quiet or no-Q1 person + a Q1-publishing colleague in the same subject
   area), and a per-faculty table with photo, this year, last year, Q1, led,
   last paper date. Papers rejected outright are excluded and counted
   separately.
2. `/api/hod/report?fmt=pdf|xlsx`: A4 PDF for the Principal (summary, pace,
   5-year chart, per-faculty table, who needs a push) and an Excel workbook
   for NBA/NAAC (Summary, Per teacher, NAAC 3.3 rows with DOI and journal
   links, Missing data). No money column anywhere.
3. `/department` opens with an "At a glance" section built on the brief:
   on-track verdict with a pace marker, output-by-year chart (5 years, this
   year marked as partial), push list with one-click Remind, suggested pairs
   with one-click Pair, the per-faculty table with faces, and the two
   downloads. Year picker defaults to the current year.

## Not fixed (remaining)

- Home still leads with all-years totals (links to the new glance instead).
- Leaderboard department default for HODs; calendar department deadlines.
- Target counting in `/hod/targets` also excludes rejected-outright papers now,
  but historic `/hod/overview` counts are unchanged (they are "on record").
