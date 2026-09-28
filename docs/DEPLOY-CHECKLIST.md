# Deploy checklist: 15ec5d3 (production) to complete-frontend2 HEAD

Render free plan: `faculty-paper` (static SPA), `faculty-paper-api` (Docker,
512 MB), `faculty-paper-db` (free Postgres). `autoDeploy` is off on both
services, so nothing ships until you click it.

## What was checked before this deploy (2026-09-29)

| Check | Result |
|---|---|
| `migrate` on a copy of production data (`real.sqlite3`), first to 0061 (the production state), then to HEAD | 7 migrations, all OK, 2.7 s. No constraint skipped, no emails lowered, no extra active formula. |
| Re-run `migrate` | "No migrations to apply". |
| Roll back to 0061 and migrate again (data steps run twice) | OK; the schedule rows are not duplicated (8 schedules). |
| Postgres review of 0062-0065 | See "Postgres notes". Not executed on Postgres (no local Postgres/Docker was running). |
| `manage.py test core --parallel 2` | 2263 tests OK (1909 s), plus 2 new guard tests OK |
| vitest `--maxWorkers=2` | 67 files, 472 tests passed |
| `npm run build` | passed, 141 s locally |
| e2e money-chain + desk-rules | passed |
| e2e full-year | 26/26 passed on its own on a fresh database. When it runs *after* money-chain in the same database, its "clear 4 tickets" step sees their leftover tickets: the specs are not isolated from each other. This is a test problem, not an app problem. |

### Postgres notes (from reading the migrations)

- 0062 adds `UniqueConstraint(Lower("email"))`, a partial unique index on
  `staff_id`, CHECK constraints, and `one_active_formula` (partial unique).
  All work on Postgres. Each one is added only when no row breaks it. If a
  row does break it, the migration prints `0062: SKIPPED constraint ...`.
  **Read the deploy log for that line.**
- 0062 also creates `pg_trgm` and four GIN indexes inside a savepoint. If the
  extension cannot be created, it prints `trigram indexes skipped` and carries
  on. On Render the database owner can create `pg_trgm` (it is a trusted
  extension).
- The data steps (formula deactivate, email lowercase, placeholder venues)
  only use the ORM, with no SQLite-only SQL. The new raw SQL (the data-health
  dangling-FK check) quotes names with `connection.ops.quote_name` and is
  portable.
- 0063 adds two django-q schedules only when they are not already there, so it is idempotent.

## Settings for production (already in render.yaml)

- `DJANGO_DEBUG=false`. Settings refuse to start without a real
  `DJANGO_SECRET_KEY` and `DATABASE_URL`.
- `DJANGO_ALLOWED_HOSTS=.onrender.com` covers `faculty-paper-api-4iso.onrender.com`.
  `CSRF_TRUSTED_ORIGINS=https://faculty-paper.onrender.com` is the origin the browser uses.
- `DJANGO_MEDIA_STORAGE=db`: evidence PDFs **and profile photos**
  (`avatars/...`, served by `default_storage`) and college-site headers are
  kept in Postgres, not on the container's ephemeral disk. They survive a redeploy.
  Only the temporary ERP workbook upload goes to local disk, and it is used
  in the same container run.
- Test helpers cannot run on the live site. `e2e_session`, `e2e_year`, and
  `seed_demo_faculty`/`finance`/`hod` raise an error when DEBUG is off.
  `E2E_UPSTREAM_FIXTURES` is ignored when DEBUG is off. All of this is
  covered by `core/test_production_guards.py`. `seed`/`seed_demo` also refuse
  unless `--force` or `ALLOW_DEMO_SEED` is given. **Never set `ALLOW_DEMO_SEED`.**
- Memory: gunicorn runs 1 worker with 8 threads. qcluster runs 1 worker,
  recycles, and has `max_rss` 180 MB. It starts 30 s after gunicorn. The app
  loaded with real data measured about 80 MB RSS locally. The weekly stored
  backup streams gzip and is capped, and keeps the newest 4. The SDK
  (`anthropic`) is imported lazily. The SPA build runs on the static-site
  builder, not the 512 MB instance.

## 1. Before you click deploy

1. Take a backup: sign in as admin, go to Data health, then Backup, and
   download it. Or run `pg_dump` with the External Database URL.
2. Write down the commit that is live now (`15ec5d3`). This is your rollback target.
3. Merge `complete-frontend2` to the branch Render deploys, then push it.
4. In the Render dashboard, go to Blueprint and **Sync** (render.yaml added
   new `sync: false` keys). Then set these on **faculty-paper-api**, under Environment:

| Variable | Value | Needed for |
|---|---|---|
| `AI_PROVIDER` | `anthropic` | AI panels (unset means the counted fallback) |
| `ANTHROPIC_API_KEY` | your key | AI panels |
| `AI_MODEL` | `claude-haiku-4-5` | AI panels |
| `AI_FAST_MODEL` | optional; unset uses `AI_MODEL` | thread assistant |
| `SCOPUS_API_KEY` | Elsevier key | Scopus sync, verify, enrich |
| `OPENALEX_API_KEY` | optional | higher OpenAlex budget for harvest |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_HOST_USER` / `EMAIL_HOST_PASSWORD` / `EMAIL_USE_TLS` / `DEFAULT_FROM_EMAIL` | e.g. Brevo `smtp-relay.brevo.com`, `2525`, TLS true | alert email (free plan blocks 25/465/587) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | optional | payment WhatsApp |

Leave `AI_BASE_URL`/`AI_API_KEY` empty when using Anthropic. Do **not**
set `DJANGO_DEBUG`, `ALLOW_DEMO_SEED`, or `E2E_UPSTREAM_FIXTURES`.

## 2. Deploy

1. Deploy **faculty-paper-api** first ("Manual Deploy", then "Deploy latest
   commit"). `scripts/start.sh` runs `migrate` on boot.
2. In the API logs, confirm the `Applying core.0062_integrity_constraints ... core.0065_journal_watch`
   lines are all OK, and check whether any `0062: SKIPPED` or `trigram indexes skipped` line appears.
3. Open `https://faculty-paper-api-4iso.onrender.com/api/health`. It should return 200.
4. Deploy **faculty-paper** (the static site).

## 3. Post-deploy jobs (Render Shell on faculty-paper-api, one at a time)

```bash
python manage.py sync_scopus_authors            # needs SCOPUS_API_KEY; --limit N to test first
python manage.py harvest_publications           # OpenAlex; --limit 50 first on the free CPU
python manage.py import_college_site <zip-or-folder>   # photos/bios; --dry-run first
```

`import_college_site` needs the scrape on the server. It is easier to use
the admin page instead: College site, then upload the zip
(`POST /api/admin/college-site/import`). The photos go into the database store.

**Seed nothing.** Do not run `seed`, `seed_demo*`, `e2e_*`, or `walkthrough`.

## 4. Verify on the live site, per role

- **Admin/super admin**: sign in. Data health shows no `dangling_fk` errors,
  and the constraints list shows nothing skipped. The AI status says Anthropic
  is connected. Schedules include `integrity-audit-nightly` and `backup-weekly`.
- **Faculty**: file a claim by DOI (lookup fills the fields). Upload a PDF,
  then reload it after about 20 min idle. Upload a profile photo, then
  redeploy and check the photo is still there.
- **Research cell**: the clearing queue loads. Watched journals are flagged.
  One bulk clear works.
- **HOD**: the department dashboard and the CSV export work.
- **Finance**: the payout run page and the ledger totals match what the
  pre-deploy backup shows.
- On a phone (390 px): sign in, the dashboard, and a claim sheet.

## 5. Rollback

1. On faculty-paper-api, go to Events, pick the `15ec5d3` deploy, and choose
   **Rollback**. Do the same for faculty-paper.
2. Leave the schema alone. The old code ignores the new columns and tables,
   **except for `core_impactshare`**, which `0062_scopus_sync_drop_impact`
   drops. After a rollback, the old `/api/rewards` impact-share endpoints
   (public "share my impact" links) return 500. Everything else works. Any
   existing share links are lost for good. Before deploying, run
   `SELECT count(*) FROM core_impactshare;` in the Render psql shell. If the
   count is non-zero, tell those faculty their share link will stop. (The
   Sep-23 data copy predates the table, so it could not be checked here.)
3. Do **not** run `migrate core 0061` against production unless it is needed.
   Reversing 0062 drops constraints and indexes, which is safe, but it does
   not un-lowercase emails.
4. Last resort: restore the step 1.1 backup (Imports, then "Restore a full export").
