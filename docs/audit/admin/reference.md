# Reference data (`/reference`)

## Who and why
The super admin or research cell, once a year and when the numbers look wrong: "Are the years my papers were published in loaded into the quartile and SNIP tables? Which year should I load first?"

## What it showed before
![before](shots/reference-before-1440.png)

On the real data: 8,466 papers, 6,779 of them published in a year with no quartile or SNIP loaded (only 2025 is).
- The answer sat inside a "lead" panel with a sub-title, then two columns of prose, and the missing years were a wall of 40 years ("Missing: 1987, 1988, 1990 …") that nobody can act on.
- Three panels in a page: a coverage panel, and the two importers each in their own bordered box holding a tinted download strip, a numbered list of steps, a tinted upload form and a note: boxes inside boxes.
- Both importers opened with 4 steps and a paragraph of warnings that matter once a year.
- " — " fragments through the copy ("SCImago — where a quartile comes from", "the audit trail is not permitted").
- The figures were not links, and the first thing to do (load 2024) was not said.

## What changed
- One question as the sub line.
- The answer: papers priced on another year's quartile (6,779), on another year's SNIP (6,779), quartile rows held (32,186), SNIP rows held (32,087). The first two link to the importer that fixes them.
- One sentence names the year to load first ("Load 2024 first: it holds the most papers with no quartile").
- "Which years are loaded": the table of years that have papers (year, papers, quartile, SNIP), then "Show the years with papers and no ranking (37)" for the full list.
- The two importers are plain sections (no panels). The steps and the source notes are "Show how to get the file", one click away. The warning that SNIP ignores the year stays visible, because it changes what an import means.
- The overwrite confirmation stays (it says nothing is deleted and what is repriced).

## Evidence after
- `shots/reference-after-1440.png`, `shots/reference-after-390.png`. No sideways scroll.
- Tests: `src/pages/reference.test.tsx`.
- API: unchanged (three small reads, all under 200 ms).
