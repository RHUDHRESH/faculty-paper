# Faculty Publication Ticket ERP

Vite React SPA + Django Ninja API + Postgres.

## Portals

| Portal | Role | URL |
|--------|------|-----|
| Faculty | FACULTY | `/faculty` |
| HoD | HOD | `/hod` |
| Principal | PRINCIPAL | `/principal` |
| Finance | FINANCE | `/finance` |
| Admin | SUPER_ADMIN / RESEARCH_CELL | `/admin` |

**Workflow:** Faculty submit (auto-verify) → HoD → Principal → Finance mark paid.  
On verify mismatch: **Edit & retry** or **Contest & forward** to HoD with a note.

## Local run

```bash
# Postgres (docker)
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

See [DEPLOY.md](DEPLOY.md): **Vercel** (frontend) + **Render** (Django + Postgres).

## Tests

```bash
cd backend && ../.venv/Scripts/python manage.py test core
```
