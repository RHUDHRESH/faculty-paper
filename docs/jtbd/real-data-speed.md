# Backend speed on the real record

Measured 2026-09-29 on a copy of `data/local-full.sqlite3` (17,375 publications,
69,612 authorships, 3,043 ledger rows, 412 people), migrated. Production is the
Render free tier (0.1 CPU, 512 MB), so every figure below is roughly 5-10x
slower there.

## Method

- One in-process Django test client per role (FACULTY, HOD, PRINCIPAL, DIRECTOR,
  FINANCE, RESEARCH_CELL, RESEARCH_COORDINATOR, SUPER_ADMIN from
  `manage.py e2e_session`, plus the real faculty account
  joyalisac@saveetha.ac.in), DEBUG on, queries counted with
  `CaptureQueriesContext`.
- Every GET route in the OpenAPI schema without a path parameter (127 routes;
  streams, feeds and `export` downloads skipped), 3 calls each, p50 time and
  max query count recorded. 401/403/405 answers dropped. 829 role x route rows.
- The machine was shared with six other builders, so times are noisy
  (+/- 30-50%). Query counts are exact.
- p50 of 3 calls hides the first call when a figure is cached, so the
  report endpoints were also measured **cold** (cache cleared) and **warm**.

## Before / after, the slowest routes (p50 of 3, worst role)

| Endpoint | Worst role | Before p50 | Before queries | After p50 | After queries |
|---|---|---:|---:|---:|---:|
| `/api/reports/pack` (xlsx download) | RESEARCH_CELL | 15011 ms | 24 | 6428 ms | 25 |
| `/api/reports/pack/rows` | RESEARCH_CELL | 3266 ms | 8 | 663 ms | 9 |
| `/api/reports/build` | RESEARCH_CELL | 2739 ms | 10 | 183 ms | 5 |
| `/api/admin/author-matches` | RESEARCH_COORDINATOR | 1019 ms | 5 | 297 ms | 9 |
| `/api/admin/attention` | SUPER_ADMIN | 665 ms | 29 | 175 ms | 31 |
| `/api/wall` | FINANCE | 663 ms | 9 | 198 ms | 10 |
| `/api/me/summary` | REAL_FACULTY | 530 ms | 19 | 364 ms | 19 |
| `/api/me/scopus-pull` | SUPER_ADMIN | 517 ms | 8 | 290 ms | 8 |
| `/api/admin/ledger` | SUPER_ADMIN | 512 ms | 13 | 383 ms | 13 |
| `/api/college/research` | SUPER_ADMIN | 498 ms | 9 | 232 ms | 13 |
| `/api/reports/search` | RESEARCH_COORDINATOR | 283 ms | **102** | 187 ms | 8 |
| `/api/claims` | RESEARCH_COORDINATOR | 176 ms | **55** | 99 ms | 6 |
| `/api/admin/clearing-queue` | SUPER_ADMIN | 126 ms | **47** | 218 ms (loaded box) | 7 |

`/api/reports` and `/api/reports/brief` show 10-20 ms p50 in both runs because
the second and third calls hit the cache; their real cost is the cold call:

## Report pages, cold vs warm (SUPER_ADMIN)

| Endpoint | Before cold | Before warm | After cold | After warm |
|---|---:|---:|---:|---:|
| `/api/reports` | 2260 ms / 40 q | 4 ms | 787-1008 ms / 44 q | 26 ms |
| `/api/reports/brief` | 1194 ms / 12 q | 5 ms | 1159-1529 ms / 16 q | 44 ms |
| `/api/reports/build` | 925 ms | 1191 ms (never cached) | 723-1019 ms | 96-122 ms |
| `/api/reports/pack/rows` | 1310 ms | 1392 ms (never cached) | 511-685 ms | 115 ms |
| `/api/college/research` | 1463 ms | 133 ms | 980-1192 ms | 83-132 ms |

Before, "warm" lasted 30 s (`AGGREGATE_CACHE_SECONDS`), so on a quiet
production site almost every visit was a cold one. After, the report figures
are kept for 10 minutes per data version (below), so a cold call happens once
per change, not once per visitor. Uncontended, the cold core is
`college_totals._papers` 443 ms and `records._collect` 101 ms.

## What was wrong and what changed

1. **Journal watch-list read once per claim row** (`journal_watch.watch_for`
   from `claim_to_dict`): 95 of `/reports/search`'s 101 queries, 50 of
   `/claims`'. Now one prepared list per data generation.
2. **Clearing queue: 3-4 queries per ticket** (`record_authorship`). New
   `deps.record_authorships(claims)` does the whole queue in three queries.
3. **`/reports/pack/rows` built 5,000 full `Publication` + `User` objects**
   per page (`reporting_pack.record_only_publications`). Now `.values()` of
   the seven columns used, and the unsearched list is cached (a search term is
   not cached, so typed terms cannot fill the 512 MB process).
4. **College-wide figures recomputed per request / every 30 s**:
   `college_totals.papers` / `payments`, `records.collect()` (everybody),
   `author_review` name groups, `/reports`, `/reports/brief`. New
   `aggregate_cache.shared()`: key = write generation + `data_version()` (one
   query of row counts / newest changes over publication, authorship,
   ledger, claim, user), kept 10 minutes (`SHARED_AGGREGATE_SECONDS`). The data
   version is what notices the job worker's writes, which the 30 s expiry was
   standing in for. `papers()` keeps one unfiltered copy and filters year /
   department in Python, so every filter shares it.
5. **xlsx export built two `Alignment` objects per cell**; now shared. The
   17k-row accreditation workbook is still 3-6 s here, i.e. tens of seconds on
   Render.

## Memory

- `research_picture.shared_college` holds every college paper in process
  memory (~13k dicts): pre-existing, deliberate, rebuilt per signature.
- The new shared entries are the college paper list (~13k small dicts), the
  paper records (~3k), the name groups (~5k) and the unsearched pack rows
  (<=5k per year). All are one copy per data version, not per filter or user.
- Nothing else loads all publications per request.

## Tests

`backend/core/test_real_data_speed.py` (11 tests): query counts that must not
grow with rows for `/claims`, `/reports/search`, `/reports/pack/rows`,
`/admin/clearing-queue`; cached figures rebuilt after an in-process write and
after a write the generation did not see (data version); filters share one
computation.

## Not done / open

- `/api/reports/pack` xlsx is still multi-second (openpyxl per-cell styling
  over ~17k rows). Options: `write_only` workbook, or build it as a job.
- Any write request anywhere bumps the generation, so the first report visit
  after any write is cold (~0.5-1 s here). Dropping the generation from
  `shared()` keys would need `data_version()` to cover every `.update()` path.
- `/api/hod/report` (20 q, 425-705 ms) and `/api/discover/for-you` were not
  touched.
- `core.tests.MoneyBlindnessSweepTests` fails on `origin/complete-frontend2`
  itself (`/api/me/publications -> amount`), independent of this branch.
