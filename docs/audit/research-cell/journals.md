# Audit: Journals (watch-list)

Routes `/journals` and `/journals/:title`. Code: `frontend2/src/pages/journals.tsx`
(other roles, unchanged list; the record page), `frontend2/src/pages/cell/journals-desk.tsx`
(the research cell's version). Server: `backend/core/api/research_cell.py`
(`GET/POST /api/admin/journal-watch`, `DELETE .../{id}`, new `GET .../for`).

## 1. Who and why
The research cell and coordinator, weekly and whenever a claim from an unfamiliar
venue arrives (job 5, watch doubtful venues). The other roles that may open
Journals (Principal, Finance, heads of department) read the list to see where the
college publishes. Question for the cell: **which venues do we doubt, why, and
which claims does that touch?** UGC-CARE stopped being maintained in February 2025,
so this college-kept list is the record of that judgement
(docs/jtbd/research-cell-daily.md).

## 2. What it showed before
Screenshot: `shots/journals-before-1440.png`.

- **The page was a list of journals with a form under it.** The watch-list, the
  thing the cell came for, was the last section: an empty ISSN box, a title box, a
  "Why" box, a disabled button, and then an empty state in a card ("No journal is
  being watched").
- **Two levels of container:** the journal table sat in its own scrolling box with
  a fixed height, so 74 journals were seen through a 12-row window with a second
  scrollbar, on top of the page scroll.
- **Nothing said which journals were watched** in the list itself.
- **A watched entry** showed its title, why, "Added by" and "N waiting" in one
  line of grey text. It did not say which claims, and "Remove" happened at once
  with no words about what would change.
- On a journal's own page there was no sign it was watched, and no way to watch it
  from there. The "Journals" back link duplicated the new breadcrumb.
- Phone: the stacked table row showed the labels "Journal", "Papers" but the
  journal name itself was hidden (a `max-w-0` meant for the desktop column).
- Sidebar: Journals lights "Reports" for the cell (the door it belongs to).

## 3. What changed (for those who clear claims)
1. **Answer:** journals on the watch-list, claims waiting in a watched journal,
   journals the college has published in. Each links to what is behind it.
2. **One primary action, top right:** "Watch a journal" opens a small form (ISSN,
   title, why). The "Why" is required; a journal needs an ISSN or a title.
3. **The watch-list comes first.** Each entry has the journal (a link to its
   record), why, who put it there and when, and a line "2 claims are waiting to be
   cleared, 7 claims in all, 5 paid". "Show the claims waiting (2)" opens them,
   oldest first, each with days and a Review button.
4. **"Take off the watch-list" asks first** and says what will change: how many
   waiting claims stop carrying a warning and become clearable in a batch, and
   repeats why it was watched.
5. **The published list marks watched journals** ("Watched" / "No") and is a
   plain table (no inner scrolling box).
6. **On a journal's record:** a "On the watch-list" panel with the reason and
   claims waiting, and "Take off", or a "Watch this journal" button when it is not
   (prefilled with its title and ISSN). Breadcrumb "Reports / Journals / <title>"
   replaces the back link.
7. Phone: the journal name shows in the stacked table.
8. The Principal, Finance and heads of department keep the plain list; the watch-list
   endpoint stays closed to them.

## 4. Evidence after
- Screenshots: `shots/journals-after-1440.png`, `shots/journals-after-390.png`,
  `shots/journal-record-after-1440.png`. No horizontal scroll at 390 px.
- Tests: `frontend2/src/pages/journals-desk.test.tsx` (6: reason and claims,
  claims open on the review page, watched marked in the list, confirm names the
  change, a reason is required, other roles keep the plain list);
  `backend/core/test_cell_today.py` (`JournalWatchViewTests`).
- API: `/api/admin/journal-watch` 30 to 60 ms with one entry.
- Not done: the Scopus-discontinued and UGC-CARE standing (`JournalStanding`) has
  no rows in the local data, so a "standing" column would show nothing here. The
  page is ready for it: a journal's own record already prints SJR, SNIP and quartile.
