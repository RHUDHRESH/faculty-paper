# Production ops — Faculty Paper Remuneration

Single-college deployment. **The outside services are Google Cloud and
Vercel, and nothing else** — anything the system needs beyond them is built
here and owned here.

- **Vercel** — the SPA, proxying `/api` and `/media`
- **Google Cloud Run** — the Django API
- **Google Cloud SQL** — Postgres (the settings take any Postgres URL, but
  the deployment constraint above is why the database lives on Google Cloud)
- **Google Cloud Storage** — uploaded evidence
- **The harness** — the college's own inference service for the Gemma
  models, our container on Cloud Run (GPU) or a GCE VM; see
  `harness/README.md`. No third-party inference vendor exists in this
  arrangement, and none is wanted: the college's unpublished work goes to
  hardware the college runs, or it does not go at all.

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
| `AI_PROVIDER` | `ollama` (a developer laptop), `harness` (the college's own inference service), `openai` (a hosted model, below) or `none`. Unset: `openai` when `AI_API_KEY` is set, otherwise Ollama with `DJANGO_DEBUG=true` and `none` in production. An unknown value stops the feature rather than silently redirecting where text is sent |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | The hosted provider: any OpenAI-compatible chat-completions API (Groq, Gemini's compatibility endpoint, OpenRouter, a remote Ollama). Values for the free tiers are in `DEPLOY.md` section E. Sends titles and abstracts to that service |
| `AI_FAST_MODEL` / `AI_TIMEOUT_SECONDS` | Optional. A quicker model for the thread assistant (defaults to `AI_MODEL`), and the per-request ceiling (default 60) |
| `HARNESS_BASE_URL` | Default `http://127.0.0.1:8300`. The harness service URL; with `AI_PROVIDER=harness` this is the production inference path |
| `HARNESS_TOKEN` | Shared secret sent as `X-Harness-Token`. Unset when the harness is behind Cloud Run ingress=internal, which is the intended arrangement |
| `HARNESS_MODEL` / `HARNESS_FAST_MODEL` | The two slots, considered and interactive. Defaults `gemma-3-12b-it-q4_k_m` / `gemma-3-4b-it-q4_k_m` |
| `HARNESS_TIMEOUT_SECONDS` | Default 240. A ceiling for a wedged generation, not an expectation |
| `HARNESS_KEEP_ALIVE` / `HARNESS_FAST_KEEP_ALIVE` | How long each slot stays warm; same asymmetry as the Ollama pair |
| `AI_DAILY_LIMIT` / `AGENT_DAILY_LIMIT` / `SEARCH_DAILY_LIMIT` | Per-account daily caps: AI suggestions (default 100), assistant replies (50), search (200) |
| `EXPORT_HOURLY_LIMIT` | Per-account hourly cap on workbook/CSV/PDF exports (default 40) |
| `LOG_FORMAT` | `json` in production by default — one JSON object per log line, which Cloud Logging and Error Reporting parse. `text` on a laptop |
| `DB_STATEMENT_TIMEOUT` | Off by default. When set (milliseconds), kills any single SQL statement that runs longer — recommended 120000 on the API service. Off deliberately: the monthly batch and ERP import share these settings through the job worker and legitimately run long transactions |
| `OLLAMA_BASE_URL` | Default `http://127.0.0.1:11434`. Used only when `AI_PROVIDER=ollama` — the laptop provider |
| `OLLAMA_MODEL` | Default `gemma4:12b` — see `docs/LOCAL-AI.md` for why that tag |
| `OLLAMA_TIMEOUT_SECONDS` | Default 240. CPU inference is slow; this is a ceiling, not an expectation |
| `CORS_ORIGIN_REGEX` | **No default any more.** It used to default to every `*.vercel.app` and `*.netlify.app` host, which with credentialed CORS made any site anybody could deploy in five minutes a trusted origin. Not needed for this deployment — the SPA proxies `/api`, so requests are same-origin |
| `TRUST_PREVIEW_HOSTS` | Off. Set `true` only to CSRF-trust `*.vercel.app` / `*.netlify.app` for preview deploys, and understand what that opens |

### Inference runs on the harness in production

`AI_PROVIDER=harness` sends every model question to the college's own
inference service — the container built from `harness/`, deployed on Cloud
Run with an L4 GPU (or a GCE VM with a T4) and reached over a private
address. The features follow the app out of a developer's laptop without the
text following anything else: the harness is our code, the weights are our
licensed copy in our bucket, and nothing along the path is a third-party
inference vendor.

Two things to know about running it:

- **Scale-to-zero has a cold start.** With `--min-instances 0` the GPU is
  billed only when used, but the first request after an idle period waits
  for a new instance to pull the weights (tens of seconds, inside
  `HARNESS_TIMEOUT_SECONDS`). `--min-instances 1` buys warmth back at GPU
  prices; the fast slot's 30-minute keep-alive is for the case in between.
- **The laptop provider still exists for a reason.** `AI_PROVIDER=ollama`
  runs the same features against a local daemon with no network at all, and
  the whole seam is tested against both — `core/test_inference.py` for the
  laptop, `core/test_harness_provider.py` for the harness — so the screens
  never learn which one answered.

`CROSS_SITE_COOKIES` is **not** needed with the proxy — leave it unset so
cookies stay `SameSite=Lax`.

## Background jobs

django-q2 runs inside the API container. Cloud Run throttles CPU between
requests, so deploy with `--min-instances 1 --no-cpu-throttling` to keep the
worker alive. Interrupted monthly batches are re-enqueued automatically by the
5-minute `recover-stale-batches` schedule.

## Logs and errors

Every log line is one JSON object on stdout (`LOG_FORMAT=json`, the
production default): `severity`, `message`, the traceback when there is one,
and a **request id** on every line a request produces — the id Cloud Run
puts in `X-Cloud-Trace-Context`, echoed to the browser as `X-Request-ID`.
A complaint with the id becomes a grep, not a hunt.

There is no error-tracking vendor, on purpose: this deployment runs on
Google Cloud and Vercel and nothing else. **Google Cloud Error Reporting**
reads these tracebacks from Cloud Logging automatically — check it after any
deploy, it needs no setup. The access log is one structured line per request
(method, path, status, duration, user) emitted by the same middleware;
gunicorn's plain-text access log is switched off because it was a second,
worse copy of the same facts.

## Backups (Cloud SQL)

The database is the money. Automated backups and point-in-time recovery are
a property of the instance, not of this repository, so enable and verify
them with the instance:

```bash
# automated backups + PITR, 7 days retained
gcloud sql instances patch faculty-paper \
  --backup-start-time 03:00 \
  --retained-backups-count 7 --enable-point-in-time-recovery

# verify: restore to a throwaway instance and count what came back
gcloud sql backups list --instance faculty-paper
gcloud sql backups restore BACKUP_ID --restore-instance=faculty-paper-restore \
  --backup-instance=faculty-paper
python manage.py shell -c "from core.models import Claim; print(Claim.objects.count())"
```

The restore step is the runbook. A backup that has never been restored is a
hope, not a backup; count the claims, then delete the throwaway instance.

## Rate limits

Expensive endpoints are capped per account (per-worker counters — the API
runs one gunicorn worker; if that changes, see `core/api/common.py`):

| Bucket | Window | Default | Covers |
|---|---|---|---|
| `ai` | day | 100 | venue search, directions — the harness GPU minutes |
| `agent` | day | 50 | the thread assistant; over the cap the post stands and the assistant stays quiet |
| `search` | day | 200 | the search page's upstream calls |
| `export` | hour | 40 | every workbook/CSV/PDF export |

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
