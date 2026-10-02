# 27. The Principal: deliberation, targets, design

Owner brief (2026-10-01): "Make the jobs to be done much easier and simpler; the website should look
elegant and like an artwork." And earlier: "What's the actual job to be done by the Principal when she
views the report?" She approves with confidence, knows whether the college is better than last year and
where, knows which departments need a push, and knows what goes into the governing council, NAAC and
NIRF pack.

Scope: every view the Principal sees. Home; Approvals (the queue, the batch, the row decisions); the
review workspace in approvals mode; Reports hub; the year brief; Departments and one department; Papers
behind a figure; Analysis; Build a report; Accreditation (NAAC 3.3.1 and NIRF); Publications (claims);
Money hub, Budget as she reads it, Monthly statements; the council pack (PDF) and the downloads;
Notifications and their settings. Built on the foundation (docs/design/foundation-handoff.md) and the
finished sibling, the research cell desk (docs/ux/26).

Skills read and applied (SKILL.md files; no skill scripts were run): jobs-to-be-done (functional,
emotional and social jobs, job stages), peak-end-rule (the Stamp and the desk-clear state), 
critique-visual-hierarchy and critique-information-density (the critique table in section 4),
readable-measure (a 40 rem text column; the brief's sentence under 75 characters a line),
data-visualization (the simplest chart that carries the finding, a zero baseline for bars, direct labels,
a table beside every chart, never colour alone), ux-writing (verbs on buttons, the toast repeats the verb,
a zero says what it means), presentation-deck and design-impact-reporting (the order of the pack: the
answer, the evidence, the ask; and the before/after case in section 12 with baseline, change, caveat),
ui-ux-pro-max (its priority list: accessibility, touch size, no sideways scroll, charts not by colour
alone), parallel-concepts, and the impeccable references (new-work, critique, layout, typeset,
visualize, clarify, distill, delight, polish, craft-floor). Fitts and Hicks are applied from the research
cell document's use of them (the common action first and large; fewer choices before the first claim).

Inspiration read first (D:\Faculty Paper\inspiration, 52 captures; not in the repository):

- **The Pudding, Our World in Data, Quanta, Distill** (editorial): a sentence that carries the finding, a
  chart with its caption beneath, a measure you can read. Taken: the year brief is a typeset article,
  not a dashboard; every chart has a one-line finding as its caption.
- **Nature, eLife** (editorial authority): a black rule, a serif headline and a strict column rhythm give
  authority without a single box. Taken: the council document's masthead and ledger rules.
- **Stripe docs, Linear** (calm density): hairlines, tiny precise type, one row is the cursor. Taken: the
  approval lanes and their keys.
- **Wellcome, Cambridge** (funder and university voice): sober navy and warm grey, a short rule under the
  heading, flat illustration used as editorial art. Taken: how a college addresses a governing body.
- **MoMA, Natural History Museum** ("open today 10:30 to 5:30" as the first line): the answer comes
  before the explanation. Taken: Home opens with the one sentence about the day.
- **Things 3, Notion Mail** (a done state that feels done): Taken: the desk-clear moment.

From docs/design/art-direction.md: the Well-Kept Register; the answer is the biggest thing on the page;
the Thread; the Stamp on a decision; "the year is one sentence or one dot field, not three blocks".

## 1. Who she is, and the real job

The Principal of Saveetha Engineering College. A few visits a week, four minutes each, between meetings,
most often on a laptop in her office and sometimes on a phone. She signs two pieces of paper outside the
app (the approval and the council pack); the app has to hand her what she signs, finished.

The job is not "view reports". It has two halves with different rhythms:

| Half | Cadence | The one question | What ends it |
|---|---|---|---|
| **Decide the spend** | Several times a week | "Is there anything I can approve, and is any of it wrong?" | The claims she cleared are stamped Approved, or sent back with a reason |
| **Answer upward** | Monthly (council), yearly (AQAR, NAAC, NIRF) | "Are we better than last year, where, who needs a push, and is the pack ready?" | A PDF she can hand over and an Excel in NAAC's layout |

Jobs-to-be-done (situation, motivation, outcome), including the emotional and social dimension the
earlier jtbd document (docs/jtbd/principal.md) left implicit:

1. When claims the research cell has cleared are waiting, I want to approve the clean ones at a glance
   and look hard only at the odd ones, so that the money moves without my having read forty files twice.
   *Emotional: confident that I have not let something wrong through. Social: that no claimant waited on me.*
2. When I open the app between meetings, I want to know in one sentence whether anything is mine to do,
   so that I can leave. *Emotional: relief on "Nothing is waiting."*
3. When the council meets, I want the year against the last in one honest sentence with its evidence, so
   that I can say "up 13.8%" and be asked "of what?" and answer. *Social: that I am the person who knows
   the numbers and where each came from.*
4. When a department looks weak, I want its story in one step (its people, its five years, who heads it),
   so that I can call the head with something specific. *Social: a fair conversation, per teacher, never
   by size.*
5. When NAAC or NIRF is coming, I want to know what would weaken our figure and who must fix it, so that
   the IQAC submits something an assessor cannot dent.
6. When I quote a number, I want to open the papers behind it, so that I never repeat a figure I cannot
   defend.

Job stages for "decide the spend" (JTBD stages): define (what is waiting), locate (the lists), prepare
(look at the odd ones), confirm (the amount shown is the amount approved), execute (stamp), monitor (the
Director has it), conclude (the desk is clear). The old build served *execute* well and *define* and
*conclude* poorly.

## 2. A journey for each session

### A. "Approve today's claims" (a Tuesday, 11:40, between meetings)

```
Step          Opens the app         Reads the answer       Approves the clean     Looks at the odd one     Leaves
------------  --------------------  ---------------------  ---------------------  -----------------------  ----------------------
Does          Home                  "10 claims, ₹9.6       "Approve the 10        opens the one with       closes the laptop
                                    lakh, are waiting.     ready": one button,    "open flag"; sends it
                                    All 10 are ready."     one dialog, Enter      back with a reason
Thinks        "Anything on me?"     "Fine; nothing odd"    "I know what I am      "Why is it flagged?"     "Done; nothing waits
                                                           signing"                                         on me"
Feels         low-grade dread       relief                 control                curiosity                accomplishment
Old build     Hello, Principal and  Four equal figures;    Home > Approvals >     No decision bar in the   Empty page with a
              four figures          you must infer         "Review the 10         workspace; go back to    second plate
                                    "ready"                ready" > confirm       the list
Pain          nothing says if she   "ready" is only on     three clicks, two      a claim is opened and    no end
              can just approve      another page           pages                  cannot be decided there
```

Peak: the Stamp landing on the batch. End: the desk-clear state, which turns the page to the year (the
only thing left to know), so the visit ends on a finding, not on an empty list.

### B. "Monthly council meeting" (the evening before; or the yearly AQAR)

```
Step          Home                   Brief                   Departments to call        Pack check               Download
------------  ---------------------  ----------------------  -------------------------  -----------------------  ------------------
Does          sees the year column   reads the one-page      opens CIVIL: its people,   "4 to settle": budget    "Download the
              (+13.8%, five years)   document; each number   five years, the head       not set, 208 papers      council pack":
                                     opens its papers                                   with no department       one PDF
Thinks        "Better. Where?"       "Can I say this?"       "Who do I call?"           "Is it ready?"           "Print it."
Old build     Year at the bottom of  PDF had a brief only    the dept page had no       checks existed, not      PDF: two pages, no
              Home, below the queue  (no money, no NAAC)     head, no face              linked to who fixes      money position
```

## 3. Targets (measured by a scripted Playwright walkthrough; numbers in section 12)

| # | Target | Before (build 39f65d6) | Goal |
|---|---|---|---|
| T1 | Approve a clean batch, from opening Home | 3 clicks and a page change (Home > Approvals > "Review the 10 ready" > confirm) | **2 actions**, no page change: the Home button, then Enter in the dialog |
| T2 | Approve one claim from Home | 3 (open Approvals, row Approve, confirm) | **2** (row Approve, Enter) |
| T3 | Decide inside the review workspace | impossible: the foot says "Decisions at your desk are made from its list" | **2 keystrokes** (`a`, `Enter`) to approve; `s`, type, `Ctrl+Enter` to send back; never on her own claim |
| T4 | "Are we better than last year, and where?" on Home | the year is a block at the bottom, 1,200 px down | **0 clicks and 0 scrolls** at 1440: the verdict, five years and the departments to call are on the first screen |
| T5 | The council pack | a 2-page PDF of the brief only; budget and NAAC on other pages | **1 click**, one PDF: the answer, the departments, the money position, NAAC 3.3.1 |
| T6 | A department's story | Reports > Year brief > scroll a table > row (4 steps) | **1 click from Home**, 2 from anywhere: the head's face, the five years, the people |
| T7 | A running year is never drawn or worded as a fall | the brief page and the departments page are honest; Build a report's year line ended in a fall; Analysis not checked | every chart that has a running year shows it hollow and labelled "to date", and nothing compares it with a full year |
| T8 | Every figure opens its papers | brief figures yes; Home figures only the count | each figure on Home, the brief, a department and accreditation is a link to its list |
| T9 | Phone | Approvals needs 5 fields and two paragraphs before claim one | at 390 px the first claim is in the first screen; no sideways scroll on any view, light or dark |
| T10 | Her own claim | server refuses; the workspace shows a note | unchanged and tested: no Approve is ever drawn on her own claim, and the server still refuses |

## 4. Critique of today's screens

Before screenshots: `D:\Faculty Paper\audit-shots\views\principal\before\` (18 views at 1440 and 390,
light, plus the workspace). Method: impeccable critique by hand, critique-visual-hierarchy and
critique-information-density on the rendered pages, and DOM reading. The previous audit
(docs/audit/principal/) fixed what was *wrong* (dead figures, a fall that had not happened, no
department page). This pass is about what is *not yet designed*.

| Dimension | Home | Approvals | Brief | Hub, Departments, Accreditation, Money |
|---|---|---|---|---|
| Entry point | "Hello, Principal" and a 168 px stamp picture; the figure strip is the same size as the title | the title and a second paragraph about her own papers | the serif paragraph is the entry; good | four equal figures again |
| Eye flow | down a column of four figures, a list, a brief block | title, refresh, count, six filters, a banner, keys, a table | sentence, four figures, checks, table | title, strip, list |
| Weight | the answer is a strip, not the biggest thing | the primary button (Review the 10 ready) is smaller than the filters | one voice | the same template on every view |
| Emphasis | three competing: strip, list, brief | none | the sentence | none |
| Density | eight rows plus a block plus a link | six filters before claim one; a table of seven columns where three do the work | long | long |

Findings, worst first:

1. **Home answers a question nobody asked.** "Hello, Principal" is not an answer, and the figure strip
   (10, ₹1,72,330, 41 days, 5) is the hero-metric template. Her two questions, "is anything mine?" and
   "are we better?", are answered by a strip, a list and, 1,200 px down, a paragraph. (Hierarchy: the
   entry point is a greeting.)
2. **The batch is two pages away.** The one action that matters most (approve what is clean) lives behind
   Approvals and a button called "Review the 10 ready" that opens a *confirmation*, not a review. The
   verb and the result disagree (vocabulary rule 1).
3. **The workspace cannot decide.** Opened from Approvals, the review workspace shows the paper, the
   record and "3 things to look at", and then a foot that says to go back to the list. The Principal is
   the one role that reads the evidence *in order to decide*; she cannot decide where she read it.
4. **Approvals repeats what the clerk's page solved.** One flat table of everything: the clean claims
   mixed with the ones that need her; six filters (two paragraphs) before claim one on a phone; a
   Refresh button as a header action (a status, not a task); two plates in the empty state (the header
   and the empty-state art).
5. **The reports look like reports, not like a document.** The brief is a good sentence on a page with
   four tiles and a table. A council reads paper; the page should be the paper. The PDF is a plain
   Helvetica-style sheet in DejaVu Sans with no serif, no rhythm, and it holds only the brief: budget and
   NAAC are other downloads. "The pack" is a phrase, not a file.
6. **Charts are table-shaped or absent.** The brief has no five-year picture on screen (the PDF has one).
   The department table has a bar and a tick but no college rate drawn, so "under half the college" is
   a sentence, not a shape.
7. **Nobody is named.** "CIVIL needs a push" does not say who heads CIVIL. A Principal's next move is
   a call; the head's face and name are one query away and absent.
8. **Pack checks name problems but not who fixes them.** "No budget is set" links to Budget, which she
   cannot edit (Finance and the office do). Said plainly: she can see it, and asks for it.
9. **Foundation leftovers.** `Lead` in `principal-parts.tsx` sets a serif sentence in `text-xl/2xl`
   (between 16 and 32); `Figure` strips on four pages; a numbered three-step card on Build a report;
   clay switches and a "your papers" first section on her notification settings (she is not mainly a
   claimant).
10. **Right and kept:** oldest first, the server recomputing the amount at approval (409 shows the new
    figure), per-claim skips with reasons, bulk approval that never approves at a wrong figure, own-claim
    refusal on the server, the department rules (`needs_a_push`, `rising`), the pack checks computed on
    the server, every figure a link on the brief, the Stamp in the toast.

## 5. Three concepts for Home (parallel-concepts)

### A. The morning sheet (chosen)

The desk is the answer; the year sits beside it as a narrow ledger column, so both of her questions are
answered on the first screen. One sentence leads (the claims waiting, or "Nothing is waiting" and then
the year); under it the waiting claims, face-led, each approvable in place; beside it, the year as one
finding, five honest columns and the departments to call.

```
Home, 1440 (content column 1100)

Good morning, Dr. Vijaya.                              [ Approve the 10 ready ]     (plate: the stamp and the file)

10 claims, ₹9,60,500, are waiting for you.                       <- AnswerLine (display-xl)
All 10 are ready: no flag, no duplicate. The longest has waited 41 days.      <- lead

Waiting for you                    Open Approvals (10)  |  The year, 2025                      Open the brief
------------------------------------------------------ |  +13.8%    <- Figure
(face) Dr. S. Kanagamalliga · ECE          ₹64,500     |  papers against 2024: 1,586 to 1,394
       Secure and Intelligent Indoor...    41 days     |  [five columns, 2026 hollow "to date"]
       [ Approve ]                                     |  Call about
(face) Ms. G. Arokia Nerling Rasoni ...                |  (face) CIVIL, Dr. A. Kumar: 6 papers, down 45%
...                                                    |  (face) TRAINING, Dr. S. Ravi: 0.2 per teacher
Cleared by the research cell. Approve sends them to    |  Council pack: 4 to settle   [ Download the pack ]
the Director.                                          |
```

Why: the common action is first and one click from the top; the answer is the biggest thing; the year is
neither buried nor equal to the desk; nothing is a card; it uses the kit as it was meant (Plate, AnswerLine,
Figure, a face for every name, the Stamp on Approve).

### B. The brief first (declined)

Home is the year in brief with an "approvals" strip across the top. Honest to the monthly council job,
wrong for the weekly job: the thing she does most often (approve) is the thing that gets smaller, and the
number that gets worse by itself (waiting days) would sit under a number that changes once a year. Kept:
the year verdict beside the desk, and the sentence-first brief.

### C. Two halves (declined)

"Today" and "The year" as two equal panels. Two answers is none (critique-visual-hierarchy: multiple
competing primaries), and it is the hero-metric template twice. Kept: the visual separation of the two
jobs by a hairline, not a box.

### D. The department board (declined)

Home is twenty-two departments as a field of dots with the college rate drawn through it. Beautiful and
true, but it is the report, not the day; it answers "which departments?" and nothing about the 10 claims
she came for. Kept: the idea as the shape of the Departments page (a per-teacher range with the college
rate through it).

### Choice

A. It is the only one that lets both of her jobs finish on one screen at 1440 without making either
equal to the other; it costs no new component she must learn; and it puts the fastest path for the
common case (approve the clean batch) at two actions. When the desk is empty (the end of the visit) the
sentence turns to the year ("Nothing is waiting. 2025 beat 2024 by 13.8%."), which is the right last
thing to read (peak-end).

## 6. Three concepts for the year brief

### A. The typeset sheet (chosen)

The page is a document: a masthead (the college emblem and name, the report's name, the year and the date
prepared), one display sentence that carries the verdict, a ledger of this year against last with every
base stated, five years drawn as columns with the finding as the caption, "where to look" with the head of
each department named and shown, the departments ranked per teacher with the college rate drawn through
the bars, NAAC 3.3.1, what to settle before handing it over, and the sources. It is on warm paper in a
measure you can read (the text column is 40 rem; a narrow margin column holds the notes), and it prints
as that same document: the PDF is its twin, in the same type.

### B. The scroll story (declined)

One question per screen with a large chart for each. A council reads on paper and wants the whole answer on
two pages; a story slows the scan and cannot be printed as itself. Kept: one finding per chart as its caption.

### C. The dashboard with a download (the old build, declined)

Four tiles, a table, a download. It was honest and it was flat.

### Choice

A: the owner asked for "a beautifully typeset document" and the council reads paper. The screen and the
PDF share one structure, so what she checks on screen is what she signs. The Excel keeps carrying the rows
for NAAC's layout.

## 7. The council pack (PDF), and its alternatives

The pack is one A4 PDF in the house type (Brygada 1918 for the headline and figures, Inter for the rest,
the rupee sign from a font that has it):

| Page | Holds |
|---|---|
| 1. The year | masthead; the sentence; this year against last (with bases); five years of papers and of incentives as columns; where to look (needs a push, rising, each with its head) |
| 2. The departments | every department ranked per teacher, with the college rate; the people count; paid and paid per paper |
| 3. Money and accreditation | spend against the budget (or "no budget is set"); NAAC 3.3.1 year by year with its band and its caveat; the checks left to settle; where each figure comes from |

Alternatives considered: (a) a single A4 page, rejected because the department table and NAAC cannot fit
without becoming a poster; (b) a zip of the PDF, the Excel and the CSV, rejected because "one click, one
file" is the target and she signs one sheet; (c) the brief as a slide deck (presentation-deck), rejected
for the council (they receive paper) but its order is kept: the answer, then the evidence, then the ask.
The Excel stays beside it for the IQAC ("Download the NAAC and NIRF workbook").

## 8. Wireframes

### Approvals, 1440 (the two lanes of docs/ux/26, for her desk)

```
Approvals                                                      [ Approve the 10 ready ]
10 claims, ₹9,60,500, are waiting.  [All 10 ready]          <- AnswerLine
The longest has waited 41 days. Approve sends them to the Director.

[ Search claim, title or claimant ]  [ Department v ]  [ Filters ]

Ready to approve  10 · ₹9,60,500                          j/k move  x choose  r choose ready  a approve
 [ ] (face) Dr. S. Kanagamalliga · ECE        Secure and Intelligent Indoor...    Q3  ₹64,500  41 days  Late
        ERP-RAW-3 · IEEE Xplore                                                    [ Send back ] [ Approve ]
Needs a look  0
 (each row says why: "Open flag", "Possible duplicate", "On hold", "No amount", "Needs a second signature")
```

### Review workspace, approvals mode (the decision bar, always in view)

```
<- Approvals | (face) Dr. S. Kanagamalliga, ECE | ERP-RAW-3 | o-o-.-.-.   1 of 10  ^ v
+-----------+--------------------------------------+-----------------------------------+
| rail      | the paper and its references         | 3 things to look at. ₹64,500      |
|           |                                      | [Check] Marks  Past cases  History |
+-----------+--------------------------------------+-----------------------------------+
| [ Approve ₹64,500  a ]  [ Send back  s ]  [ Hold  h ]            Cleared by the research cell, 3 Sep |
+----------------------------------------------------------------------------------------------------+
Own claim: no bar, one sentence: "This is your own claim. Another officer decides it."
```

### Year brief, 1440 (a document on paper)

```
Reports > Year brief                                  [ Download the council pack ]
The year in brief                                     Year: 2021  2022  2023  2024  [2025]  2026 to date

 ┌ the sheet ─────────────────────────────────────────────────────────────────────────────┐
 | (emblem) Saveetha Engineering College            Calendar year 2025 · FY 2025-26       |
 | Research publications and incentive spend        Prepared 1 October 2026               |
 | ─────────────────────────────────────────────────────────────────────────────────────  |
 | In 2025 the college published 1,586 papers, up 13.8% on 2024.        | margin:          |
 | 3.86 a teacher across 411 teachers; ₹1,28,65,956 paid in incentives; | The base         |
 | no budget is set. BME leads, TRAINING is lowest.                      | 449 of 1,586 have|
 |                                                                       | a quartile ...   |
 |  This year against last        2025     2024    Change                                    |
 |  Papers published              1,586    1,394   +13.8%                                    |
 |  ...                                                                                       |
 |  Five years     [ columns, 2026 hollow, "to date" ]   caption: finding                    |
 |  Where to look  Needs a push | Rising                 (each with the head's face)          |
 |  Every department  [ per-teacher range with the college rate drawn through ]               |
 |  NAAC 3.3.1 ...    Before you hand this over (4)   Where the figures come from              |
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

### Departments

One sentence, then the **range**: each department a row, a bar from zero to this year's papers per
teacher, a tick for last year, and one vertical hairline across every row for the college rate, labelled
once. Under half the rate, the bar is amber and the row says "Under half the college rate" in words.

## 9. Interaction

| Moment | Trigger | Feedback | Rules |
|---|---|---|---|
| Approve the batch | the Home or Approvals button, then Enter | the dialog lists each claim with its amount; the button holds focus; the Stamp lands in the toast; the page turns to the next answer | each claim is re-checked as it approves; a moved amount is skipped, never approved at the wrong figure |
| Approve one | row button, or `a` | confirm at the figure; the Stamp | the amount shown is the amount approved (409 re-shows the new figure) |
| Send back | row button, or `s` | a reason of at least five characters, shown to the research cell exactly as written | goes to the cell, not the claimant; no bulk send-back (every reason is its own) |
| Hold | `h` | a reason, the claim leaves the ready lane | |
| In the workspace | `a`, `s`, `h`, `j`, `k`, `1` to `4`, `?` | the bar acts on the open claim; after a decision the next claim opens | never on her own claim (no bar at all) |
| Pack check | a row in the brief | opens the place to fix it, or says who fixes it ("Finance sets the budget") | she cannot fix what is not hers |

## 10. Copy deck (docs/ux/19; no em dashes, no kickers)

| Where | Text |
|---|---|
| Home title | "Good morning, Dr. Vijaya." (first name from the account; "Good afternoon" after 12) |
| Home answer, work waiting | "{n} claims, {₹}, are waiting for you." |
| Home lead | "All {n} are ready: no flag, no duplicate. The longest has waited {d} days." / "{k} of {n} need a look before you approve." |
| Home answer, desk clear | "Nothing is waiting for you. {Year} beat {year-1}: {n} papers, up {x}%." (or "...fell short of..." with the fall in words, never colour alone) |
| Home primary | "Approve the {n} ready" ; none ready: "Open Approvals" ; desk clear: "Download the council pack" |
| Year column title | "The year, {y}" ; running year note "{y+1} is to date: {n} papers by 1 October." |
| Departments to call | "Call about" ; row "{Department}, {Head name}" ; sub "{reason}" |
| Pack line | "Council pack: {k} to settle" / "Council pack: ready" ; button "Download the council pack" |
| Approvals answer | "{n} claims, {₹}, are waiting." + chip "All {n} ready" / "{k} need a look" |
| Lanes | "Ready to approve" (hint "No open flag, no duplicate, an amount worked out.") ; "Needs a look" (reasons) |
| Batch confirm | "Approve {n} for {₹}" ; toast stamp "Approved" + "{n} claims, {₹}, sent to the Director." |
| Send back | title "Send this claim back?" ; field "Reason" ; hint "It goes back to the research cell with this note. Say what to check again." ; button "Send back" ; toast "Sent back" |
| Workspace bar | "Approve {₹}" ; "Send back" ; "Hold" ; meta "Cleared by {name}, {date}." |
| Own claim | "This is your own claim. Nobody decides a claim they filed, so another officer decides it." |
| Brief title | "The year in brief" ; sub "Are we better than last year, and where? The page the governing council reads." |
| Brief pack check, budget | "No budget is set for FY {fy}. Finance sets it, so the council cannot yet see spend against it." |
| Departments answer | "{n} departments need a push in {y}: {A}, {B} and others." |
| Accreditation answer | "NAAC 3.3.1: {x} papers per teacher over five years, band {b} of 4. {k} things could weaken it." |
| Money answer | "FY {fy}: {₹} paid, {₹} approved and waiting. No budget is set, so there is nothing to weigh it against." |
| Notifications desk first | "Waiting for your approval" ; "Sent back to you by the Director" ; "The monthly statement" ; then "Your own papers" |

## 11. What is built (per view), and what is left

| View | Built |
|---|---|
| **Home** (`home-principal.tsx`) | The greeting and one primary button ("Approve the N ready", which approves the ready lane after one confirmation, or "Open Approvals", or "Download the council pack" when the desk is empty). The answer is one display sentence ("10 claims, ₹9,60,500, are waiting for you."; with the desk empty it turns to the year). The desk's plate sits beside it, so the page is not spent on a header. Under it, the waiting claims, face-led, each approvable in place (Stamp). In the margin, **the year**: the finding (+13.8%), five honest columns with the running year hollow, the departments to call (the head's face and name where one is set, said once where none is), and the council pack with what is left to settle. Her own papers stay last. |
| **Approvals** | Two lanes (Ready to approve, Needs a look, each row saying why). One primary button. Rows approve (confirmed at the figure, re-confirmed if it moved) or send back with a reason. Keys `j k x r a s h Enter /`. Search plus one "Filters" button (the rest of the filters, sort, days and amount are behind it). The explanation, the keys, her own-papers note and the CSV are behind "Show how this works". |
| **Review workspace, approvals mode** | A decision bar that was missing: Approve (with the amount, `a`), Send back (`s`), Hold (`h`), "Cleared by ...", always in view. After a decision the next claim opens. On her own claim there is no bar, only the reason. |
| **Reports** | One sentence ("4 things to settle before the pack goes." / "The council pack is ready."), one primary button (the pack), then her six questions, each with today's answer and a real button. Look-ups and "make your own" are behind "Show more reports and look-ups". |
| **Year brief** | A typeset sheet: masthead (emblem, college, document, year, date prepared), the finding in display type, this year against last with every base stated and every figure a link, five years as three honest charts, needs a push and rising with the head to call, every department per teacher with the college rate drawn through the bars, NAAC 3.3.1. What to settle before it goes and where the figures come from are one step away. It prints as the same document. |
| **Departments** | One sentence, "Needs a push" and "Rising" with heads, the ranked table, the rules behind "why these" one step away. One department: the finding, the head (face, name, an Email button), four figures each opening its list, five years (running year hollow), the people, the journals one step away. |
| **Accreditation** | One sentence ("NAAC 3.3.1: 12.14 papers per teacher, band 4 of 4."), "4 things could weaken it", a three-line ledger of what NIRF reads, the checks (each with a button), five years. The 6,331-row paper list is behind a disclosure with its count (it is the research cell's work, not hers). |
| **Money** | One sentence ("₹23,02,959 paid, ₹1,84,330 on its way in FY 2026-27. No budget set."), one primary button (the budget), the pages as rows with a button each. |
| **Analysis, Build a report, Papers, Claims (Publications), Budget, Monthly statements, Notifications** | Header lines cut to one short line or none, the spot plates removed from non-Home views, header actions turned into buttons with one primary, the numbered three-step card on Build a report turned into a hairline panel. |
| **Notification settings** | "Your desk" leads (what waits for her), the per-kind descriptions are a hover and a screen-reader line, the email notice is behind "about email". |
| **Council pack (PDF)** | Three A4 pages in the house type (Brygada 1918 and Inter, instanced to static TrueType in `backend/core/assets/fonts`, OFL licences beside them): the year (finding, against last, five years with the running year hollow, where to look with heads), every department with the college rate, money and NAAC 3.3.1 with what is left to settle and the sources. The same dict feeds the page and the Excel. |
| **Backend** | `principal_brief`: `head` on every department, `running` (the part year, never compared), the headline split into `caveat`, `finding`, `context`, `detail` (the joined `headline` is unchanged), the budget check says "Finance sets it". `principal_reports.department_detail`: `running`. |

### What was removed or hidden (owner direction, 2026-10-01: buttons accentuated, redundancy cut, text hidden away)

Removed: "Hello, Principal" and the four-figure strips on Home, Reports, Money, Accreditation and a department
(one sentence each now); the Refresh button on Approvals; the repeated "Late" word on every row (the days carry
the tone, the hint is in the disclosure); the repeated "No head of department is set" on every row (said once under
the list); the second plate in the Approvals empty state; the "Paid per paper" column on screen (it is in the PDF);
the numbered circles on Build a report; header lines on Analysis, Build a report, Papers, Claims, Budget, Monthly
statements, Notifications; the spot plates on every non-Home view.

Hidden behind a disclosure, with the count on its door: the pack checks, the sources, the rules behind "needs a push",
the paper list on Accreditation, the journals on a department, Approvals' filters, keys and own-papers note, the more
reports and look-ups, the email notice on notification settings.

Turned into buttons: every "Open ..." link on the hubs, the pack checks, accreditation checks, "Open the brief", "All
departments", "Open Approvals (n)", "Open Track", Print, CSV and the other download formats, Choose none, Clear filters,
the notification "Open the calendar" and "Notifications" back link. One primary per screen.

### Left, said plainly

- The like-for-like year-to-date comparison (2026 to September against 2025 to September) was considered and not built:
  the record lags, so it would read as a fall that is the harvest's. The running year is shown hollow and uncompared.
- Twelve of 22 departments have a head on the roll; the rest say so once. Appointing one is the office's.
- Budget stays read-only for her (Finance and the office set it); the pack says so.
- The Track page is shared and was not changed. The Faculty directory was not in scope.
- Playwright specs under `frontend2/e2e` that look for the old "Review the N ready" button or the old Approvals table were
  not run (they need the full stack); the walkthrough below drove the real app instead.

## 12. Measured

Method: a scripted Playwright walkthrough (Chromium, 1440 px, signed in as PRINCIPAL on a copy of the real data with 10
cleared claims seeded and one of her own; `audit-shots/views/principal/`, scripts outside the repository). An "action"
is one click, one keypress or one typed phrase. Before is the build at 39f65d6; after is this branch.

| # | Target | Before | After | Met |
|---|---|---|---|---|
| T1 | Approve a clean batch from opening Home | 3 clicks and a page change (measured; 7.8 s) | **2 actions** (button, Enter), no page change, 10 of 10 approved, 4.9 s | yes |
| T2 | Approve one claim from Home | 3 | **2** (row Approve, Enter), 2.2 s | yes |
| T3 | Decide in the workspace | impossible | **2 keys** (`a`, Enter) to approve, 2.0 s; `s`, type, Ctrl+Enter to send back (3 actions, 1.7 s) | yes |
| T4 | Year answered on Home, 0 clicks, 0 scrolls at 1440 | the year at the bottom | verdict, five-year chart, "Call about" and the first department link all inside the first 900 px | yes |
| T5 | The council pack in 1 click | 2-page brief PDF, budget and NAAC elsewhere | **1 click**, one PDF of **3 pages** (year, departments, money and NAAC) | yes |
| T6 | A department's story | 4 steps | **1 click** from Home (and 2 from Reports > Departments) | yes |
| T7 | A running year is never drawn or worded as a fall | the brief was honest; Build a report's year line and Analysis were not checked | the Home, brief (3 charts) and department charts all name the running year "to date" and draw it hollow; nothing compares it with a whole year | yes |
| T8 | Every figure opens its list | brief figures only | 45 linked figures on the brief; Home, department and accreditation figures link too | yes |
| T9 | Phone | the first claim below 5 fields and two paragraphs | first claim at y 429 of 844; no sideways scroll on any of the 17 views at 390 and 1440, light and dark (68 screenshots, the script prints any overflow and printed none) | yes |
| T10 | Her own claim | server refuses | no Approve is drawn (the bar says "This is your own claim..."), the server answers 403 | yes |

Tests: backend `core.test_principal_brief` 13 tests (heads, the running year, the finding, a 3-page pack); vitest on the
touched files (principal reports and Home, the review workspace including three new Principal cases, notifications,
home-officer, the app folder) green; `npx tsc -b` clean; `npm run audit` clarity baseline 0. Updated by design:
`principal-reports.test.tsx` (strip to sentence and sheet), `home-officer.test.tsx` (new Home module),
`notifications.test.tsx` (the email notice is behind a disclosure).

Screenshots (kept outside the repository, real faces): `D:\Faculty Paper\audit-shots\views\principal\before\` (37) and
`after\` (68: 17 views at 1440 and 390, light and dark; full page in light, first screen in dark), plus the pack as
PNGs in `wip\pack-1.png` to `pack-3.png`.
