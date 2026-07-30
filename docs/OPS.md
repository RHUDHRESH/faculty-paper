# Production ops — Faculty Paper Remuneration

Single-college deployment: **Vercel** (frontend) + **Render** (Django API) + **Neon** (Postgres).

## URLs
- App: `https://faculty-paper.vercel.app`
- API: `https://faculty-paper-api.onrender.com`
- Health: `GET /api/health`

## Required env (Render)
| Variable | Notes |
|----------|--------|
| `DJANGO_SECRET_KEY` | Strong secret; refused if weak when `DJANGO_DEBUG=false` |
| `DJANGO_DEBUG` | `false` |
| `DATABASE_URL` | Neon Postgres URL (`sslmode=require`) |
| `CORS_ALLOWED_ORIGINS` | `https://faculty-paper.vercel.app` |
| `CSRF_TRUSTED_ORIGINS` | Same as CORS |
| `CROSS_SITE_COOKIES` | `true` (SameSite=None for Vercel ↔ Render) |
| `DJANGO_ALLOWED_HOSTS` | `.onrender.com` (and custom domain if any) |
| `SCOPUS_API_KEY` | Optional; enrich/verify degrade gracefully |

## Optional email
Set `EMAIL_NOTIFICATIONS=true` plus SMTP (`EMAIL_HOST`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `DEFAULT_FROM_EMAIL`). Off by default; in-app notifications always work.

## Frontend (Vercel)
| Variable | Notes |
|----------|--------|
| `VITE_API_BASE` | `https://faculty-paper-api.onrender.com` |

Demo login shortcuts are **dev-only** (`import.meta.env.DEV`).

## Migrations & seed
```bash
python manage.py migrate
python manage.py seed --force   # prod only with --force; change passwords after
```

## Cold starts
Free Render may sleep; first request can take 30–60s. Hit `/api/health` after deploy.

## Smoke checklist
1. Faculty login → new ticket stepped form → submit → ticket number
2. HoD approve → Principal approve → Finance mark paid
3. Faculty sees “Payment cleared”
4. Admin Formula preview calculator returns an amount
5. CORS: browser Network tab shows `access-control-allow-origin` for Vercel
