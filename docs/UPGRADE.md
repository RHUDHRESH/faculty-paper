# Upgrading a deployment

The order is always the same: **back up, pull, migrate, verify.** Migrations
run on container start, so "deploy" and "migrate" are the same step — which
is exactly why the backup comes first.

## 0. Know which release you are on

```bash
curl -s https://<the college's host>/api/health
# → {"version": "1.0.0", "git": "8745161…", ...}
```

`version` is the `VERSION` file baked into the build; `git` is the exact
commit. Bump `VERSION` as part of a release, never after it.

## 1. Back up

Docker compose deployment:

```bash
docker compose -f deploy/docker-compose.yml exec db \
  pg_dump -U faculty faculty > backup-$(date +%F).sql
```

Cloud SQL (Saveetha's deployment): use the console's on-demand backup, then
verify a restore to a throwaway instance by counting claims — a backup that
has never been restored is a hope (docs/OPS.md).

## 2. Pull and rebuild

```bash
git pull
docker compose -f deploy/docker-compose.yml up --build -d
```

The API container runs `manage.py migrate` before serving. If a migration
fails, the container exits and the old containers keep running — an upgrade
that does not complete is not half-applied to the people using the system.

## 3. Verify

1. `/api/health` → `ok: true`, `migrations_pending: false`, and the **new**
   version string.
2. Sign in as each of one faculty, one head of department and one office
   account.
3. File a draft, clear one ticket, and open the ledger — the three screens
   that touch every layer.

## 4. If it goes wrong

Roll back is `git checkout <previous tag> && docker compose up --build -d`
**after** restoring the backup from step 1, because a migration that changed
the schema is not reversible by code alone. Collect for the report: the
`api` container's last hundred log lines (`docker compose logs --tail 100
api`) and the `/api/health` body.
