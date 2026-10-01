# Principal: Papers (/reports/papers), the list behind every figure

## 1. Who and why
The Principal (and the research cell) when a figure needs proof: Q6 of docs/jtbd/principal.md, "Can I trust this figure? Show me the papers." Also the IQAC's "give me the list for this department and year".

## 2. What existed
Nothing. "Publications" (`/publications`) lists 95 *claims* (the few months the app has run), not the 8,466 papers the brief counts. There was no page that counted what the brief counts, so a figure such as "1,586 papers" could not be opened, and "208 papers with no department" could not be found.

## 3. What is new
- One list, one definition of "a college paper" (`college_totals.papers`), shared with the brief. The tests assert that the total of every department's list equals the department's figure on the brief.
- Filters: year, department (including "Department not recorded"), journal quartile (Q1 or Q2, each, "Quartile not recorded"), and a search over title, journal, DOI and author. The filter is in the address, so each figure on the brief links here already applied.
- Each row: title (opens the claim if there is one, else the paper at its DOI), authors with faces linking to their record, journal, year, quartile, departments. On a phone the table stacks with labels.
- "Download these 51 papers" gives an Excel carrying the college name and the filter.
- An empty result says what to widen and offers "Clear filters".

## 4. Evidence after
- `shots/papers-after-1440.png`, `shots/papers-after-390.png`.
- Tests: `test_papers_list_matches_the_brief`. First page of 25 in about 300 ms.
