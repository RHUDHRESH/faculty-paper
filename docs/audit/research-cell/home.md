# Audit: Home (research cell and research coordinator)

Route `/`. Code: `frontend2/src/pages/home-cell.tsx` (new), dispatched from
`OfficeHome` in `home-staff.tsx`. Server: `GET /api/cell/today`
(`backend/core/api/research_cell.py`).

## 1. Who and why
The research cell (the supervisor and colleagues at the first desk) and the
research coordinator open it first thing and after lunch. Question: **what do
I do first today?** (jobs 1, 7 and 8 in `docs/jtbd/research-cell-daily.md`).

## 2. What it showed before
Screenshot: `shots/home-before-1440.png`.

- The one list was "Waiting on you to clear", the five oldest claims. It made
  no difference between claims given to me and everyone else's, although the
  coordination desk had been giving claims out since the last audit.
- No answer at the top: no figure said how many were late. The number sat in
  the link text "Open Claims (14)" and in a small "Where everything is" strip
  below.
- Every row's button said "Check" and opened `/clearing`, the whole queue,
  not that claim. The review page (`/review/:id`) was not linked.
- A claim the Principal returned, or one the claimant fixed after "sent back",
  looked like any new claim. Nothing said it had been here before.
- "ERP-RAW-3" with no explanation. 13 of the 14 claims at the desk are
  imported ones.
- Days waiting was colour alone (red text); no word.
- No target for the day and no count of what was decided today.
- "Also waiting" listed duplicates and faults in a sentence but not the open
  flags, and not the watch-listed journals with claims waiting.
- The coordinator saw exactly the same page as the cell; no "not given to
  anyone", no reviewers.
- Divider check: three hairlines between sections, plus one card (the welcome
  dialog on first visit). No card in card.

## 3. What changed
1. **The answer first** (the base kit's `Answer`, four figures at most), each a
   link to the list behind it: Given to you, Waiting at the desk (with the
   oldest), Past 14 days (critical colour, "over the service level"), and Came
   back. The coordinator sees "Not given to anyone" in place of Came back (the
   section below still says how many came back). A zero says what it means
   ("Nothing is given to you", "None past 14 days").
2. **Today's target** in one sentence: decide the N claims that are past 14 days
   or reach it today; you have decided X today and the desk Y; "Target met."
   when the desk has decided at least N. The number comes from the same
   waiting-days rule as Coordination.
3. **Given to you first, then the oldest.** Rows show face, paper, claimant,
   department, claim number, "Watched journal" / "On hold" / who holds it,
   days and the word "Late" or "Nearly late", and a **Review** button that
   opens that claim in the review workspace.
4. **Came back to the desk.** Claims the claimant fixed (with what the desk asked
   for) and claims the Principal returned (with who and why), newest first, with
   "Review again".
5. **Claim numbers explained.** Imported numbers carry the sheet they came from
   on hover and a one-line legend under the list.
6. **Coordinator:** "Who holds what" (top five reviewers with open counts and
   claims cleared this week) and a link to give out the un-given claims.
7. **One list of the rest**, each with a real count: open flags (and how many on
   claims already paid), watched journals with claims waiting, possible
   duplicate payments, profile corrections, faults.
8. **This month so far** in a sentence: came in, cleared, sent back, not
   accepted, and how many decisions took a week or less; links to the monthly
   report. The whole-college strip stays below the fold.

## 4. Evidence after
- Screenshots: `shots/home-after-1440.png` (coordinator), `shots/home-after-390.png`
  (cell). No horizontal scroll at 390 px (`scrollWidth == clientWidth`).
- API: `/api/cell/today` 90 to 160 ms on the real local data (95 claims, 54 flags).
- Tests: `frontend2/src/pages/home-cell.test.tsx` (7),
  `backend/core/test_cell_today.py` (7: access, counts equal Coordination's, mine
  first and never the viewer's own claim, decisions today, fixed and returned
  shown apart, watched and imported marked, flags leave out own claims).
- The "Given to you" link opens `/clearing?assigned=me`. The queue page belongs
  to the review-queues helper; NEEDS: it reads `?assigned=me` (the API already
  supports `assigned=me`).
