# HOD: Home (/)

`frontend2/src/pages/home-hod.tsx` (was `HodHome` in `home-staff.tsx`). Shared pieces in `hod-parts.tsx`. API `GET /api/hod/brief`.

## 1. Who and why
The head of department, most days, and always before the monthly review with the Principal. The three questions of docs/jtbd/hod.md: is the department on track, who needs a push, what do I tell the Principal.

## 2. What it showed before
Screenshot: `shots/home-before-1440.png` (real copy, ECE, 72 teachers).

| Element | Problem |
|---|---|
| "13 papers so far", "6 by the same date in 2025" | The whole page counted **claims for the incentive**, not papers. The Principal's own page for ECE shows 261 papers for 2026 to date and 373 for 2025. A head would have said "13" to the Principal. |
| "Against the college, all years on record": "1 of 16", "Share 20% of 95 publications", "Q1 rate 0%" | Same wrong base (95 claims for the whole college). ECE is 4th of 20 on papers per teacher. All-years, not this year. |
| "Who needs a push, 72 people", eight identical rows "Has never filed a paper here" | The finding was hidden by the volume: 72 of 73 had "never filed a claim". Nothing said who had actually slipped, and a person with 37 papers on Scopus was listed as someone who has published nothing. |
| "Remind" on each row | No preview of what would be sent; one fixed sentence for everyone. |
| "Papers 13, Q1 papers 0, Faculty published 8 of 73, Per teacher 0.18" | All claim counts. "0 Q1" was a claim count. |
| "Your department's claims" strip, "Waiting longest" list | The Track page repeated on Home, with three named papers and no meaning for a head, who cannot act on a claim. |
| No download on Home | The one thing a head hands upward was two clicks away on another page. |
| A full-width rule above "Your own papers" | Kept (shared with the officers' homes). |

## 3. What changes
- **One sentence at the top, in the head's words:** "ECE has 261 papers in 2026 so far, against a target of 300 (224 expected by now): on track. 39 to go in 3 months, about 13 a month." With no target: this year to today against last year to the same date.
- **Four figures, each a link:** papers so far (opens the list), faculty with a paper ("59 of 72"), how many have no paper this year (goes to the push list), papers of the last five years missing a DOI or an ISSN (opens the records tab).
- **"Who needs a push":** the people with no paper on record this year, the ones who slipped first, five rows, each with the reason in words and the suggested next step. "Remind" opens an editable draft naming the person's own situation ("you had 4 papers in 2025 and none on record for 2026"); "Remind all 13" opens one draft for the group. Where a colleague in the same area publishes in Q1 journals, the row offers "Pair them". A person with no paper and no Scopus ID is told apart: the next step is "Ask for their Scopus ID", because their papers may simply be unmatched.
- **"What to tell the Principal":** the one primary button, "Download the note for the Principal".
- **Claims:** one sentence ("3 claims are being checked by the college, the longest for 91 days; 16 are complete. 3 have been in one place over a month."), with Open Track. No desk, no amount.
- The head's own papers section is unchanged: their own amounts, no desk.
- Removed: the all-years "Against the college" block, the claims-based strip and list. The place in the college is one sentence on the Department page.

## 4. Evidence after
- `shots/home-after-1440.png`, `shots/home-after-390.png` (no horizontal scroll at 390).
- Tests: `pages/home-hod.test.tsx` (13: sentence, four figures and their links, push rows with reason and next step, quality reasons kept back, draft before send, note link, claims sentence with no desk or amount, refusal without retry, error with retry, own papers). Backend: `core/test_hod_brief.py` (record count equals the Principal's department figure, months left, same-date comparison, push kinds).
- API (real copy): `/api/hod/brief` 1.3 s cold (the shared record cache), about 0.6 s after; Home reads it once.
