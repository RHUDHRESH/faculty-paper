# Audit: Flags

Route `/flags`. Code: `frontend2/src/pages/flags.tsx`,
`frontend2/src/pages/cell/flag-parts.tsx`. Server: `backend/core/api/flags.py`
(`GET /api/flags`, `POST /api/flags/{id}/resolve`, new `POST /api/flags/resolve-many`).

## 1. Who and why
Research cell, research coordinator, Principal, super admin (never Director,
Finance or the claimant). Weekly, and whenever a notification says a claim was
paid with a question open. Question: **which doubts are still open, and what
did we answer before?** (jobs 5, 6 and 11).

## 2. What it showed before
Screenshot: `shots/flags-before-1440.png` (5,300 px tall for 25 rows).

- **Figures:** Open 54, Open on paid claims 53, Resolved 0. Plain numbers, no
  links, no word for "Resolved 0".
- **Titles were the kind, not the question.** 50 flags read "Amount" and three
  read "Something else". The real question ("paid nothing but the ERP working
  gives a figure") was buried in a 250-character paragraph, repeated 50 times.
- **Nothing to act on a group.** 47 of the 50 were the same question with the
  same answer, and each needed its own dialog.
- **Columns:** no headings. "Awaiting check" (a faculty word) was the stage for
  a claim waiting at the research cell. "Paid ... ₹0 paid on 23 Sept 2026" said
  "paid" twice.
- "ERP-PROCESSED-60" had no explanation. "Not Found · Not Found" was shown as a
  department (that is the imported data; the row now says so honestly, and the
  fix is a data fix in Admin).
- **Buttons:** "Resolve" on every row (ambiguous when read alone); the result
  toast said "Resolved. Amount".
- **Filters:** a kind dropdown that did not map to what the flags asked. "History"
  meant answered flags but did not say so.
- **Empty state:** "No open flags" with no next step.
- **Phone:** 25 tall cards, each with the button below the fold.

## 3. What changed
1. **The answer:** three figures, each a link (Open, Open on claims already paid
   in red, Answered), and a zero says what it means ("None answered yet").
2. **What the open flags are about:** one line per question ("Paid nothing, but
   the old ERP's own working gives a figure": 50 open, 50 on paid claims), each
   with Show to narrow the list. The server groups them (`summary.groups`).
3. **One row per flag, with the question as its headline** (`headline`), the
   note clamped to three lines with Show all, who raised it and when, and a link
   to every flag on that claim. Where the claim stands is in staff words
   ("Waiting to be cleared", "Paid on 23 Sept 2026"), with the amount.
4. **Resolve with a reason, one or many.** Ready-made reasons for each question
   fill the box and stay editable; at least 10 characters are required. Choose
   several rows (or "Choose all 50 shown") and "Resolve 12 flags" opens a dialog
   that says how many are on paid claims and the total, then gives every flag
   the same reason. Each is audit-logged; flags on your own claim or already
   answered are skipped by name.
5. **History in place.** "Answered" shows who answered, when and the reason
   under each flag.
6. Imported claim numbers explain themselves on hover and in one legend line.
7. **Keys:** j/k move, x chooses, r resolves. The empty state offers the next
   step ("Look through past claims" / "Show every flag").
8. Built on the base kit: `PageHeader`, `Answer`, `Section`, breadcrumbs from the
   shell; hairlines between rows only.

## 4. Evidence after
- Screenshots: `shots/flags-after-1440.png`, `shots/flags-after-390.png`. No
  horizontal scroll at 390 px.
- Tests: `frontend2/src/pages/flags.test.tsx` (9, including batch resolve,
  the grouped summary and the answered history);
  `backend/core/test_flags_desk.py` (5: groups, `rule` filter, headline and
  origin, access, batch resolve with skips and audit rows).
- API: `/api/flags` 40 to 90 ms with 54 flags.
