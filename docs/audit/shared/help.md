# Audit: Help (`/help`)

Built in `frontend2/src/pages/help.tsx`.

## 1. Who and why
Somebody stuck on one job ("how do I get my payment statement for tax"). A few times a year. The research cell also prints the quick guides for a meeting.

## 2. What it showed before
Screenshot: `img/help-before-1440.png`.

| Part | Problem |
|---|---|
| Role tabs | A faculty member saw a tab for every role (Principal, Director, Finance, Research cell, Super admin) and could read each guide. Together they describe the whole chain, step by step, which faculty are not shown anywhere else. `?role=` did the same. |
| End of page | Nowhere to go when the guides do not answer. |
| Guides | Short, numbered, each ends in a button to the right page. Right. Kept. |

## 3. What changed
- Faculty and heads of department get their own guides only; the tabs and `?role=` are for the offices, who still read each other's and print them.
- "Still stuck?" ends the page for everybody outside the office: "Ask the research office" opens Messages with the office.

## 4. Evidence after
Screenshots `img/help-after-1440.png` (faculty), `img/help-cell-after-1440.png` (cell, tabs present), `img/help-after-390.png`. Test: `shared-views.test.tsx` (faculty: no Director or Finance tab even with `?role=DIRECTOR`; Finance: tab present).
