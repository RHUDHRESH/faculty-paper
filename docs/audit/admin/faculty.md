# Audit: Faculty (directory)

Route `/faculty`. `frontend2/src/pages/faculty.tsx`; API `backend/core/api/faculty_directory.py` (`GET /api/directory/faculty`).

## 1. Who and why
The office (and a head of department, for their own department) opens it to find one person, or to see who is missing a photo, a Scopus ID or a paper. Weekly, and whenever someone asks "what do we hold on Dr X?".

## 2. What it showed before
Screenshot: `img/faculty-before-1440.png` (412 rows on the real copy).

| Element | Problem |
|---|---|
| Skeleton for 2.5 s | The directory API took 700 ms to 1.3 s cold, and it was rebuilt every 30 seconds. Every person's papers were loaded as whole publication objects (17,000 of them). |
| "What is missing" panel | A boxed panel inside the page, with its own tabs and a second list of eight names, saying 74 without a photo of 411. The list under it said 75 of 412 (it counted people who have left). |
| Sentence "412 faculty, 0 of them on research posts. 124 have no paper in 2026." | A figure that is zero, a figure that is a button, in one line of grey. |
| Column "Type and Scopus ID" with a "Regular" chip on every row | "Regular" says nothing; only research faculty differ. |
| "Profile 43%" under "Last paper" | A different fact in another column's cell; not explained. |
| Incentives paid "₹77,078 / ₹77,078 in all" | Two figures, one label; "in all" of what? |
| "No photo" / "2 things missing" in the Last-paper cell | Said what, but not who fixes it or where. |
| Filters: five controls, a checkbox and a sort with a separate arrow | Kept; the sort arrow is labelled. |

## 3. What changes
- **The answer first:** four figures, each a link to the list behind it: faculty at the college, without a photo, without a Scopus ID, with no paper this year. A zero says what it means ("Everyone has a photo").
- The boxed panel is gone. A row that is missing something says it under the name ("Missing: photo, Scopus ID") with a link to fix it on the account. Choosing "Without a photo" shows one line saying who fixes it (only they can add a photo).
- **One population everywhere:** current staff by default, so 411 here equals the gaps count and Admin. People who have left are one tick away ("Include 1 who have left"), and the CSV follows it.
- Only research faculty carry a chip ("Research faculty" with its threshold); "Scopus ID" is its own column; the incentives column is "Incentives paid in 2026" with "in all years" under it; the profile percentage is dropped from the list.
- **Speed:** the totals are built once and kept for ten minutes (keyed to the record's own fingerprint), papers are read as plain rows, and Home warms it. Cold 1,100 ms to 580 ms on the real copy; warm 90 to 140 ms.

## 4. Evidence after
- Screenshots: `img/faculty-after-1440.png`, `img/faculty-after-390.png`.
- Tests: `frontend2/src/pages/faculty.test.tsx` (glance figures and links, fix link, hint, no `include_left` by default); `backend/core/test_admin_a.py::FacultyDirectoryCounts`; the existing `test_faculty_directory`, `test_paper_count_agrees` still pass.
- API timing (real copy, cold then warm): `/api/directory/faculty` 580 ms then 100 ms (was 1,100 ms then 100 ms, and cold every 30 s).
