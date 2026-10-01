# Audit: Home (super admin)

Route `/`. Built in `frontend2/src/pages/home-admin.tsx` (was the admin branch of `OfficeHome` in `home-staff.tsx`).

## 1. Who and why
The super admin opens it first thing, most days. The job is doc 22's daily loop: "is anything broken or stuck?", then fix each item in at most two clicks.

## 2. What it showed before
Screenshot: `img/home-before-1440.png`. Checked against the real local data (95 claims, 413 people).

| Element | Problem |
|---|---|
| "9 things need attention" list | Only the first three showed, the rest hid behind "6 more in Admin". |
| "Running" tag at the right of every row | It is the internal job name (`running`), not a fact. It said nothing and looked like a status. |
| Title carried the count ("Waiting to clear over 14 days: 13") | A number inside a sentence cannot be scanned; no unit. |
| Every row linked to `/faults` or a page one hop from the real fix | "Waiting to clear" went to Faults, not to the claims. "Waiting to pay over 14 days" was wrong: those claims are waiting for the Principal, not Finance. |
| Red dot as the only severity | Colour alone. |
| "Fine: a policy version is active, ..." | 10-pt grey sentence nobody reads. |
| Empty desks (no Director, no Finance) | Not mentioned anywhere on Home. |
| Section "Waiting on you to clear" | The button said "Check" (vocabulary: "Clear") and opened the whole queue, not the claim. The "Waiting longest" list under "Where everything is" repeated the same claims. |
| First `/api/admin/attention` call | 2.0 s cold, 120 ms warm. |

## 3. What changed
- One question at the top: "Is anything broken or stuck?" Title counts the real number ("14 things need attention").
- Each row: severity word plus colour, plain title, one sentence of why, the real count with its unit ("13 claims", "2,841 names"; "1 claim" in the singular) and one verb button ("Open claims", "Match names", "Review them"). The whole row is the link.
- Five rows show; "Show 9 more" opens the rest in place. What is fine is one collapsed line ("4 things are in order").
- Now includes the readiness failures (Director and Finance desks have nobody, email not set up, Scopus key not set, worker looks stopped) and the old-ERP data-fix queue (links to `/data/fixes`).
- Fault links go where the work is: stale claims to `/clearing`, claims waiting for the Principal to `/track?stage=checked`. The wrong "waiting to pay" wording is fixed.
- "Waiting to be cleared" rows open the claim (`/review/:id`), the button says "Clear", and the link says how many are waiting in all.
- Skeletons only after 300 ms.

## 4. Evidence after
- Screenshots: `img/home-after-1440.png`, `img/home-after-390.png` (no horizontal scroll at 390).
- Tests: `frontend2/src/pages/home-admin.test.tsx` (counts, units, no "Running", show-more, empty); `backend/core/test_admin_a.py::AttentionShape`.
- API timing on the real copy: `/api/admin/attention` about 120 ms warm. Cold, the unmatched-author grouping was the cost; its query is now filtered on the selective `is_college` flag (about 3 times faster).
