# Super admin audit (branch audit/super-admin)

Checked against docs/jtbd/super-admin.md. The pages were read in code and the fixed ones were exercised in a browser (shots in `shots/super-admin/`).

## Gaps found

| # | Page / feature | Gap | Job | Status |
|---|---|---|---|---|
| 1 | Home health | Only counted urgent faults and open duplicates. It did not cover backups, data health, author matches, profile requests or a missing policy, and it did not say why an item matters | Keep it running | **Fixed**: `GET /api/admin/attention` plus a Home list showing severity, why it matters, a link, and the job; everything already fine is listed underneath |
| 2 | Audit log | No filter by person or claim. The date range was applied in the browser to at most 500 rows, so older entries could silently go missing. No export | Who changed what | **Fixed**: server-side `person`, `claim` (ID or ticket, including its flags), `date_from`, `date_to`; `GET /api/admin/audit.csv` with the same filters; a "Download CSV (n)" button |
| 3 | Policy | Publishing showed a worked example only. It did not show which real unpaid claims change | Keep money right | **Fixed**: `POST /api/admin/formula/preview` prices every open claim under the live version and under the draft (nothing is saved). The typed-version confirm shows the count, the totals before and after, and each changed ticket |
| 4 | Data health fixes | Used `window.confirm` with a generic OK | Dangerous actions | **Fixed**: ConfirmDialog whose button carries the fix's own name |
| 5 | Imports | Already has Preview (dry run) with a "nothing saved" report and a typed confirm for destructive rebuilds | Keep data right | OK, not changed |
| 6 | People: deactivate and role change | Confirm button already uses the same verb ("Deactivate", "Change role") | People | OK |
| 7 | Undo payment | Super admin only, needs a reason, button reads "Undo payment" | Money | OK |
| 8 | View as | Read-only, audited, confirm reads "View as {name}" | Support | OK |
| 9 | Data wipe / row delete | Needs a reason of at least 10 characters | Data | OK |
| 10 | Backups | There is no automated alert when a backup is stale | Running | Partly fixed: it now appears on Home after 2 days |
| 11 | Audit CSV | Capped at 50,000 rows, and the button does not say when the cap is hit | Who changed what | Remaining |
| 12 | Policy preview | Leaves out the per-person quota, so a claim inside the quota may show a change it will never pay | Money | Remaining; noted in the endpoint docstring |
| 13 | Institution settings, Setup, Reference, Journals, Publications, Flags, Archive, Budget | Read in code only; nothing found that blocks a job in this pass | Mixed | Not deep-audited |
| 14 | Jobs queue | There is only a per-job status endpoint, no list of recent or failed jobs | Running | Remaining |
