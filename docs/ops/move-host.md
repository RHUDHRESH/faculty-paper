# Moving the college to a new host

The college's data travels as one file, loaded through the app (no shell is
needed on the new host). The loader streams the file, saves its place after
every batch and carries on after a restart.

## 1. Export (on the old host, or from a copy of its database)

```
manage.py dumpdata --natural-foreign --format jsonl \
  --exclude sessions --exclude django_q --exclude contenttypes \
  --exclude auth.permission --exclude core.StoredFile \
  -o export.jsonl.gz
```

A `.gz` name makes dumpdata compress the output. Local SQLite example:

```
DJANGO_USE_SQLITE=true DJANGO_SQLITE_PATH=...\local-full.sqlite3 python manage.py dumpdata ...
```

**Do not add `--natural-primary`.** It drops each user's primary key from the
file, so every restored person would get a new random id. Rows that carry the
old id would then point at nobody: the 367 `PublicationMetrics` rows (their key
*is* the user), and ids written inside JSON (`college_site_applied`, audit and
scout records). The loader copes (it drops what it cannot link and reports the
count under "dropped"), but the metrics then have to be rebuilt by *Author
re-matching*. With `--natural-foreign` alone, users are referenced by email and
keep their ids.

Measured on the real data (160,524 rows): the export takes ~30 s and the file
is ~14 MB gzipped (~95 MB as plain jsonl). The upload limit is 90 MB; send the
`.gz`.

### What does not travel

`core.StoredFile` is excluded entirely for a host move. That table holds
files kept in the database: uploaded evidence PDFs/photos when
`DJANGO_MEDIA_STORAGE=db`, and the stored weekly backups. Backups are never
included (neither here nor in the in-app backup, `BACKUP_PREFIX` in
`core/services/backup.py`), and uploaded evidence has to be copied separately
(or re-uploaded) if it matters. Files under `MEDIA_ROOT` (avatars, etc.) are
not in any dump either.

The in-app backup (*Data health -> Make a backup now*) is also accepted by
the loader (`.json.gz`), and does include non-backup stored files.

## 2. Load (on the new host)

1. Deploy; `migrate` runs and builds the empty tables.
2. Open the site and make the first super admin with an email that is *not*
   in the export (a restored row with the same email is skipped, and the
   account you just made is kept).
3. *Set up -> Imports -> Restore a previous installation*: choose
   `export.jsonl.gz`, type RESTORE, press Restore. Progress (rows done of
   total, the table being loaded, then "linking") is shown on that page.
4. Sign in as a restored person, run *Data health -> Run now*, compare counts.

Accepted files: `.jsonl`, `.jsonl.gz`, `.json`, `.json.gz`.

### If it stops

* The job uses at most 50 minutes (`RESTORE_JOB_SECONDS`, default 3000; the
  queue's own limit is 3300 s), then saves its place and queues itself again.
  Nothing to do.
* If the host restarts mid-way, the page shows the restore as stalled. If the
  uploaded copy is still on the server press **Continue**; otherwise
  **upload the same file again** (matched by SHA-256, so it continues from the
  saved place rather than starting over). Claims already loaded do not block
  this; a *different* file is refused once claims exist.
* A failure shows its message (model and object range). Fix the cause and
  continue the same way.

## What the loader does (for the next maintainer)

`core/services/restore.py`. Objects are grouped by consecutive model and
inserted ~1000 per statement with a raw insert (exported `created_at` /
`updated_at` are kept), one transaction per batch that also writes the
checkpoint (`SystemSetting` key `restore_run`). Natural keys (users by email,
permissions) come from a cache. Foreign keys are checked before each batch; a
nullable one pointing at a row not loaded yet is filled in at the end. Many-to-
many links are inserted in a second pass straight into the through tables.
At the end: sequences are reset (Postgres), the college's formula is made the
active one, the shared-figures cache is bumped. Signals are not fired: as with
`loaddata`, the claim threshold re-decision and identifier tidying never ran
on a restore.

## Measured (the real export, 160,524 rows, 13.9 MB gzipped)

Into a fresh, migrated SQLite database through the real job code
(`restore.execute`), Python 3.12, Windows laptop:

| | wall | CPU | peak RSS |
|---|---|---|---|
| one core, unthrottled | 32 s | 28 s | 86-91 MB (whole process) |
| process suspended 85% of the time (about 0.15 CPU) | 202 s | 30 s | 86 MB |
| stopped by a crash at 76,169 rows, then continued | 13 s + 19 s | | 89 MB |
| 6-second job budget (chained into 6 jobs) | 32 s in all | | 78 MB |

Every table's row count equals the source's (plus the new admin, the default
formula, the `restore_run` record and the audit entries). On Render's 0.1 CPU
expect about 5-8 minutes of CPU-bound work plus database round trips (170
batches of ~1000 rows; the dominant cost is Python building the model rows,
not the database), so one job, well inside the 55-minute limit. That is an
extrapolation from the CPU seconds above, not a measurement on Render.