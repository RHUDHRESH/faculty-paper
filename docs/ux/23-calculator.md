# 23. Incentive calculator (owner request 2026-09-30)

> "Admin side feature: calculator. Input the values, or check how much
> remuneration should actually happen."

One page at `/calculator`, three tabs. It answers one question for one person:
**how much should this paper pay, and does what we recorded agree?** It never
changes a claim. Every rupee it shows is worked out on the server by the same
`calculate_remuneration` the claims are priced with.

## Who
Super admin, research cell, research coordinator, Principal, Director, Finance
(`rbac.ADMIN_ROLES` + the three chain roles). A head of department or a faculty
member gets 403 from every calculator endpoint and the page redirects them
home. Faculty already have the estimate in filing; a head is money-blind.
Director and Finance are shown no flags: this page shows none for anyone
(it prices, it does not judge), and no claim's flag text is read.

## Standard
docs/ux/22 anatomy: title and one sentence, the answer first (large, one
figure), the work, then detail on demand. Words from docs/ux/19 ("incentive",
"claim no.", "paper"). Tables use the kit `Table` with a footer; a missing
value reads "Not recorded". At 390 px nothing scrolls sideways.

## The server (`core/services/calculator.py`, `core/api/calculator.py`)
All routes are under `/api/calculator/` and gated by one guard.

| Route | Purpose |
| --- | --- |
| `GET options` | Policy versions (in force first), the paper types the policy names, indexing and quartile choices, the policy's limits |
| `POST price` | Price a paper, with the working |
| `GET prefill?q=` | Inputs from a claim number (stored inputs) or a DOI (a claim already filed with it, else the Scopus lookup). Never blocks: a failed lookup says so and the form stays as it is |
| `GET people?q=` | Find a person, to apply their research threshold |
| `GET claim?q=` | Check a claim: recorded vs formula under its snapshot vs formula today vs ledger |
| `GET many` / `GET many.csv` | Check many: every approved, authorised and paid claim (optionally submitted) against its pricing snapshot |

No route writes anything. `POST price` is a POST only because it takes a body.

### Agreement rule
`price` calls `calculate_remuneration` (or `calculate_student_project`) once
per author position and never does the arithmetic itself. The working lines are
read back from the result (`base`, `qf`, `point`, `remuneration`, `note`,
`category`) plus the policy's own numbers, and a test asserts the base line
equals `result.base` and the amount equals the engine's for a grid of inputs.
A claim is priced by `common.price_claim`, the function `_apply_calc` uses, so a
check cannot disagree with the pricing of the same claim.

## Tab 1: Price a paper
Answer: the amount in large type, one sentence under it ("For the first of
three authors, under Policy v1, in force now"). If ₹0, the sentence is the
reason ("Fewer SEC-affiliated references than the 2 the policy requires").

Inputs (left, one column on a phone):
- Fill from a claim no. or DOI (optional, never blocking).
- Paper type (the policy's own types), indexing (Scopus, Web of Science, both,
  not stated), Engineering class, quartile, SNIP (blank allowed: says "Priced
  without a SNIP, at the fixed rate").
- Total authors, and which position is yours; tick several positions to price
  co-authors at the college.
- SEC-affiliated references cited (blank = not checked yet, as in a draft).
- "Final-year student project (a fixed amount per team)" toggle.
- Policy version: in force by default, any past version selectable.
- Person (optional): applies their research threshold for the year, first
  position listed.

Output, in this order:
1. The amount (large), the sentence.
2. "How it was worked out": one line per term in plain words, each with its
   rupees: which rate applies, SNIP times the rate, the quartile incentive (or
   why none), the no-SNIP floor when it beats the SNIP formula, the type
   multiplier, the value of the paper, this author's share, the threshold.
3. When several positions are ticked, a table: position, share of the paper,
   incentive, and a total for the college.
4. "What this ignores": present only when it matters (indexing not stated is
   priced as Scopus, exactly as a draft is).

The browser shows nothing until the server answers; while it thinks the last
answer stays, dimmed, labelled "Updating". No local arithmetic.

## Tab 2: Check a claim
Enter a claim no. (`FP-2026-000123`, `fp 2026 123`, `ERP-PROCESSED-120`) through
`/api/calculator/claim`, which uses `claim_numbers.variants`.

Answer: one sentence. "The recorded amount agrees with the policy it was priced
under" or "The recorded amount is ₹X more than the policy gives".

Side by side (a table on a desk, stacked rows on a phone):
| | Amount | Note |
| Recorded on the claim | payable, and the policy amount before the threshold | |
| Formula under the policy it was priced with (snapshot) | | policy name and version |
| Formula under the policy in force now | | |
| Paid, from the ledger | | vouchers and months |

Each difference gets a cause in words, one of:
- `inputs_changed`: the claim's figures now price the paper differently from
  what it was priced at (something the price depends on was edited after).
- `policy_changed`: agrees with its own snapshot; today's policy would give
  another figure. Expected, never a fault.
- `threshold`: the research threshold took ₹X; expected.
- `manual_override`: a super admin entered the amount (data fix or claim edit),
  with who and when from the audit log.
- `old_erp`: brought from the old ERP with its own sheet's arithmetic, so there
  is no snapshot; compared with today's policy.
- `imported_no_amount`: paid with no amount recorded in the import (link to the
  fix queue).
- `ledger_differs`: what the ledger shows paid is not what the claim says.
- `counted_only` / `old_quota`: paid nothing on purpose.
- `unexplained`: the amount differs and none of the above accounts for it.

Links: "Open the claim" (the review workspace for a claim at the reader's desk,
else Track), "Why this amount" (Track's sheet), "See the ledger". A super admin
sees "Fix this in the data-fix queue" (`/data/fixes`) when the cause is a hole.

## Tab 3: Check many
Recomputes every claim in the status filter (default: approved, authorised,
paid; a switch adds claims still being checked) against its pricing snapshot.
A claim with no snapshot (an old ERP import) is compared with the policy in
force, and the cause says so.

Answer: "N of M claims differ by more than ₹1" with figures: paid more than the
formula (sum), paid less (sum), net, and "left out on purpose" (counted only,
old quota, and how many differ only because of the research threshold).
Each figure filters the list below it.

Work: a table, largest difference first: claim no., who (face), paper, status,
month, recorded, formula, difference, cause, and a link to where it is fixed.
Filters: status, department, month. A footer with the totals. "Download CSV"
(same filters, `cell_safe.csv_writer`, so a title beginning `=` is safe).

Detail on demand: "Show causes (5)" lists each cause with a count and a sum.

Speed: one query for the claims, one for SEC reference counts, one for ledger
sums, one for override audit rows; the rest in memory. Target under 2 s for the
whole college; measured in `test_calculator.py` on 3,000 claims and reported.

## Where it is
- `/calculator` in `PAGES` (`app/nav.ts`), roles = the six above, keywords
  "calculator", "how much", "price", "remuneration", "check amount", "what
  should this pay".
- Admin hub, Money group. Money hub (Principal, Director, Finance). The
  research cell's Claims "Also look at" list.
- The Policy page keeps its worked example and gains "Open the full
  calculator".
- Deep links: `/calculator?tab=claim&q=FP-2026-000123`,
  `/calculator?tab=many&stage=paid`.

## Not built
- Nothing on this page repairs a claim. A mismatch links to the data-fix queue
  or the claim.
- No what-if on unpublished policy drafts (the Policy page's editor has that).
