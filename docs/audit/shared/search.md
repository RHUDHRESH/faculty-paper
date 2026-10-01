# Audit: Search (`/search`) and the Ctrl-K palette

Built in `frontend2/src/pages/search.tsx`, `app/search-row.tsx`, `app/palette.tsx`. Read as faculty (real account with 10 claims) and as the research cell.

## 1. Who and why
Everybody, several times a week: "who here works on X", "is this DOI already filed", "where is the page for Y". Ctrl-K opens the same engine in a small window; `/search` is the roomy version.

## 2. What it showed before
Screenshots: `img/search-before-*.png`. Checked against the real local data (414 people).

| Part | Problem |
|---|---|
| Idle page | "Jump to" was a row of four cards, each with a big icon: a card grid for four links. |
| Failed search | "Search did not answer. Nothing was lost." named nothing and the button said "Retry". First seen for real: the local copy lacked a migration and every search failed. |
| No results | "Nothing called “x” here or in the literature": the search does not read the literature. |
| Result groups | A rule under every group heading and no rule between rows, so the rows floated. |
| People with no query | "Everyone at the college — 414 people" (dash in prose). A 3-column wall of 48 cards, each with a "Saveetha" chip (all 414 carry it), a "Message" and a "View" button. "1 papers". Sorted A to Z inside the first 48 only, so the order was arbitrary. Stopped at 60 of 414 with "Type a name". |
| Palette | "Ctrl↵ secondary", "did not answer" after a heading with a dash. |

## 3. What changed
- Idle "Jump to" is four hairline rows (icon, title, one line), headed "Or go straight to".
- Failure names what failed ("Could not load the results for “kumar”") with "Try again". A group that failed says which group.
- No results: "Nothing found for “x”." plus the same fixes.
- Result groups: one hairline between rows, none under the heading; roomy rows are square so the rule stays straight.
- People directory: a hairline list, face first, department and designation, paper count ("1 paper", "No papers yet") and one Message button (icon only on a phone). Fullest profiles first, as the server orders them. "Show 60 more" pages through all 414; the count is the real number.
- Palette: wording "Ctrl↵ other action", "Did not load"; each group heading carries the real total ("People 44") when it shows only the first four. Screenshots `img/search-palette-after-1440.png`, `img/search-palette-after-390.png`.

## 4. Evidence after
- Screenshots: `img/search-after-1440.png`, `img/search-people-after-1440.png`, `img/search-people-after-390.png`, `img/search-results-after-1440.png` (no horizontal scroll at 390).
- Tests: `src/pages/search.test.tsx` (8 passing, directory and no-result wording updated).
- API: `/api/search/all?q=kumar` took 141 to 250 ms warm and 828 ms on one cold call (over the 800 ms line, not investigated here: NEEDS a look at the cold path). `/api/people` was not timed.
