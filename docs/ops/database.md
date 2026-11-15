# The database: running it, moving it, checking it

The app keeps everything in one PostgreSQL database. It does not care which
company hosts it: the only thing the app knows is `DATABASE_URL`. Today that
is Supabase; next it is Render Postgres 17. Use PostgreSQL 15 or newer.

Keep the API and the database in the **same region** (Singapore for both).
Every page makes several queries, and each one pays the round trip.

## Settings (all optional; the defaults are right for Render)

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | none | The connection string. Secret. |
| `DB_CONN_MAX_AGE` | 60 | Seconds a web thread keeps its connection open. |
| `DB_CONNECT_TIMEOUT` | 10 | Seconds to wait for the database before giving up. |
| `DB_APP_NAME` | `faculty-paper-api` | The name the database shows for this app's connections. |
| `DB_SSLMODE` | `require` for any host that is not local | Overrides the URL. |
| `DB_SSLROOTCERT` | none | Path to the provider's CA file. Switches on `verify-full` (checks the server's certificate and name, not just encryption). |
| `DB_STATEMENT_TIMEOUT` | off | Milliseconds before the database stops a single query. `120000` is a sane value for the API. Leave it off for the job worker, which runs long imports. |

Two things are automatic. Connections send TCP keepalives, so one dropped by
a firewall is noticed in about a minute instead of hanging. And a URL on
**port 6543** is treated as a transaction-mode pooler (Supabase's): the app
closes the connection after each request and stops using server-side cursors,
because a pooler hands every transaction to a different server connection.

## Pointing the app at a new database

Do this in a quiet hour. The old database stays untouched throughout, so you
can go back at any step before the switch.

1. **Create the database** at the new host (same region as the API). Note its
   *internal* connection string if the host offers one; it is faster and
   needs no public access.
2. **Look at it from a laptop first.** Set `DATABASE_URL` in your own shell
   (not on the live API) and run `python manage.py db_check`. It must not say
   CRITICAL.
3. **Create the tables:** `python manage.py migrate`. (On Render the start
   script does this on every deploy.)
4. **Rehearse the load.** Take a backup on the old site (*Data health -> Make a
   backup now*, a `.json.gz` file). On a copy of the API pointed at the new
   database, make the first super admin and use *Set up -> Imports -> Restore a
   previous installation*. The steps, the file limit and what to do if it
   stops are in `docs/ops/move-host.md`. Note how long it took.
5. **Compare the rehearsal:**
   ```
   python manage.py db_compare --source <old URL> --target <new URL>
   ```
   Passwords in the URLs are never printed. Both URLs can instead be set as
   `SOURCE_DATABASE_URL` and `TARGET_DATABASE_URL`. It prints each table
   that differs and exits 1 if there are any. Restore's own audit lines
   (`RESTORE_*`) and the stored `backups/` files are left out on purpose.
   Nothing is written to either side. Fix whatever it reports now, while
   nothing is at stake.
6. **Freeze writes.** Announce a short pause and ask everyone to stop filing
   and editing (the app has no read-only switch, so this one is by
   agreement). Anything saved after this point would be missing from the copy.
7. **Final load.** The restore service only loads into an installation with
   no claims, and refuses a different file once claims exist, so a "delta" is
   not possible: load once more into an *empty* database. Take a fresh backup
   of the old site, then empty the new database (delete and recreate it, or
   create a second new one), `migrate`, make the first admin, restore the
   fresh file, and run `db_compare` again. It must say the two agree.
8. **Switch.** Change `DATABASE_URL` on the live API and deploy. Check
   `/api/health?deep=1` (see below) and sign in as a real person. Lift the
   freeze.
9. **Keep the old database for a week**, untouched, and then delete it. If
   something is wrong in that week, point `DATABASE_URL` back (you lose
   anything written since the switch, so decide quickly).

## How many connections will it use?

Each web thread holds one connection while it is busy, and keeps it for
`DB_CONN_MAX_AGE` seconds afterwards. So:

```
web         workers x threads            1 x 8  =  8   (backend/scripts/start.sh)
job worker  its workers + 2 helpers      1 + 2  =  3
deploy      the old and new copy overlap, so double the two lines above
headroom    psql, backups, db_check, db_compare, you:  5

(8 + 3) x 2 + 5 = 27 connections at the worst moment
```

Compare that with the database's own limit (`db_check` prints it as
"connections used of max"). If you raise the workers or threads, redo the
sum. If the limit is close, use the host's pooler (a **transaction-mode**
pooler on port 6543 works with the app as it is) rather than a bigger
database.

## Backups, and proving they work

There are three layers. Know which one you are relying on.

* **The host's automatic backups and point-in-time recovery (PITR).** On
  Render these need a paid database; the recovery window is 3 days on the
  lower plan and 7 days on Pro and above. It is the only layer that can put
  the database back to *a minute before a mistake*.
* **The daily off-site copy** in the object store (`backups/`, the newest 14
  are kept) when `S3_BUCKET_NAME` is set. It survives losing the database.
* **The weekly copy inside the database** (the newest 4). It is a convenience
  for the app's own restore; it goes down with the database, so do not count
  it as a backup of the database.

**Restore drill, every quarter (and once right after any move):**

1. Make a scratch database (a free one is fine). Never use the live one.
2. Download the newest off-site backup, or take one from *Data health*.
3. `migrate` the scratch database, make its first admin, restore the file with
   the restore page.
4. `python manage.py db_compare --source <live URL> --target <scratch URL>`.
   Differences should only be what was written since the backup (look at the
   row counts and newest timestamps it prints).
5. Sign in to a scratch copy of the API and open a few papers and a PDF.
6. Delete the scratch database. Write down the date and how long it took.

**Point-in-time recovery drill** (on a paid Render database): in the
database's *Recovery* page choose a time at least 10 minutes ago and restore.
Render creates a **new** instance; it never overwrites the old one. Run
`db_check` and `db_compare --source <live URL> --target <recovered URL>`
against it, then either point `DATABASE_URL` at it or delete it. Practise this
once while nothing is wrong.

## Rotating the database password

1. In the host's dashboard, set a new password (or create a second database
   user with a new password, which allows a rollback).
2. Update `DATABASE_URL` on the API service and deploy. Special characters in
   the password must be percent-encoded in the URL (`@` is `%40`, `/` is
   `%2F`).
3. Within a minute check `/api/health?deep=1` is `ok` and the job worker is
   alive.
4. Update every other place the URL lives: your own `.env`, any copy of the
   API used for restore drills. Then remove the old password or user.

Existing connections made with the old password stay open until they are
recycled (60 seconds by default), so a brief overlap is normal.

## Reading the two checks

### `GET /api/health?deep=1`

Plain `GET /api/health` never touches the database (so the free plan can
sleep); this one does. Look at `db` (reachable or not) and `db_details`:

* `latency_ms`: the median of three `SELECT 1` round trips. In the same region
  this is 1 to 5 ms. Above 50 the report adds `latency_warning: true` and a
  `hint`: the database is probably in another region, or you are using its
  public address instead of the internal one.
* `server_version`: should start with 15 or higher.
* `size_mb`: the size of the database; compare against the plan's storage.
* `connections`: `used` out of `max`. Persistently above two thirds means the
  sum above needs redoing.

A 503 means the database could not be reached at all.

### `python manage.py db_check`

Read-only (it runs in a read-only transaction). On SQLite it says "not
PostgreSQL" and stops. It exits **1** when it finds something critical:
a server older than 15, a round trip over 100 ms, or more than 80% of the
connection limit in use. The rest is advice:

* **10 largest tables:** where the space is going. Expect claims, audit log
  and stored files to lead.
* **Foreign keys with no covering index:** each is a table scan waiting to
  happen when a parent row is deleted or joined. Add an index in a migration.
* **Indexes never used and over 1 MB:** candidates to drop. The counters
  reset when the server restarts or after a restore, so judge them only after
  a few weeks of normal use. Unique and primary-key indexes are left out
  because they enforce rules even when nothing reads them.
* **Tables with over 20% dead rows (at least 1,000):** autovacuum is behind.
  Nothing to do for a one-off after a big import; if it persists, run
  `VACUUM (ANALYZE) <table>`.
* **Queries running over 60 seconds:** usually a stuck import or report. The
  job worker's long imports will show here legitimately.
* **pg_stat_statements:** when installed, `SELECT query, calls,
  mean_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC
  LIMIT 10` shows which queries cost the most. If it says "not installed",
  `CREATE EXTENSION pg_stat_statements;` once (most hosts allow it).
