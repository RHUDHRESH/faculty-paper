# Principal: Home (/)

## 1. Who and why
The Principal, several times a day. She opens Home for two things: what waits for her approval (Q7 of docs/jtbd/principal.md) and whether the year is going well (Q1).

## 2. What it showed today
Screenshot: `shots/home-before.png`.

- Three figures led the page: "Waiting on you 0", "Worth ₹0", "Longest wait —". With nothing waiting, two of three were zeros and a lone dash that meant nothing ("—" is not a value).
- "Worth" and "Longest wait" repeat the queue; "Across everything waiting, not this page" was an explanation of a limitation of the page, not an answer.
- "Where everything is" (a five-stage strip and a list of claims at other desks) took half the page. It is the Track page repeated. Her question there is only "is anything stuck?", and one sentence answers it.
- The one thing she reports upward, the year, was a paragraph at the very bottom under "The college, last full year", after the strip and the list.
- No department was named. To find who needed a call she had to go brief, chart, table.
- "On the way to you: 14 papers with the research office, being checked" is good and stays.
- Button labels: "Council PDF" (the file is a brief for the governing council; now "Download council PDF"), "Budget" and "NAAC and NIRF tables" are quiet links and stay.
- Dividers: a full-width rule above "Your own papers" and a second under the strip; the page was nine bands.

## 3. What changes
- The Answer strip: waiting for your approval (or "Nothing is waiting for your approval", said in words), then, when claims are waiting, what they are worth and the longest wait (red beyond 30 days); when nothing waits, papers this year and papers per teacher. The last figure is always "departments need a push", and every figure opens its list.
- Waiting claims: the oldest eight with the action, or the "on the way to you" counts when the desk is empty.
- "The college, 2025": the brief's sentence, the three departments to call about with their reasons, "All departments", the council PDF, NAAC and NIRF tables, Budget.
- The pipeline is one sentence ("13 claims have been in one place for over a month. Open Track."), from the same Track figures.
- Her own papers stay last, unchanged. The rule that another officer decides them is untouched.

## 4. Evidence after
- `shots/home-after-1440.png`, `shots/home-after-390.png`. Page height at 1440: from about 1,470 px to 1,210 px, and the year now sits above the fold.
- Tests: `pages/home-officer.test.tsx` (Principal keeps her desk and her own papers section; no desk named on her own paper).
