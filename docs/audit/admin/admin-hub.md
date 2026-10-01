# Audit: Admin hub

Route `/admin`. Built in `frontend2/src/pages/hub.tsx` (`AdminHub`), with `admin-parts.tsx`.

## 1. Who and why
The super admin (and the research cell) opens it weekly, or when Home points at a page. The job: find the right admin page, and know whether the system is set up to do its work.

## 2. What it showed before
Screenshot: `img/admin-before-1440.png`.

| Element | Problem |
|---|---|
| "99+" on Faults and Author matches | Real values are 167 and 2,841. An admin needs the number. |
| "27 need attention now" under Faults | Beside 167 it read as a contradiction. It meant 27 of the 167 are urgent. |
| Sentence "4 pages need attention: ..." | A list of names with no numbers and no reason. |
| "Newest backup 2026-09-28" | Raw ISO date. |
| Nothing said whether the system is set up | No Director, no Finance, no Scopus key, no email, and the admin could not tell. |
| Old ERP claims with holes | Not visible anywhere on Admin. |
| A count pill in one colour for every kind of waiting | Fine, kept, but the pill now carries the whole number. |

## 3. What changed
- **Is the system ready?** A checklist of nine lines: the four desks each have a person (Research cell, Principal, Director, Finance), a policy is in force, a backup in the last 2 days, email set up, the worker running, the Scopus key set. Each is "Ready" or "Not ready" (words and icon), states why in a sentence, and links to its fix ("Give the Director role to someone" opens People filtered to that role). All green collapses to one line.
- **Claims from the old ERP that need fixing:** the four queues (paid with no amount, no paper title, no quartile, claimant not identified), each with its real count and a link to `/data/fixes?kind=...`. The line explains that a claim number starting ERP- was imported from the old ERP.
- Real numbers everywhere: no "99+". Faults says "27 of them urgent". Backup date reads "28 Sep".
- Intro sentence says what the page is for; the status sentence names pages that have something waiting.

## 4. Evidence after
- Screenshots: `img/admin-after-1440.png`, `img/admin-after-390.png`.
- Tests: `frontend2/src/pages/home-admin.test.tsx` ("the Admin page"); `backend/core/test_admin_a.py::ReadinessChecks`, `DataFixes`.
- API timing: `/api/admin/readiness` about 50 ms, `/api/admin/data-fixes` about 30 ms, `/api/admin/hub` about 110 ms.

The fix forms themselves (`/data/fixes`) belong to Admin B; the API they need is `GET /api/admin/data-fixes` (counts and one row per claim with its problems).
