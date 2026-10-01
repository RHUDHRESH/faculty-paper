# Faculty: My claims, the sent-back fix view, and filing (docs/ux/21 section E)

## 1. Who and why

- **Who:** any faculty member (research faculty too) who has filed, or is about to file, a claim.
- **My claims:** opened almost weekly, to answer "where is my money, and do I have to do anything?"
- **Fix view:** opened once per sent-back claim, by someone who wants to know exactly what to change and get it back in.
- **Filing:** opened a few times a year. The job is to file once and not have it come back.

## 2. Before

- My claims listed claims in a table with a stage badge and the amount. It said nothing about how long a claim had waited, gave no reason to expect a month for the money and did not say whether anything was wanted from the claimant.
- A sent-back claim showed the reviewer's reason as one paragraph. The claimant had to work out which file, which page and which field it meant, and fix it in a separate form.
- Filing was one long form. The three conditions had a one-line label each and no help on how to be sure. The first sign that a paper would be sent back (affiliation not in the PDF, fewer than 2 numbered references) was the send-back itself.
- Saving any change to a claim's files deleted and rebuilt every attachment, and a reviewer's marks hang off the attachment row. On a sent-back claim, correcting one field would therefore have wiped every mark on the claim.
- Editing a draft or a sent-back claim in the filing form showed "This paper can no longer be edited" for the claimant, because the form read a raw status that the claimant's copy deliberately does not carry.
- Faculty-facing text named the research cell in two filing messages.

## 3. What changed

**My claims (`/papers/claims`, `src/pages/claims-list.tsx`, `claims-track.ts`)**
- Each claim is a timeline in faculty stages only: Submitted, Being checked, Approved for payment, Paid; Sent back and Not accepted replace the middle. The stage filters use the same words.
- Under each: "Filed 11 days ago", and one sentence "Needed from you: ..." that is always present ("Nothing. We'll tell you when it moves." is an answer).
- Expected amount, captioned "Expected" with "An estimate until it is paid"; after payment "Paid" and "Paid in September 2026". A research-faculty claim shows the real research-threshold sentence (`ClaimThresholdNote`) and, when the threshold took everything, "Inside your research threshold" instead of "No payment due". The ThresholdCard sits above the list.
- A payout sentence ("The college pays in a monthly run ... the next is expected in October 2026") with a link to the payment statement; a paid row links to its line in the statement.
- Drafts show "Not worked out yet" rather than a calculator value for a half-filled form.
- Built on `PageHeader`; title, one line of purpose, one primary action.

**Sent-back fix view (`src/pages/fix/*`, shown on the claim page)**
- Reads the real marks API through `useMarks`. Lists each claimant-facing open mark as an item, in document order. A failed checklist item that has no mark of its own becomes an item too. The reviewer is only ever "the college".
- A mark with a region shows a drawing of the page with the region on it, the words for where it is ("the top left of the page"), the quoted text if any, and "Open page N" at that page of the file. A mark with no region shows page and link only.
- "Fix this" per item opens Replace a file, Correct a field, or Add a reference, opened on the one that fits ("Reference 1 has no number" opens on the field correction, not on a new reference).
- "Send again" is enabled once every item is fixed or marked done. It asks for the three conditions ticked again, every time, then the claim goes to Being checked and its marks turn to "fixed?" for the reviewer.
- Marks survive a claimant's save: files still on the claim are updated in place; a replacement file takes over the old file's marks; a removed file leaves its marks with the text but no page (`_persist_attachments`, tests in `core/test_applicant.py`).

**Filing** (flow unchanged: Pull from Scopus first, the three conditions ticked every time)
- Each condition has "What the reviewer checks, and how to be sure".
- The last step has "What the reviewer will look for": the affiliation line in the PDF, numbered references against the minimum, author position against the record. It only warns; it never ticks or blocks.
- Editing a draft or sent-back claim works for the claimant (`claimStatus` falls back to the faculty stage).

**Copy check:** no desk or person is named in anything a claimant reads here. Two filing strings that named "the research cell" now say "the college".

## 4. Evidence after

Screenshots (faculty session, copy of the local database, seeded claims at every stage, one sent-back claim with two claimant marks and one staff-only note):

| View | 1440 | 390 |
| --- | --- | --- |
| My claims | `D:\Faculty Paper\scratch\applicant2\shots\claims-1440.png` | `...\claims-390.png` |
| Fix view | `...\fix-1440.png`, `...\fix-open-1440.png` | `...\fix-390.png` |
| After "Send again" | `...\fix-sent-1440.png` | |
| Filing, last step with the check | `...\filing-1440.png` | `...\filing-390.png` |

No horizontal overflow at 390 on any of them; the fix buttons are 40 px tall on a phone.

Checked end to end on the copy: correcting a reference number kept both marks (label became "SEC reference 7"); Send again with the three conditions ticked moved the claim to Being checked and both marks to "fixed?".

Tests: `core.test_applicant` (now includes three marks-survive tests), `core.test_review_marks`, `core.test_security_rules`, `core.test_research_threshold`, `core.test_flags`, `core.test_filing_conditions`, `core.test_chain_rules`: 240 OK. Vitest on `claims-track`, `fix/items`, `paper-detail`, `home-*`, `file-paper`: 83 OK plus the new ones. `npx tsc -b` and `npm run audit` clean.

## 5. Not done / needs

- NEEDS (shared nav, `src/app/nav.ts`): the find-only entry for `/papers/claims` is labelled "Your claims"; the page title is "My claims". One word.
- The mark's region is drawn as a schematic page, not the rendered PDF page; the link opens the real page in the browser's viewer.
