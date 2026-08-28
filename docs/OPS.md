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
| `AI_PROVIDER` | `ollama`. The only value. An unknown one stops the feature rather than silently redirecting where text is sent |
| `OLLAMA_BASE_URL` | Default `http://127.0.0.1:11434`. Must be reachable from the API container |
| `OLLAMA_MODEL` | Default `gemma4:12b` — see `docs/LOCAL-AI.md` for why that tag |
| `OLLAMA_TIMEOUT_SECONDS` | Default 240. CPU inference is slow; this is a ceiling, not an expectation |
| `CORS_ORIGIN_REGEX` | **No default any more.** It used to default to every `*.vercel.app` and `*.netlify.app` host, which with credentialed CORS made any site anybody could deploy in five minutes a trusted origin. Not needed for this deployment — the SPA proxies `/api`, so requests are same-origin |
| `TRUST_PREVIEW_HOSTS` | Off. Set `true` only to CSRF-trust `*.vercel.app` / `*.netlify.app` for preview deploys, and understand what that opens |

### Inference is not a Cloud Run workload

`AI_PROVIDER=ollama` expects a model on the same host. Cloud Run gives no GPU,
a cold container, and no room for a 7 GB model — the two discovery features
will report `service_down` there and the rest of the application is unaffected
by design, which is the correct behaviour rather than a workaround.

Running them in production means an on-premise host, or a VM with a GPU that
Cloud Run can reach on a private network via `OLLAMA_BASE_URL`. Until then the
features are simply off in production and work on any machine that has Ollama.
Nothing else in the system depends on them.

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
