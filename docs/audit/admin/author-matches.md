# Audit: Author matches

Route `/people/matches`. `frontend2/src/pages/author-matches.tsx`; API `backend/core/api/author_review.py`, `backend/core/services/author_review.py`.

## 1. Who and why
The super admin (or coordinator) places author names from the paper harvest: "this name on 68 papers is Dr X" or "not one of ours". Until a name is placed, its papers are credited to nobody. Monthly, after a harvest.

## 2. What it showed before
Screenshot: `img/author-matches-before-1440.png`. Checked against the real copy: 2,841 unplaced names.

| Element | Problem |
|---|---|
| The figure "2,841 names nobody has placed" | True, and unusable: only 12 of the 2,841 have anyone on the roster who looks like them. The other 2,829 are people who left, students and namesakes. |
| The list | Sorted by paper count, so the first 25 rows were all "No likely match on the roster. Pick someone else, or reject it." The 12 real matches were on page 114. |
| The work | No way to set the 2,829 aside except one row at a time (about 2,800 clicks). |
| "Accept" and "Reject" | "Reject" is the final refusal in the staff vocabulary; here it means "not on our roster". Toasts said "Accepted" and "Rejected". |
| "Mark ambiguous", "Someone else..." | Unclear verbs. |
| Duplicate accounts tab | A table with a column heading that is empty (the merge button column). Copy said "names normalise to the same person". |
| Tab counts and the hero band | The band carried a figure and a picture but no answer about what to do first. |
| Keys hint (j k a r o) | Useful, kept. |

## 3. What changes
- **The answer first:** names to place (2,841), with a likely match (12, in green), match nobody on the roster (2,829), set aside as not on our roster (0). Each is a link to its list.
- **The list opens on the 12 with a likely match**, each with a face, the department, the score and a "Match" button. "Match nobody (2,829)" is one click away.
- **Set them aside in one step:** on the "Match nobody" list, "Set all 2,829 aside..." asks first with the count ("These 2,829 names match nobody on the roster. No paper changes, and you can bring any name back") and writes one audit row for the lot. Every name keeps its own decision, so "Move back to review" still works one at a time, and "Move all N back to review" undoes a whole list.
- One vocabulary: "Match" (toast "Matched: ..."), "Not on our roster" (toast "Set X aside: not on our roster"), "Cannot tell", "Pick someone else", "Move back to review".
- The Duplicate accounts table has a named last column and plain copy.
- Home's attention row and this page now say the same thing: "12 have a likely match on the roster; the rest match nobody and can be set aside in one step."

## 4. Evidence after
- Screenshots: `img/author-matches-after-1440.png`, `img/author-matches-after-390.png`.
- Tests: `frontend2/src/pages/author-matches.test.tsx` (8 pass, including the split, the default view and the confirmed bulk step); `backend/core/test_admin_a.py::AuthorMatchTriage`; `core.test_author_review` still passes.
- API timing (real copy): `/api/admin/author-matches?suggested=yes` 90 to 100 ms warm. The grouping query now filters on the selective college flag (about 3 times faster cold) and the "likely match" set is built once with it.
