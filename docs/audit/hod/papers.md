# HOD: Department papers (/publications) and one paper (/department/papers/:id)

`frontend2/src/pages/hod-papers.tsx`, `hod-paper.tsx`; API `GET /api/hod/department/papers` (+ `/export`), `GET /api/hod/papers/:id`. For a head, `/publications` is this page; everyone else keeps the general query.

## 1. Who and why
The head, when a figure needs proof ("261 papers: which?") or a name needs a look ("what has Dr X published this year?"), and before an NBA or NAAC return ("which papers have no DOI?"). Job 5 and 6 of docs/jtbd/hod.md.

## 2. What it showed before
Screenshots: `shots/publications-before-1440.png`, `shots/reports-before-1440.png` (the "Analysis" page linked from the Reports hub).

| Element | Problem |
|---|---|
| "Every publication filed in ECE, 19 claims" | A list of the department's incentive **claims**. The record holds 261 papers for 2026. Home said 261, this said 19. |
| Rows | "ERP-PROCESSED-850" under each title: an old-ERP claim number with no explanation; "Progress: Completed" on every row; faded text on a loading list. |
| Red panel "Payment figures are not shown for this role. As a head of department you can see what your department has published, not what anybody has been paid for it — this list…" | A paragraph about money on a page with no money on it, with a " — " fragment. |
| Sort "Most recently updated", a "Filters" popover | Filters hid year, quartile, faculty; nothing showed what was applied. |
| "Export" | One flat sheet, no college name, no filter said. |
| Reports > Analysis (`/reports`) | A second page of claim-based charts ("ECE published 19 papers across all years on record, 1st of 16 departments", a chart with a single year, "Not drawn — this is a gap in the data", 73 zero-bars for every faculty member). |
| Paper page (`/department/papers/:id`) | Only worked for claim ids. Names linked to `/people/:id`, closed to a head. "Progress" and "Author position 1 of ?" for a paper the head did not file. |

## 3. What changes
- **The list is the record's, and equals the figure that opened it.** "261 papers of 2026. From the college record, the same papers the Principal counts for ECE." Four figures under the title, each a link that applies the filter: in Q1 journals (8), Q2 (33), Q3 or Q4 (33), no quartile recorded (187).
- **Filters you can see and share:** year, journal quartile, author (everyone in the department), search (title, journal, DOI, author), and a "missing a DOI" or "missing an ISSN" chip when a records link opened it. All in the address.
- **One table** with a heading on every column: paper (opens the paper page), authors with faces and links to their record, journal, year, quartile, "Read the paper" (or "No DOI"). Phones get a title, authors and one line of facts.
- **"Download these 261 papers":** an Excel with the college name and the filter on top, from the same function, so the file is the list.
- **One paper:** the facts in words ("Conference paper", "None: not a journal article" for the ISSN, "1 February 2026"), topics, and every author with the department's own first and labelled "Your department", "Our college" or "Outside the college". A claim id from Track still opens, and adds "Where its claim stands: Under review" in the head's three words, never the desk.
- `/reports` (Analysis) for a head is retired in favour of Department (see reports.md).

## 4. Evidence after
- `shots/papers-after-1440.png`, `shots/papers-after-390.png`, `shots/paper-after-1440.png`, `shots/paper-after-390.png`, `shots/paper-claim-after-390.png` (no horizontal scroll).
- Tests: `pages/hod-papers.test.tsx` (10), `core/test_hod_brief.py::DepartmentPapersTests` (department scope, count equals the brief, filters including "low" and "top", another department's person refused, export carries the filter, record paper opens and a foreign one is a 404).
- API (real copy): first page of 25 in about 500 ms.
