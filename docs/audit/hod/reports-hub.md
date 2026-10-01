# HOD: Reports hub (/reports/all), Analysis (/reports) and the downloads

`frontend2/src/pages/hod-reports-hub.tsx`; `/reports` for a head redirects to Department. Files: `GET /api/hod/report?fmt=pdf|xlsx`, `GET /api/hod/department/papers/export`.

## 1. Who and why
The head, when preparing something to hand upward: the monthly note for the Principal, the NBA and NAAC workbook, the list of papers behind a figure. Jobs 4 and 5 of docs/jtbd/hod.md. Perhaps twice a month, and hard in the week before a return.

## 2. What it showed before
Screenshots: `shots/reports-all-before-1440.png` (the hub), `shots/reports-before-1440.png` (Analysis, 5,057 px tall).

| Element | Problem |
|---|---|
| Hub "Reports": Analysis, Search, Publications ("Search every paper the college has claimed or published"), Journals | Names of pages, not the questions a head is asked. Nothing said which page holds the note for the Principal; it was a button on the Department page. "Publications" promised every paper and listed 19 claims. |
| Analysis: "ECE published 19 papers across all years on record, 1st of 16 departments. 8 of 73 faculty contributed." | Claims, again. The Principal's figure is 373 papers in 2025. |
| Analysis: "Publications by year" as a line of one point, "By type: Not drawn, this is a gap in the data", "By indexing", a bar for every one of 73 faculty (65 of them zero) | Five charts and a list of 73 bars on claim counts. "Not drawn" boxes are an apology for a chart. |
| Downloads on Analysis: Excel, CSV, Print | Three equal small links on a page a head cannot trust. |
| The workbook | Summary sheet counted claims; the NAAC sheet listed claims, with no DOI when the claim had none. |
| The PDF | Titled "Research publication report", counts of claims with "papers the review chain did not accept are left out". |

## 3. What changes
- **The hub is the head's questions, each with today's answer:** Are we on track? (the same sentence as Home), Who needs a push?, What do I tell the Principal? (button "Note for the Principal"), Is every paper ready for NBA and NAAC? (15 papers need a DOI or an ISSN, 8 faculty have no Scopus ID; button "NBA and NAAC workbook"), Which papers make up a figure? Then Search, Journals and Faculty. Four figures on top, each a link.
- **Analysis is retired for a head:** `/reports` sends them to Department, where the same questions are answered from the record. Nine hundred lines of claim-based charts and their tests are deleted.
- **The note for the Principal** (`fmt=pdf`) is now "Research note for the Principal": A4, letterhead, page 1 stands alone (a head can hand over that page): one sentence that says whether the department is on track (with months left and papers a month needed), four figures, pace table, papers per year with Q1 marked, who needs a push with a reason and a next step, records to fix (DOI, ISSN for journal articles, Scopus ID), then, on their own page, per teacher. Counted from the record; no money column; page numbers.
- **The workbook** (`fmt=xlsx`): Summary, Per teacher (five years), NAAC 3.3 papers (one row per paper with DOI link, journal, ISSN, quartile, where indexed, author position), Missing data (only what an assessor would send back), Who needs a push (with the next step).
- **Papers export** ("Download these N papers" on the papers list): the list on screen with the college name and the filter on top.

## 4. Evidence after
- `shots/reports-hub-after-1440.png`, `shots/reports-hub-after-390.png`. PDF text and workbook cells are asserted in `core/test_hod_brief.py` (title, headings, "Next step", "Records to fix", page numbering, no rupee, DOI links, missing-data sheet).
- Tests: `pages/reports.test.tsx` (a head is sent to Department), `pages/hod-papers.test.tsx`.

