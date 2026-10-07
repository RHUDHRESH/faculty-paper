# Deploy — Google Cloud Run (API) + Vercel (SPA)

One backend service on Cloud Run, one static site on Vercel, Postgres wherever
`DATABASE_URL` points, uploads in a Cloud Storage bucket.

Do **not** ship demo passwords to real faculty without changing them.

## Architecture

The SPA never calls Cloud Run directly. `frontend2/vercel.json` rewrites
`/api/*` and `/media/*` to the Cloud Run service, so the browser only ever
talks to the Vercel origin: cookies stay first-party and there is no CORS or
cross-site-cookie configuration to get wrong.

```
browser ──▶ faculty-paper…vercel.app ──▶ faculty-paper-api…run.app ──▶ Postgres
             (static SPA + /api proxy)      (Django + django-q worker)   + GCS bucket
```

## A. One-time Google Cloud setup

```bash
gcloud auth login                       # browser sign-in
gcloud config set project YOUR_PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com storage.googleapis.com
```

Billing must be enabled on the project — Cloud Run's free tier still requires
a billing account attached.

### Bucket for uploaded evidence

```bash
gcloud storage buckets create gs://YOUR_BUCKET --location=asia-south1 \
    --uniform-bucket-level-access
```

Keep it **private**. Proof PDFs are streamed through Django's authenticated
`/media/` view, which enforces per-claim access; a public bucket would hand
them to anyone with the URL.

## B. Deploy the API

```bash
gcloud run deploy faculty-paper-api \
  --source backend \
  --region asia-south1 \
  --allow-unauthenticated \
  --min-instances 1 --no-cpu-throttling \
  --memory 512Mi --timeout 120 \
  --set-env-vars "DJANGO_DEBUG=false,DJANGO_ALLOWED_HOSTS=.run.app,GS_BUCKET_NAME=YOUR_BUCKET" \
  --set-secrets "DJANGO_SECRET_KEY=django-secret:latest,DATABASE_URL=database-url:latest,SCOPUS_API_KEY=scopus-key:latest"
```

- `--min-instances 1 --no-cpu-throttling` keeps the django-q worker alive
  between requests; without it background jobs only run while a request is in
  flight. Drop to `--min-instances 0` if you accept queued work waiting for
  the next request.
- The service account needs `roles/storage.objectAdmin` on the bucket.
- Migrations run on container start (`backend/scripts/start.sh`).

Secrets, created once:

```bash
printf '%s' "$(python -c 'import secrets;print(secrets.token_urlsafe(64))')" \
  | gcloud secrets create django-secret --data-file=-
printf '%s' 'postgresql://…' | gcloud secrets create database-url --data-file=-
printf '%s' 'YOUR_ELSEVIER_KEY' | gcloud secrets create scopus-key --data-file=-
```

Then seed once (demo accounts — **change the passwords**):

```bash
gcloud run jobs create seed --image ... # or POST /api/admin/erp-import for masters
```

## C. Frontend on Vercel

The SPA is `frontend2/`. `frontend2/vercel.json` holds the API address, so
there is no build-time env var to forget. Its rewrites point at the Cloud Run
URL; the Vercel project's **Root Directory** setting decides which app builds
— `frontend/` for the old one, `frontend2/` for the rebuilt one. The cutover
is that one setting plus a push; the old app stays in the repo until the new
one has served production for a while.

Local check of the same flow:

```bash
cd frontend2
vercel deploy --prod
```

Leave `VITE_API_BASE` **unset** — an empty base means same-origin `/api`,
which is what the rewrites handle.

## D. Smoke after deploy

1. `GET /api/health` → `{"ok":true,"media_persistent":true}`
2. Open the Vercel URL → sign in (then change the password)
3. Faculty: New ticket → ticket number + amount
4. Admin clearing queue: Clear (confirm the recalculated amount) → Finance **Yes**
5. Faculty sees the payment-processed message; Finance ledger has the row
6. Upload a PDF, redeploy, reopen it — it must still be there (bucket, not disk)

## E. AI suggestions on Render (free, hosted model)

Render's free instance (512 MB, 0.1 CPU) cannot run a model, so the AI features
use a hosted one over the OpenAI-compatible API. With none configured the site
still works: every AI panel shows its counted version (people to work with,
journals, topics, leaderboards) and one line saying AI suggestions are not set up.

In the Render dashboard open **faculty-paper-api → Environment**, add these
three variables, then **Save, rebuild and deploy**. (`render.yaml` declares them
with `sync: false`, but Render only prompts for those when a Blueprint is first
created, so on an existing service add them by hand.)

**Groq — recommended.** Free key at <https://console.groq.com/keys>, no card.
Groq does not keep request data by default.

```
AI_BASE_URL = https://api.groq.com/openai/v1
AI_API_KEY  = gsk_...your key...
AI_MODEL    = llama-3.3-70b-versatile
```

**Google Gemini.** Free key at <https://aistudio.google.com/apikey>. On the free
tier Google may use what is sent **to improve its products**, which here means
draft titles and abstracts. Use it only if that is acceptable, or on a paid key.

```
AI_BASE_URL = https://generativelanguage.googleapis.com/v1beta/openai
AI_API_KEY  = AIza...your key...
AI_MODEL    = gemini-3.5-flash
```

Model names checked against the providers' model lists on 2026-09-24. If a
provider retires one, the Discover page names the model it cannot find, and
the fix is a new `AI_MODEL`. Optional: `AI_FAST_MODEL` (e.g.
`llama-3.1-8b-instant`) for the discussion-thread assistant, and
`AI_TIMEOUT_SECONDS` (default 60).

How the provider is chosen: `AI_API_KEY` set → the hosted provider. Otherwise
`AI_PROVIDER` if set (`ollama`, `harness`, `none`), else Ollama when
`DJANGO_DEBUG=true` and nothing at all in production. Check it at
`GET /api/discover/status`: `"code": "ready"` with `"host": "api.groq.com"`.
The key never appears in that answer or in any error.

What leaves the college: with a hosted provider, a faculty member's paper
titles, abstract (venue search) and subject areas are sent to that service.
The Discover page says which service. Ollama and the harness keep them in
house.

## F. Alert email and WhatsApp (optional)

Every alert arrives in the app whatever is set here. Email is added when
`EMAIL_HOST` is set; each person then chooses, per kind of alert, "by email
too", "in the app" or "off" at **/settings/notifications**, and every email
carries a link that stops that kind. With `EMAIL_HOST` empty nothing tries to
connect and the settings page says email is not set up.

Add the variables in **faculty-paper-api → Environment** (declared in
`render.yaml` with `sync: false`, so an existing service needs them added by
hand), then **Save, rebuild and deploy**.

**Render's free plan blocks outbound ports 25, 465 and 587**
(<https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports>).
On the free plan use Brevo on port 2525. Gmail only offers 465 and 587, so it
works locally or on a paid Render instance, not on the free one.

**Brevo SMTP — recommended on the free plan.** Free account at
<https://www.brevo.com>, 300 emails a day. Under **SMTP & API → SMTP** generate
an *SMTP key* (not an API key), and under **Senders** add and verify the address
mail will come from.

```
EMAIL_HOST          = smtp-relay.brevo.com
EMAIL_PORT          = 2525
EMAIL_USE_TLS       = true
EMAIL_HOST_USER     = the SMTP login shown on that page (e.g. 8a1b2c@smtp-brevo.com)
EMAIL_HOST_PASSWORD = the SMTP key
DEFAULT_FROM_EMAIL  = Research Office <research-office@your-college.edu>
```

**Gmail with an app password** (local runs, or a paid instance). The Google
account needs 2-Step Verification on; then create an app password at
<https://myaccount.google.com/apppasswords> and use the 16 characters without
spaces. Gmail caps how much a personal account sends in a day, and mail goes
out from the account's own address.

```
EMAIL_HOST          = smtp.gmail.com
EMAIL_PORT          = 587
EMAIL_USE_TLS       = true
EMAIL_HOST_USER     = the.account@gmail.com
EMAIL_HOST_PASSWORD = the app password
DEFAULT_FROM_EMAIL  = Research Office <the.account@gmail.com>
```

Optional: `EMAIL_DAILY_CAP` (default 280, under Brevo's 300; 0 for no cap) --
past it, alerts that day are in the app only. `APP_BASE_URL` is where links in
emails point; it defaults to the first https origin in `CSRF_TRUSTED_ORIGINS`.
Check the setup by switching one kind to "by email too" and having it happen
(for example a paper sent back); a failed send is logged as `email_failed` and
never loses the in-app alert.

**WhatsApp (Meta Cloud API).** Off unless both `WHATSAPP_TOKEN` and
`WHATSAPP_PHONE_ID` are set; then it carries only payment news (approved, paid,
sent back, not accepted), only to people who switched it on in their settings
and have a phone number on their profile. Business-initiated messages must use
a template Meta has approved: create one named `paper_update` (or set
`WHATSAPP_TEMPLATE`) with two body variables, the headline and the detail.

**The scheduled jobs** are registered by migration 0051 and run in the job
worker that `scripts/start.sh` starts beside the API (times are India time):

| Schedule | When | What |
|---|---|---|
| `citation-check` | daily 03:30 | citation counts from OpenAlex for claimed DOIs; tells owners of new citations |
| `daily-nudges` | daily 09:00 | filing-deadline reminder to people with drafts (only once a filing cutoff day is set on the Policy page) and "one paper from your quota"; at most one nudge a person a week |
| `weekly-digest` | Monday 08:00 | the weekly summary; the same content is always on Notifications → This week |

A job due while the free instance slept runs once when it wakes.

## ERP Excel → SQL

```bash
# Local (SQLite): set DJANGO_USE_SQLITE=true and DJANGO_DEBUG=true
# (DEBUG is off unless DJANGO_DEBUG=true is set explicitly)
python manage.py import_erp_excel ../data/Publication_Processing_ERP_V3.0.xlsx
python manage.py sync_faculty_users

# Faster first bring-up (masters + claims, skip huge SJR/SNIP):
python manage.py import_erp_excel ../data/workbook.xlsx --skip-sjr --skip-snip
```

In production without a shell: `POST /api/admin/erp-import` (session auth,
SUPER_ADMIN) takes the `.xlsx` upload and runs it as a background job; poll
`GET /api/admin/jobs/{job_id}` and check counts with `GET /api/admin/erp-stats`.

## Backups and moving to a new Postgres (Render free expires ~23 Oct 2026)

The Render free Postgres is deleted about 30 days after creation. Everything
needed to move is in the app; no shell is required.

**Taking a backup.** Sign in as a super admin, open *Set up → Data health*
(`/data/health`), press **Make a backup now**, wait for it to appear in the
list (a few minutes on 0.1 CPU; it runs on the job queue), then **Download**.
The file is `manual-YYYYMMDD-HHMMSS-….json.gz`: every row of every table in
`manage.py dumpdata` format, except sessions, the django-q queue, content types
and permissions (recreated by `migrate`) and older stored backups. Uploaded
evidence stored in the database (`DJANGO_MEDIA_STORAGE=db`) is included.
Primary keys are kept, so links and ids survive.

A weekly backup is also made automatically (Sunday-ish, schedule
`backup-weekly`) and kept in the database's file store — the newest four, and
none bigger than 40 MB (a bigger one is skipped and logged as
`BACKUP_SKIPPED`). Those protect against a bad import or delete, **not**
against the database itself being deleted — download one and keep it
elsewhere. On the real data (Sept 2026) a backup is ~14 MB and ~157,000 rows.

API equivalents: `POST /api/admin/backups` → `{job_id}`; poll
`GET /api/admin/jobs/{job_id}`; `GET /api/admin/backups` lists;
`GET /api/admin/backups/download?name=backups/…` downloads.

**Restoring into Neon (or any Postgres).**

1. Create the Neon project; copy its connection string (with
   `?sslmode=require`).
2. On Render, set the API service's `DATABASE_URL` to it and redeploy. The
   start command runs `migrate`, which builds every table (and the scheduled
   jobs) in the empty database.
3. Open the site; first-run setup appears. Create the first super admin with
   an email address that is **not** in the backup (e.g.
   `restore@yourcollege.edu`) — a restore adds rows by primary key and would
   collide with an existing address.
4. Signed in as that account, upload the `.json.gz` to the restore endpoint
   (`POST /api/admin/restore`, form fields `file` and `confirm=RESTORE`; max
   90 MB). It refuses if the database already holds a claim. It runs on the
   job queue and is streamed, saved after every batch and resumable: watch the
   progress on *Set up -> Imports -> restore a full export*, or `GET /api/admin/restore/status`.
   After a restart upload the same file again (or press *Continue*) and it
   carries on. Accepts `.jsonl`, `.jsonl.gz`, `.json`, `.json.gz`. The default
   formula made by setup is stood down in favour of the backup's own. For a move
   between hosts use the portable export in `docs/ops/move-host.md`.
5. Sign in with a restored account (passwords are restored as they were), run
   *Data health → Run now*, and compare counts with the old site. Deactivate
   the temporary restore account.
6. The restore loads records, not files: photos and claim PDFs are still on the old machine.
   Add them from a zip of its `media` folders (*Admin -> Get the college running -> Photos and
   files*, or `POST /api/admin/media-import`, or `manage.py import_media`). How to make the
   zip is in `docs/ops/go-live.md`.

Local check of the same round trip (SQLite):

```bash
DJANGO_USE_SQLITE=1 DJANGO_SQLITE_PATH=/tmp/fresh.sqlite3 python manage.py migrate
DJANGO_USE_SQLITE=1 DJANGO_SQLITE_PATH=/tmp/fresh.sqlite3 python manage.py loaddata manual-….json.gz
```

## Data health and database constraints

`/data/health` (super admin) lists what in the data contradicts itself —
duplicate staff/biometric/Scopus ids, paid claims without a ledger row or with
a ledger total different from the remuneration, ledger rows matching no
person, publications sharing a DOI, dangling references, orphaned files, paper
counts that disagree between screens — with links to fix them. It runs nightly
(`integrity-audit-nightly`) and on demand; `manage.py integrity_audit` prints
the same report. Only unambiguous fixes are offered (normalise DOIs, trim
identifiers, delete notifications about deleted claims, recount discussion
posts), each written to the audit log.

Migration `0062_integrity_constraints` adds: case-insensitive unique email,
unique non-blank staff id, one active formula, non-negative formula amounts,
budgets and claim remuneration, and at least one author / author position ≥ 1.
It first deactivates extra active formulas (keeping the newest) and lowercases
emails where that collides with nobody; any constraint the data still violates
is **skipped with a printed warning** rather than failing the deploy — fix the
rows listed on Data health, then `migrate core 0061 && migrate` to add it.

## Security notes

- Payouts are computed only from server-verified SNIP/quartile; faculty
  declarations are stored separately and never priced
- Clearing and payment require the confirmed amount; high-value claims need a
  second, distinct approver
- Mark-paid is atomic and the ledger is append-only (voids write a reversal)
- Client cannot set `scimago_verified`, `override_duplicate`, or spoof `staff_id`
- Seed is blocked when `DJANGO_DEBUG=false` unless `--force`; a weak
  `DJANGO_SECRET_KEY` is refused in production
- Login throttles after repeated failures; an admin password reset unlocks
- **Change all demo passwords** before real users
