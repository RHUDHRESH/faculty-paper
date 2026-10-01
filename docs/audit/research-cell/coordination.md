# Audit: Coordination (Desk, Monthly report, Research coordination)

Route `/coordination` (`?tab=report`, `?tab=research`, and `?scope=unassigned|breach#assign`
on the Desk). Code: `frontend2/src/pages/coordination.tsx`, `coordination-parts.tsx`,
`cell/monthly-report.tsx`. Server: `backend/core/api/coordination.py`,
`backend/core/api/research_cell.py` (report), `backend/core/services/coordination.py`.

## 1. Who and why
The research coordinator (daily and weekly), the research cell's lead and the super admin.
Questions, one per tab:
- **Desk:** is the desk on time, and who holds what? (jobs 7, 8, coordinator 1 to 4)
- **Monthly report:** what do I tell the Principal? (job 9)
- **Research coordination:** are the scheme rules being met? (coordinator 5 to 8)

## 2. What it showed before
Screenshots: `shots/coordination-before-1440.png` (Desk).

Desk
- Four figures in a ruled strip, none of them links. "Not given to anyone: 9" was
  the sentence the coordinator acts on, and the way to act on it was at the very
  bottom of a 2,900 px page, under four charts and a list that repeated the claims
  past 14 days a second time.
- "Waiting over 14 days" list (Breaches) and the Assign list's "Past 14 days" tab
  showed the same claims twice.
- Claim numbers "ERP-RAW-3" unexplained; each opened `/papers/:id`, not the review page.
- Buttons said "Assign" and "Take back" with no count, and the toast said "Assigned. 3
  claims given to X": three verbs for one act.
- Phone: the tab row and chips were under the 40 px tap size.

Monthly report
- Six figures as a definition list with no links, "Median days to decide: None decided"
  as a value, "Who decided" as a list of sentences ("2 cleared, 1 sent back, 0 not
  accepted") rather than columns, the waiting ageing as unlinked lines. The month input
  was the only control; nothing said how to print it for the Principal.

Research coordination
- "Research faculty" was a single link. Four figures for project teams (Teams,
  Claimed, Not claimed, Mentor has no account) with no links, then bars with no
  headings. The whole journal watch-list form sat at the foot of this tab, a second
  copy of the one on Journals. With no teams loaded, four zeros and an empty state.

## 3. What changed
Desk
1. **The answer, four links:** Waiting at the research cell (to the queue), Not given
   to anyone (to the assign list, filtered), Waiting over 14 days with the oldest
   (to the assign list, filtered to those), On hold. A zero says what it means.
2. **The work moves up.** "Assign claims to reviewers" comes straight after the answer;
   the pace and ageing follow. The duplicate "Waiting over 14 days" list is gone
   (its claims are one tab away in the assign list).
3. **Buttons say what happens:** "Assign 3 claims to Ravi Cell", "Take back 3 claims"; the
   toast reads "Assigned 3 claims to Ravi Cell." / "Took back 3 claims."
4. Claim numbers open the review page, explain themselves on hover, and a legend line
   sits under the list. The `?scope=` in the URL picks the tab.
5. Tabs and chips are 40 px tall on a phone.

Monthly report
6. Four figures (came in, cleared with the amount, sent back or not accepted, median
   days), one sentence for the Principal, "Who decided" and the ageing as tables with
   headings, "Open these 13" links into the queue, a month picker, **Download CSV** and
   **Print**.

Research coordination
7. Four linked figures (research faculty, those with no threshold set, teams claimed,
   journals watched); the research faculty section reads the same request as
   `/research-faculty` and links to it; project teams by department as a headed table;
   the watch-list is one line and a link to Journals (where it now lives in full).

## 4. Evidence after
- Screenshots: `shots/coordination-after-1440.png`, `shots/coordination-report-after-1440.png`,
  `shots/coordination-research-after-1440.png`, `shots/coordination-after-390.png`,
  `shots/coordination-report-after-390.png`. No horizontal scroll at 390 px.
- Tests: `frontend2/src/pages/coordination.test.tsx` (7: linked answer, scope from the URL,
  count on the button and the request sent, imported number explained, Finance refused,
  report, research tab); `backend/core/test_coordination.py` still passes.
- API: `/api/coordination/overview` about 60 ms, `/api/coordination/claims` about 50 ms,
  `/api/admin/clearing-report` about 40 ms on 95 claims.
- Not changed: `/reports`. It is one college-wide page shared by the Principal, Finance,
  the super admin and the cell (the cell sees no different view of it), so it belongs to
  the reports pass, not to this one.
