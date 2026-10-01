# HOD: Department (/department)

`frontend2/src/pages/department.tsx`, shared pieces in `hod-parts.tsx`; backend `core/services/hod_record.py`, `core/api/hod_brief.py`, `core/api/hod.py` (targets).

## 1. Who and why
The head, before and after the monthly review, and each week to decide whom to talk to. It is the head's page for the department: is it on track, who needs a push, what goes to the Principal.

## 2. What it showed before
Screenshot: `shots/department-before-1440.png` (4,294 px tall on the real copy; the welcome dialog is over the top in the first screenshot and is not part of the page).

| Element | Problem |
|---|---|
| Every figure on the page | Counted the department's **claims** (13 for 2026), not its papers (261). The Principal's page for the same department disagreed by a factor of twenty. "Position 1st of 16" against the Principal's 4th of 20. |
| Push list | 72 rows of "Has never filed a paper here" and a "Show all 72" button. |
| Targets (none set) | Whole section an empty state; with a target, progress counted claims and never said how many months were left or what a month must now deliver. |
| "Who should write with whom, 0 suggested" | Half the width of the page for a sentence saying nothing was suggested. Pairing keyed on a claim's subject field, which the record does not carry. |
| The people table | Nine columns including "On Scopus" and "Citations" with dashes, a bar pair, "Set one" buttons, a scrolling box. Names linked to `/people/:id`, which is closed to a head ("Not visible to this account"). |
| "From the college website" paragraph | Marketing copy about placements in a working page. |
| "Against the college" with two bars and a coloured banner | The same comparison three times (figures, bars, sentence). |
| "Where the lift is": three groups of 18 names, "5 papers are missing an ISSN or DOI", "Where the department publishes lowest" | Claim-based; one long page, no way to jump to a part. The NAAC point (a paper needs a DOI) was buried. |
| Buttons | "Send a reminder" x3, "Set one" x30, "Write the vision", "Set a target", "Assign work": eight primary-looking buttons on one page. |
| Downloads | Two equal buttons at the top: a PDF called "Report for the Principal" and "NBA / NAAC workbook (Excel)". |

## 3. What changes
- **The record, not the claims.** Papers come from `college_totals.papers` (the Principal's definition) and each person's from `person_record.papers_of` (the faculty directory's). A test asserts the head's figure equals the Principal's for the same department and year.
- **The page opens with the answer:** the title is the department; one primary button ("Download the note for the Principal"); the year; the one-sentence answer; four figures (papers, faculty with a paper, no paper this year, papers per teacher against the college).
- **Four tabs, one question each** (a tab keeps the page to one screen of reading, and the count on a tab says what is behind it):
  - **On track:** pace against the calendar per target (bar with a tick for where it should be today, "39 to go in 3 months, about 13 a month"); with no target, this year to today against last year to the same date; the place among departments as a sentence, no other department named; papers per year and Q1 per year side by side, the current year marked "so far", with the quartile base said ("recorded for 74 of the 261 papers, so 8 in Q1 is a floor"); **Who needs a push** (eight rows, "Show more people with no paper (5)", "Remind all 13", quality reasons behind "Show people to talk to about the quality of their papers (26)").
  - **Faculty:** one table, a heading on every column, sortable, faces, names linking to `/faculty/:id`, this year, last year, Q1, led, all years, and each person's target (or "Set target"). Stacks with labels at 390 px.
  - **Targets and work:** targets for the year (progress against the calendar is on the first tab), work assigned, the vision. Unchanged behaviour, in one place.
  - **Records to fix:** papers of the last five years with no DOI, or, for a journal article, no ISSN (a conference paper has none to give, which had inflated the list from 15 to 740); faculty with no Scopus ID, with "Remind all 8". Each paper opens its detail.
- The college-website paragraph, the Scopus line, the three bar comparisons and "Where the department publishes lowest" (claim-based) are gone.
- Reminder drafts are specific and editable; one per person per day, as before, and the result names who was skipped.
- `/api/hod/targets` counts from the record too, so a target's "done" equals the figure at the top.
- Ctrl-K finds Department by "who needs a push", "on track", "monthly note", "records to fix", "missing doi".

## 4. Evidence after
- `shots/department-after-1440.png`, `department-faculty-after-1440.png`, `department-plan-after-1440.png`, `department-records-after-1440.png` and the `-390` versions (no horizontal scroll).
- Tests: `pages/department.test.tsx` (18: answer sentence, tabs and counts, pace, push with reason and next step, place without naming, error vs refusal, faculty table headings, records and Scopus reminders, vision, work assigned, target deadline, reminder, no rupee on any tab); backend `core/test_hod_brief.py` (20) and `core/tests.py::HodTargetsTests`.
- API (real copy): brief 0.6 s, records 0.5 s, targets 0.6 s.
