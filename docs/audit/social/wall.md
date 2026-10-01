# Audit: Wall of fame

Route `/leaderboard?view=wall` (`/wall` redirects there; `/wall?display=1` is the lobby screen). `frontend2/src/pages/wall.tsx`; API `GET /api/wall`, `/api/wall/cheer`, `/api/wall/pin`.

## 1. Who and why
Every faculty member, monthly: "Was my paper noticed, and what did my colleagues publish?" Officers use it to pick a paper of the month and to show the college on a lobby screen. Job: docs/jtbd/social.md 3 and 5.

## 2. What it showed before
Screenshots: `img/wall-before-1440.png`, `img/wall-before-390.png`.

| Element | Problem |
|---|---|
| Heading | A 30 px bold serif sentence, "September 2026 — 69 new papers, 15 in Q1 journals.", larger than the page title; an em dash; the figures buried in prose. Above it a small "Wall of fame · Whole college" eyebrow said the same thing as the tab. |
| Faces | A cluster of small faces beside the Q1 chip, and the same people again as bare names underneath. Nobody could tell which face was which name. |
| "Congratulate 0" | On all 69 tiles: a zero on every button is noise and reads as "nobody cares". |
| Kiosk empty text | An em dash in prose. |
| Nothing said whether the reader is on the wall | The one thing a faculty member scans for. |

Checked against data: month tab counts (69, 90, 111, ...) equal the number of tiles for that month; every tile author has an id and a photo where the college holds one (68 of 71 authors this month).

## 3. What changes
- One quiet section heading ("September 2026 · Whole college") and three figures: new papers, in Q1 journals, and how many have the reader as an author (a link to My papers).
- Each author is a face beside their name, linking to their profile; four at most, then "and 3 more" with the rest on hover.
- "Congratulate" shows a count only once someone has cheered; "Congratulated" when the reader has.
- Department and "Display on a screen" stay top right; the month ribbon and Q1 double-width plates are unchanged.
- Lobby screen heading and empty text lose their dashes ("September 2026: 69 new papers, 15 in Q1 journals.").

## 4. Evidence after
- Screenshots: `img/wall-after-1440.png`, `img/wall-after-390.png`.
- Tests: `frontend2/src/pages/wall.test.tsx` (5) and `leaderboard.test.tsx` (12) pass.
- API: `/api/wall` about 100 ms; unchanged.
