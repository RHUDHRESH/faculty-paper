# Record quality (`/data/record`)

## Who and why
The super admin, weekly to monthly: "Is any paper recorded twice on somebody's record, do the roster names agree with the papers, and does any record look wrong?"

## What it showed before
![before](shots/data-record-before-1440.png)

On the real data: 51 pairs of papers recorded twice on 38 people's records; 6 roster names that papers spell differently; 73 odd records.
- No figure at the top. The count was one line of small text inside the first tab, and the other two tabs did not say how much was waiting in them.
- The tabs were unlabelled by count ("Recorded twice", "Roster names", "Odd records"), so a reader had to open each one.
- All 51 pairs rendered at once: a 10,000 px page (1.7 MB screenshot) where the one you wanted was somewhere down the scroll.
- The merge confirmation said "The authors, filed claims and ledger links move…" without saying how many.
- A rule above and below every list, and a card inside each pair.
- "5 same doi": the reason shown lower-cased, so DOI read as a word.

## What changed
- One question as the sub line, and the answer as four linked figures: papers recorded twice (51), roster names to check (6), odd records (73), merges done (0). The tab is in the URL (`?tab=names`), so the figures link to their list.
- The pairs show ten at a time ("Show 10 more (41 left)").
- The merge confirmation says what moves: "4 authors, 1 filed claim and 3 citations move to the record you keep, and the paper count drops by one for each of 2 people. You can undo it from this page."
- One hairline between rows, no rule around lists, one radius for controls.
- Reasons read as written ("5 Same DOI, 33 Same title and year").

## Evidence after
- `shots/data-record-after-1440.png`, `shots/data-record-after-390.png`. No sideways scroll.
- Tests: `src/pages/record-quality.test.tsx`.
- API: unchanged; the three lists are read once and shared between the answer and the tabs.
