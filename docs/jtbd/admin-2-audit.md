# Super admin audit, round 2 (branch audit/admin-2)

These pages were checked only in code last time. This round I opened each one in a browser as the super admin (seeded demo data, SQLite) at 1280 and 390 px. The screenshots are in `shots/admin-2/`. No page scrolls sideways at 390 px.

## Leftovers from the first audit

| Item | Status |
|---|---|
| Jobs view | **Added.** `/jobs` uses `GET /api/admin/jobs` and `POST /api/admin/jobs/{id}/retry`, super admin only. It lists queued, recent and failed django-q2 jobs by plain name, with start time, duration and result. For a failure it shows the last line of the traceback. **Run again** has a matching confirm and only appears for jobs that are safe to repeat: harvest, Scopus sync, backup, re-matching, citations and the health check. Imports, restores, monthly runs and bulk verify are never retried from here. Every retry writes an audit row (`JOB_RETRY`). |
| Policy preview and the quota | **Fixed.** A research faculty paper that falls inside its owner's yearly quota now prices at 0 under both versions. The preview lists each affected person with their face, papers inside the quota, and the amount the quota absorbs before and after the change. |
| Audit CSV cap | **Fixed.** Past 50,000 rows, the first line of the CSV says it was truncated, and the response carries the headers `X-Truncated` and `X-Total-Rows`. The download button reads "newest 50,000 of N", and a note under it explains the cap. |

## Pages

| Page | What was wrong | Status |
|---|---|---|
| Accreditation | The NAAC 3.4.3 rows came from claims only, so any paper on the publication record with no claim was missing. There were no faces in the Author column. | **Fixed.** Record papers with a matched college author and no claim are now added to the screen rows and to the workbook: one row per teacher, labelled "not claimed", read-only. The Notes sheet names the source. Authors now show faces. |
| Publications | No faces on the Faculty column (table or phone cards). | **Fixed.** |
| Imports | Showed the raw endpoint `/api/admin/erp-stats` and audit action codes to people, plus "None —" fragments. | **Fixed.** Now plain copy, with links to the audit log filtered to imports and to Jobs. |
| Batches | The list showed the creator's email with no face. | **Fixed.** It now shows the name and a face (server adds `by`). |
| Batch detail | Opened with a sandbox batch. The rows, matched count and export all work. | OK |
| Data health | A 15 KB backup showed as "0.0 MB". | **Fixed.** Sizes under 1 MB now show in KB. |
| Faults | "Duplicate warning overridden" was critical but had no Open link. | **Fixed.** It links to Duplicates. |
| Journals and journal record | The SNIP note used a " — " fragment. | **Fixed.** Counts match the report API. |
| /setup while signed in | Showed "No page at this address". | **Fixed.** It redirects to /settings. |
| Requests, Institution settings, Reference, Data | Nothing that blocks a job. Requests already gets faces through `faces.py`. | OK |

## Remaining

- Faults lists sample people as email addresses, not faces. The endpoint returns strings, not person dicts.
- Journal record: the "Who publishes here" chart shows names with no faces, because the chart component takes plain points.
- Jobs cannot see a job that is still running until django-q writes its Task row. Those jobs show under "Waiting to run" only while they are queued.
- Batch detail was checked against a hand-made sandbox batch. There is no sample Scopus sheet in the repo.
