# Installing the product at a college

One afternoon, one machine with Docker, no management commands, no demo
passwords. This is the path for **a new college**. Saveetha's own deployment
predates this document and runs on Vercel + Google Cloud Run (docs/OPS.md) —
everything below also applies to standing up a second, third or disaster
recovery instance.

## The afternoon

**1. Get the code and the secrets.**

```bash
git clone <this repository> faculty-publication && cd faculty-publication
cp deploy/.env.product.example deploy/.env
```

Fill `deploy/.env` in: a database password and a Django secret, both from
`python -c "import secrets; print(secrets.token_urlsafe(24))"`. A weak or
missing secret refuses to boot rather than arriving insecure.

**2. Bring the box up.**

```bash
docker compose -f deploy/docker-compose.yml up --build -d
```

Three containers: Postgres with a named volume, the Django API (web worker
included), and nginx serving the built app and proxying `/api` — the browser
talks to one origin, so there is no CORS to configure.

**3. Walk the setup wizard.**

Open `http://localhost:8080/setup` (or your `WEB_PORT`). Three steps:

- the college's name — it appears on the sign-in screen, the sidebar and
  every export, and can be corrected later on the **Institution** screen;
- the first administrator — a name, an email, a password of at least 12
  characters;
- confirm.

The door closes permanently once one account exists: `/setup` then says
"already set up", and the endpoint refuses. There is no seed command on this
path and no password anybody could look up.

**4. Load the college's real data.**

Sign in as the administrator, then, from the office screens:

- **Imports** — the ERP workbook (faculty master, prior payments, the
  publication history);
- **Data → Scimago / SNIP** — the journal reference tables the payout
  formula reads;
- **Institution** — the sign-in note and support email people will ask for
  in week one.

**5. Read the smoke checklist** at the end of DEPLOY.md and walk it. If any
step fails, `/api/health` says which layer (database, media storage,
migrations, job worker) and docs/UPGRADE.md says what to collect.

## What is deliberately not here

- **No demo data.** A production install starts empty; the walkthrough and
  seed commands are development tools and refuse to run in production
  without `--force`.
- **No secrets in the database.** The Institution screen holds the college's
  name and contact strings. Passwords, keys and database addresses live in
  `deploy/.env` and stay there.
- **No AI dependency.** The suggestion features answer "switched off" until
  a model service is configured (harness/README.md or an Ollama daemon);
  nothing else waits on them.

## Upgrades

See docs/UPGRADE.md — backup, pull, migrate, verify, in that order, and the
version to say when somebody asks which release is live (`/api/health`
reports it, and it is stamped on every build).
