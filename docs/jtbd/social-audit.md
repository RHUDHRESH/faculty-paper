# Social and discovery: audit (round 1)

Walked with Playwright on 2026-09-28 as two faculty (Kavya Ramesh = A, Nandhini
Selvam = B) against `seed_demo` (40 seeded faculty, 90 co-authored papers,
posts, threads, DMs, a scout run). Widths 1280 and 390. Screenshots:
`docs/jtbd/shots/social/`.

| # | Flow / page | What was wrong | Severity | Status |
|---|-------------|----------------|----------|--------|
| 1 | Profiles (`/people/:id`) | Every face in Search, Leaderboard and the feed links to `/people/:id`, which for faculty rendered "This record is not visible to this account" (403 on the office record). The colleague profile only lived at `/u/:id`. | Broken | Fixed: faculty get the colleague profile at `/people/:id` |
| 2 | Find people (`/people`) | "Find people" on Discussions opened the admin user list and 403'd for faculty. The people directory had no route. | Broken | Fixed: non-office roles get the directory |
| 3 | Notifications | Mention codes shown raw: `@"Nandhini Selvam"`. | Ugly | Fixed at write time and on read (old rows too) |
| 4 | Notifications | Social notifications (follow, comment, mention, reaction, message, collab, endorsement) showed a bell, not the person's face. | Faces | Fixed: actor passed through; new rows carry a face (rows written before the fix still show a bell) |
| 5 | Share a paper | Composer says "Share a paper" but the paper button only appears for papers filed as claims; a teacher with 11 papers on record and none filed had no way to share one. | Broken for the job | Fixed: record papers listed too; picking one drafts the text and DOI link |
| 6 | Messages | Clicking Message on a profile created an empty conversation that appeared in the *other* person's inbox as "No messages yet". | Confusing | Fixed: an empty chat shows only to its opener |
| 7 | Research scout | Without the Claude key (or with no worker) Run queued a job that never finished: "Scouting..." forever, and a run was spent. | Broken | Fixed: 503 with a plain sentence before queueing; a queued run older than 15 min is marked failed |
| 8 | Leaderboard | With a department filter the hero said "You are not on this board — it ranks active faculty members" to a ranked faculty member; also a " — " fragment. | Confusing | Fixed: "Showing AIDS. You are not in this list." |
| 9 | Leaderboard | "This academic year" showed everyone at 0 with non-zero trend lines: seeded papers had no date. | Seed data | Fixed in seed (dates) |
| 10 | Faces | HOD/Principal/other officers had no photo in the demo, so initials appeared among faces. | Seed data | Fixed in seed |
| 11 | Dev setup | Running the frontend on a port other than 5173/5174 fails every write with "CSRF check Failed" (untrusted origin). | Setup | Not a code bug: set `CSRF_TRUSTED_ORIGINS` |

Worked without change: A messages B, B gets one notification that opens the
conversation and replies; A mentions B from the composer's @ menu (rendered as
a link, no markup), B's notification opens the exact post; congratulate;
follow; the "How you're connected" path on a profile; Ctrl-K finds a person;
leaderboard filters and CSV; Discover (5 tabs), Who to work with and circle
map, research-office thread, wall of fame. No horizontal scroll at 390 px on
any page in scope.

## Remaining
- Leaderboard and wall use "—" for an unranked row. It is a table
  placeholder, not a sentence fragment; left as is.
- Many reactions to one post give one notification each; grouping would help.
- A paper on the publication record is shared as text plus DOI link, not as a
  paper card (the card needs a filed claim; a record-paper card needs a model
  change).
- Discussion threads (the public "Which journals turn papers around..." one)
  are not reachable from the feed; only via notifications and direct links.
