# Final sweep: every role, every route, two widths, two colour schemes (2026-10-01)

The owner asked for a last whole-app polish pass after about thirty merges in
one day. This is what was measured, what was fixed straight away (one commit
per theme), and what is left, with the evidence for each.

Everything here is reproducible: `frontend2/audit/sweep.mjs` runs it and
`frontend2/audit/sweep-report.mjs` writes the tables below (usage at the top of
each file).

## Result in one table

Counts are **routes affected** (a route that breaks a check on any of its four
views counts once), summed over all eight roles. "Before" is the unchanged
code at `5f1c4f3`; "After" is the final commit.

Routes visited: 658 across 8 roles (before: 650).

| Check (routes affected) | DIRECTOR | FACULTY | FINANCE | HOD | PRINCIPAL | R_CELL | R_COORDINATOR | SUPER_ADMIN | Total | Before |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Console errors | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Failed calls (4xx/5xx) | 1 | 2 | 1 | 3 | 1 | 1 | 1 | 1 | 11 | 16 |
| API over 800 ms | 2 | 8 | 4 | 8 | 3 | 2 | 4 | 4 | 35 | 55 |
| Sideways scroll | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| undefined / NaN / null | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Raw enum or code | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| ALL-CAPS label | 29 | 4 | 27 | 0 | 28 | 19 | 18 | 24 | 149 | 222 |
| Dash in prose | 0 | 0 | 0 | 0 | 2 | 2 | 2 | 2 | 8 | 121 |
| Lone dash in a cell | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 29 |
| Person without a face | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 97 |
| Broken image | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Link to no page | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Lands on not-found | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Contrast, light | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 33 |
| Contrast, dark | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Forbidden content | 3 | 0 | 2 | 25 | 0 | 0 | 0 | 0 | 30 | 30 |
| Empty state beside figures | 0 | 0 | 0 | 1 | 0 | 1 | 1 | 1 | 4 | 4 |
| Error state shown | 1 | 2 | 1 | 2 | 1 | 1 | 1 | 1 | 10 | 9 |
| Tap target under 36 px | 3 | 4 | 3 | 4 | 3 | 3 | 3 | 3 | 26 | 122 |

How to read the rows that did not reach zero:

- **Person without a face (1):** a false positive. The scanner took the link
  text "Office record" on one head-of-department profile for a name.
- **Dash in prose (8):** one stored flag note ("... has no text to read - it
  is probably a scanned copy") seen on eight routes. It is a row in the
  database; the wording is fixed at source for new flags.
- **ALL-CAPS (149):** department codes and other stored data (see "Accepted").
  The shouted paper titles and journal names are gone from every page except
  the data views (Accreditation, Record quality) and a few author names.
- **Forbidden content (30):** all accepted, and explained under "Accepted".
- **Failed calls and Error state (11 and 10):** the after run also visits two
  routes per role that the before run did not (a private thread and a pasted
  review link), so these do not fall as far as the real fixes would make them.
  What is left: the thread's 404, a faculty member's refused read of someone
  else's claim, a head of department's refused read of the same claim.
- **API over 800 ms (35):** see "Not fixed", item 2: external lookups, cold
  caches, and stalls of the machine itself while the sweep ran.
- **Tap target (26):** text inputs 32 px high, a visually hidden file input and
  the nodes of the network map; see "Not fixed", item 3.

Nothing overflowed sideways at 390 px, nothing printed `undefined`, `NaN`,
`null` or `[object Object]`, no route showed a console error, and no link led
to a page that does not exist, before or after.

## How it was run

- **Data.** A copy of `data/local-full.sqlite3` (8,466 papers, 2,801 payments,
  real names, real photos from `backend/media`), served by the Django app on
  port 8168 and the built frontend on 5168. The owner's app on 8010/5180 was not
  touched.
- **Who.** Six desk roles signed in with `manage.py e2e_session` accounts
  (Super admin, Research cell, Research coordinator, Principal, Director,
  Finance). Faculty and head of department were two real people from the copy
  (a faculty member with 10 claims; the Head of ECE with 73 papers), signed
  in with a session written the same way `e2e_session` writes one, so their
  pages had real data on them and not an empty fixture.
- **Browser.** One Playwright Chromium, one page, one route at a time. Each
  route is loaded once at 1440x900 in light, then read again at 390x844 in
  light, at 390x844 in dark and at 1440x900 in dark (the theme follows
  `prefers-color-scheme` live, which is how the dark pass was driven).
- **Routes.** Every page the role can open (`pagesFor(role)`: sidebar doors,
  hub pages, the Research group, find-by-name pages), the old paths that
  redirect, My profile and File a paper, then detail pages reached by a real
  link harvested from the lists (a claim, a paper, a person, a faculty record,
  a profile, a journal, a department, `/review/:id` for the desk roles) and up
  to 25 links per role that carry a query string (the figures that open a
  list). 650 route views before, 658 after (the after run also visits a
  thread and a review link for every role).
- **Per route:** console errors and page errors; 4xx/5xx and failed requests;
  API calls over 800 ms; sideways scroll (with the elements that cause it);
  `undefined`/`NaN`/`null`/`[object Object]`; raw enum codes; ALL-CAPS text
  (literal and by CSS); " - " fragments in prose and lone dashes in cells;
  a person's link in a row with no photo or initials; broken images; internal
  links that match no route; contrast under WCAG AA against the real
  background colour (translucent layers composed, gradient panels skipped);
  tap targets under 36 px on a phone; empty states and error states shown;
  forbidden content per role (flag wording and flag fields for Director and
  Finance, rupee figures for a head of department, desk names for faculty).

One thing about the method is worth keeping: the first dark-mode contrast
pass reported 16 failures, all false. The scanner un-premultiplied canvas
colours twice, so any translucent background was wrong. It was found by
comparing one reported element with its real computed colours, fixed, and the
"before" column was re-measured on the unchanged code with the fixed scanner.

To run it again: start the API (`DJANGO_DEBUG=true`, `DJANGO_USE_SQLITE=true`,
`DJANGO_SQLITE_PATH=<copy of the database>`, `DJANGO_MEDIA_ROOT=backend/media`,
`CSRF_TRUSTED_ORIGINS=http://127.0.0.1:<vite port>`), start Vite or
`vite preview` with `VITE_API_PROXY` pointing at it, write a session key per
role with `manage.py e2e_session --role <ROLE> --json` into a JSON file, then:

```
SESS=sessions.json PORT=5168 OUT=out/now node audit/sweep.mjs
node audit/sweep-report.mjs out/now out/earlier      # add MATRIX=compare for the per-route table
```

`ROUTES_FROM=<earlier out dir>` replays exactly the routes an earlier run
visited, which is how the after run was made comparable with the before run.

## What was fixed (one commit per theme)

| Theme | What changed | Commit |
|---|---|---|
| Clarity baseline | Jobs said "Running and waiting" (the one entry left in `audit/clarity.mjs`); it now says "In progress and waiting". The baseline is `{}` and `node audit/clarity.mjs` reports 0 known violations. | `7263cfd` |
| The sweep itself | `audit/sweep.mjs`, `audit/sweep-report.mjs` | `6b9974b` and later fixes |
| Contrast (33 route views) | Muted and subtle text now hold 4.5:1 on every step of the surface ladder, down to "active" (light `#67645e` and `#686560`, dark `#b4b0a7` and `#a8a49b`); the honours text (the Q1 chip) and the people-area text (the Saveetha chip) are a shade darker. | `04f8880` |
| Faces (97) | The Most published and Highest paid rankings (the server rows now carry the person's photo), the data table under every ranked chart, and the Author column on a journal's claims all show the person's face. | `312fe40` |
| Copy, dashes (121) | Reports, Policy, the review page, the rate categories (Category I to IV, shown on the filing form, the calculator and Policy), file-check results, the count-only note and the weekly summary description no longer use " - " fragments. They read as two sentences or a colon. | `6d1f711`, `ec36623` |
| Blank values (29) | `money(null)` reads "Not recorded" (a lone dash could mean zero, unknown or not applicable), a dash inside a table cell element is treated as blank by the kit, Budget says "None" or "Not set". | `bc858d0` |
| Head of department | The filing form no longer calls the duplicate-payment check, which the server refuses a head outright (403 on every filing). Wall of fame links a tile's title only where the reader may open it (their own claim, a desk, a head's own department), otherwise to the paper's DOI; before, a head could click a colleague's paper and be told "You cannot open this claim". | `5339691` |
| Phones | Disclosure lines ("Show the numbers"), 16 px checkboxes, 24 px copy buttons and 28 px close buttons get a 40 px press area with an invisible frame, so nothing reflows; the copy button's accessible name no longer says "Copy" twice. | `8c2c860` |
| Capitals | Imported titles typed in capitals read in sentence case, keeping known short forms (IOT, CNN, IEEE...). Applied to paper titles and journal names on the home screens, queues, desk dialogs, the claim page, ledger, statements, feed, search, Wall of fame, Journals and the appraisal list. | `d1e921b`, `6843ca7`, `d213976`, `b15e406`, `417fcf3` |
| Empty and error states | An empty In progress tab says "Nothing is in progress" instead of "No papers match". 18 error states passed `onRetry={cond ? undefined : ...}` meaning "no retry", but `undefined` is the default and drew a Try again button on a 403 or 404 that can only fail; they now pass `false`. | `d1e921b`, `199a5a9` |
| Pasted /review link | A faculty member, head of department or Finance who follows a `/review/:id` link now lands on the claim's own page instead of a workspace whose three requests are all refused. | `b15e406` |
| Speed | The model-service health probe: with no model service running (this machine) every `/api/trends/me` and `/api/discover/status` that landed after a 20 second memo paid a 2 second connection attempt. A service known to be down is now answered from the last look and re-checked in a background thread (`/api/trends/me` now answers in 21 ms and `/api/discover/status` in 12 ms on a cold call, down from 2 s). A co-author connection (six per Search page, 0.44 s each) is shared until the record changes. | `67b8abe`, `257d10c` |

Tests: the whole frontend suite passes (120 files, 899 tests), `npx tsc -b`
is clean, `npm run audit` (tokens, routes, clarity) passes, and the backend
classes that touch what changed pass (257 tests across the reports, money
blindness, trends, flags, notify, logic and AI health suites, 18 for the
collaboration graph). The one test the label change broke
(`test_a_student_publication_is_always_zero_and_says_why` wants the lower-case
phrase "no remuneration is payable") was fixed by keeping the phrase.

## Accepted, not defects

- **Capitals that are data.** Department codes (`S&H-ENGLISH`, `AI&DS`,
  `CSE - CS`, `MED ELE`) and staff ids are codes the college uses. Author
  names typed in capitals (`P. MADHUMITHA`), the Accreditation title column
  (it shows what a submission would carry) and the Record quality page (where
  you fix such rows) show the stored value on purpose.
- **Server setting names** (`EMAIL_HOST`, `SCOPUS_API_KEY`) on Admin and
  Notification settings, for the super admin, are the instruction ("set
  EMAIL_HOST on the server"), not an enum. A camera file name
  (`IMG_20230909_162525`) in a flag is the file's name.
- **A head of department's rupee figures** are their own: their own papers,
  claims and payment statement. No page or response a head can reach carries
  another person's money; `/api/hod/*` has no money field, and
  `/api/prior/check` refuses a head.
- **Director and Finance and flags.** No page carries flag wording and no flag
  list is reachable (`/api/flags` answers 403). The only flag-shaped fields in
  any response are `sees_flags` and `can_see_flags`, both false for these
  roles.
- **"No journal is being watched"** beside a list of journals is true: the
  watch list is a separate list.
- **Dash in a stored flag note.** Flag notes written before the wording fix
  ("... has no text to read - it is probably a scanned copy") are rows in the
  database; new ones are fixed at source.

## Not fixed: follow-ups, with evidence

1. **About 100 more dashes in strings that no swept view shows**: dialogs,
   toasts, tooltips and error messages (103 lines in `frontend2/src`, about 100
   in `backend/core`, comments and docstrings included). The desk buttons
   ("Clear - ₹1,05,000", "Sign - ₹...") are pinned by four Playwright specs
   (`e2e/money-chain`, `full-year`, `dual-role`), so they need the specs and
   the toasts changed together. A lint rule would keep them from coming back,
   but a rule with a non-zero baseline would undo the zero baseline above.
2. **Slow calls that remain are external or cold.** `/api/lookup/paper` is
   1 to 3 s (a Crossref and OpenAlex round trip, and the form shows progress).
   The shared college figures are 0.04 to 0.16 s warm but 0.6 to 1.2 s on the
   first request after any write, measured by posting a harmless write and
   timing each GET twice: Reports 1,227 ms cold and 49 ms warm, a department
   report 1,083 and 163, Build a report 997 and 92, the leaderboard 745 and
   39, the faculty directory 611 and 78. The cause is
   `BumpOnWriteMiddleware` (it invalidates every shared figure on every
   non-GET request, including the harmless `POST /api/me/celebrations/seen`)
   and `aggregate_cache.data_version()` (it includes the newest user
   `updated_at`, which a seen-flag save moves). Narrower invalidation would
   stop one person's write making the next reader's Reports page cold. The
   other flagged calls in the table (`/api/me/research` 77 ms, `/api/auth/me`,
   the notification calls on one route) are 10 to 100 ms when timed alone: the
   machine stalled while the sweep ran.
3. **Text inputs under 36 px high on a phone** (Calendar feed link 32 px, the
   people finder 32 px). The rule in `styles.css` leaves inputs alone on
   purpose; a decision for the owner, not a bug.
4. **Capitals as data.** Journal names, department values and author names
   typed in capitals could be cleaned once in the data (Record quality is the
   place) rather than normalised at display time.
5. **Pages that have no rows in the local copy** and so were not exercised:
   `/batches/:id` (no monthly run), a discussion post and a direct-message
   chat (no feed posts or conversations). The one thread that exists is private
   and answers 404 to every role, which the page handles.
## Screenshots

Looked at, 1440 and 390 px, light and dark, in `docs/audit/final-sweep-shots/`
(file names say the role, the route, the width and the scheme).

- `docs/audit/final-sweep-shots/director-budget-1440-dark.jpg`
- `docs/audit/final-sweep-shots/director-budget-390-dark.jpg`
- `docs/audit/final-sweep-shots/faculty-home-1440-dark.jpg`
- `docs/audit/final-sweep-shots/faculty-home-390-dark.jpg`
- `docs/audit/final-sweep-shots/faculty-my-claims-1440-light.jpg`
- `docs/audit/final-sweep-shots/faculty-my-claims-390-light.jpg`
- `docs/audit/final-sweep-shots/finance-reports-who-is-publishing-1440-light.jpg`
- `docs/audit/final-sweep-shots/finance-reports-who-is-publishing-390-light.jpg`
- `docs/audit/final-sweep-shots/hod-my-papers-in-progress-1440-light.jpg`
- `docs/audit/final-sweep-shots/hod-my-papers-in-progress-390-light.jpg`
- `docs/audit/final-sweep-shots/hod-wall-of-fame-1440-light.jpg`
- `docs/audit/final-sweep-shots/hod-wall-of-fame-390-light.jpg`
- `docs/audit/final-sweep-shots/principal-track-1440-dark.jpg`
- `docs/audit/final-sweep-shots/principal-track-390-dark.jpg`
- `docs/audit/final-sweep-shots/research_cell-clearing-1440-light.jpg`
- `docs/audit/final-sweep-shots/research_cell-clearing-390-light.jpg`
- `docs/audit/final-sweep-shots/super_admin-policy-1440-dark.jpg`
- `docs/audit/final-sweep-shots/super_admin-policy-390-dark.jpg`

## Still flagged after the fixes (all of it accepted or listed above)

**Failed calls (4xx/5xx)** (4 distinct)

- `404 /api/threads/f3b6006add094bc1b743eb4e7b310c8c` on 8 route(s): DIRE:/discussions/f3b6006add094bc1b743eb4e7b310c8c, FACU:/discussions/f3b6006add094bc1b743eb4e7b310c8c, FINA:/discussions/f3b6006add094bc1b743eb4e7b310c8c, HOD:/discussions/f3b6006add094bc1b743eb4e7b310c8c, ...
- `404 /api/claims/fdf0205af5034017ab10eef5f9434d0d` on 1 route(s): FACU:/review/fdf0205af5034017ab10eef5f9434d0d
- `403 /api/claims/fdf0205af5034017ab10eef5f9434d0d` on 1 route(s): HOD:/papers/fdf0205af5034017ab10eef5f9434d0d
- `404 /api/hod/papers/fdf0205af5034017ab10eef5f9434d0d` on 1 route(s): HOD:/review/fdf0205af5034017ab10eef5f9434d0d

**API over 800 ms** (33 distinct)

- `/api/lookup/paper` on 9 route(s): FACU:/papers/new?publication=333759cfc9544619ba4e2c9d38534257, FACU:/papers/new?publication=37539d38410d4a08976e2f9f987bb5e6, FACU:/papers/new?publication=3610d06a200f4424a0d38aa1ece17152, HOD:/papers/new?publication=5039ad2b9cd4422ca956ce6fcf31abf0, ...
- `/api/leaderboard?category=score&period=academic` on 4 route(s): FACU:/leaderboard, PRIN:/leaderboard, RESE:/leaderboard
- `/api/me/research` on 3 route(s): DIRE:/goals, FACU:/research, RESE:/goals
- `/api/reports/build?dimensions=year&limit=1000` on 3 route(s): RESE:/reference, SA:/reference
- `/api/reports/department?name=TRAINING&year=2025` on 2 route(s): DIRE:/reports/departments/TRAINING?year=2025, FINA:/reports/departments/TRAINING?year=2025
- `/api/people/8141e69ab4934d709b2921ada0b2b25d/connection?to=bb1728fa93b542028dbf28350cd545a8` on 1 route(s): FACU:/search
- `/api/people/8141e69ab4934d709b2921ada0b2b25d/connection?to=0231d739f5de4432b2a8d7eea9878c79` on 1 route(s): FACU:/search
- `/api/people/8141e69ab4934d709b2921ada0b2b25d/connection?to=3370a851325f4f7ab61b98158bcc4ac5` on 1 route(s): FACU:/search
- `/api/people/8141e69ab4934d709b2921ada0b2b25d/connection?to=863e8b9be9b54288af569cf770e4d862` on 1 route(s): FACU:/search
- `/api/people/8141e69ab4934d709b2921ada0b2b25d/connection?to=650b7802d1da4219ae229bfbf4765ee8` on 1 route(s): FACU:/search
- `/api/people/8141e69ab4934d709b2921ada0b2b25d/connection?to=a720c6c5a58442e7a4520fefc90c7ad3` on 1 route(s): FACU:/search
- `/api/discover/status` on 1 route(s): FACU:/discover
- `/api/institution` on 1 route(s): FACU:/me
- `/api/auth/me` on 1 route(s): FINA:/settings/notifications
- `/api/claims/counts` on 1 route(s): FINA:/settings/notifications
- `/api/notifications/unread-count` on 1 route(s): FINA:/settings/notifications
- `/api/dm/unread` on 1 route(s): FINA:/settings/notifications
- `/api/notifications/preferences` on 1 route(s): FINA:/settings/notifications
- `/api/reports?` on 1 route(s): FINA:/reports
- `/api/reports/pack/rows?limit=50&offset=0` on 1 route(s): FINA:/accreditation
- `/api/hod/brief` on 1 route(s): HOD:/
- `/api/people/26458fb62df84685a308eb6d0ddc13a5/connection?to=c09d8c68cf73446ab02f085838f284a7` on 1 route(s): HOD:/search
- `/api/people/26458fb62df84685a308eb6d0ddc13a5/connection?to=ff58f36761e248ed807d5d1e93f23af8` on 1 route(s): HOD:/search
- `/api/people/26458fb62df84685a308eb6d0ddc13a5/connection?to=bed4ddf70c8742d89ec8eec3ac8ceaa5` on 1 route(s): HOD:/search
- `/api/directory/faculty?sort=name&dir=asc&limit=30&offset=0` on 1 route(s): PRIN:/faculty

**ALL-CAPS label** (11 distinct)

- `CSE - CS` on 139 route(s): DIRE:/leaderboard, DIRE:/reports, DIRE:/reports/brief, DIRE:/reports/departments, ...
- `MED ELE` on 98 route(s): DIRE:/reports, DIRE:/reports/build, DIRE:/ledger, DIRE:/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-01%22%2C%22filters%22%3A%7B%22status%22%3A%22PAID%22%2C%22month%22%3A%222024-01%22%7D%7D, ...
- `AI&DS, CSE` on 6 route(s): DIRE:/reports/papers, FINA:/reports/papers, PRIN:/reports/papers, RESE:/reports/papers, ...
- `AI&DS, IT` on 6 route(s): DIRE:/reports/papers, FINA:/reports/papers, PRIN:/reports/papers, RESE:/reports/papers, ...
- `BME, CSE` on 6 route(s): DIRE:/reports/papers, FINA:/reports/papers, PRIN:/reports/papers, RESE:/reports/papers, ...
- `AI&DS, CSE, IT` on 6 route(s): DIRE:/reports/papers, FINA:/reports/papers, PRIN:/reports/papers, RESE:/reports/papers, ...
- `COMPREHENSIVE MACHINE LEARNING MODELS FO` on 6 route(s): DIRE:/accreditation, FINA:/accreditation, PRIN:/accreditation, RESE:/accreditation, ...
- `, P. MADHUMITHA` on 2 route(s): FACU:/papers/appraisal, FACU:/papers/new?publication=333759cfc9544619ba4e2c9d38534257
- `P. MADHUMITHA` on 1 route(s): FACU:/collaborate
- `A ZIGBEE AND EMBEDDED BASED SECURITY MON` on 1 route(s): SA:/data/record
- `BEYOND PROFICIENCY: A COMPREHENSIVE MODE` on 1 route(s): SA:/data/record

**Dash in prose** (1 distinct)

- `(1).pdf” has no text to read — it is probably a scanned cop` on 8 route(s): PRIN:/flags, PRIN:/audit, RESE:/flags, RESE:/audit, ...

**Person without a face** (1 distinct)

- `Office record` on 1 route(s): HOD:/u/b66daf4fac974251ae4cbe7d5b2a0f53

**Forbidden content** (14 distinct)

- `/api/me/payments has amount` on 14 route(s): HOD:/, HOD:/papers, HOD:/papers?tab=unclaimed, HOD:/papers?tab=progress, ...
- `/api/me/publications has amount` on 14 route(s): HOD:/papers, HOD:/papers/appraisal, HOD:/papers?tab=unclaimed, HOD:/papers?tab=progress, ...
- `money: 2 rupee figure(s) on a head's page` on 9 route(s): HOD:/papers?tab=unclaimed, HOD:/papers?tab=progress, HOD:/papers?year=2026, HOD:/papers?year=2023, ...
- `/api/calculate has remuneration` on 7 route(s): HOD:/papers/new?publication=5039ad2b9cd4422ca956ce6fcf31abf0, HOD:/papers/new?publication=3cebaff04f744c9c9797a1caa59bb6eb, HOD:/papers/new?publication=c07f69716b264ea7b525ffc8022b8526, HOD:/papers/new?publication=db463461bc58444eb69f03c50384b9c9, ...
- `/api/track has sees_flags` on 4 route(s): DIRE:/, DIRE:/track, FINA:/, FINA:/track
- `money: 11 rupee figure(s) on a head's page` on 2 route(s): HOD:/, HOD:/papers?year=2024
- `/api/claims has remuneration` on 2 route(s): HOD:/, HOD:/papers/claims
- `money: 22 rupee figure(s) on a head's page` on 2 route(s): HOD:/papers, HOD:/papers?tab=paid
- `money: 1 rupee figure(s) on a head's page` on 2 route(s): HOD:/papers/claims, HOD:/papers/df45e4814bca4676b60199900d8104b2
- `/api/claims/fdf0205af5034017ab10eef5f9434d0d/context has can_see_flags` on 1 route(s): DIRE:/review/fdf0205af5034017ab10eef5f9434d0d
- `money: 40 rupee figure(s) on a head's page` on 1 route(s): HOD:/papers/statement
- `/api/me/payments/statement has amount` on 1 route(s): HOD:/papers/statement
- `/api/claims/df45e4814bca4676b60199900d8104b2 has remuneration` on 1 route(s): HOD:/papers/df45e4814bca4676b60199900d8104b2
- `money: 13 rupee figure(s) on a head's page` on 1 route(s): HOD:/papers?year=2025

**Empty state beside figures** (2 distinct)

- `No journal is being watched` on 3 route(s): RESE:/journals, SA:/journals
- `Nothing is in progress` on 1 route(s): HOD:/papers?tab=progress

**Error state shown** (3 distinct)

- `No thread hereIt may have been removed, or it is not one this account can see.` on 8 route(s): DIRE:/discussions/f3b6006add094bc1b743eb4e7b310c8c, FACU:/discussions/f3b6006add094bc1b743eb4e7b310c8c, FINA:/discussions/f3b6006add094bc1b743eb4e7b310c8c, HOD:/discussions/f3b6006add094bc1b743eb4e7b310c8c, ...
- `This paper does not existIt may have been withdrawn, or the link is wrong.Try again` on 1 route(s): FACU:/review/fdf0205af5034017ab10eef5f9434d0d
- `You cannot open this claimHeads of department see their department's publications under Department, ` on 1 route(s): HOD:/papers/fdf0205af5034017ab10eef5f9434d0d

**Tap target under 36 px** (8 distinct)

- `input "" 1x1` on 8 route(s): DIRE:/me, FACU:/me, FINA:/me, HOD:/me, ...
- `input "Calendar feed link" 137x32` on 8 route(s): DIRE:/settings/notifications, FACU:/settings/notifications, FINA:/settings/notifications, HOD:/settings/notifications, ...
- `input "10.1016/j.… or https://d" 358x16` on 6 route(s): DIRE:/papers/new, FINA:/papers/new, PRIN:/papers/new, RESE:/papers/new, ...
- `input "Name, department or inst" 160x32` on 2 route(s): FACU:/collaborate, HOD:/collaborate
- `g "B. K. Bala, outside, 3 p" 32x32` on 1 route(s): FACU:/network
- `g "S Prema, outside, 3 pape" 32x32` on 1 route(s): FACU:/network
- `g "N G Praveena, outside, 3" 32x32` on 1 route(s): HOD:/network
- `g "Govindasamy Kalaivani, o" 30x30` on 1 route(s): HOD:/network

## Matrix: every route, before and after

#### DIRECTOR

| Route | Before | After |
|---|---|---|
| `/` | forbidden | forbidden |
| `/search` | ok | ok |
| `/authorisations` | ok | ok |
| `/papers` | ok | ok |
| `/papers/new` | tap | tap |
| `/research` | ok | ok |
| `/discover` | slow | ok |
| `/scout` | ok | ok |
| `/collaborate` | ok | ok |
| `/messages` | ok | ok |
| `/discussions` | caps | ok |
| `/leaderboard` | slow, caps | caps |
| `/calendar` | ok | ok |
| `/papers/claims` | ok | ok |
| `/papers/appraisal` | ok | ok |
| `/papers/statement` | ok | ok |
| `/wall` | caps | ok |
| `/me` | tap | tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | tap | tap |
| `/messages/office` | ok | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/publications` | dash-cell | ok |
| `/reports` | slow, caps, dash, faces, tap | caps |
| `/reports/brief` | caps | caps |
| `/reports/departments` | caps | caps |
| `/reports/papers` | caps | caps |
| `/reports/build` | caps, tap | caps |
| `/journals` | caps, dash-cell | ok |
| `/accreditation` | caps | caps |
| `/ledger` | caps | caps |
| `/statements` | ok | ok |
| `/budget` | caps, dash-cell | caps |
| `/calculator` | tap | ok |
| `/track` | caps, forbidden | forbidden |
| `/money` | ok | ok |
| `/reports/all` | ok | ok |
| `/u` | ok | ok |
| `/network` | ok | ok |
| `/goals` | slow | slow |
| `/programme` | ok | ok |
| `/impact` | ok | ok |
| `/people/86928106c7fe47de846ee94acad173c2` | dash, tap | ok |
| `/u/8ed779a906414918959702133ddd6536` | tap | ok |
| `/papers/fdf0205af5034017ab10eef5f9434d0d` | tap | ok |
| `/papers/a708a7a8f38a4f25940de66dbdf6299e` | tap | ok |
| `/reports/departments/TRAINING?year=2025` | slow | slow |
| `/faculty/b66daf4fac974251ae4cbe7d5b2a0f53` | ok | ok |
| `/journals/Lecture%20Notes%20in%20Networks%20and%20Systems` | dash-cell, faces, tap | ok |
| `/statements?month=2026-09` | ok | ok |
| `/statements?month=2026-06` | caps | caps |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/papers/new?method=doi` | ok | ok |
| `/papers?year=2026` | ok | ok |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-01%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-03%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-07%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-08%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-09%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-10%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-11%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-12%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-01%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-03%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-07%22%2C%22filters%...` | caps, dash, faces | caps |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | forbidden |

#### FACULTY

| Route | Before | After |
|---|---|---|
| `/` | caps | ok |
| `/search` | slow | slow |
| `/papers` | caps, contrast-light | ok |
| `/papers/new` | caps, tap | ok |
| `/research` | slow, contrast-light, tap | slow |
| `/discover` | slow, contrast-light, tap | slow |
| `/scout` | ok | ok |
| `/collaborate` | caps, tap | caps, tap |
| `/messages` | contrast-light | ok |
| `/discussions` | ok | ok |
| `/leaderboard` | slow, caps | slow, caps |
| `/calendar` | ok | ok |
| `/papers/claims` | slow, caps, tap | ok |
| `/papers/appraisal` | caps | caps |
| `/papers/statement` | ok | ok |
| `/wall` | caps | ok |
| `/me` | tap | slow, tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | forbidden, tap | tap |
| `/messages/office` | contrast-light | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/u` | ok | ok |
| `/network` | slow, tap | tap |
| `/goals` | contrast-light, tap | ok |
| `/programme` | contrast-light, tap | ok |
| `/impact` | ok | ok |
| `/papers/aebe228e18224fb9a8cc1484db9b9eb8` | caps, tap | ok |
| `/papers/1f3baa53a4154108bdb981a8c81de7b6` | caps, tap | ok |
| `/u/533eceb84e0844d8b5f08c886d4f340f` | caps, tap | ok |
| `/people/bb1728fa93b542028dbf28350cd545a8` | tap | ok |
| `/papers?filter=unclaimed` | caps | ok |
| `/papers/new?publication=333759cfc9544619ba4e2c9d38534257` | slow, caps | slow, caps |
| `/papers/new?publication=37539d38410d4a08976e2f9f987bb5e6` | caps | slow |
| `/papers/new?publication=3610d06a200f4424a0d38aa1ece17152` | ok | slow |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/papers?year=2026` | caps | ok |
| `/papers?year=2025` | caps | ok |
| `/papers?year=2024` | contrast-light | ok |
| `/papers?tab=progress` | caps | ok |
| `/search?scope=topics&q=EFL%2FESL%20Teaching%20and%20Learning` | ok | ok |
| `/search?scope=topics&q=Speech%20and%20dialogue%20systems` | ok | ok |
| `/search?scope=topics&q=Natural%20Language%20Processing%20Techniques` | ok | ok |
| `/search?scope=topics&q=Topic%20Modeling` | ok | ok |
| `/search?scope=topics&q=Innovative%20Teaching%20and%20Learning%20Met...` | ok | ok |
| `/search?scope=topics&q=Engineering%20Education%20and%20Curriculum%2...` | ok | ok |
| `/search?scope=topics&q=Speech%20Recognition%20and%20Synthesis` | ok | ok |
| `/search?scope=topics&q=Online%20Learning%20and%20Analytics` | ok | ok |
| `/search?scope=topics&q=Sentiment%20Analysis%20and%20Opinion%20Mining` | ok | ok |
| `/search?scope=topics&q=AI%20in%20Service%20Interactions` | ok | ok |
| `/search?scope=topics&q=Mental%20Health%20via%20Writing` | ok | ok |
| `/search?scope=topics&q=Student%20Assessment%20and%20Feedback` | ok | ok |
| `/search?scope=topics&q=Internet of Things and AI` | ok | ok |
| `/search?scope=journals&q=Scientific Reports` | ok | ok |
| `/discover?tab=directions` | slow | ok |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | calls, error-state |

#### FINANCE

| Route | Before | After |
|---|---|---|
| `/` | forbidden | forbidden |
| `/search` | ok | ok |
| `/payments` | ok | ok |
| `/papers` | ok | ok |
| `/papers/new` | tap | tap |
| `/research` | ok | ok |
| `/discover` | slow | ok |
| `/scout` | ok | ok |
| `/collaborate` | ok | ok |
| `/messages` | ok | ok |
| `/discussions` | caps | ok |
| `/leaderboard` | slow, caps | caps |
| `/calendar` | ok | ok |
| `/papers/claims` | ok | ok |
| `/papers/appraisal` | ok | ok |
| `/papers/statement` | ok | ok |
| `/payments/done` | dash-cell | ok |
| `/wall` | caps | ok |
| `/me` | tap | tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | tap | slow, tap |
| `/messages/office` | ok | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/publications` | dash-cell | ok |
| `/reports` | slow, caps, dash, faces, tap | slow, caps |
| `/reports/brief` | caps | caps |
| `/reports/departments` | caps | caps |
| `/reports/papers` | caps | caps |
| `/reports/build` | caps, tap | caps |
| `/journals` | caps, dash-cell | ok |
| `/accreditation` | caps | slow, caps |
| `/ledger` | caps | caps |
| `/statements` | ok | ok |
| `/budget` | caps, dash-cell | caps |
| `/calculator` | tap | ok |
| `/policy` | dash, tap | ok |
| `/track` | caps, forbidden | forbidden |
| `/money` | ok | ok |
| `/reports/all` | ok | ok |
| `/u` | ok | ok |
| `/network` | ok | ok |
| `/goals` | ok | ok |
| `/programme` | ok | ok |
| `/impact` | ok | ok |
| `/people/86928106c7fe47de846ee94acad173c2` | dash, tap | ok |
| `/u/ab56f02a71bd42e6be6af9b95d21c636` | tap | ok |
| `/papers/46887566c0274987b184b03353be0fea` | tap | ok |
| `/papers/e2eaa50ced154a43a09b62fbbab01624` | tap | ok |
| `/reports/departments/TRAINING?year=2025` | ok | slow |
| `/faculty/b66daf4fac974251ae4cbe7d5b2a0f53` | ok | ok |
| `/journals/Lecture%20Notes%20in%20Networks%20and%20Systems` | dash-cell, faces, tap | ok |
| `/statements?month=2026-09` | ok | ok |
| `/statements?month=2026-06` | caps | caps |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/papers/new?method=doi` | ok | ok |
| `/papers?year=2026` | ok | ok |
| `/payments/done?month=2026-10` | ok | ok |
| `/payments/done?month=2026-09` | dash-cell | ok |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-01%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-03%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-07%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-08%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-09%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-10%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-11%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-12%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-01%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-03%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-04%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | ok |

#### HOD

| Route | Before | After |
|---|---|---|
| `/` | slow, forbidden | slow, forbidden |
| `/search` | slow | slow |
| `/department` | ok | ok |
| `/papers` | contrast-light, forbidden | forbidden |
| `/papers/new` | caps, tap | ok |
| `/research` | contrast-light, tap | ok |
| `/discover` | slow, contrast-light, tap | ok |
| `/scout` | ok | ok |
| `/collaborate` | slow, tap | tap |
| `/messages` | contrast-light | ok |
| `/discussions` | caps | ok |
| `/leaderboard` | ok | ok |
| `/calendar` | ok | ok |
| `/papers/claims` | forbidden, tap | forbidden |
| `/papers/appraisal` | caps, forbidden | forbidden |
| `/papers/statement` | forbidden | forbidden |
| `/wall` | caps | ok |
| `/me` | tap | tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | tap | tap |
| `/messages/office` | contrast-light | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/publications` | ok | ok |
| `/reports` | ok | ok |
| `/journals` | ok | ok |
| `/track` | ok | ok |
| `/reports/all` | ok | ok |
| `/u` | ok | ok |
| `/network` | tap | tap |
| `/goals` | contrast-light, tap | ok |
| `/programme` | contrast-light, tap | ok |
| `/impact` | ok | ok |
| `/faculty/bed4ddf70c8742d89ec8eec3ac8ceaa5` | ok | ok |
| `/people/ff58f36761e248ed807d5d1e93f23af8` | ok | ok |
| `/u/b66daf4fac974251ae4cbe7d5b2a0f53` | faces, tap | faces |
| `/papers/df45e4814bca4676b60199900d8104b2` | forbidden, tap | forbidden |
| `/papers/fdf0205af5034017ab10eef5f9434d0d` | calls, error-state | calls, error-state |
| `/department/papers/00fe8d0fb79e427abb4f0d68b8d7b0fa` | ok | ok |
| `/journals/Proceedings%20of%20the%206th%20International%20Conference...` | faces, tap | ok |
| `/publications?year=2026` | ok | ok |
| `/department?tab=faculty` | ok | ok |
| `/department?tab=records` | caps | ok |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/papers?tab=unclaimed` | caps, forbidden | forbidden |
| `/papers?tab=progress` | forbidden, empty | forbidden, empty |
| `/papers?tab=paid` | contrast-light, forbidden | forbidden |
| `/papers/new?publication=5039ad2b9cd4422ca956ce6fcf31abf0` | calls, slow, forbidden | slow, forbidden |
| `/papers/new?publication=3cebaff04f744c9c9797a1caa59bb6eb` | calls, slow, forbidden | slow, forbidden |
| `/papers/new?publication=c07f69716b264ea7b525ffc8022b8526` | calls, slow, forbidden | slow, forbidden |
| `/papers/new?publication=db463461bc58444eb69f03c50384b9c9` | calls, slow, forbidden | slow, forbidden |
| `/papers/new?publication=104a8d75518349278cbec02346933d71` | calls, slow, forbidden | slow, forbidden |
| `/papers/new?publication=faa8dfc13cd94323bad8664cfa759d95` | calls, slow, forbidden | slow, forbidden |
| `/papers/new?publication=861fee9596b74d4788752d1f9ea24370` | calls, forbidden | forbidden |
| `/papers/new?method=doi` | caps | ok |
| `/papers?year=2026` | forbidden | forbidden |
| `/papers?year=2025` | contrast-light, forbidden | forbidden |
| `/papers?year=2024` | contrast-light, forbidden | forbidden |
| `/papers?year=2023` | caps, forbidden | forbidden |
| `/papers?year=2022` | forbidden | forbidden |
| `/papers?year=2021` | forbidden | forbidden |
| `/papers?year=2020` | forbidden | forbidden |
| `/papers?year=2018` | forbidden | forbidden |
| `/papers?year=2017` | forbidden | forbidden |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | calls |

#### PRINCIPAL

| Route | Before | After |
|---|---|---|
| `/` | ok | ok |
| `/search` | ok | ok |
| `/approvals` | ok | ok |
| `/papers` | ok | ok |
| `/papers/new` | tap | tap |
| `/research` | ok | ok |
| `/discover` | slow | ok |
| `/scout` | ok | ok |
| `/collaborate` | ok | ok |
| `/messages` | ok | ok |
| `/discussions` | caps | ok |
| `/leaderboard` | slow, caps | slow, caps |
| `/calendar` | ok | ok |
| `/faculty` | caps, tap | slow, caps |
| `/papers/claims` | ok | ok |
| `/papers/appraisal` | ok | ok |
| `/papers/statement` | ok | ok |
| `/wall` | caps | ok |
| `/me` | tap | tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | tap | tap |
| `/messages/office` | ok | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/publications` | dash-cell | ok |
| `/reports` | slow, caps, dash, faces, tap | caps |
| `/reports/brief` | caps | caps |
| `/reports/departments` | caps | caps |
| `/reports/papers` | caps | caps |
| `/reports/build` | caps, tap | caps |
| `/journals` | caps, dash-cell | ok |
| `/accreditation` | caps | caps |
| `/statements` | ok | ok |
| `/duplicates` | caps | ok |
| `/flags` | dash, tap | dash |
| `/archive` | ok | ok |
| `/faults` | ok | ok |
| `/audit` | dash | dash |
| `/budget` | caps, dash-cell | caps |
| `/calculator` | tap | ok |
| `/policy` | dash, tap | ok |
| `/track` | caps | ok |
| `/money` | ok | ok |
| `/reports/all` | slow | slow |
| `/u` | ok | ok |
| `/network` | ok | ok |
| `/goals` | ok | ok |
| `/programme` | ok | ok |
| `/impact` | ok | ok |
| `/reports/departments/TRAINING?year=2025` | ok | ok |
| `/people/86928106c7fe47de846ee94acad173c2` | dash, tap | ok |
| `/u/65263d4dd9974d728a0ba85fed820738` | tap | ok |
| `/faculty/38578c1995e84685b8b9c48ff625cd66` | caps | caps |
| `/papers/fdf0205af5034017ab10eef5f9434d0d` | dash, tap | ok |
| `/papers/a708a7a8f38a4f25940de66dbdf6299e` | dash, tap | ok |
| `/journals/Lecture%20Notes%20in%20Networks%20and%20Systems` | dash-cell, faces, tap | ok |
| `/review/834d1f03219a41b8b4b7c15509ff28a7` | dash, tap | ok |
| `/review/c3b015fdcbd64334b696607247a86aca` | dash, tap | ok |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/papers/new?method=doi` | ok | ok |
| `/papers?year=2026` | ok | ok |
| `/faculty?missing=photo` | slow | ok |
| `/faculty?missing=scopus` | ok | ok |
| `/faculty?nopapers=1` | ok | ok |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-01%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-03%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-07%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-08%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-09%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-10%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-11%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-12%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-01%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-03%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2025-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | ok |

#### RESEARCH_CELL

| Route | Before | After |
|---|---|---|
| `/` | ok | ok |
| `/search` | ok | ok |
| `/clearing` | caps, dash-cell, tap | ok |
| `/coordination` | caps, tap | ok |
| `/papers` | ok | ok |
| `/papers/new` | tap | tap |
| `/research` | ok | ok |
| `/discover` | slow | ok |
| `/scout` | ok | ok |
| `/collaborate` | ok | ok |
| `/messages` | ok | ok |
| `/discussions` | caps | ok |
| `/leaderboard` | caps | slow, caps |
| `/calendar` | ok | ok |
| `/faculty` | caps, tap | caps |
| `/papers/claims` | ok | ok |
| `/papers/appraisal` | ok | ok |
| `/papers/statement` | ok | ok |
| `/wall` | caps | ok |
| `/me` | tap | tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | tap | tap |
| `/messages/office` | ok | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/publications` | dash-cell | ok |
| `/reports` | slow, caps, dash, faces, tap | caps |
| `/reports/brief` | caps | caps |
| `/reports/departments` | caps | caps |
| `/reports/papers` | caps | caps |
| `/reports/build` | caps, tap | caps |
| `/journals` | caps, dash-cell, empty | empty |
| `/accreditation` | caps | caps |
| `/duplicates` | caps | ok |
| `/flags` | dash, tap | dash |
| `/archive` | ok | ok |
| `/faults` | ok | ok |
| `/data/fixes` | ok | ok |
| `/audit` | dash | dash |
| `/people` | ok | ok |
| `/people/matches` | slow | ok |
| `/requests` | ok | ok |
| `/budget` | caps, dash-cell | caps |
| `/calculator` | tap | ok |
| `/policy` | dash, tap | ok |
| `/settings` | ok | ok |
| `/reference` | slow | slow |
| `/imports` | ok | ok |
| `/batches` | ok | ok |
| `/track` | caps | ok |
| `/admin` | ok | ok |
| `/reports/all` | ok | ok |
| `/u` | ok | ok |
| `/network` | ok | ok |
| `/goals` | ok | ok |
| `/programme` | ok | ok |
| `/impact` | ok | ok |
| `/review/834d1f03219a41b8b4b7c15509ff28a7?queue=clearing` | caps, dash, tap | ok |
| `/review/c3b015fdcbd64334b696607247a86aca?queue=clearing` | caps, dash, tap | ok |
| `/people/86928106c7fe47de846ee94acad173c2` | tap | ok |
| `/u/b1b2ed20766e4dbb9feb51ccaf6dde5d` | tap | ok |
| `/faculty/38578c1995e84685b8b9c48ff625cd66` | caps | caps |
| `/papers/fdf0205af5034017ab10eef5f9434d0d` | dash, tap | ok |
| `/papers/a708a7a8f38a4f25940de66dbdf6299e` | dash, tap | ok |
| `/reports/departments/TRAINING?year=2025` | ok | ok |
| `/journals/Lecture%20Notes%20in%20Networks%20and%20Systems` | dash-cell, faces, tap | ok |
| `/clearing?assigned=me` | ok | ok |
| `/coordination?tab=report` | ok | ok |
| `/track?stage=submitted` | caps, contrast-light | ok |
| `/track?stage=checked` | contrast-light | ok |
| `/track?stage=approved` | contrast-light | ok |
| `/track?stage=authorised` | contrast-light | ok |
| `/track?stage=paid` | caps, contrast-light | ok |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/coordination?scope=unassigned#assign` | caps | ok |
| `/coordination?scope=breach#assign` | caps | ok |
| `/papers/new?method=doi` | ok | ok |
| `/papers?year=2026` | ok | ok |
| `/faculty?missing=photo` | ok | ok |
| `/faculty?missing=scopus` | ok | ok |
| `/faculty?nopapers=1` | ok | ok |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-01%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-03%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-07%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-08%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-09%22%2C%22filters%...` | caps, dash, faces | caps |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | ok |

#### RESEARCH_COORDINATOR

| Route | Before | After |
|---|---|---|
| `/` | ok | ok |
| `/search` | ok | ok |
| `/clearing` | caps, dash-cell, tap | ok |
| `/coordination` | caps, tap | ok |
| `/papers` | ok | ok |
| `/papers/new` | tap | tap |
| `/research` | ok | ok |
| `/discover` | slow | ok |
| `/scout` | ok | ok |
| `/collaborate` | ok | ok |
| `/messages` | ok | ok |
| `/discussions` | caps | ok |
| `/leaderboard` | caps | slow, caps |
| `/calendar` | ok | ok |
| `/faculty` | caps, tap | caps |
| `/papers/claims` | ok | ok |
| `/papers/appraisal` | ok | ok |
| `/papers/statement` | ok | ok |
| `/wall` | caps | ok |
| `/me` | tap | tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | tap | tap |
| `/messages/office` | ok | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/publications` | dash-cell | ok |
| `/reports` | slow, caps, dash, faces, tap | caps |
| `/reports/brief` | caps | caps |
| `/reports/departments` | caps | caps |
| `/reports/papers` | caps | caps |
| `/reports/build` | caps, tap | caps |
| `/journals` | caps, dash-cell, empty | empty |
| `/accreditation` | caps | caps |
| `/duplicates` | caps | ok |
| `/flags` | dash, tap | dash |
| `/archive` | ok | ok |
| `/faults` | ok | ok |
| `/data/fixes` | ok | slow |
| `/audit` | dash | dash |
| `/people` | ok | ok |
| `/people/matches` | ok | ok |
| `/research-faculty` | ok | ok |
| `/requests` | ok | ok |
| `/budget` | caps, dash-cell | caps |
| `/calculator` | tap | ok |
| `/policy` | dash, tap | ok |
| `/settings` | ok | ok |
| `/reference` | slow | slow |
| `/imports` | ok | ok |
| `/batches` | ok | ok |
| `/track` | caps | ok |
| `/admin` | ok | ok |
| `/reports/all` | ok | ok |
| `/u` | ok | ok |
| `/network` | ok | ok |
| `/goals` | slow | slow |
| `/programme` | ok | ok |
| `/impact` | ok | ok |
| `/review/834d1f03219a41b8b4b7c15509ff28a7?queue=clearing` | caps, dash, tap | ok |
| `/review/c3b015fdcbd64334b696607247a86aca?queue=clearing` | caps, dash, tap | ok |
| `/people/86928106c7fe47de846ee94acad173c2` | tap | ok |
| `/u/5a533ef688564e58a6c683cb4da1510b` | tap | ok |
| `/faculty/38578c1995e84685b8b9c48ff625cd66` | caps | caps |
| `/papers/fdf0205af5034017ab10eef5f9434d0d` | dash, tap | ok |
| `/papers/a708a7a8f38a4f25940de66dbdf6299e` | dash, tap | ok |
| `/reports/departments/TRAINING?year=2025` | ok | ok |
| `/journals/Lecture%20Notes%20in%20Networks%20and%20Systems` | dash-cell, faces, tap | ok |
| `/clearing?assigned=me` | ok | ok |
| `/coordination?tab=research` | ok | ok |
| `/coordination?tab=report` | ok | ok |
| `/track?stage=submitted` | caps, contrast-light | ok |
| `/track?stage=checked` | contrast-light | ok |
| `/track?stage=approved` | contrast-light | ok |
| `/track?stage=authorised` | contrast-light | ok |
| `/track?stage=paid` | caps, contrast-light | ok |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/coordination?scope=unassigned#assign` | caps | ok |
| `/coordination?scope=breach#assign` | caps | ok |
| `/papers/new?method=doi` | ok | ok |
| `/papers?year=2026` | ok | ok |
| `/faculty?missing=photo` | slow | ok |
| `/faculty?missing=scopus` | ok | ok |
| `/faculty?nopapers=1` | ok | ok |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-01%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-03%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-07%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-08%22%2C%22filters%...` | caps, dash, faces | caps |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | ok |

#### SUPER_ADMIN

| Route | Before | After |
|---|---|---|
| `/` | slow, tap | slow |
| `/search` | ok | ok |
| `/clearing` | caps, dash-cell, tap | ok |
| `/coordination` | caps, tap | ok |
| `/research` | ok | ok |
| `/discover` | slow | ok |
| `/scout` | ok | ok |
| `/collaborate` | ok | ok |
| `/messages` | ok | ok |
| `/discussions` | caps | ok |
| `/leaderboard` | caps | caps |
| `/calendar` | ok | ok |
| `/faculty` | caps, tap | caps |
| `/wall` | caps | ok |
| `/me` | tap | tap |
| `/u/me/stats` | ok | ok |
| `/notifications` | ok | ok |
| `/settings/notifications` | tap | tap |
| `/messages/office` | ok | ok |
| `/help` | ok | ok |
| `/privacy` | ok | ok |
| `/publications` | dash-cell | ok |
| `/reports` | slow, caps, dash, faces, tap | caps |
| `/reports/brief` | caps | caps |
| `/reports/departments` | caps | caps |
| `/reports/papers` | caps | caps |
| `/reports/build` | caps, tap | caps |
| `/journals` | caps, dash-cell, empty | empty |
| `/accreditation` | caps | caps |
| `/ledger` | caps | caps |
| `/statements` | ok | ok |
| `/duplicates` | caps | ok |
| `/flags` | dash, tap | dash |
| `/archive` | ok | ok |
| `/faults` | ok | ok |
| `/data/fixes` | ok | ok |
| `/jobs` | ok | ok |
| `/audit` | dash | dash |
| `/people` | ok | ok |
| `/people/passwords` | tap | ok |
| `/people/matches` | ok | slow |
| `/research-faculty` | ok | ok |
| `/requests` | ok | ok |
| `/budget` | caps, dash-cell | caps |
| `/calculator` | tap | ok |
| `/policy` | dash, tap | ok |
| `/settings` | ok | ok |
| `/reference` | ok | slow |
| `/imports` | ok | ok |
| `/batches` | ok | ok |
| `/data` | ok | ok |
| `/data/health` | ok | ok |
| `/data/record` | slow, caps | slow, caps |
| `/track` | caps | ok |
| `/admin` | ok | ok |
| `/reports/all` | ok | ok |
| `/papers/new` | tap | tap |
| `/u` | ok | ok |
| `/network` | ok | ok |
| `/goals` | ok | ok |
| `/programme` | ok | ok |
| `/impact` | ok | ok |
| `/review/834d1f03219a41b8b4b7c15509ff28a7` | caps, dash, tap | ok |
| `/review/c3b015fdcbd64334b696607247a86aca` | caps, dash, tap | ok |
| `/people/86928106c7fe47de846ee94acad173c2` | tap | ok |
| `/u/39f0a90b938c43e7b526bb25fcaa8e96` | tap | ok |
| `/faculty/38578c1995e84685b8b9c48ff625cd66` | caps | caps |
| `/papers/fdf0205af5034017ab10eef5f9434d0d` | dash, tap | ok |
| `/papers/a708a7a8f38a4f25940de66dbdf6299e` | dash, tap | ok |
| `/reports/departments/TRAINING?year=2025` | ok | ok |
| `/journals/Lecture%20Notes%20in%20Networks%20and%20Systems` | dash-cell, faces, tap | ok |
| `/track?stage=submitted` | caps, contrast-light | ok |
| `/track?stage=checked` | contrast-light | ok |
| `/track?stage=approved` | contrast-light | ok |
| `/track?stage=authorised` | contrast-light | ok |
| `/track?stage=paid` | caps, contrast-light | ok |
| `/search?scope=people` | ok | ok |
| `/search?scope=departments&q=eng` | ok | ok |
| `/coordination?scope=unassigned#assign` | caps | ok |
| `/coordination?scope=breach#assign` | caps | ok |
| `/papers?year=2026` | ok | ok |
| `/faculty?missing=photo` | slow | ok |
| `/faculty?missing=scopus` | ok | ok |
| `/faculty?nopapers=1` | ok | ok |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-01%22%2C%22filters%...` | slow, caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-02%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-03%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-04%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-05%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-06%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-07%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-08%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-09%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-10%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-11%22%2C%22filters%...` | caps, dash, faces | caps |
| `/reports?sheet=%7B%22label%22%3A%22Paid+in+2024-12%22%2C%22filters%...` | caps, dash, faces | caps |
| `/discussions/f3b6006add094bc1b743eb4e7b310c8c` | calls, error-state | calls, error-state |
| `/review/fdf0205af5034017ab10eef5f9434d0d` | not visited | ok |
