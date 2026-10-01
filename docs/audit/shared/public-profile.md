# Audit: A colleague's profile (`/u/:id`, and `/people/:id` for faculty)

Built in `frontend2/src/pages/person.tsx`, `person-context.tsx`, `person-social.tsx`. Read as a faculty member opening a colleague with 159 papers, and as the research cell (who is sent to the office record instead).

## 1. Who and why
Anyone who found a name in Search, a feed post or a notification and asks "who is this, what have they published, how do I reach them". Several times a week.

## 2. What it showed before
Screenshot: `img/profile-before-1440.png`.

| Part | Problem |
|---|---|
| Badges | Ten badges drew as ten cards in a grid, three lines each, before the tabs. The papers, the reason anybody opens a profile, began two screens down. |
| "How you're connected" | The side column is 320 px wide. A three-person path printed the outside co-author's institution under each link and the labels ran over each other ("Konē Lakshmaiah Edu... on Foundation..."); the last person was cut off at the edge. |
| Co-authors | A "Saveetha" chip on every co-author who is at the college (almost all). |
| Prose | "No direct paper together yet — 3 steps apart", "research office — ask for a change", "List what you are good at — a technique" (dashes). |
| Empty state | "by title, journal and year, never by what they paid" after a dash. |

Buttons checked: Follow, Message, Collaborate (all do what they say and stay 40 px on a phone), Scopus link, tabs Papers / Research / Activity, "Show more (149 left)".

## 3. What changed
- Badges: newest three, "Show all 10 badges" (`BadgeStrip`, same tile and same data as the shelf).
- The connection path in the side column is one person per line: face, name (a link), "1 paper together". The institution is gone from the label. The wide sheet keeps the horizontal path.
- Only the exception is marked on a co-author: "Outside". "108 at the college · 61 outside".
- Dashes removed from every sentence on the page.

## 4. Evidence after
- Screenshots: `img/profile-after-1440.png`, `img/profile-after-390.png` (no horizontal scroll).
- Tests: `src/pages/shared-views.test.tsx` (BadgeStrip: three shown, all on request, nothing when empty on somebody else's page); the person, people and social-plus suites still pass.
