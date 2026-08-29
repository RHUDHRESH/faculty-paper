# Faculty Publication Ticket ERP

Vite React SPA + Django Ninja API + Postgres. The app is `frontend2/`; the
production proxy lives in `frontend2/vercel.json`.

## Portals

| Portal | Role | URL |
|--------|------|-----|
| Faculty | FACULTY | `/papers` |
| Head of department | HOD | `/department` (money-blind server-side) |
| Principal (approves the spend) | PRINCIPAL | `/approvals` |
| Director (authorises it) | DIRECTOR | `/authorisations` |
| Finance (pays) | FINANCE | `/payments` |
| Admin / research cell | SUPER_ADMIN | `/clearing` |

**Workflow:** Filed → Checked (research cell) → Approved (Principal) →
Authorised (Director) → Paid (Finance). Finance cannot see a ticket the
Director has not authorised. High-value claims need a second, distinct
approver. On verify mismatch: **Edit & retry** or **Contest & forward**.

## Install it at a college

One Docker command and a three-step wizard — see [docs/PRODUCT.md](docs/PRODUCT.md).
Upgrades: [docs/UPGRADE.md](docs/UPGRADE.md). Saveetha's production
deployment runs on Vercel + Cloud Run ([docs/OPS.md](docs/OPS.md)).

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
cd frontend2 && npm install && npm run dev    # port 5174, proxies /api
```

Open http://localhost:5174

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
