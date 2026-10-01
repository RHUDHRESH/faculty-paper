# Faculty: Your full record (`/faculty/me`) and Your stats (`/u/me/stats`)

`frontend2/src/pages/faculty-record.tsx` (shared with the office and heads; this card is the person's own view, `viewer.is_self`), `stats.tsx`; data `GET /api/directory/faculty/me`, `GET /api/people/me/stats`. Jobs 3, 6 and 8 in docs/jtbd/faculty.md.

## 1. Who and why
Every faculty member, rarely: "what does the college hold on me?" It is the one page that puts the identifiers (staff ID, Scopus ID, ORCID), the figures, every claim filed in the system and every payment in one place, the same page the office sees for them. A faculty member who opens `/faculty` is sent here.

## 2. What it showed before
Screenshots: `img/before_d_faculty_me.png`, `img/before_m_faculty_me.png`; `img/before_d_u_me_stats.png` for stats.

| Element | Problem |
|---|---|
| Reachable only by typing the address | No sidebar item, no link from My papers or Your profile. A page nobody could find. |
| The Papers tab (default) | A second, plainer list of the same 145 papers as My papers, 40 at a time, with "No claim filed" on 24 of them and no "File it". Two places to read the same list, and only one could act on it. |
| Research and Details tabs | Repeat My research (topics, co-authors, Scopus figures) and Your profile (bio, areas, requests). |
| "ERP-RAW-3", "ERP-PROCESSED-110" | Internal import codes beside a claim, with no word saying what they are. |
| Third figure "Claims filed in 2026: 4, 4 in all" | Counted only claims filed in this system. A person with 119 papers paid saw "4", against 24 papers waiting to be filed. |
| "Public profile" as the only button | The person's own record had no way to change anything. |
| Ident row: ORCID "Not on record" | Correct, but with no way to add one from here. |

`/u/me/stats` (Your stats): a reasonable page (followers, profile views, reach, switches). It is about social reach, not papers, so it does not need the paper count. Its purpose line in `app/nav.ts` ("Your papers, citations and claims in numbers") is wrong (NEEDS: shell). The impact and badge views reachable from Your profile (badges shelf) count from the same record and were left as they are.

## 3. What changes (the person's own view only)
- Tabs are Claims and Payments. The paper list, topics and details are one click away where they belong: the first figure links to My papers, the second to My research, "Edit your profile" to Your profile.
- The third figure is "24 papers ready to claim" (the same rule as My papers "Not claimed"), linking to that list.
- "Old ERP, RAW-3" replaces "ERP-RAW-3" for every viewer (the same wording the office's claim list uses).
- A line on the Claims tab says these are the claims filed in this system and that earlier payments are under Payments; the Payments tab links to the statement by financial year.
- The record is now reachable: My papers has "Your full record with the college" under the list.
- The office's and heads' views of the same page are unchanged; their tests pass.

## 4. Evidence after
- Screenshots: `img/after-record-1440.png`, `img/after-record-390.png` (no horizontal scroll at 390).
- Tests: `frontend2/src/pages/faculty.test.tsx`, 13 pass (new: the self view has no Papers, Research or Details tab, the figure links, the ERP claim number reads plainly).
- One paper count: `backend/core/test_paper_count.py` asserts the figure and the list on this page equal Home, My papers and My research.
- API: `/api/directory/faculty/me` 75 to 480 ms on the full local data.

## Your stats (`/u/me/stats`), changed too
- The back button and hand-made header became the standard header with one action (See your public profile); the privacy line stays.
- The six-tile boxed panel became four figures (followers, people who viewed your profile, people reached by posts, share who reacted), each saying what a zero means; "following" and "posts" moved into one sentence beneath.
- Screenshots: `img/after-stats-1440.png`, `img/after-stats-390.png`. Tests: `social-plus.test.tsx` 24 pass.
