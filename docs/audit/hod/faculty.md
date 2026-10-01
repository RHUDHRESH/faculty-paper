# HOD: Faculty (/faculty) and a colleague's record (/faculty/:id), as a head sees them

`frontend2/src/pages/faculty.tsx` (shared with the office; the head's branch is `data.scope === "department"`), `faculty-record.tsx`; API `backend/core/api/faculty_directory.py`.

## 1. Who and why
The head, to look up one colleague ("what has Dr X published, and is their Scopus ID on file?") and to reach a person from the push list. Jobs 2 and 6 of docs/jtbd/hod.md. Weekly.

## 2. What it showed before
Screenshots: `shots/faculty-before-1440.png`, `shots/faculty-record-before3-1440.png`.

| Element | Problem |
|---|---|
| **"Paid" on a colleague's papers** | The record page tagged the papers a colleague was paid for with a green "Paid" chip. A head is not in the payment chain: every other head screen says "Completed" (`hod.PROGRESS`) because "Paid" tells a head that a colleague was paid. `_paper_row` took the word from the ledger and skipped the head's translation. No amount was sent, but the fact was. |
| Department name under every row ("ECE" x 72) | The same word on every row of a list of one department. |
| "Claims in 2026: 0 filed, 4 completed" column | Incentive claims are not the head's to chase; the column repeated the Track page and crowded out the papers. |
| Sort by "Department" and "Claims filed this year" | Options that mean nothing for one department. |
| Sub-line: "with their Scopus ID, papers and claims" | Said the page was about claims. |
| Four figures ("72 faculty, 11 without a photo, 8 without a Scopus ID, 13 with no paper in 2026"), the missing-photo hint ("only they can add a photo, so ask them") | Clear and correct; kept. The 13 equals "have no paper in 2026" on Home and Department. |
| Colleague's record: identifiers, four figures, tabs Papers, Claims, Research, Details | Clear; kept. Names on the push list and the Department table now link here (they linked to `/people/:id`, which is closed to a head). |

## 3. What changes
- **Security first:** for a head opening a colleague's record, a paper paid through the ledger reads "Completed" (`faculty_directory._paper_row`), the same word as every other head screen. Test `HeadSeesNoPayment` asserts the response holds no "Paid" and no amount.
- Head's list: no department line under each name (shown only for someone who has left or has no department), no claims column and no claims sentence on a phone, no Department or Claims sort, and the sub-line says "with their Scopus ID and papers".
- The office's directory is unchanged (its tests still pass).

## 4. Evidence after
- `shots/faculty-after-1440.png`, `shots/faculty-after-390.png`, `shots/faculty-record-after-1440.png`, `shots/faculty-record-after-390.png`.
- Tests: `pages/faculty.test.tsx` (a head's list has no department line, claims column or department filter); `core/test_hod_brief.py::HeadSeesNoPayment`.
