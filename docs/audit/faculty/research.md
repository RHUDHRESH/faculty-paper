# Faculty: My research (`/research`, and `/goals` which lands here)

`frontend2/src/pages/research.tsx`; data `GET /api/me/research`, `GET /api/college/research`, `PUT /api/me/goals`. Jobs 7, 9 and the pride in job 8 (docs/jtbd/faculty.md). `/goals` redirects to `/research?tab=me#this-year` (`app/nav.ts`), so the goal is set on the "This year" block of this page.

## 1. Who and why
Every faculty member, now and then (monthly to yearly). Three questions in the owner's order: what have I done (past), what do I work on now and how is this year going (present), and what should I do next (future: a topic, a journal, a person to write with).

## 2. What it showed before
Screenshots: `img/before_d_research.png`, `img/before_m_research.png`; full page seen at 1440 (3,445 px tall).

| Element | Problem |
|---|---|
| Header | A 28 px serif headline sentence under the tabs, a pill "Me / The college" with its own shape, and a small "Your public profile" link drawn by hand. |
| Five tiles with icons (145, 540, 12, 1, 93) | Five figures (the rule is one to four), as boxed tiles. "12 h-index" and "1 Q1 papers" gave no meaning; only the first tile linked anywhere. The pace for the year, the thing most people came for, was at the very bottom. |
| Past: four bordered panels side by side and stacked | Boxes in boxes. "Most cited: X, 77 citations" was said twice (a caption under the chart and again as the first row of "Your most-cited papers"), with a " — " fragment. The list did not link to the papers. |
| "Papers by month" grid | A decoration between the record and the topics. |
| Present | Two more panels, then journals, then a bar. "4 more" said nothing about where (that phrase comes from `ui/chart`, see NEEDS). |
| Future | Three idea cards labelled "Counted" or "Suggested by the model" (an internal word), "A partner who completes you", and buttons "Profile", "Journal". |
| This year | At the bottom under Future: the pace line, "1 under review" (linking to the whole list, and a desk-flavoured word), "1 drafts wait", "Set a personal target (only you see it)" as a link, a plain `<input>` with a different radius from the app. |
| The college tab | A headline in the display serif with the number 8,395 in it (numbers are never set in the display face). "People near you" drew every face as initials (`photo_url: null` hard-coded). |

Checked against data: 145 papers, 540 citations, h-index 12, 93 as first author equal Home, My papers and the record page. Pace (36 in 2026, 5 ahead) equals the 36 on My papers for 2026.

## 3. What changes
- Standard header: title, the headline sentence as the one line, one action (Your public profile), and the two views as one row of choices.
- The answer, four figures: papers on your record (links to My papers), citations with the h-index in words, papers so far in this year (links to that year on My papers), papers as first author. A zero says what it means; an empty record says "Citations arrive with your Scopus record".
- Past, Present, Future stay, as the owner described. The panels go: sections are separated by space, and the lists by one hairline. The duplicated "Most cited" line goes; each most-cited paper links to its DOI. h-index gets a sentence ("h-index 12 means 12 of your papers have at least 12 citations each"). Papers by month folds away behind "Show papers by month, last ten years".
- "This year" (pace, goal ring, target) moves to the top of Present, where the question belongs. It says "with the college", links to My papers filtered to those in progress, and the target form uses the kit's input and buttons.
- Words: "A suggestion" instead of "Suggested by the model", "Someone to write with", "See their profile", "See the journal", no " — " fragments.
- The college tab: the sentence is in the interface face with the count as a figure, and people near you show their photos.

## 4. Evidence after
- Screenshots: `img/after-research-1440.png`, `img/after-research-390.png`, `img/after-research-college-1440.png` (no horizontal scroll at 390).
- Tests: `frontend2/src/pages/research.test.tsx` 6 pass (new: four figures and their links, pace under Present, no "model" word).
- API: `/api/me/research` 560 to 800 ms on the full local data (a faculty member, 145 papers). Under the 800 ms line, but the slowest faculty call; noted for the base helper.

## Not done, needs the kit
- `ui/chart` `RankedBars` prints "4 more, in the numbers below" with a dash fragment (NEEDS).
- The college total (8,395 papers) is counted differently from the leaderboard footer (6,981 papers in the whole record); both are true of different things but a reader sees two college totals (for the base helper).
