# 18 — One dedicated builder per page (owner request 2026-09-28)

"Every single page, every single UI, every single button, every single file:
I want a separate and impeccable design. Very serious on this."

Standard: docs/ux/17-touchups.md. Each page gets its own `page-builder`, in its
own worktree, reviewed on screen by the orchestrator before merge.

## How every builder works (read this, then your page brief)
1. In PowerShell from your worktree's `frontend2`:
   `New-Item -ItemType Junction -Path node_modules -Target "D:\Faculty Paper\repo\frontend2\node_modules"`
2. Your own Vite on the port in your brief:
   `VITE_API_PROXY=http://localhost:8010 npx vite --port <PORT> --strictPort` (background).
   The API on 8010 serves the real local data and is shared. Never stop or
   restart 5180 / 5174 / 8010, and never write through it (no posting, filing,
   approving, sending). Verify backend changes with `manage.py test`
   (`D:\Faculty Paper\repo\.venv\Scripts\python.exe`, env `DJANGO_USE_SQLITE=true`).
3. Screenshots: copy `D:\Faculty Paper\repo\frontend2\design-shot.local.mjs` into
   your `frontend2`, change 5180 to your port, run
   `MSYS_NO_PATHCONV=1 TAG=<page> node design-shot.local.mjs <routes...>`.
   It signs in as faculty member Joyal Isac. For an office page, sign in as an
   office role instead: copy `D:\Faculty Paper\repo\frontend2\shot.local.mjs`
   (uses `manage.py e2e_session --role <ROLE>` against the e2e API on 5174),
   or ask the orchestrator for a session. Look at every shot at 1440 and 390
   wide. Fix what looks wrong before reporting. Never commit `*.local.mjs`.
4. Audit every button and link on your page: it does what its label says,
   it is keyboard reachable with a visible focus ring, disabled states explain
   why, and every toast uses the same verb as the button.
5. Stay in your files. Do not edit `src/styles.css`, shared `src/ui/*`
   components, the shell or other pages. If a shared fix is needed, say so in
   your report: `NEEDS: <what> in <file>`.
6. Commit early and often; never push or deploy. Finish with `npx tsc -b`,
   `npx vitest run --maxWorkers=2` and the relevant backend tests. Report in
   under 150 words with screenshot paths.

## Queue (status: in flight / done / queued)
| # | Page(s) | Routes | Status |
|---|---|---|---|
| 1 | Research scout + Discover | /scout /discover | in flight |
| 2 | Leaderboard + Calendar | /leaderboard /wall /calendar | in flight |
| 3 | Messages + Discussions | /messages/* /discussions/* | in flight |
| 4 | Who to work with | /collaborate | in flight |
| 5 | Your circle (map) | /collaborate?view=map | in flight |
| 6 | File a paper, every step + receipt + edit | /papers/new /papers/:id/edit | queued |
| 7 | Flows check, every role end to end | all | queued |
| 8 | Paper detail + claims list | /papers/:id /papers/claims | queued |
| 9 | My papers | /papers | queued |
| 10 | Home, every role | / | queued |
| 11 | My research + my stats | /research /u/me/stats | queued |
| 12 | Profile (public + own) | /u/:id /me | queued |
| 13 | Search | /search | queued |
| 14 | Notifications + notification settings | /notifications /settings/notifications | queued |
| 15 | Sign in, password, privacy, 404 | * /privacy | queued |
| 16 | Clearing queue + claim review | /clearing | queued |
| 17 | Approvals (Principal) | /approvals | queued |
| 18 | Authorisations (Director) | /authorisations | queued |
| 19 | Payments + done | /payments /payments/done | queued |
| 20 | Department (HOD) | /department | queued |
| 21 | People + person + author matches | /people /people/:id /people/matches | queued |
| 22 | Reports + report builder | /reports /reports/build | queued |
| 23 | Ledger | /ledger | queued |
| 24 | Flags + duplicates | /flags /duplicates | queued |
| 25 | Archive (past claims) | /archive | queued |
| 26 | Audit + faults | /audit /faults | queued |
| 27 | Imports + batches | /imports /batches /batches/:id | queued |
| 28 | Policy + budget | /policy /budget | queued |
| 29 | Journals + journal record | /journals /journals/:title | queued |
| 30 | Accreditation | /accreditation | queued |
| 31 | Requests | /requests | queued |
| 32 | Publications (college) | /publications | queued |
| 33 | Data + data health | /data /data/health | queued |
| 34 | Institution settings + setup + reference | /settings /setup /reference | queued |
