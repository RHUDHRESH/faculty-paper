# Deploy checklist — Vercel + Render

Red-team pass is in place (auth field stripping, SNIP caps, atomic pay, seed guard).
Do **not** ship demo passwords to real faculty without changing them.

## A. Push to GitHub (required for Render Blueprint)

```bash
cd Faculty_paper
git status   # review — never commit .env / secrets
git add -A
git commit -m "Faculty publication ticket ERP ready for deploy"
# create empty GitHub repo, then:
git remote add origin https://github.com/YOUR_USER/faculty-paper.git
git push -u origin master
```

## B. Backend on Render

1. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint** → select the repo (`render.yaml`),  
   **or** **Web Service** with:
   - Root Directory: `backend`
   - Build: `pip install -r requirements.txt && python manage.py collectstatic --noinput`
   - Pre-deploy: `python manage.py migrate --noinput`
   - Start: `gunicorn config.wsgi:application --bind 0.0.0.0:$PORT --workers 2`
2. Attach **Postgres** (`DATABASE_URL`).
3. Environment:

| Key | Value |
|-----|--------|
| `DJANGO_SECRET_KEY` | long random (Render can generate) |
| `DJANGO_DEBUG` | `false` |
| `CROSS_SITE_COOKIES` | `true` |
| `CORS_ALLOWED_ORIGINS` | `https://YOUR-APP.vercel.app` |
| `CSRF_TRUSTED_ORIGINS` | `https://YOUR-APP.vercel.app` |
| `SCOPUS_API_KEY` | your Elsevier key |
| `DJANGO_ALLOWED_HOSTS` | `.onrender.com` |

4. After first deploy (Shell):

```bash
# Demo accounts (CHANGE PASSWORDS after):
python manage.py seed --force
# optional masters:
# python manage.py import_erp_excel /path/workbook.xlsx --skip-sjr --skip-snip
```

Copy the service URL, e.g. `https://faculty-paper-api.onrender.com`.

## C. Frontend on Vercel

```bash
cd frontend
vercel login          # browser OAuth once
vercel link           # Root Directory: frontend
```

Vercel → Project → Settings → Environment Variables:

| Key | Value |
|-----|--------|
| `VITE_API_BASE` | `https://faculty-paper-api.onrender.com` (no trailing slash) |

```bash
vercel --prod
```

Or dashboard: Import repo → Root `frontend` → Framework Vite → Output `dist`.

## D. Wire CORS both ways

Set Render `CORS_*` / `CSRF_*` to the final Vercel domain and redeploy API. Redeploy Vercel after any `VITE_API_BASE` change (build-time).

## Security notes (red team)

- Client cannot set `scimago_verified`, `override_duplicate`, or spoof `staff_id`
- SNIP capped (max 30); pay is formula-calculated server-side
- Mark-paid is atomic (no double ledger)
- Seed blocked when `DJANGO_DEBUG=false` unless `--force`
- Weak `DJANGO_SECRET_KEY` refused in production
- **Change all demo passwords** before real users; force `must_change_password` if needed
- Contested tickets still need HoD eyes — “send anyway” is intentional, not a silent bypass of approval
- **PDF uploads** on free Render disk are ephemeral (lost on redeploy). Historical Excel proofs are stored as URL strings (`proof_url`). Add S3/R2 later for durable new uploads.

## ERP Excel → SQL

```bash
# Local (SQLite): set DJANGO_USE_SQLITE=true
python manage.py import_erp_excel ../data/Publication_Processing_ERP_V3.0.xlsx
python manage.py sync_faculty_users

# Faster first bring-up (masters + claims, skip huge SJR/SNIP):
python manage.py import_erp_excel ../data/Publication_Processing_ERP_V3.0.xlsx --skip-sjr --skip-snip
# Then full journal dumps in a Shell session when ready (no --skip-*).
```

### Prod without Shell
`POST /api/admin/erp-import` (session auth, SUPER_ADMIN / RESEARCH_CELL) accepts the `.xlsx` multipart upload.
Defaults: `skip_sjr=true`, `skip_snip=true`, `sync_users=true`. Check counts via `GET /api/admin/erp-stats`.

## Smoke after deploy

1. Open Vercel URL → login (then change password)
2. Faculty: New ticket → ticket number + amount
3. Admin clearing queue: Clear (confirm the recalculated amount) → Finance **Yes**
4. Faculty sees the payment-processed message; Finance ledger has the row
