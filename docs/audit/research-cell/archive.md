# Audit: Past claims

Route `/archive`. Code: `frontend2/src/pages/archive.tsx`. Server:
`GET /api/archive/claims` in `backend/core/api/flags.py`.

## 1. Who and why
Research cell, coordinator, Principal, super admin. Whenever someone asks "was
this paper ever claimed or paid?", before clearing a suspicious claim (job 6, stop
double payment), and before NAAC (job 11, keep the database right). Several
times a week.

## 2. What it showed before
Screenshot: `shots/archive-before-1440.png`.

- **No answer at the top.** Only "95 claims" in small grey text under the filters.
  Nothing said how many were paid, sent back or flagged.
- **Every row was a card** (title, face, claimant, department, claim number,
  stage bar, journal, year, files, amount) with the same information in the same
  order as every other list. No column headings, so "Amount not on record" and
  "Paid" had to be read to be understood.
- **Stage words for the claimant, not the desk:** "Awaiting check", and a
  progress bar under each imported claim that was never in this chain.
- **How it ended was not there.** A sent-back claim showed "Sent back" but not
  why; "Not accepted" (rejected outright) was the same word as sent back.
- **Imported claims:** "ERP-PROCESSED-890" unexplained; "Paid" with no date and
  "Amount not on record"; the filter had "Filed (old chain)" jargon.
- **The same paper twice** was invisible unless the reviewer thought to search
  the DOI.
- **Buttons:** "Flag" on every row is fine, but there was no way from a row to
  the flags that already exist on it (only a "1 open flag" chip that did nothing).
- **Empty state:** "Try loosening one of the filters".
- **Phone:** cards worked but were long and had no labels.

## 3. What changed
1. **The answer:** claims on record (or matching the search), Paid, Sent back or
   not accepted, With open flags. Each is a link that sets one filter and keeps
   the search, year and department. The counts come from the server
   (`summary`) and ignore the status and flag filters, so the four figures stay
   comparable while narrowing.
2. **A table with headings** (the base kit's): Claim, Claimant with face and
   department, Journal and year, How it stands, Amount, Flags, and a Flag
   button. Stacked with labels under 640 px. A missing amount reads "Not
   recorded"; no flags reads "None".
3. **How it stands in the desks' words:** "Waiting to be cleared", "Cleared, with
   the Principal", "Paid on 23 Sept 2026", "Paid before this system" (imported),
   "Sent back" with the reason under it, "Not accepted".
4. **Same DOI warning:** "Same DOI on 1 other claim" links to a search for that
   DOI (server field `same_doi_others`).
5. **Open flags link to the flags on that claim** (`/flags?claim=...&status=all`).
6. **Claim numbers explain themselves:** hover an ERP number for its sheet, one
   legend line under the list.
7. Search says what it finds (claim number, title, DOI, ISSN or faculty).
8. Empty state says what to do ("Try a shorter search, or clear the filters").

## 4. Evidence after
- Screenshots: `shots/archive-after-1440.png`, `shots/archive-after-390.png`.
  No horizontal scroll at 390 px.
- Tests: `frontend2/src/pages/archive.test.tsx` (9, including outcome words,
  the reason a claim was sent back, the same-DOI link and the answer links);
  `backend/core/test_flags_desk.py` (`ArchiveSummaryTests`: summary counts
  ignore status and flag filters and leave out the viewer's own claims;
  `same_doi_others`, `rejected_outright`).
- API: `/api/archive/claims` about 90 ms on 95 claims.
