# HOD: Track (/track), as a head sees it

`frontend2/src/pages/track.tsx` (shared with the office; the head's branch is `data.scope === "department"`); API `backend/core/api/track.py` unchanged (department only, no money, four coarse stages).

## 1. Who and why
The head, occasionally: "Are my colleagues' claims stuck?" (job 7 of docs/jtbd/hod.md). A head is not in the chain and cannot move a claim; what they can do is ask a colleague. So the page has to say where the claims are, and how long, and nothing that is not theirs to know.

## 2. What it showed before
Screenshot: `shots/track-before-1440.png` (ECE, 19 claims).

| Element | Problem |
|---|---|
| Stage board (Under review 3, Approved 0, Completed 16, Sent back 0) | Clear; kept. |
| No sentence | The answer ("3 have waited over two months") had to be read off a bar and a table. |
| "A claim number that starts ERP- came from the old ERP and has no FP- number. ERP-RAW claims were still waiting when they were imported. ERP-PROCESSED claims had already been paid." | Office wording for a head: "the old ERP", "waiting when imported", and "already been paid" tells a head that colleagues were paid (a head sees no money, and the desk rule says "Completed", not "Paid"). |
| "Since filed 7 days" on all 16 completed claims | Days since the import, not since filing. The head read "7 days" as a fact about each colleague's claim. |
| Table | Every column has a heading (fixed for everyone by the base work); phone stacks with labels. |
| Row link | Opens the department paper, no money; kept. |

## 3. What changes (head only)
- **One sentence under the title:** "ECE has 19 claims: 3 claims are being checked by the college, the longest for 91 days; 16 are complete. You are not in the chain, so you cannot move a claim. If one is stuck, ask its owner." From the same stage figures, said in the three words a head may have (checked by the college, approved, complete); never a desk, never an amount.
- **Completed rows read "Complete"** in the time column instead of a count of days that means nothing once a claim is done.
- **The ERP legend** says "brought over from the college's earlier system, so it has no FP- number" and nothing about payment.
- The office's view of Track is unchanged (tests for it still pass).

## 4. Evidence after
- `shots/track-after-1440.png`, `shots/track-after-390.png`.
- Tests: `pages/track.test.tsx` (head sentence, no desk or amount in it, "Complete" not "7 days", legend wording; the earlier head test still asserts no money, no flags, no department filter, "Since filed", and the link to the department paper).
