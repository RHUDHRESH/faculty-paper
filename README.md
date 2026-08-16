# Faculty Publication Ticket ERP

Vite React SPA + Django Ninja API + Postgres.

## Portals

| Portal | Role | URL |
|--------|------|-----|
| Faculty | FACULTY | `/faculty` |
| Principal (oversight) | PRINCIPAL | `/principal` |
| Finance | FINANCE | `/finance` |
| Admin / research cell | SUPER_ADMIN | `/admin` |

**Workflow:** Faculty submit (auto-verify) → research cell clears (amount re-verified
and confirmed) → Finance marks paid. High-value claims need a second, distinct approver.
On verify mismatch: **Edit & retry** or **Contest & forward** with a note, or the research
cell enters manually verified values.

## Local run

```bash
# Postgres (docker, optional — SQLite is the default local fallback)
docker compose up -d db

# Backend
cp .env.example .env   # set SCOPUS_API_KEY, DJANGO_* 
./.venv/Scripts/python backend/manage.py migrate
./.venv/Scripts/python backend/manage.py seed
./.venv/Scripts/python backend/manage.py runserver 8000

# Frontend
cd frontend && npm install && npm run dev
```

Open http://localhost:5173

### Import ERP Excel masters

```bash
./.venv/Scripts/python backend/manage.py import_erp_excel \
  "/path/to/Publication_Processing_ERP_V3.0_FIXED.xlsx"
```

Use `--skip-sjr` / `--skip-snip` / `--limit 100` for faster trials.

## Seed logins

| Email | Password | Portal |
|-------|----------|--------|
| faculty@college.edu | faculty123 | Faculty |
| hod@college.edu | hod123 | HoD |
| principal@college.edu | principal123 | Principal |
| finance@college.edu | finance123 | Finance |
| admin@college.edu | admin123 | Admin |
| research@college.edu | research123 | Admin (imports) |

## Deploy

See [DEPLOY.md](DEPLOY.md): **Vercel** (SPA) + **Google Cloud Run** (Django API)
+ **Neon** (Postgres) + **Cloud Storage** (uploads).

## Tests

```bash
cd backend && ../.venv/Scripts/python manage.py test core
```
