# Audit: Calendar

Route `/calendar` (`?view=month|week|agenda&date=`). `frontend2/src/pages/calendar.tsx` and `calendar/` (views, dialogs, model); API `/api/calendar` (`backend/core/api/calendar.py`).

## 1. Who and why
Everyone. "What is coming up, and when did my colleagues and I publish?" Faculty look weekly for the college's dates (filing cutoff, payment run) and their own reminders. Jobs: docs/jtbd/social.md 3 and 6.

## 2. What it showed before
Screenshots: `img/calendar-before-1440.png` (September, nothing ahead), `img/calendar-before-390.png` (June, agenda).

| Element | Problem |
|---|---|
| Top | The title, month arrows, Today, three view tabs, Google Calendar and Add event were one row of eight controls with the "Next:" line squeezed under it. Two primary-looking things (Add event and the tabs). |
| "Up next" | Set in the display face at 20 px; the display face is for page titles only. |
| Loading | A lone dash where the next date goes. |
| Agenda | A colleague's "published" rows had a sparkle icon, not the colleague's face. |
| Wording | "College payout run", "Payout run", "Filing cutoff for this month's payout": docs/ux/19 says "payment". |
| Radius | Grids and lists used a third corner size. |

Checked against data: the June 2026 items (payment run, colleagues' papers, "You filed ...") equal the record in `/api/calendar`; every colleague item carries `photo_url`.

## 3. What changes
- Standard header: title, the "Next:" event as the one line of purpose (it opens the event), and one action, Add event (on phones the round button stays).
- Below it one toolbar: period arrows and title, Today, Month / Week / Agenda, Google Calendar. Layer chips stay under it.
- Colleague events in the agenda show the colleague's face.
- The college's own dates say "payment" (a paper title is never rewritten).
- "Up next" is a section heading; grids and lists use the panel radius; no dash while loading.

## 4. Evidence after
- Screenshots: `img/calendar-after-1440.png`, `img/calendar-after-390.png`.
- Tests: `frontend2/src/pages/calendar.test.tsx`, 9 pass (new: payment wording, paper titles untouched).
- API: `/api/calendar` about 100 ms.
