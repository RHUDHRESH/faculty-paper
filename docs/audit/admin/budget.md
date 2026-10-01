# Budget (`/budget`)

## Who and why
Finance, the Principal, the research cell and the super admin: "Is the scheme within its allocation for the year, and which department is close to its limit?" Monthly, and when an allocation is set (yearly).

## What it showed before
![before](shots/budget-before-1440.png)

This page was already one of the better ones (four figures, a used bar, over-budget flagged in words as well as colour, a card list for phones, "Not set" instead of zero). What it still got wrong:
- The four figures were a hand-made grid with their own label component; the answer to "are we within budget?" was on the page but the sentence under the title did not ask it.
- Three ways to do the same thing on the first screen: the primary "Set an allocation" beside the year picker, a second button "Set an allocation for the college" under a callout, and a "Set" button on every department row.
- Copy with " — " fragments (dialogs, hints, the committed line).
- "Remove the allocation" said what removal means but not what was being removed.
- No answer to "who changed this figure?": the audit entry held the new amount only, with no department and no previous amount.

## What changed
- One question as the sub line. The year picker and the one primary action sit at the top right.
- The four figures are the kit's answer strip: Allocated, Paid out, Committed (approved, not yet paid, so the college owes it), Left or Over by. "Not set" stays "Not set", never ₹0.
- The remove confirmation now names the amount and the position: "The ₹6,50,000 allocation is removed. … (₹4,20,000 paid, ₹1,10,000 committed)".
- "Show who changed an allocation (N)" at the foot lists each set or removal: who, which department and year, and "Amount: ₹5,00,000 to ₹6,50,000", with the note given. The audit entry now records the amount before and after and the note (`BUDGET_SET`, `BUDGET_DELETE`).
- The dashes are gone from what people read.

## Evidence after
- `shots/budget-after-1440.png`, `shots/budget-after-390.png`. No sideways scroll.
- Tests: `src/pages/budget.test.tsx` ("Not set" is not zero), `backend/core/test_admin_b.py::test_setting_an_allocation_records_from_what_to_what`.
