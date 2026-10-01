# Audit: Who to work with (co-authors, suggestions, your circle)

Route `/collaborate` (`?view=suggested|map`, `?show=members|others|outside`, `?person=<id>` opens how you are connected). `frontend2/src/pages/collaborate.tsx`; API `/api/people/{id}/coauthors`, `/api/people/me/ego`, `/api/discover/next` (`backend/core/services/coauthors.py`).

## 1. Who and why
Every faculty member, when planning a paper: "Who have I written with, who should I write with next, and how am I connected to this person?" Job: docs/jtbd/social.md 1 and 4.

## 2. What it showed before
Screenshots: `img/collaborate-before-1440.png`, `img/collaborate-before-390.png` (a faculty member, 267 co-authors).

| Element | Problem |
|---|---|
| Top | One sentence with the counts, "193 at Saveetha, 74 outside", and a big illustration. No figure could be opened. |
| "Saveetha 193" | Wrong word. The server counts an author as "inside" when their affiliation says Saveetha; only 18 of the 193 have an account on this app. The rows for the other 175 said "Saveetha, former", a claim nobody had checked. |
| Filters | All, Saveetha, Outside: no way to see the colleagues you can actually message, and no way to find one person among 267. |
| Row | On a phone the Message button was hidden until you opened the row. The connection paths were behind an unlabelled chevron. |
| Empty state | While the account was still loading, the list said "Your co-authors will appear here" for a moment, as if the reader had none. |
| Your circle | The circle shows the closest 60; nothing said so, so "Saveetha 55, Outside 4" beside "193 / 74" looked like a mismatch. |
| Suggested | A "How you're connected" button only; no Message. |
| Map text | An em dash in prose. |

## 3. What changes
- Standard header and four figures, each a link to its filter: people you have written with (267), colleagues on this app (18), Saveetha authors not on this app (175), outside at 18 institutions (74). The words say what the data says.
- Filters All / On this app / Not on this app / Outside, in the URL (`?show=`), plus a search box for name, department or institution, and "Show everyone" when nothing matches.
- Message is a 40 px icon button on a phone; "How we are connected" is a labelled button on desktop that opens the paths inline.
- The list waits for the account before it decides it is empty.
- "Your circle" says how many of the co-authors it draws ("The closest 59 of your 267 co-authors. The list has everyone.").
- Suggested rows get Message beside "How we are connected".
- The person sheet (`person-context.tsx`, not changed) already shows paths, reasons and papers, as in `img/collaborate-person-after-1440.png`.
- Done in docs/audit/social/discussions.md (was NEEDS): `/api/people/me/ego?limit=60` returned only first-step co-authors for anyone with more than 59, so "co-authors' co-authors" suggestions never appear for the most active authors. The server should keep some second-step people in the 60. Also `is_college_member` means "has an account", not "is at the college".

## 4. Evidence after
- Screenshots: `img/collaborate-after-1440.png`, `img/collaborate-after-390.png`, `img/collaborate-person-after-1440.png`.
- Tests: new `frontend2/src/pages/collaborate.test.tsx`, 6 pass (figures and their links, faces and Message on every row, the filter in the URL, search, failure is not empty, empty state).
- API: coauthors 220 ms on the full local data; unchanged.
