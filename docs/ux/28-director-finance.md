# 28. The Director's and Finance's desks: deliberation, targets, design

Owner brief (2026-10-01): "Run a deep contextual agent for every type of view... every aspect:
landing, every button, settings, all of that. Add, rework, make it exponentially better... make the
jobs to be done easier and simpler; the site should look elegant and like an artwork." Later the
same day: "make every button accentuated and highlighted, remove redundant stuff, and text that
can be hidden away should be hidden."

Scope: the Director's views (Home, Authorisations and the review workspace in authorisations
mode, Money, Budget, Ledger, Monthly statements, notifications and settings as the Director sees
them) and Finance's (Home, Payments, Paid, Safeguards, the bank file, the statement PDF, and the
same Money, Budget, Ledger, Statements). Built on the foundation (docs/design/foundation-handoff.md)
and the finished sibling (docs/ux/26-research-cell.md: answer sentence, lanes, keyboard, Stamp).
The money safeguards (docs/ops/safeguards.md) are kept whole: one live payment per claim, an
idempotency key, the amount locked at authorisation, separation of duties, the bank-file record and
the Safeguards page. This round changes screens, not rules.

Skills applied: jobs-to-be-done, critique-information-density, feedback-patterns, error-handling-ux,
peak-end-rule, ux-writing, data-visualization, ui-ux-pro-max, and impeccable (new-work, critique,
layout, typeset, visualize, clarify, distill, harden, polish, craft-floor). Inspiration read first
(D:\Faculty Paper\inspiration): Stripe's payout and invoice pages and Mercury for how money states
are written (a status sentence, then the figure, then the action); Linear for the keyboard row;
Things 3 for the calm batch; museum catalogue pages and Indian cheque-voucher and file-noting
tradition for the statement as a document one signs. From the art direction: the Well-Kept
Register, the answer first, the Thread, the Stamp when something is decided.

## 1. The people and their jobs

**The Director** opens the app when the Principal has approved a batch, a few times a month, and
once at month end to sign the statement. On a phone as often as at a desk. Not an accountant: they
want to know they are not authorising money the college does not have, or money that is wrong.

**Finance** works to a calendar, not a queue: a monthly run and a few off-cycle payments. The job
is exactness: the right amount, once, to the right person, with a voucher, and a file the bank
accepts; then a statement the Director signs.

| Session | Who, when | The one question | What ends it |
|---|---|---|---|
| **Authorise the batch** | Director, when the Principal has signed a batch | "How much is it, what does it do to the budget, is anything odd?" | The batch authorised; Finance notified; a Stamp |
| **Decide one claim** | Director, from a notification or the list | "Can I authorise this one?" | Authorised in the workspace; the next claim opens |
| **Pay the run** | Finance, pay day and month end | "What is payable, what is blocked, does the budget cover it?" | Paid once each, with a voucher |
| **Release the month's paper** | Finance, right after the run | "Does the file equal what I paid, and is the statement ready to sign?" | Bank file downloaded and recorded; statement PDF in hand |
| **Sign the statement** | Director, month end | "What went out, to whom, does it add up?" | The signed A4 sheet |
| **Look at the year** | Both, a governing-body or audit question | "What did we spend, on whom, against what?" | An answer, a CSV |

Jobs-to-be-done statements (situation, motivation, outcome):

1. When the Principal's batch arrives, I want to see in one look what it comes to and what it does
   to the year's budget, so I can authorise the clean ones without opening each.
2. When a claim is odd (the research threshold cut it, a long wait), I want that said beside the
   amount, so I authorise the figure that will actually be paid.
3. When I am in a claim, I want Authorise right there, so I do not go back to a list to act.
4. When it is pay day, I want to pay the whole run in two moves, so the day goes to the exceptions.
5. When the run is done, I want the bank file and the statement one move away, so I never hunt for
   them and never produce the file twice by accident.
6. When I sign a month, I want a statement that reads like a document, with the total in figures
   and in words, so my signature is an informed one.

## 2. Two journeys (service blueprint)

```
JOURNEY 1: Authorise this week's batch (Director)
Stage        Notice                  Judge                          Decide               After
-----------  ----------------------  -----------------------------  -------------------  ---------------
DIRECTOR     badge on Authorisations "6 claims, ₹3,15,370, wait"    Authorise all        sees Stamp,
(does)       or a notification       "leaves ₹X in the budget"      (or one, or select)  list is empty
-------------------------------------- line of visibility ------------------------------------------
SCREEN       Home: one sentence,     budget strip: paid | already   dialog repeats the     Home says
(shows)      the Thread, the strip   committed | this batch | left   figure and the         "Nothing is
                                                                    left; Enter confirms  waiting"
-------------------------------------- line of internal work ----------------------------------------
SYSTEM       counts, wait days       threshold-reduced amounts      amount locked at     Finance's
(does)       from the queue          already in each row            authorisation        queue grows
Failure      amount moved (409)      own claim (no button)          calc error: the row  budget not set:
points                                                              cannot be authorised "not set", no bar

JOURNEY 2: The month-end run (Finance, then the Director)
Stage        Pay                       Release                       Sign               File
-----------  ------------------------  ----------------------------  -----------------  ----------------
FINANCE      Pay all N (one dialog)    bank file (CSV), once         statement PDF to   ledger agrees
(does)       3 checks in words         recorded against the rows     the Director       with statement
SYSTEM       one live payment per      BankExport row; a second      statement reads    Safeguards
(does)       claim, key per batch      file needs a reason           the ledger         nightly check
Failure      already paid; amount      already exported (409):       a line to explain  Safeguards page
points       changed since authorised  "new only" or "again, why"    before signing     says what
```

State machine (the money end only; the claimant's four stages are a view of it):

```
PRINCIPAL_APPROVED --Authorise (amount locked)--> DIRECTOR_APPROVED --Pay (voucher, once)--> PAID
PRINCIPAL_APPROVED --Send back (super admin standing in; reason)--> CLEARED (Principal again)
PAID --Undo (super admin, reason, reversing row)--> CLEARED
Guards: not your own claim; amount recomputed at each step; authoriser is not the payer
(a super admin standing in needs a recorded reason); a month's bank file is recorded once.
```

## 3. Targets (measured by a scripted Playwright walkthrough; numbers in section 11)

| # | Target | Before (this build, 886720b) | Goal |
|---|---|---|---|
| T1 | Authorise a clean batch, from the Director's first screen | Authorise all, confirm: 2 actions (but only on Home, and only if every claim is on the first page); from the queue: 3 | **2 actions** from Home or the queue (button, confirm) and **1 keystroke + Enter** from the keyboard |
| T2 | "What does this do to the budget" visible before authorising, without a click | Home sentence only; the queue page has it below the table; the confirm dialog has none | **0 clicks and in the first screen** on Home, the queue, the confirm dialog and the workspace bar, at 1440 and 390 |
| T3 | Authorise one claim from inside the workspace | impossible (the bar says "decisions are made from the list"): back, click, confirm = 3+ | **2 keystrokes** (`a`, `Enter`) |
| T4 | Month-end run: pay, bank file, statement | Home, Pay, tick all, Pay, confirm, bank file, statement = 6 to 7 | **at most 5** (target 4: Pay all, confirm, bank file, statement) |
| T5 | Sign the statement (Director) | Home, Statements, month, PDF = 3 | **1 action** from Home once a month is paid |
| T6 | The answer on Home is a sentence the person reads without a click | four figures plus a paragraph | one sentence, biggest thing on the page, with the budget effect in the next line |
| T7 | Every action reads as a button; one primary per screen | link-styled "All 6 in Payments", "Open the budget", "Open in the ledger" | **0 text-link actions** in the views; 1 primary |
| T8 | Redundant words | the budget over-run is said four times on Budget; "never paid twice" boilerplate on four pages | each fact **once**, the rest behind a Details |
| T9 | 390 px | no horizontal scroll; first action within the first screen | unchanged, verified light and dark |
| T10 | Contest-blind | no flag, watch-list, duplicate finding or contest note on any screen | unchanged: **0**, asserted in tests |
| T11 | The statement PDF | A4, DejaVu Sans, one weight of grey rule, signatures at the end | a typeset document: serif title, tabular figures in a measured column, total in words, a signature block that never splits, 1 page for up to 18 payments |

## 4. Critique of today's screens (screenshots first)

Before screenshots, `D:\Faculty Paper\audit-shots\views\director-finance\`: `before_l_d_*.png`
(Director, 1440), `before_l_m_*.png` (390), `beforeF_l_d_*.png`, `beforeF_l_m_*.png` (Finance).
Method: impeccable critique by hand, then DOM measurements. The previous pass (docs/audit/
director-finance/) fixed the *content* of each page; this pass is about the *form*, the kit, and the
two jobs that were still three or four moves long.

Findings, worst first:

1. **The decision has no home in the workspace.** The Director opens a claim from a notification and
   the bar says "Decisions at your desk are made from its list". The one person whose single act
   is Authorise cannot do it where they are looking. (Fitts, and the sibling's lesson: the verb
   belongs where the evidence is.)
2. **The budget effect is a paragraph.** On Home it is a sentence under four figures; on the queue
   it is a panel below the table; in the confirm dialog it is absent. The question "what does this do
   to the budget" is the Director's whole reason to exist and it is answered in the smallest type on
   the page, in a different place each time. It is a picture (a bar with four parts) and it should be
   the same picture everywhere.
3. **Home is four figures plus a paragraph, no thread.** The foundation's answer is a sentence
   (docs/design/foundation-handoff.md, Director) and the Thread with "Your desk" at Approved; neither
   is used. The per-row "Authorise" button on Home is a link to the queue (a second move to do what
   its label says).
4. **The queue repeats the strip.** Header with a picture, a two-line sub, an "own papers" note, three
   figures with hints, a banner repeating the count, a one-line note about the Principal, then the
   table: five things say "6 are waiting" before the first row. The table is 8 columns (claim
   number, claimant, paper, journal with quartile chip, waiting, amount, approved, action) with the
   journal truncated in three lines; the claim number is as loud as the person.
5. **Finance Home pays by travelling.** "Pay 6 claims" is a link to Payments, where the person ticks
   all six and presses another Pay and then confirms: the same job in three moves.
6. **After the run the paper is a hunt.** The bank file and the statement are downloads on the
   Statements page; the run's result dialog offers them, but Home, Payments and Paid do not say
   whether the month is released. The danger case (a second bank file) is guarded by the server and
   explained only at the moment of the second download.
7. **Statements is a document of prose.** Four figures, a sentence in words, a paragraph about the
   bank file, an "Against the ledger" list of four lines with a footnote and a caution box. All
   true; most of it is for the person who is *not* signing.
8. **Links where buttons should be.** "All 6 in Authorisations", "Open the budget", "Open in the
   ledger", "All months", "Build a report", "See what has been paid" read as footnotes; the owner
   asked for every action to read as a button.
9. **The PDF is a form, not a document.** DejaVu Sans at 7.5 pt in a banded table, a left-aligned
   title in bold sans, no month in the largest type, the total below the table in the same size as
   the body, a reconciliation sentence in 7.5 pt and a signature row with three bare rules. It prints
   correctly and looks like a database dump.
10. **Safeguards (Finance)** is right but the first thing a Finance officer sees on a fresh database
    is "The checks have not run yet" and no way to run them (only a super admin may); the page says
    who to ask. Kept, with the sentence made specific.
11. Right and kept: the whole-queue totals from the server, the threshold beside each amount, the
    three checks in the Pay dialog, the bank-file record and its dialog, Undo with rupees, "ERP-"
    legend once, no flag anywhere, Ctrl K reaching every page.

## 5. Two concepts (parallel-concepts)

### A. The Signature Desk (chosen)

One sentence is the answer, with the budget as one drawn strip directly under it. The batch is the
work: faces, amounts, one verb. The same strip returns in every place the money decision is made (the
queue's header, the confirm dialog, the workspace bar), so the person learns it once. Finance's Home
is the mirror: one sentence ("6 claims, ₹2,18,460, are ready to pay"), the same strip showing what
paying leaves, one primary that opens the run in place; after the run, a **Month's paper** block that
says in words whether the bank file has gone and the statement is ready. The statement is a typeset
document. Everything explanatory (how a payment is checked, what the bank file holds, how the
threshold works) sits behind a "Why?" disclosure.

- Hicks: one primary per screen; the rest are secondary buttons or hidden.
- Fitts: Authorise and Pay are in the thumb zone on a phone (a bar pinned to the bottom of the
  workspace; the batch button is full width under the sentence).
- Peak-end: the Stamp on Authorise and on Pay is the peak; the end is the statement in hand.

### B. The Budget Console

The budget is the page: a big chart of the year with the queue as a sidebar list. It answers "can we
afford it" best, but the Director's *job* is a decision about claims, and a chart-first Home makes
the batch a footnote. Finance would get a second console of the same shape. It also invites the
four-tile dashboard the brief rules out. Rejected; its one good idea (the year as a picture) is kept
as the strip and on the Budget page.

**Choice: A.** It is the shorter path in both journeys, it reuses the kit's answer and thread, and the
strip is the single new element, drawn once and reused.

## 6. Wireframes

```
DIRECTOR HOME (1440)                                        DIRECTOR HOME (390)
 Good morning, Dr. Name                    [ Authorise all 6 · ₹3,15,370 ]   Good morning
                                                                              6 claims, ₹3,15,370,
 6 claims, ₹3,15,370, are                              (plate 120)            are waiting for you.
 waiting for your signature.                                                 [ Authorise all 6 ]
 That leaves ₹X in the 2026-27 budget.                                       ▬▬▬▬▬▬▬▬░░░░  strip
 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░                                        Filed ·Checked·●Approved
 Paid ₹31.9L · Committed ₹4.1L · This ₹3.2L · Left ₹X                         ...rows (face, paper, ₹, [Authorise])
 Filed   Checked   [Approved]   Authorised   Paid     (Thread)
                    Your desk
 Waiting longest                                  [ All 6 in Authorisations ]
  (face) A study of ...    ₹44,550   52 days   [ Authorise ]
 ...
 The month's statement      Sep 2026 · ₹4,53,345      [ Statement to sign (PDF) ]
 Show where every claim is     Show what the college researches     Your own papers

AUTHORISATIONS (1440)
 Authorisations                                       [ Authorise all ready · ₹3,15,370 ]
 6 · ₹3,15,370 · longest 52 days (Answer, 3 figures)  strip: what authorising does to the budget
 [ search ] [ department ] [ sort ]                   (filters one row; "Clear" when set)
 Ready to authorise (6)                                          choose all  [x]
  [ ] (face) Dr. Anitha Raman · EEE         A study of EV ...      52 days  ₹44,550   [ Authorise ]
  ...                                       FP-2026-000012 (quiet meta)
 Needs a look (n)  -- amount not worked out: no Authorise, says why
 Show waiting by department   Show how this desk works

WORKSPACE BAR (Director)                                    (super admin standing in adds Send back)
 [ Authorise ₹44,550  a ]  [ Send back  s ]    ▬▬▬▬▬▬░░  ₹4.2L left after authorising   2 of 6   ↓
 own claim: "This is your own claim. Another officer decides it." (no buttons)

FINANCE HOME                                                MONTH'S PAPER (Home and Payments)
 6 claims, ₹2,18,460, are ready to pay.                      Sep 2026   ₹4,53,345 in 15 payments
 Paying them leaves ₹X in the budget.   [ Pay all 6 ]         1 Bank file       Not yet released  [ Bank file (CSV) ]
 strip                                                        2 Statement       Ready to sign     [ Statement to sign (PDF) ]
 Thread (Your desk at Authorised)                             "Agrees with the ledger" / "1 line to explain" [ Review ]
 Next to pay ... (face, ₹, days, [Pay])

STATEMENT PDF (A4)
 Saveetha Engineering College                       (serif, 15 pt, left)  | month in Display (serif 28 pt)
 Research publication incentive: payment statement   Statement no. 2026-09  |  Prepared 1 Oct 2026
 ─────────────────────────────────────────────────────────────────────
 ₹4,53,345            15 payments · 11 people · 5 departments   (figure serif, tabular)
 Rupees Four Lakh Fifty Three Thousand ... only
 [ table: staff id, name, department, paper, voucher, amount ]  hairline rows, right-aligned money
 By department (small table)   Against the ledger (3 lines, plain)
 Prepared by (Finance)    Authorised by (Director)    Approved by (Principal)
 (signature rules, name, date)                    page n of N  ·  figures read from the ledger
```

The strip (`BudgetStrip`, one component, four places): a bar the width of the allocation split in the
order the money moves: **Paid** (navy ink), **Already committed** (navy wash), **This batch** (clay),
**Left** (the empty track). Labels sit beneath their segments (direct labels, no legend); numbers are
the segment values; the sentence above it says the one fact. When the allocation is exceeded the bar
is full, the over-run is a crimson tick past the end with the word "over", never colour alone. When
no allocation is set it is replaced by one sentence and a "Set the allocation" button for Finance.

## 7. Copy (docs/ux/19 vocabulary: Authorise, Pay, Send back, statement)

| Where | Text |
|---|---|
| Director Home sentence | "6 claims, ₹3,15,370, are waiting for your signature." / "Nothing is waiting for your signature." |
| Budget line | "Authorising them leaves ₹X in the 2026-27 budget." / "They take the 2026-27 budget ₹X over." / "No budget is set for 2026-27." |
| Primary | "Authorise all 6 · ₹3,15,370" (confirm: "Authorise 6 claims, ₹3,15,370"; toast stamp: "Authorised", "6 claims, ₹3,15,370, released to Finance.") |
| Row | "Authorise" (toast stamp "Authorised") |
| Workspace bar | "Authorise ₹44,550" / "Send back" (super admin only) |
| Own claim | "This is your own claim. Another officer decides it." |
| Finance Home sentence | "6 claims, ₹2,18,460, are ready to pay." / "Nothing is ready to pay." |
| Month's paper | "Bank file: not released" / "Released 3 Oct by Name"; "Statement: ready to sign"; "Agrees with the ledger" / "1 line to explain" |
| Pay | "Pay all 6 · ₹2,18,460"; confirm "Pay 6 claims, ₹2,18,460"; stamp "Paid" |
| After the run | "Paid 6 of 6." then "Bank file (CSV)" and "Statement to sign (PDF)" as buttons |
| Why (hidden) | "How a payment is checked", "What is in the bank file", "How this desk works" |
| Empty (Director) | "Nothing is waiting for your signature." + "The Principal's next approvals appear here." |

## 8. Removed or hidden in this pass (the owner's later direction)
## 8. Removed or hidden in this pass (the owner's later direction)

Rule applied: one title, at most one short purpose line; a fact is said once; explanation sits
behind a disclosure; every action is a button, one primary per screen.

| View | Removed | Hidden behind a disclosure | Link turned into a button |
|---|---|---|---|
| Director Home | the four figures and the paragraph under them (the sentence and the strip say it); the "largest three" links; the research-threshold paragraph (each row carries it); the page sub | what the college researches; "Where every claim is" is now always shown but is the Thread, not a list | All 6 in Authorisations, All months, Build a report, Open |
| Authorisations | the header picture caption line, the "own papers" note, the "approved by the Principal" note, the banner repeating the count, the 8-column table, the quartile chip on every row, the Principal's-question note | what is waiting by department; how this desk works (own papers, forward-only, keys); a note field in each dialog; the claims list in the batch dialog | Clear filters |
| Review workspace (Director) | the cell's verdict ("Nothing to look at", "Every check passed") | none | Authorise, Send back are the bar |
| Finance Home | the four figures, the partial-total box, "Where everything is" list | the research-threshold sentence is one line under the strip | All 6 in Payments, All months, See why |
| Payments | the two-sentence sub, the "own papers" paragraph, the explanation under "Ready to pay" and "Held up" | how a payment is checked, own papers | See what has been paid, Select all, Clear selection |
| Pay dialog and run | "Month paid" and claim-count figures (the total says it), the long description, the Stamp twice | voucher numbering; the claims paid (after a clean run); what is in the bank file | Statement, Open the statement |
| Paid | the sub, the "Finance cannot undo" paragraph above the table | who can undo a payment | Open the statement, Open in the ledger, Export, Print, Clear filters; Undo is a danger button |
| Statements | the sub, four figures, the words under them as a line of its own, the bank-file paragraph, the "against the ledger" block when it agrees, the year line, the "where it was recorded" chip on every row | the month by department; how this agrees with the ledger | Open in the ledger, the ledger checks |
| Money | the sub, the four figures, every row's purpose sentence, the group blurbs | none | every row ends in an Open button |
| Budget | the sub, the dates line, the over-the-allocation callout, the no-allocation callout, the chart's duplicate caption, the departments count | none | Change the college allocation |
| Ledger | the sub, the "to N people" clause, the duplicates link | how the ledger works | possible duplicates to review (super admin only) |
| Safeguards | "in 2 seconds" | already behind Details | none |

## 9. Build notes

- **One new picture, reused: `BudgetStrip`** (`pages/budget-strip.tsx`). Paid, also committed, this
  batch, left; the batch is carved out of "committed", never added to it (the Budget page counts
  everything from Cleared on). It is on Director Home, Authorisations, the authorise confirm, the
  review bar, Finance Home, Payments, both pay dialogs, Money and Budget. `budgetLine` says the same
  fact in words. Unit tests in `budget-strip.test.ts`.
- **Director.** `home-director.tsx` (sentence, strip, rows with Authorise in place, Thread,
  the month's statement); `authorisations.tsx` (two lanes, one primary, keys `j k x Enter a A`);
  `authorise-dialogs.tsx` (authorise, send back, batch; the dialog opens with the button focused, so
  Enter confirms); `review/authorise-bar.tsx` and `review/director-verdict.tsx` give the workspace the
  Director's own bar and verdict. `review-workspace.tsx` and `review-panel.tsx` each changed by two
  lines. Send back exists for a super admin standing in only, as the server requires.
- **Finance.** `home-finance.tsx`; `payments.tsx` split so `pay-dialogs.tsx` holds the single and the
  batch dialogs and both Home and Payments open the same ones (Home opens the whole run in place when
  the queue is fully loaded, else it links); `month-paperwork.tsx` is the month's paper on both Homes.
- **Statements and the PDF.** `statements.tsx` leads with a sentence and the files. The PDF
  (`services/payout_statement.py`, `services/pdf_fonts.py`) is typeset in Brygada 1918 and Inter,
  static instances of the web fonts with the rupee merged and tabular, lining digits set as the
  default digits (reportlab runs no OpenType features); fonts and licences are in
  `core/assets/fonts`. The total is the table's last row, the signature block travels with a sentence
  restating the total, and every page says "Page n of N".
- **Kept whole**: every safeguard in docs/ops/safeguards.md (idempotency key, `pay-check`, amount lock,
  separation of duties, bank-file record, undo by a super admin only). The only backend change is the
  PDF.
- **Notifications and settings.** Unchanged: shared with every role. The server sends the same
  preference kinds to everyone (none for "a claim waits for you"), so a Director-specific list needs a
  backend kind first; recorded as an open item, not guessed. No flag or watch-list text appears on
  either role's notifications (asserted in the walkthrough).
- **Left for others**: the sibling Principal and Admin views use `QueueTable` and the shared decision
  bar; nothing in them was edited.

## 10. What changed, by view

Director Home, Authorisations and the review bar, Finance Home, Payments (and its two dialogs), Paid,
Monthly statements (and the PDF), Money, Budget, Ledger, Safeguards: each as in sections 6, 8 and 9.
Screenshots (light and dark, 1440 and 390): `D:\Faculty Paper\audit-shots\views\director-finance\`
(`before_*`, `beforeF_*`, then `x_*`, `xF_*`, `dialog_*`, `stamp_*`, `stmt-*.pdf`).

## 11. Measured

Scripted Playwright walkthrough on a copy of the real data (6 claims waiting for the Director, 6 for
Finance), 1440 px unless stated. Script: scratch `walk.mjs`.

| # | Target | Before | Measured after |
|---|---|---|---|
| T1 | Authorise a clean batch from the first screen | 2 (Home only) to 3 (queue) | **2 actions** (button, Enter), 2.4 s including the request; the queue is also 2 |
| T2 | Budget effect visible with no click | Home only, small type | **yes**, in the first screen of Home, the queue, the confirm and the workspace bar at 1440 and at 390 |
| T3 | Authorise one claim in the workspace | not possible | **2 keystrokes** (`a`, Enter), 0.6 s |
| T4 | Month-end run: pay, bank file, statement | 6 to 7 | **4 actions** (Pay all, confirm, Bank file, Statement); files `bank-upload-2026-10.csv`, `payout-statement-2026-10.pdf` |
| T5 | Director signs the statement | 3 | **1 action** from Home |
| T6 | The answer is a sentence | four figures and a paragraph | sentence on both Homes and on Statements and Money |
| T7 | Link-styled actions | about 14 | **0** in these views; one primary each |
| T8 | Redundant words | see section 8 | removed or behind a disclosure |
| T9 | 390 px | no overflow | **no horizontal overflow** on every route, light and dark |
| T10 | Flags or watch-list text | none | **none** on 8 Director routes and 8 Finance routes |
| T11 | PDF | DejaVu 7.5 pt, banded | typeset; 15 payments in 2 pages, 11 in 2, the signature never on a page alone; fonts embedded |

Checks: `npx tsc -b` clean; `npm run audit` clean (clarity 0); `vitest run src/pages` 95 files,
680 tests pass; `core.test_payout_statement` passes.
