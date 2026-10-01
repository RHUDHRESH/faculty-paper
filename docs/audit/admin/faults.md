# Faults (`/faults`)

## Who and why
The super admin, every morning: "Is anything stuck or wrong, and where do I fix it?" The Principal can read it. Daily.

## What it showed before
![before](shots/faults-before-1440.png)

Checked against the real local data (96 claims, 3,043 ledger rows):
- 16 checks on one page and 10 of them were a row with a grey 0. The 6 that mattered were scattered among them.
- The count "167 faults found, 27 urgent" was right, but nothing on it was a link. "27 urgent" led nowhere.
- Every row said "Open" with an external-link icon. It did not say where it went or what it would do.
- 61 claims "Paid, but for nothing" had no button at all. The number that most needed a fix had no way in.
- "For example: ERP-RAW-81 · ERP-RAW-72 …" gave four of 13. There was no way to see the other nine short of guessing at another screen. "ERP-RAW-81" was never explained.
- Words a person does not use: "Stranded on a retired status", "Verification did not pass", "Payments voided".
- Sample people were faces (fixed last round), but claims were bare numbers with no person or paper.

## What changed
- One line saying what the page is for. The answer is three figures, each a link: **27** need action now, **140** to look at, **10** checks found nothing. Plus how long ago it ran and a "Check again" button.
- The work is only the checks that found something, most urgent first. Each has the count, a plain severity word (Urgent / Look at / For information), and one button that says what it does ("Fix 61 amounts", "Set 13 quartiles", "Open the clearing desk").
- "Show all 61" opens the whole list inline, from a new endpoint (`GET /api/admin/faults/{key}`) that shares its query with the count, so the two cannot disagree. Claims show the face, the paper, where it stands and how long, the amount ("Not recorded" when missing).
- The ten clean checks are one line at the foot ("Checked, and nothing found (10)"), opened on request.
- ERP claim numbers get a dotted underline, a hover explanation, and the meaning once in words at the top of the list.
- Counts are exact everywhere (`1,000`, never `99+`), and use the same query as the new Fix imported claims queue.
- Words follow docs/ux/19 ("Stuck at an old step", "Payments cancelled").
- The paid-for-nothing and in-review-no-quartile faults now link to **/data/fixes**; paid-with-no-ledger-row links to the ledger checks.

## Evidence after
- 1440 px: `shots/faults-after-1440.png`. 390 px: `shots/faults-after-390.png`. No sideways scroll.
- Tests: `src/pages/faults.test.tsx` (real counts, button text, list behind a count, "Not recorded"), `src/pages/faults-faces.test.tsx`, `backend/core/test_admin_b.py::QueueTests::test_the_fault_and_the_queue_count_the_same_claims`, `core.test_speed` (fault cost still under 20 queries).
- API on the real data: `/api/admin/faults` 320 ms cold, 40 ms cached; `/api/admin/faults/paid_zero` 90 ms.
