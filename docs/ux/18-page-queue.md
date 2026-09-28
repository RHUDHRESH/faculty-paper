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
   It signs in as faculty member Joyal Isac. Look at every shot at 1440 and 390
   wide. Fix what looks wrong before reporting. Never commit `*.local.mjs`.

   **Office pages (any role):** the shared local DB has no Research cell,
   Director or Finance accounts yet, and its office accounts are behind a
   forced password change. So check office pages on a private copy:
   ```
   cp "D:/Faculty Paper/data/local-full.sqlite3" <your scratch>/office.sqlite3
   export DJANGO_SQLITE_PATH=<your scratch>/office.sqlite3 DJANGO_USE_SQLITE=true DJANGO_DEBUG=true PYTHONUTF8=1
   manage.py migrate -v0
   manage.py e2e_session --role RESEARCH_CELL --json   # throwaway account; also PRINCIPAL, DIRECTOR, FINANCE, HOD, SUPER_ADMIN, RESEARCH_COORDINATOR
   manage.py e2e_session --role FACULTY --claim --json # seeds a SUBMITTED claim for queues
   manage.py runserver <PORT+1000> --noreload           # your own API on the copy
   ```
   Point a second Vite (`VITE_API_PROXY=http://localhost:<PORT+1000>`) at it and
   set the `sessionid` cookie from `session_key`. Run every manage.py command
   with the env above (a missing `DJANGO_SQLITE_PATH` gives "no table
   core_user"). Never point these at `local-full.sqlite3` or `real.sqlite3`.
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
| 1 | Research scout + Discover | /scout /discover | done |
| 2 | Leaderboard + Calendar | /leaderboard /wall /calendar | done |
| 3 | Messages + Discussions | /messages/* /discussions/* | done (composer follow-up in flight) |
| 4 | Who to work with | /collaborate | done |
| 5 | Your circle (map) | /collaborate?view=map | done |
| 6 | File a paper, every step + receipt + edit | /papers/new /papers/:id/edit | in flight |
| 7 | Flows check, every role end to end | all | in flight |
| 8 | Paper detail + claims list | /papers/:id /papers/claims | done |
| 9 | My papers | /papers | done |
| 10 | Home, every role | / | done |
| 11 | My research + my stats | /research /u/me/stats | in flight |
| 12 | Profile (public + own) | /u/:id /me | in flight |
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
