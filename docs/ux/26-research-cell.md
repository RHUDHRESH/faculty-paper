# 26. The research office desk: deliberation, targets, design

Owner brief (2026-10-01): "Make the jobs to be done much easier and simpler; the website should
look elegant and like an artwork." Earlier (docs/ux/21): the reviewer opens the PDFs, marks
issues, sends back precisely, processes many at once, sees claim numbers and past cases, and
supervises and coordinates research.

Scope: the research cell's and the research coordinator's views. Home, Claims (the clearing
queue), the review workspace, Flags, Past claims, Journals, Coordination (Desk, Monthly report,
Research coordination), Research faculty, the desk's notifications, Track as the desk sees it.
Built on the foundation (docs/design/foundation-handoff.md). Skills applied: jobs-to-be-done,
service-blueprint, user-flow-diagram, state-machine, micro-interaction-spec, fitts-law,
hicks-law, critique-information-density, feedback-patterns, loading-states, error-handling-ux,
data-visualization, search-ux, ux-writing, parallel-concepts (concept-selection) and the
impeccable references (new-work, critique, layout, typeset, animate, clarify, distill, harden,
polish).

Inspiration read first (D:\Faculty Paper\inspiration, 52 captures; not in the repository):
Linear and Superhuman for the keyboard-first list (one row is the cursor; one letter acts on it;
done means the next one is already under the cursor), Things 3 and Notion Mail for the calm
row (a face, one line, one number), museum collection pages for how a document is mounted and
captioned, the Indian file-noting tradition for how a claim's history reads (numbered notes,
initials, dates). From docs/design/art-direction.md: the Well-Kept Register; the answer is the
biggest thing on the page; the Thread; the Stamp on a decision.

## 1. The people and their jobs

Two people sit at the first desk. The **research cell** checks every claim on the facts and
clears it or sends it back. The **research coordinator** does that too, and also owns the desk's
flow (who holds what, what is late) and two scheme rules (research-faculty thresholds and
final-year project teams). docs/jtbd/research-cell.md has the 14 jobs; this is how they
collapse into four sessions.

| Session | When | The one question | What ends it |
|---|---|---|---|
| **Open the desk** | Morning, after lunch | "What is late, and what is mine?" | The first claim open in the workspace |
| **Work the queue** | Most of the day | "Can this go?" | Cleared, sent back, held, or flagged; the next claim is already open |
| **Clear the clean ones** | Twice a week | "Which of these have nothing wrong with them?" | One confirmation for the whole batch |
| **Supervise** (coordinator) | Daily glance, weekly sit-down | "Is the desk on time, who holds what, what is stuck further down?" | Claims given out; chasers sent |
| **Report and keep the rules** | Month end, year start | "What do I tell the Principal; who is research faculty; which journals do we doubt?" | A CSV; a corrected list |

Jobs-to-be-done statements (situation, motivation, outcome):

1. When a claim arrives, I want to see in one look whether it can go, so I can clear the clean
   ones without reading them twice.
2. When a claim has something wrong, I want to mark it on the document where it is wrong, so
   the claimant is told precisely and does not file it wrong again.
3. When I have a backlog, I want to clear every clean claim in one pass, so my time goes to the
   hard ones.
4. When a claimant asks, I want the claim number to find the claim in one step, with its past.
5. When I coordinate, I want to see what is stuck without opening anything, so I can chase.
6. When a journal is doubtful, I want it watched with a reason, so the next reader is warned.

## 2. A claim through the desk (service blueprint)

```
Stage        Filed            At the desk                         Decided              After
-----------  ---------------  ----------------------------------  -------------------  ---------------
CLAIMANT     files, ticks 3   (sees "Being checked")              reads the reason or  (sees "Checked")
(sees)       confirmations                                         "Checked"
-------------------------------------------- line of visibility ------------------------------------
DESK         queue row        1 open  2 compare to record  3 mark   4 decide:            Principal's
(does)       appears          the     (claim vs Scopus,   issues    Clear  | Send back   queue, or the
                              PDFs    affiliation, ISSN)  on PDF    Hold   | Reject      claimant's fix
-------------------------------------------- line of interaction -----------------------------------
SCREEN       Home answer;     workspace: rail, PDF,       marks +   Stamp, next claim   Home answer
(shows)      queue lane       verdict + record table      checklist opens                 updates
-------------------------------------------- line of internal work ---------------------------------
SYSTEM       verify against   recompute amount inside     marks     bulk-clear/clear     counts, Thread,
(does)       Scopus, price,   the same request; skip a    stored,   server re-checks the notifications
             flag watch/dup   claim whose amount moved    staff or  amount; audit row
                                                          claimant
Failure      no PDF; imported  Scopus down; amount moved   own claim (no     409 amount changed -> recompute, never
points       ERP row (no       (409); watched journal      decision bar)     clear at the wrong figure
             amount)
```

State machine (desk-side only; the claimant's four stages are a view of it):

```
SUBMITTED --Clear--> CLEARED (Principal)         SUBMITTED --Hold--> SUBMITTED + on_hold --Resume--> SUBMITTED
SUBMITTED --Send back (reason >= 10 chars)--> REJECTED (claimant edits, refiles --> SUBMITTED, "came back")
SUBMITTED --Reject outright (final)--> REJECTED + rejected_outright
Guards: not your own claim; amount recomputed before clear; watched journal skipped in a batch.
```

## 3. Targets (measured by a scripted Playwright walkthrough; numbers in section 11)

| # | Target | Before (today's build) | Goal |
|---|---|---|---|
| T1 | Clear one ready claim, from the queue | open row, c, move to the button, click: 4 actions | **2 keystrokes** (`c`, `Enter`) |
| T2 | Send back with a precise reason built from marks | mark on PDF or checklist, `s`, edit, click | **under 60 s**, reason prefilled, `Ctrl+Enter` sends |
| T3 | Process 20 ready claims in one pass | filter, review the ready, confirm | **under 2 min**, 3 actions (`a`, `c`, confirm) |
| T4 | Find a claim by number | type in the queue search (only queued claims) | **1 step** from anywhere (Ctrl K, number, Enter), including paid ones |
| T5 | "What is stuck" on Home | a figure and a strip, no sentence | **0 clicks**: the first sentence says it, and where |
| T6 | A phone (390 px) shows the first claim | 5 filter fields and two paragraphs first | the first claim within the first screen |
| T7 | No horizontal scroll at 390, light and dark | Past claims scrolled sideways | none |

## 4. Critique of today's screens (screenshots first)

Before screenshots: `D:\Faculty Paper\audit-shots\views\research-cell\before\`. Method:
impeccable critique by hand plus DOM measurements; the foundation's critique (docs/design/
critique-before.md) is the reference for what "designed" now means.

Findings, worst first:

1. **The queue is one flat list of everything.** The 22 claims that can simply go are mixed with
   the 3 that need a human, so every row must be read to learn which is which. The "ready" idea
   exists as a banner and a filter, not as the structure of the page. (Hicks: one choice list of
   40; Fitts: the action is far from the cursor.)
2. **Every row repeats what is true of the whole list**: "Not recorded", a "No amount" chip on 14
   rows, the claim number as loud as the person. (density critique)
3. **Clearing is four moves.** Open, `c`, wait for a Scopus recalculation, then reach for the
   button with a mouse. Enter does not confirm. The dialog shows the money as `text-2xl
   font-semibold` Inter, outside the type scale.
4. **The workspace panel is a 3,000 px scroll** (claimant, table, amount, confirmations,
   checklist, marks, flags, past cases, history). The verdict ("can this go?") is not on it; the
   reviewer builds it in their head from the table. 40% of the screen is a blank pane when a claim
   has no attachment, although the claimant linked their proof.
5. **Home opens with "Hello, Research"** and four equal figures. The sentence a clerk needs
   ("13 are past 14 days") is the second line, in small type. Nothing says what is stuck at the
   Principal.
6. **Past claims is a table that cannot fit**: it scrolls sideways at 1440 and is 4,300 px for 25
   rows, because the "How it stands" cell is a paragraph. The same table has no face-led row.
7. **Coordination Desk is a 14-row form** where the coordinator must pick a reviewer 14 times, or
   tick rows and a reviewer. There is no "share these out evenly".
8. **The foundation was not applied**: `PageTitle` (not `PageHeader`) on Home, Claims, Flags,
   Journals; a selected rail row with a coloured left stripe (banned); `text-2xl font-semibold`
   figures; spots on non-Home pages; "Refresh" as a header action (a status, not a task).
9. **Phone**: five filter fields before claim one; claim numbers in a monospace stack.
10. Right and kept: oldest first, j/k/x/Enter, the server re-checking the amount, per-claim
    skips with reasons, marks that become the send-back reason, own-claim refusal, past cases.

## 5. Three concepts for the queue and the workspace (parallel-concepts)

### A. Two lanes (chosen)

The queue is two sections: **Ready to clear** (every check passed, nothing watched, priced) and
**Needs a look** (each row says why in one phrase). The cursor row is the unit; `c` clears it;
`a` chooses all the ready ones; `c` again clears the chosen. The workspace is the three panes
(rail, PDF, panel) with a **verdict** at the top of the panel and the panel split into four tabs.

```
Clearing queue                                          [ Clear the 22 ready ]
22 of 40 are ready to clear.
₹6.1 lakh in all · oldest 92 days · 13 past 14 days

Ready to clear  22 · ₹5,04,215
 [ ] (face) Dr. S. Kumar · CSE    Attention-based segmentation of retinal ...   Q3   ₹12,100   7 days  Review
 [ ] (face) Ms. T. Devi  · ECE    Deep ensemble for early detection of ...     Q2   ₹19,800   9 days  Review
Needs a look  18
 [ ] (face) Dr. K. Raman · MECH   Bio-inspired antenna array ...               Q1   ₹29,480   2 days  Review
            Affiliation not confirmed · Possible duplicate
```

### B. The deck (declined)

One claim at a time, full screen, a big Clear and Send back, swipe to the next. Fast for one,
useless for "what is late" or "find FP-2026-000010", hides the oldest, no batch, no overview on
a phone. Kept: after a decision the next claim opens (already true), and the verdict-first panel.

### C. The inbox with a preview pane (declined)

The queue on the left and the claim's detail on the right on one screen (mail style), no
separate workspace. It duplicates the workspace (two places to judge a claim), and a PDF at half
width is not a PDF you can read. Kept: the rail inside the workspace is this, at the size that
works.

### Choice

A, because it is the only one that changes the *structure* of the work (clean claims are a batch,
the rest are the job) instead of decorating it; it keeps the oldest-first order inside each lane;
it costs no new component the clerk must learn (two sections, one verdict sentence, the same
keys); and the fastest path for the common case is two keystrokes. Section order puts the batch
first because Fitts and Hicks both say the common, safe action goes first; the hard lane is
second and gets the reasons.

## 6. Wireframes

### Home (research cell; coordinator adds the right column)

```
Good morning, Meena.                                             (plate: the register)
13 claims are past 14 days.
5 are waiting at the Principal.            <- AnswerLine, display-xl, two clauses

o----------o-------o--------o--------o      <- Thread, "Your desk" ringed at Filed
Filed 40   Checked 5  Approved 0  Authorised 0  Paid 81

Given to you first                                              Open the queue (40)
 (face) Title ................................ Dr. K. Raman · FP-2026-000021 · 30 days  Late   [Review]
Came back to the desk
Also needs a look: 54 open flags (53 on paid claims)  · 47 possible duplicates · 0 watched
October so far: 0 came in, 0 cleared ...                                    Monthly report
```

### Workspace (1440)

```
<- Clearing queue | (face) Dr. S. Kumar, CSE | FP-2026-000010 [copy] | 7 days waiting | o-o-.-.-.   3 of 40  ^ v  keys  rail
+-----------+-----------------------------------------------+-----------------------------------+
| rail      | Published paper | Reference 7 | Reference 12  | Nothing to look at.               |
| (face,    | [thumbs]  PDF page                            | Every check passed.   ₹12,100     |
|  days,    |                                               | [Check] Marks 2  Past cases  Hist  |
|  title)   |                                               | table: claimed vs record           |
|           |                                               | checklist                          |
+-----------+-----------------------------------------------+-----------------------------------+
| [ Clear c ]  [ Send back s ]  [ Hold h ]   Reject outright   Flag f   ...                       |
+--------------------------------------------------------------------------------------------------+
```

On a phone the three areas stay tabs (Document, Review, Queue); the verdict sits above them, and
the decision bar stays at the foot.

### Coordination, Desk

```
Coordination
5 of the 40 are late and not given to anyone.
[ Share the 14 un-given claims evenly among 4 reviewers ]   (preview: Meena 4, Ravi 4, ...)
Who holds what (bars)             How long they have waited (bars)      Where claims are (Thread)
Give out by hand ... (rows with face, claim, selector)
```

## 7. Keyboard map

Everywhere on the desk (never while typing, never while a dialog is open):

| Key | Queue (Claims) | Workspace | Flags |
|---|---|---|---|
| `j` / `k` | next / previous row | next / previous claim | next / previous flag |
| `Enter` | open the row | (in a dialog) confirm | open the claim |
| `x` | choose the row | | choose the row |
| `a` | choose every ready row (again: none) | | |
| `c` | clear the chosen, or the cursor row (ready rows only) | Clear | |
| `s` | open the claim to send back | Send back | |
| `h` | hold the chosen | Hold | |
| `f` | | Flag | |
| `m` | | add a mark | |
| `[` `]` | | previous / next file | |
| `1` to `4` | | Check, Marks, Past cases, History | |
| `/` | search | focus the rail filter | search |
| `?` | all keys | all keys | |
| `Ctrl+Enter` | | send a typed reason | resolve |
| `Ctrl K` | find a claim by number or name, anywhere | | |

Dialogs: the primary button has focus when the dialog is ready, so `Enter` confirms; `Esc`
cancels; nothing is confirmed by a keystroke before the amount has been checked.

## 8. Micro-interactions (micro-interaction-spec)

| Moment | Trigger | Feedback | Rules |
|---|---|---|---|
| Clear one | `c` then `Enter` | the Stamp lands in the toast ("Cleared"), the row leaves, the cursor stays on the next row | no motion on the list; a row that cannot clear says why in a toast |
| Clear a batch | `a`, `c`, confirm | one summary: "Cleared 20. 2 skipped" with each skip's reason | skip is per claim; an amount that moved is skipped, never cleared wrong |
| Send back | `s` | dialog already holds the reason written from marks; `Ctrl+Enter` sends | at least 10 characters, shown to the claimant exactly |
| Move | `j` / `k` | cursor row `bg-selected`, scrolled into view, 80 ms | no coloured stripe |
| Wait | a recalculation takes over 300 ms | the dialog says "Checking the figure against Scopus", the button is disabled until it is true | never a spinner on a page |

## 9. Copy deck (docs/ux/19 vocabulary; no em dashes)

| Where | Text |
|---|---|
| Queue answer | "{n} of {total} are ready to clear." / "Nothing is waiting." |
| Queue sub | "{money} in all. Oldest {n} days. {m} past 14 days." |
| Ready lane | "Ready to clear" ; hint "Every check passed and no journal is watched." |
| Needs-a-look lane | "Needs a look" ; reasons: "Affiliation not confirmed", "Possible duplicate", "Watched journal", "Checks failed", "No amount", "Contested by the claimant", "On hold" |
| Primary | "Clear the {n} ready" ; confirm "Clear {n} for {money}" ; toast "Cleared. {n} claims sent to the Principal" |
| One-claim confirm | title "Clear this claim?" ; line "{name}, {paper}" ; figure "{money}" ; "It goes to the Principal. You can find it under Past claims." ; button "Clear {money}" |
| Workspace verdict | "Nothing to look at." / "{n} things to look at." / "Not checked yet." ; sub "Every check passed." / the reasons as links |
| No attachment | "Nothing is attached to this claim." + "The claimant linked their proof instead." with buttons "Open the paper proof", "Open reference proof 1" ; else "Send it back and ask for the paper." |
| Send back hint | "Written from your marks. The claimant sees this exactly as it stands." |
| Home zero | "Nothing is waiting. The desk is clear." |
| Past claims | "Every claim ever filed, paid ones and imported ones included. Find one by its number." |
| Coordination share | "Share {n} un-given claims evenly" ; "Shared. {n} claims given to {m} reviewers" |

## 10. What is built (per view) and what is left

| View | Built |
|---|---|
| **Home** (cell and coordinator) | `PageHeader` with the greeting; the answer is one display-size sentence: "24 claims are past 14 days." then, if anything is held up below, "5 are waiting for the Principal, 2 over two weeks." (counts only, from `/api/track`). Under it one line with links: the ready count, "given to you", and for the coordinator "not given to anyone". The Thread sits directly under the answer. Four equal figures are gone. |
| **Claims** (`/clearing`) | Two lanes: Ready to clear (the batch) and Needs a look (each row says why). Person-led rows (face, name, department, paper, claim number, journal, quartile, amount, days with the word "Late"). `c` clears the cursor row (ready rows only) through one confirm dialog whose button has focus, so `c`, `Enter` is a clear; `a` chooses every ready row; `s` opens the claim with the send-back dialog already open; `h` holds. A primary button "Clear the N ready". The Stamp lands on a full success. On a phone the filters collapse behind one button and each row wraps. The monthly report left this page (it lives in Coordination). |
| **Review workspace** | The header carries the claimant's face, name and department, the claim number (copy), the five-dot ClaimThread and "N days waiting". The panel opens with the verdict ("Nothing to look at." / "2 things to look at." with the reasons) and the amount as a figure, then four tabs (Check, Marks, Past cases, History) so it is no longer a 3,000 px scroll. Keys 1 to 4, `f`, `?` added. The rail's selected row is `bg-selected` (the coloured stripe is gone) and leads with the person. When nothing is attached, the pane offers the proof links the claimant gave. The Clear dialog focuses its button when the figure is checked (`Enter`), shows the money as a Figure, and `Ctrl+Enter` sends a typed send-back reason. |
| **Flags** | One plate fewer, a shorter lead, rows at 12 px padding with the note at two lines, and a row that repeats the one above says "Same question and answer as the row above" instead of printing it again. |
| **Past claims** | Person-led rows that wrap instead of a 60 rem table that scrolled sideways at 1440 and 390. |
| **Journals** | The empty watch-list is a compact state (one plate in the viewport, not two); the published list shows the top 15 with "Show all 74". |
| **Coordination** | Kit `Tabs`; no borrowed admin plate; "Share these N out evenly": choose the reviewers (the cell and the coordinator are pre-chosen), see each person's open count and what they would get, one button. Oldest first, to whoever holds the fewest, never to the person who filed it (`planShare`, unit tested). |
| **Research faculty** | The kicker and the second plate are gone. |
| **Notifications** | Kit header, one plate. |
| **Track** | Not changed: it is shared with every office role and belongs to the Admin builder. |

Left, said plainly:

- Author position is still not checked against a stored Scopus author list (a data gap, docs/audit/research-cell).
- The workspace panel on a phone shows the verdict only on the Review tab; a one-line verdict above the tabs would help.
- Research coordination's final-year-project panel and the monthly report keep their present layout; they were already on the kit's header and tabs.
- The hand-assign list under "Share evenly" is still 40 rows long; it could collapse behind a "Give out by hand" disclosure.

## 11. Measured

Method: a scripted Playwright walkthrough (Chromium, 1440 px, signed in as RESEARCH_CELL on a copy of the
real data with 26 realistic claims added, each with a published-paper PDF and two reference PDFs; 22 of
the 40 queued claims are ready). Before is the build at 2e36e11, after is this branch. An "action" is one
keypress, one click or one typed phrase. Times include the Scopus recalculation dialog where it applies.

| # | Target | Before | After | Met |
|---|---|---|---|---|
| T1 | Clear one ready claim from the queue | 3 actions (Enter, `c`, click) from the queue with the "ready" filter already on; from the default queue add one `j` per claim above it. 5.3 s | **2 keystrokes** (`c`, `Enter`) from the default queue, because the ready lane is first. 3.0 s | yes |
| T2 | Send back with a reason from a mark | 5 actions, 5.2 s | 6 actions (adds the `1` key to be on the Check tab, then tick Issue, type the reason, `s`, `Ctrl+Enter`), 6.8 s, the reason prefilled from the mark | yes (under 60 s both) |
| T3 | Clear every ready claim in one pass (21 claims) | 2 clicks, 2.5 s (a button already existed) | **3 keystrokes** (`a`, `c`, `Enter`), 4.7 s; or the header button "Clear the 22 ready" then Enter | yes (under 2 min both) |
| T4 | Find a claim by number | Ctrl K, type, Enter: already one step in the palette (an early probe of mine failed on timing, not on the product) | unchanged: 3 actions, lands in `/review/:id` when the claim is at the desk, else the claim page | yes, no change |
| T5 | "What is stuck", 0 clicks | the late count in a 16 px line; nothing about the desks below | the first sentence is the late count in display type, and the second clause names the desk below with most waiting (when there is one) | yes |
| T6 | First claim in the first phone screen (390 x 844) | no: two paragraphs and five filters first (y about 800) | yes: the first row starts at y 520 | yes |
| T7 | No horizontal scroll at 390, light and dark | Past claims scrolled sideways at both widths | none on any of the 14 views, 2 widths, 2 themes, 2 roles (56 screenshots, the script prints any overflow and prints none) | yes |

Honest note on T3: the old queue already had a one-button batch, so the gain there is the keyboard path
and the clearer split, not speed. The large gains are T1 (the common case is two keystrokes), the verdict
at the top of the workspace (no number: it replaces reading an eight-row table), and T6.

Tests: 123 files and 921 tests pass (`npx vitest run --maxWorkers=1`), `npx tsc -p tsconfig.app.json
--noEmit` is clean, `npm run audit` is green (clarity baseline 0). Updated by design: the clearing queue
tests (now `clearing.test.tsx`, 14 tests, table to lanes), `home-cell.test.tsx` (figures to a sentence),
`archive.test.tsx` (table to list), and five Playwright specs that found a queue row by `role=row` or the
word "selected" (now `[data-claim]` and "chosen"; the specs were not run here, they need the full stack).

Screenshots (kept outside the repository, real faces): `D:\Faculty Paper\audit-shots\views\research-cell\`,
`before\` and `after\` (56 after-shots: cell Home, Claims, workspace with a PDF, workspace with no
attachment, Flags, Past claims, Journals, Notifications, Track; coordinator Home, Coordination three tabs,
Research faculty; at 1440 and 390, light and dark).
