# Audit: Research scout

Route `/scout`. `frontend2/src/pages/scout.tsx`; API `GET/POST /api/scout` (`backend/core/api/scout.py`, `services/scout.py`).

## 1. Who and why
A faculty member planning the next paper, a few times a term: "What should I take up next, which calls are open, who do I write to?" Jobs: docs/jtbd/social.md 1 and 2.

## 2. What it showed before
Screenshot: `img/scout-before-1440.png` (no run yet).

| Element | Problem |
|---|---|
| First visit | A title, a small illustration, a "Scout for me" button in the corner and one grey line about "5 of 5 runs left". Nothing said what the scout does, what it reads or how long it takes, so most people would not press it. |
| Result | A long brief with no summary at the top: to know whether anything was found the reader scrolled the whole page. Each section had a rule and a card-like top border. |
| Colleagues | Faces and names, but no way to act: no Message. |
| Runs used up | "Scout again" went grey with no reason. |
| "1 papers" | Plural not handled. |

The result view was checked with a seeded run in the scratch database (web items marked "fixture"); the colleagues in it are real people from the record. No model is configured locally, so a live run could not be made.

## 3. What changes
- Standard header, one action. Before the first run the page says what the scout does (calls, directions, colleagues and people beyond the college, journals), that it takes a minute or two, how many runs are left, and offers one big "Scout for me".
- After a run: four figures that scroll to their section (open calls, directions, colleagues, people beyond the college), then the lead direction as before.
- Each colleague has a Message button next to the face and name.
- When today's runs are used up, both the first-run panel and the footer line say so, and that Scout again is off until tomorrow.
- Sections are separated by space and not by rules; the paper count reads "1 paper".
- Web findings and our own records stay labelled apart; nothing about money.

## 4. Evidence after
- Screenshots: `img/scout-after-1440.png`, `img/scout-after-390.png`, `img/scout-result-after-1440.png`, `img/scout-result-after-390.png`.
- Tests: `frontend2/src/pages/scout.test.tsx`, 6 pass (first run text and single button, runs used up, figures, Message link, sources labelled apart).
- API: `/api/scout` 60 to 100 ms (reads the stored run).
