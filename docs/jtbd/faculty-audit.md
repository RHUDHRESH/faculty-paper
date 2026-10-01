# Faculty audit against the jobs (docs/jtbd/faculty.md)

Checked on `audit/faculty` with the `seed_demo` record (25 publications 2013-2026,
claims at five stages, five ledger payments). Screenshots at 1280 and 390 px are in
`docs/jtbd/shots/faculty/`. No page scrolls sideways at 390 px (measured with scrollWidth).

| Page / feature | Job | Finding | Status |
|---|---|---|---|
| My papers, downloads | 4 | CSV and BibTeX existed, hidden in the "..." menu, with no author role or indexing. Nothing shaped like an appraisal form, no PDF. | **Fixed**: new `/papers/appraisal` page, linked from the header and the menu |
| Payments | 3 | Faculty could see a lifetime total on Home and nothing else. No row list, no financial year, no document for tax. | **Fixed**: `GET /api/me/payments/statement?fy=&format=csv` and the `/papers/statement` page |
| Home, "See every payment" | 2, 3 | Linked to `/papers?filter=paid`. My papers ignores `filter`, and ledger-only payments have no paper row, so the link showed everything. | **Fixed**: links to the statement |
| Appraisal list, indexing | 4 | The first version printed the record's provenance (`source`, e.g. "claim") as "Indexed in". | **Fixed**: the API now returns `scopus_indexed`, and the list shows "Scopus indexed" only when it is true |
| PhD supervisor check | 5 | No count of journal papers anywhere | **Fixed** with the "Journal papers only" filter and a count sentence. The app does not rule on eligibility, because the rules differ by rank. |
| File a paper | 1 | Step 1 is Pull from Scopus. The three conditions are ticked every time (`ui/eligibility`, shown again on the filed receipt). | OK |
| Paper detail, Home "On the way" | 2 | Stage track only. No desk or officer name shown to the owner. | OK |
| Home "Needs you (2)" | 1 | The count says 2 but the list under it shows three unfiled papers plus a line about 25 | **Open**: the count rule needs checking against 17-touchups "counts agree" |
| Appraisal list, papers without author order | 4 | Records built from a claim have no author position, so the role says "Author" | **Open**: needs author order from Scopus or OpenAlex |
| API/PBAS points | 4 | Not computed. Point values differ by college and by the UGC and AICTE versions. | **Open, by choice**: needs the college's own table |
| Corresponding author | 4 | Not stored, so the list cannot mark it | **Open**: needs a model field |
| Search, Discover, Research scout, Who to work with, Messages, Discussions, Leaderboard, Calendar, Notifications, Settings | 6, 7 | Load for faculty with no sideways scroll. No job-blocking gap found in this pass. The review was shallow: screenshots only, no click-through of every button. | Not deeply audited |
