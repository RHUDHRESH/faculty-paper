# Faculty: List for appraisal (`/papers/appraisal`)

`frontend2/src/pages/my-record.tsx` (`AppraisalList`); data `GET /api/me/publications`. Job 4 and 5 in docs/jtbd/faculty.md.

## 1. Who and why
A faculty member (or an officer for their own papers), once or twice a year: when the appraisal (API/PBAS) form, a promotion (CAS) file, a PhD supervisor application or the NAAC data request lands. The question is "list my papers from 2021 to 2025 the way the form asks, and tell me the totals". Rare but high stakes: what is printed goes into a file a committee reads.

## 2. What it showed before
Screenshots: `img/before_d_papers_appraisal.png`, `img/before_m_papers_appraisal.png` (a faculty member, 145 papers).

| Element | Problem |
|---|---|
| Back link "My papers" above the title, and the shell's breadcrumb "My papers > List for appraisal" | The same way back twice. |
| Page column | A bare `mx-auto max-w-5xl`, not the page column; title a plain serif `text-2xl`, not the kit's title. |
| Count sentence "145 publications in 2015 to 2026: 12 in journals, 93 as first author, 1 in Q1 and 0 in Q2 journals." | The answer was one line of small text. "12 in journals" was wrong: preprints, Zenodo uploads and papers with no recorded type were counted as journals. The record's real journal count for this person is 7. On a form a committee reads, that is an overclaim. |
| "Journal papers only" checkbox | Same wrong rule, so ticking it kept preprints. Its state was not in the URL, so a reload lost it. |
| Type printed raw ("conference-paper", "other", "preprint") | Index words, not the words a form uses. |
| Print and Spreadsheet, both small quiet buttons | The job of the page is to print. The main action was the least visible thing on it. |
| No paragraph | A teacher still had to write the "research contribution" paragraph by hand from the tally. |
| Empty range ("Nothing in these years.") | A bare line and no way back. |

Checked against data: 145 rows equal the My papers count and the record page count; 93 first-author equals My research.

## 3. What changes
- Standard header: title, one line of purpose, one primary action ("Print or save as PDF"). No second back link; the breadcrumb stays.
- The answer first: four figures (papers in the range, in journals, as first author, in Q1 or Q2), each saying what a zero means.
- A "For your form" block with a paragraph written from the list ("Between 2021 and 2025, Dr X published 40 papers: 12 in journals and 28 in conference proceedings or other venues. ..."), with "Copy paragraph". The paragraph and the list are counted from the same rows.
- "In journals" now means journal articles only (`isJournal`); a paper with no type is not counted. Types read "Journal article", "Conference paper", "Preprint".
- The journal filter lives in the URL (`?journals=1`) so a reload keeps it. The spreadsheet is one clear button beside the filters.
- Empty range says what to do (a button that shows all years). No papers at all points to My papers.
- Print keeps only the college stamp and the list, with each entry kept whole across pages.

## 4. Evidence after
- Screenshots: `img/after-appraisal-1440.png`, `img/after-appraisal-390.png` (no horizontal scroll at 390).
- Tests: `frontend2/src/pages/my-record.test.ts` (journal rule, paragraph, tally, CSV type label), `my-record.page.test.tsx` (figures and paragraph on screen, journal filter), 14 pass in all.
- API: `/api/me/publications` 340 to 410 ms on the full local data; unchanged.
