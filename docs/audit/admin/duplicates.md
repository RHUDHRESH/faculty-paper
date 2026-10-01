# Duplicates (`/duplicates`)

## Who and why
The super admin or research cell, when the queue has something: "Was anyone paid twice for one paper, and what did we decide?" The Principal can read it. Director and Finance never see it.

## What it showed before
![before](shots/duplicates-before-1440.png)

On the real data: 47 groups to review, ₹2,75,060 at issue, none decided.
- A hand-made strip of four numbers between two rules (a `Stat` component of its own), while every other admin page had a different way of showing its answer. The figures were not links.
- The comparison table scrolled sideways inside itself at 390 px (`min-w-[32rem]`), so on a phone the second payment was off screen, which is the payment you came to compare.
- A decided row could not say who decided or what changed, except a one-line note. The audit log had it, with no way in from here.
- The page sub line was a two-sentence instruction, not the question.
- `rounded-md` on controls; two radii were mixed.

What was already right and is kept: the side-by-side with the differences marked, the keyboard keys (j, k, a, r), the button verb equal to the dialog verb, the dialog that states "N payments totalling ₹X" and the money that becomes recoverable, and a reason required for "Not a duplicate".

## What changed
- Title, one question as the sub line.
- The answer is the kit's linked figures: To review (47), At issue (₹2,75,060), Recovered so far (₹0), Decided (0, "Nothing decided yet"); To review and Decided are links to the two lists.
- On a phone each payment is its own labelled block, with "Differs from payment 1" written under the cells that differ. Nothing scrolls sideways.
- "Show change history" on every group reads the audit log in words: who, when, "Decision: Not yet reviewed to Confirmed duplicate", money at issue, money recovered.
- One radius for controls.

## Evidence after
- `shots/duplicates-after-1440.png`, `shots/duplicates-after-390.png`. No sideways scroll.
- Tests: `src/pages/duplicates.test.tsx` (3, unchanged and passing), `backend/core/test_admin_b.py::HistoryTests::test_a_duplicate_decision_reads_as_a_decision`.
- API: `/api/admin/duplicate-findings` unchanged, 140 ms on the real data.
