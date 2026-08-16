# Production ops — Faculty Paper Remuneration

Single-college deployment: **Vercel** (SPA) + **Google Cloud Run** (Django API)
+ **Neon** (Postgres) + **Cloud Storage** (uploaded evidence).

The SPA proxies `/api` and `/media` to Cloud Run via `frontend/vercel.json`,
so the browser only ever talks to the Vercel origin — cookies are first-party
and there is no CORS to maintain.

## URLs
- App: the Vercel production URL
- API: the Cloud Run service URL (`…run.app`) — reached through the proxy
- Health: `GET /api/health` → `ok`, `db`, `media_persistent`

## Required env (Cloud Run)
| Variable | Notes |
|----------|--------|
| `DJANGO_SECRET_KEY` | Strong secret; refused if weak when `DJANGO_DEBUG=false` |
| `DJANGO_DEBUG` | `false` |
| `DATABASE_URL` | Neon Postgres URL (`sslmode=require`) |
| `GS_BUCKET_NAME` | Private bucket for uploads; without it they die with the instance |
| `DJANGO_ALLOWED_HOSTS` | `.run.app` (and custom domain if any) |
| `CSRF_TRUSTED_ORIGINS` | The Vercel origin (the proxy forwards its `Origin` header) |
| `SCOPUS_API_KEY` | Optional; enrich/verify degrade gracefully |

`CROSS_SITE_COOKIES` is **not** needed with the proxy — leave it unset so
cookies stay `SameSite=Lax`.

## Background jobs
django-q2 runs inside the API container. Cloud Run throttles CPU between
requests, so deploy with `--min-instances 1 --no-cpu-throttling` to keep the
worker alive. Interrupted monthly batches are re-enqueued automatically by the
5-minute `recover-stale-batches` schedule.

## Optional email
Set `EMAIL_NOTIFICATIONS=true` plus SMTP (`EMAIL_HOST`, `EMAIL_HOST_USER`,
`EMAIL_HOST_PASSWORD`, `DEFAULT_FROM_EMAIL`). Off by default; in-app
notifications always work.

## Migrations & seed
Migrations run on container start. Seeding is manual:
```bash
python manage.py seed --force   # prod only with --force; change passwords after
```

## Smoke checklist
1. Faculty login → new ticket stepped form → submit → ticket number
2. Admin clearing queue: Clear (confirm recalculated amount) → Finance mark paid
3. Faculty sees “Payment processed”
4. Admin Formula preview calculator returns an amount
5. `/api/health` reports `media_persistent: true`
6. Upload a PDF, redeploy, reopen it — still there (bucket, not container disk)
