# Principal: Accreditation (/accreditation)

## 1. Who and why
The Principal (and the IQAC coordinator) when the AQAR or a NAAC/NIRF submission is being prepared. Question Q4 of docs/jtbd/principal.md: "Where do we stand for NAAC 3.3.1 and NIRF, and what would weaken it?" A few times a year; the research cell uses the same page to fix rows.

## 2. What it showed today
Screenshot: `shots/accreditation-before.png`.

- The page opened on the research cell's job, not hers: filters, a 6,330-row list and gap chips ("Anything missing · 2708"). The answer to her question (12.17 papers per teacher, band 4 of 4) was on another page, and no NIRF figure was anywhere.
- "6,330 rows" was neither the 8,466 papers on the Reports page nor the 4,988 in five years on the brief. The reason (one row per college author per paper, as NAAC 3.4.3 asks) was not said.
- The amber "No UGC-CARE list is loaded" callout was correct and the most important caveat, but it sat between the filters and the list and explained a column, not the figure it weakens.
- Five buttons ("xlsx csv json pdf docx") of equal weight, and a "Download" that did not say what it downloads.
- Nothing about retractions, although NIRF now takes marks off for them.
- Tables: a `<table>` with truncated titles and "Not recorded" cells is fine; the row count "2708 would be sent back — each chip below is the list…" ran two ideas together with a dash.

## 3. What changes
- Title and one line in her words; one primary action, "Download the NAAC and NIRF workbook". The other formats are quiet "Also download as" links beside the list.
- The answer strip: 12.17 papers per teacher (NAAC 3.3.1, band 4 of 4); 76% of the record's papers listed in Scopus (NIRF reads Scopus and Web of Science only); 16% of 2025's papers in Q1 or Q2; 85 papers with a retraction notice in the title. Each links to its list.
- "What would weaken it": four checks in words with a status (UGC-CARE list loaded, every row has an ISSN, every row links to the paper, no paper looks retracted), each saying what it means for the score, and a link to the fix or the papers.
- "Five years, as the assessors ask": year by year, papers, papers per teacher, in Scopus, in Q1 or Q2, retraction notices; the base of each column stated (the publication record), the teacher roll stated.
- The paper list stays, as "The paper list", with its own explanation of the row count. Correcting a row remains the research cell's alone.

## 4. Evidence after
- `shots/accreditation-after-1440.png`, `shots/accreditation-after-390.png`.
- Tests: `test_accreditation_summary` (five years, Scopus count, retraction signal, refusal for faculty). Real finding on the college's data: 85 titles carry "RETRACTED" or "Retraction Note", 9 of them in 2025.
- API: `/api/reports/accreditation` about 400 ms cold, then cached.
