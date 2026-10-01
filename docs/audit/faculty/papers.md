# Faculty: My papers (`/papers`)

`frontend2/src/pages/papers.tsx` (with `record-bits.tsx`); data `GET /api/me/publications`, `GET /api/me/payments`, `GET /api/me/research-threshold`. Jobs 1, 2 and 6 in docs/jtbd/faculty.md.

## 1. Who and why
Every faculty member, weekly. The question is "which of my papers can I still claim, where is each claim, and is my record right?" Ten seconds to spot what to file, then one click to file it.

## 2. What it showed before
Screenshots: `img/before_d_papers.png`, `img/before_m_papers.png` (a faculty member, 145 papers, 24 unclaimed).

| Element | Problem |
|---|---|
| Header | Four buttons of near-equal weight (Pull from Scopus, File a paper, List for appraisal, Payment statement). The same two links were repeated in the "More" menu. On a phone they wrapped into three rows before the list began. |
| The answer | There was none. One sentence ("145 papers on your record, 540 citations, since 2015.") and a chart. The 24 papers that are money left on the table were only a tab label. |
| "Papers per year" chart | A 150 px chart between the title and the list: detail shown before the work. |
| Claim state tabs | Custom tab strip, different height and radius from the controls beside it. On a phone it scrolled sideways and hid "Paid" and "Not eligible". |
| One card per paper | Each row had a decorative picture (clip-art per row, against docs/ux/17), a card inside a card (`!border-0 !bg-transparent` overrides), a "First author of 1" beside "Sole author" for the same fact, and a button that said "File". Only the Paid tab showed the amount. |
| Reports a paper twice | A ZIGBEE paper appears twice on this record (two Zenodo uploads). Nothing said so and there was no way to report it. |
| "Report... to the research cell" | Staff-facing word to faculty (docs/ux/19). |
| Nothing said what money had come | The person's total received, and the research threshold sentence for research faculty, were not on the page. |
| 145 rows at once | No paging. |

Checked against data: All 145 = Not claimed 24 + In progress 1 + Paid 119 + Not eligible 1, and 145 equals Home, My research, the record page and the public profile (see "One paper count" below).

## 3. What changes
- Standard header: title, one line, one primary action (File a paper). The appraisal list and statement move to the "For a form" line under the list and the More menu (no duplicates).
- The answer: 24 papers ready to claim (links to that tab, says "Every paper is claimed" at zero), 1 with the college, 119 paid, and the total received (links to the statement). The research threshold sentence shows under it for research faculty.
- One table with a heading on every column: Paper (title, venue and year, quartile, citations), Authors (your part, and co-authors from the college with their faces, and a count of those from outside), Where it stands. The state is words from the college's list ("Under review, 91 days", "Paid Jun 2026, ₹1,600 to you") and never a desk. An unclaimed paper has one button, "File it". On a phone each paper stacks with its labels.
- The claim state is a wrapping row of choices with counts, the same on every screen size. Paging: 50 at a time, "Show 50 more".
- "Listed twice" chip on a paper whose title matches another on the record, and "Same paper is listed twice" in its menu (reports it as a duplicate through the existing dispute endpoint). Reported papers leave the list with a "Show it again".
- The chart moves behind "Show papers per year (10)". Pull from Scopus sits beside the search, where the list is worked.
- Words: "research office", not "research cell"; "Sole author" once.

## One paper count
`/api/people/{id}/publication-metrics` (the public profile's figures) read a stored snapshot that lagged the record: 18 of 60 people sampled on the local data showed one to four papers fewer than they themselves saw (a faculty member 144 against 145). It now counts with the same service as Home and My papers. Test: `backend/core/test_paper_count.py` asserts Home, My papers, My research, the record page (figure and list) and the public profile's figure agree, with a deliberately stale snapshot.

## 4. Evidence after
- Screenshots: `img/after-papers-1440.png`, `img/after-papers-390.png` (no horizontal scroll at 390).
- Tests: `frontend2/src/pages/papers.page.test.tsx` (figures and their links, tab counts equal the figures, one "File it" per unclaimed paper, the stage words, "Listed twice", no desk named, sole author), 6 pass; `papers.test.ts` still passes.
- API: `/api/me/publications` 340 to 410 ms on the full local data (145 papers); unchanged.
