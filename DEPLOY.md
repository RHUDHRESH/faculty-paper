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

## ERP Excel → SQL

```bash
# Local (SQLite): set DJANGO_USE_SQLITE=true
python manage.py import_erp_excel ../data/Publication_Processing_ERP_V3.0.xlsx
python manage.py sync_faculty_users

# Faster first bring-up (masters + claims, skip huge SJR/SNIP):
python manage.py import_erp_excel ../data/workbook.xlsx --skip-sjr --skip-snip
```

In production without a shell: `POST /api/admin/erp-import` (session auth,
SUPER_ADMIN) takes the `.xlsx` upload and runs it as a background job; poll
`GET /api/admin/jobs/{job_id}` and check counts with `GET /api/admin/erp-stats`.

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
