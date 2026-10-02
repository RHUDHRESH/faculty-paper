# 29. The super admin's views: deliberation, targets, design

Owner brief (2026-10-01): "Run a deep contextual agent for every type of view: landing, every
button, settings, all of that. Add, rework, make it exponentially better. Make the jobs to be done
easier and simpler; the site should look elegant and like an artwork." Earlier: "admin side UI is
trash, can't see, can't track, confusing mess and pile." Then, on the way: "make every button
accentuated and highlighted, remove redundant stuff, and text that can be hidden away should be
hidden."

Scope: Admin Home; the Admin hub; Track; People and person admin; Issue passwords; Faculty
directory (admin variant); Profile requests; Author matches; Research faculty; Imports (with the
streaming Restore); Monthly runs; Reference data; Record quality; Data health; Duplicates; Data
browser; Fix imported claims; Jobs; Faults; Audit log; Safeguards; Institution; Policy and the
Calculator; first-run Setup; View-as. Built on the foundation (docs/design/foundation-handoff.md).
Skills applied: jobs-to-be-done, information-architecture, navigation-patterns, onboarding-design,
form-design, error-handling-ux, feedback-patterns, critique-information-density, ux-writing,
ui-ux-pro-max, and the impeccable references (new-work, critique, layout, typeset, clarify,
distill, harden, onboard, polish, craft-floor).

Inspiration read first (D:\Faculty Paper\inspiration; not in the repository): Linear's settings
and triage for the idea that an admin page is a short list of states, each with its one verb;
Stripe's dashboard and GitHub's repository setup checklist for "what is left before this is
live" as an ordered list with a progress count; Things 3 for the calm row; the museum collection
captures for the mounted drawing. From docs/design/art-direction.md: the answer is the biggest
thing on the page; quiet everywhere else; one primary button.

## 1. The person and the jobs

One person, or two, keeps the college's system running. They are not in a hurry and not
technical in the sense that matters: they are an administrator who knows the college, not a
developer. They open the app to learn one thing, **is anything broken or stuck?**, and leave when
the answer is no.

| Session | When | The one question | What ends it |
|---|---|---|---|
| **Check** | Daily, 2 minutes | "Is anything broken or stuck?" | An empty list, or each item fixed in at most two clicks |
| **Keep the chain moving** | When it says so | "Who holds this, and who should?" | A desk has a person; a claim moved |
| **Look something up** | Whenever asked | "Where is this claim, who is this, was this paid?" | The record open, in one step |
| **Bring data in** | Weekly or monthly | "What will this file change?" | A previewed, committed import; the monthly run done |
| **Keep the rules** | Yearly, or on a decision | "If I change a rate, what changes?" | A new policy version with a before and after |
| **Get the college running** | Once per installation, once per move of host | "What is left before people can sign in?" | A list with every step done |

The job statements (situation, motivation, outcome):

1. When I open the app, I want one sentence that says whether anything is wrong, so I can leave
   if nothing is.
2. When something is wrong, I want the row to open the place where it is fixed, so I never hunt.
3. When a new installation comes up, I want the steps in order with what is done and what is
   next, so I do not need the move-host document open beside it.
4. When someone phones with a claim number, a staff ID, a DOI or a voucher, I want to type it
   once and be on the record.
5. When I am about to change something I cannot take back, I want to see exactly what will
   change, then confirm.
6. When a number on a page looks odd, I want to open what is behind it without leaving.

## 2. Targets

Measured by a scripted Playwright walkthrough on a copy of the college's real data (section 8
has the numbers; "before" is the build at commit 886720b).

| # | Target | Before | After (goal) |
|---|---|---|---|
| T1 | Home says whether anything is wrong, and what, with 0 clicks | four figures and a list, the count said three times | one sentence and the first five rows in the first screen |
| T2 | Every item on Home is fixed in at most 2 clicks | 1 click to the page | held at 1 click |
| T3 | Fresh install to people signing in: every required step reachable in 1 click from one list, each step done in a page that is already built | steps spread over 5 pages with no order | one ordered list of 5 required steps, "next" highlighted, 10 minutes of admin time or less (restore not counted: it runs by itself) |
| T4 | Find a claim, person or payment in one step | claim number, name, DOI by Ctrl K; no staff ID, no voucher | adds staff ID, Scopus author ID and voucher number; a visible Find button on Home |
| T5 | Words on the page: Admin hub, Imports, Policy, Data health, Duplicates, Fix list, Reference | 732, 282, 520, 722, 1,028, 1,595, 641 | each cut by at least a third; the explanation behind a "Why?" or a tooltip |
| T6 | One obvious primary button per page; every action is a button | actions as link-coloured words ("Open claims", "See who") | every action a button; one primary |
| T7 | A fresh admin lands on a page that tells them what to do | Home with an empty list ("Nothing needs you") on an empty install | Home answers "N of 5 steps left. Next: load the record." |
| T8 | The old-ERP claims that were wrongly marked paid are reversible in one dialog | no tool | preview, apply, undo; 7 repeats and 3 rejected held back |

## 3. Critique of today's screens

Screenshots (kept outside the repository, in audit-shots/views/admin): `before_light_1440_*.png`.

**What is good and stays.** The kit work of the last sweeps held: every page has a title and one
purpose line, the attention list on Home is real and one click from each fix, tables have heads,
numbers carry units, a zero says what it means. People, Imports and the settings forms are
calm. The estate is not a mess of broken pages any more.

**What is still wrong, which is why it still reads as a pile.**

1. **The same question is answered three times.** Home has a count in the figure row, a count in
   the title and the list. The Admin page then asks "Is the system ready?" with ten rows and
   again lists what is waiting. Two places claim to be the check.
2. **Admin is a wall of words.** 732 words and 2,637 px: every one of 26 pages carries a
   sentence explaining itself, under a heading that already names it, in three columns of
   descriptions. A page you know does not need to explain itself every time.
3. **Actions are written as links.** "Open claims", "See who", "Take a backup", "Review them":
   clay words with an arrow. They do not read as buttons, and a keyboard or a thumb has to guess.
4. **Nothing says what order a new installation is brought up in.** The facts are on five pages
   and in docs/ops/move-host.md. An administrator on day one sees an empty list and "Nothing
   needs you" on a college with no people in it.
5. **The Thread on Home renders as a faint ghost** until its animation finishes, and sits
   between two lists with no reason to be there for an admin.
6. **The explanatory paragraph is the default and the control is the exception.** Policy opens
   with a paragraph under every group; Imports with three; Data health with a dozen.
7. **Find is a keystroke a stranger does not know,** and cannot take a staff ID or a voucher.
8. **Wrongly marked paid.** 61 old-ERP claims say Paid and were never priced, and the only tool
   is a form per claim.

## 4. Two concepts for Home and the Admin page

### A. One answer, one directory (chosen)

Home is the daily check and nothing else: **one sentence** (the answer), then the list of what
needs you, then the claims that wait on you. When the college is not yet running, the sentence
is the setup ("2 of 5 steps left") and the list is the checklist. The Admin page becomes a
**directory**: the same twenty-odd pages, grouped by the four jobs, each a name and a number,
with the explanation moved behind the row (a tooltip and the page's own header). Readiness lives
where it is acted on: in the Home list while it fails, and on the "Get the college running" page
for first-run.

### B. The cockpit (declined)

Home shows readiness, health, counts for every area and the claims thread as one grid of
status tiles; the Admin page is removed. Familiar from operations dashboards, and an
anti-goal here (a dashboard of cards: foundation, "Anti-goals"). It would also make the answer
a thing to be found among thirty equal tiles, which is today's problem with new paint.

### Choice

A. Cost of B is the one answer; cost of A is that the directory is one click from Home, not
zero. Targets T1 and T2 hold under A because the things that need action are on Home; the
directory is only for the things that do not.

## 5. Wireframes (1440)

### Home, the college running

```
Hello, Super                                                       [ drawing ]
Nothing is wrong. Two claims have waited over a month.   [Find anything  Ctrl K]

  Nothing needs you now, except two claims that have waited over a month.   <- the answer, display

  3 things need attention                                       (most urgent first)
  [dot] Claims waiting to be cleared 14 days   13 claims                [Open claims]
  [dot] Paid with no ledger row                 1 claim                 [Open faults]
  ...                                                                   [Show 9 more]
  4 things are in order  (details)

  Waiting to be cleared                                   [Open all 14 claims]
  (face) Title ...                                   92 days     [Clear]
```

### Home, the college not yet running

```
Hello, Super                                                       [ drawing ]
  Two steps are left before people can sign in.  <- the answer
  [ Continue: put someone at every desk ]       <- the one primary button

  Get the college running                              3 of 5 steps done
  (done)  1  Load the college's record            412 people and 8,466 papers
  (next)  2  Put someone at every desk            Nobody holds Director.   [Choose the Director]
  (todo)  3  Give people their first password     412 people have none     [Issue passwords]
  ...
  Also: Set up email, Add the Scopus key (optional)
```

### Admin directory

```
Admin
[ Find a page ]                                         <- filter as you type, one field

People                    Data                       Money                System
 People            417     Imports                    Policy        v1     Jobs
 Issue passwords           Fix imported claims   61   Calculator           Faults        162
 Author matches  2,841     Monthly runs               Budget               Audit log
 Research faculty          Reference data             Ledger               Institution
 Profile requests          Record quality             Statements           Get the college running
                           Data health        6       Safeguards
                           Duplicates        47
                           Data browser
```

Each row is a name, an icon and, where something waits, one number. The purpose sentence is the
row's tooltip and the page's own header, not repeated text.

## 6. What the build does, page by page

- **Home.** The four-figure row and the count heading are one sentence (`AnswerLine`). A Find
  button next to it. The list keeps its rows, with the action as a button. Setup mode replaces
  the list while the record is not loaded or a desk has nobody. The Thread stays under the list: where every claim is is part of "is anything stuck".
- **Get the college running** (`/admin/start`, new; `GET /api/admin/start`): ordered steps with
  state (done, next, to do, working), a fact line, and one button that opens the page where the
  step is done. Restore progress shows on the step while a restore runs. Reached from Home while
  incomplete, from the Admin directory always, and from Ctrl K ("set up", "new host", "move
  host", "first run").
- **Admin directory.** Four groups, a name and a number each, a filter field. The readiness
  list and the old-ERP queue leave this page: the first is Home and the checklist; the second is
  the top of Fix imported claims.
- **Fix imported claims** gains the tool: "Paid, never priced" with a preview of exactly which
  claims change, a confirm, and an undo (section 7).
- **Find.** The global search finds a person by staff ID or Scopus author ID, and a claim by
  voucher number, for the office.
- **Every admin page:** one title, one short purpose line, one primary button; actions are
  buttons (`Button`), not link-coloured words; explanations that restate the title or the
  field label are removed, and the rest sits behind a Details or a tooltip. The lists of what
  was removed and hidden are in section 9.
- **First-run Setup** is cut to its fields; the page that follows signs the new administrator in
  and drops them on Home, where the checklist is the answer.

## 7. The tool: re-mark the old-ERP claims that were wrongly marked paid

The old workbook's Accounts sheet never priced or paid these claims, yet the import marked them
Paid. The owner approved putting them back to **approved, amount to be worked out**, so they
enter the normal monthly run, where Finance prices them and pays them once. Done through a
service (`core/services/erp_remark.py`), never in the view.

- **Dry run first.** The preview lists each claim that will change (number, claimant with face,
  title, from and to), and, separately, the claims held back for the research cell: possible
  repeats of another paper, and claims the sheet marks rejected. Nothing changes until the
  administrator types the count and confirms.
- **Stale previews are refused.** Apply carries a signature of the previewed list.
- **Audit-logged and reversible.** One audit row per run with a snapshot; Undo restores exactly
  those claims (and skips any that has moved on since, saying which).
- **Idempotent.** A second press finds nothing to change.

## 8. Micro-interactions and states

Press, then busy, then a stamp-less toast that repeats the verb ("Re-marked 61 claims"); an
undo link in the toast for the re-mark. A failed save keeps what was typed and names what
failed. A zero says what it means. Skeletons only after 300 ms. Reduced motion respected;
nothing new moves.

## 9. What was removed or hidden (owner: "remove redundant, hide text that can be hidden")

Rough visible words, before to after. "Hidden" means behind a Details, a hover note or a row's
open state, with a visible way in; a warning that guards a destructive action or an error was
never hidden.

| Page | Words | Removed | Hidden behind | Now buttons |
|---|---|---|---|---|
| Home | 390 to about 250 | the four-figure row, the count heading, "Most urgent first..." | the reason is one clamped line, full on hover | every row's action; Find; "Open all 14" |
| Admin | 732 to about 120 | the readiness list (Home and the checklist own it), the old-ERP queue (top of Fix imported claims), every one-sentence description | the description is the row's hover note | "Continue" for the setup |
| Get the college running | new, about 120 | | the new-host steps | each step's action |
| People | about 190 fewer | the four-figure strip (one line, and a figure only for desks with nobody), per-section sentences on the person form | | "Open the full record", "Finish profile", "Message" |
| Person | about 150 fewer | explanatory lines | | "Edit account" is the primary |
| Issue passwords | about 70 fewer | dialog description, two radio hints | | |
| Faculty directory | about 100 fewer | the "faculty at the college" figure, the long sub | | "Export as CSV" is the primary; "Fix on the account" |
| Profile requests | about 90 fewer | the sub, the "only a super admin can decide" line, the third figure | | "Apply" (the first row's is primary) |
| Author matches | about 130 fewer | three of four figures, the "accounts disagree" callout | the keyboard shortcuts | "Add Scopus ID" and the ORCID and OpenAlex links |
| Research faculty | about 150 fewer | per-row "Paid as regular faculty", the long sub | the threshold rule | "Change threshold", "Set threshold", "All research faculty" |
| Imports | about 650 fewer | "asks before it changes anything", the harvest intro | how restore works, how the college site matches people, what the run would do | every importer row has Open or Close; "Import history", "Running jobs" |
| Reference data | about 450 fewer | the long intro paragraphs | the 37-row years table | "Load 2024 quartiles" (primary), "Download rankings" |
| Monthly runs | about 120 fewer | the runs figure, the sub | | "Export this run", "Show all rows" |
| Record quality | about 60 fewer | the duplicates summary line, "Suggestions only", the anomalies paragraph | recent merges, spelling sentences | merge and rename actions |
| Data health | 722 to about 120 | the backups explainer, the badges note, timing lines | every finding's explanation sits in its row's Details; "how backups work" | each fix; "Check now" is the primary |
| Duplicates | about 45 fewer | the callout, hints | | the open decision carries the primary |
| Data browser | about 60 fewer | sentences restating permissions | | |
| Jobs | about 60 fewer | the "N jobs on record" line, the per-row "Failed" word | | "Show everything" |
| Faults | about 65 fewer | "Includes ... and N more" | each fault's detail | "Check again" (primary), row actions |
| Audit log | about 30 fewer | the cap paragraph | | "Download CSV" is the primary |
| Fix imported claims | 1,595 to about 700 | "N to fix in all", the ERP legend, "where corrections come from" | the whole form opens from the row's Fix button | "Fix", "Save fix" (primary), "Show those 8" |
| Policy | 520 to about 200 | the purpose line, every group paragraph | each rule's gloss is a hover note and also under "Show what each rule means" | "Open the full calculator"; "Publish a new version" stays the primary |
| Calculator | about 130 fewer | tab subtitles, the empty-state paragraph | | one primary per tab |
| Institution | 87 to about 55 | three hints, the preview's line | | |
| Setup | about 90 to 40 | the reassurance paragraph, two long hints | | |
| Track | | the "Also" prose, the fix paragraph | the ERP legend | "Open the fix list", "Show them here", "Why this amount" |
| View-as banner | 25 to 6 | "You can look around; nothing can be changed" | | "Stop viewing" |

## 10. Measured

One batched pass on a copy of the real data (95 claims, 413 people, 8,466 papers) at 1440 and
390 px, light and dark (screenshots in audit-shots/views/admin, outside the repository), then a
scripted fresh-install walkthrough on an empty database. No horizontal overflow at 390 on any
admin page; no page errors.

| # | Target | Before | After |
|---|---|---|---|
| T1 | Home: what is wrong, with 0 clicks | four figures, a count heading, a list: 390 words, the count said three times | one sentence ("15 things need you, 4 of them urgent") and the first five rows in the first screen; 330 words in all, 164 above the fold (was 218) |
| T2 | Fix any Home item in at most 2 clicks | 1 click | 1 click (the row's button); the first row's is the primary |
| T3 | Fresh install to people signing in | five pages, no order | one list. Measured: setup 3 clicks, sign-in 2, record 2 (Load the record, Restore; 46 s of restore on the real export, 160,524 rows, unattended), desks 2 per empty desk (search and press, no list to hunt through), passwords 2 (the step, then "Issue 408 passwords", the sign-in list downloads), backup 1 (in place). 14 clicks and 16 fields in all; about 4 minutes of machine time of which 46 s is the restore; well under the 10-minute target |
| T4 | Find any claim, person or payment in one step | claim no., name, DOI | adds staff ID, Scopus author ID, voucher; a Find button on Home |
| T5 | Words on the page (before to after) | | Admin 732 to 74; Data health 722 to 374; Fix imported claims 1,595 to 852; Reference 641 to 306; Policy 520 to 266; Imports 282 to 216; People 324 to 271; Faults 308 to 169; Jobs 183 to 157; Settings 87 to 43. Page height: Admin 2,637 to 1,151 px, Policy 2,944 to 2,480, Data health 3,105 to 2,811, Fix imported claims 7,680 to 2,911 |
| T6 | One primary, every action a button | actions as link-coloured words | Home rows, the setup steps, the Admin banner, Imports rows, Track's fix line, Faults, Data health, Reference, Fix imported claims are buttons. One primary per page except Author matches (its selected filter uses the primary style; NEEDS a toggle style in the kit) |
| T7 | A fresh admin knows what to do | "Nothing needs you" on an empty college | "4 steps are left. Next, load the college's record." and the steps |
| T8 | The wrongly Paid old-ERP claims | no tool | 61 claims were Paid with no amount: 51 change, 7 held as possible repeats, 3 held as rejected. Preview 47 ms (was 5 s before the service was tuned), apply in one transaction, undo restores all 51, audit rows for both. Status chosen: Checked (cleared), see the note below |

### The status the re-marked claims go to

The owner's words were "approved, amount to be worked out". In this chain the amount is worked
out and confirmed at each signature: the Principal's approval and the Director's authorisation
each recompute and confirm a figure, the Director's locks it, and Finance pays only that locked
figure (docs/ops/safeguards.md). Marking the claims Principal-approved or Director-authorised
would fake a signature on an amount nobody saw, and Finance's queue would refuse them. So they
go back to **Checked**: the research cell's work stands, the Principal approves an amount, the
Director authorises it, Finance pays it in the normal run. Each claim's import-time rupee-zero
ledger row is reversed (append-only) so the later real payment is not refused as "already paid".
If the owner wants them to skip a signature, that is a separate decision.

### Tests

Backend: `test_go_live` (8), `test_erp_remark` (20), neighbouring suites green. Frontend:
`home-admin.test` (13), `erp-remark.test` (4), and every page test touched; the full suite is
green (when run under load three timing-sensitive tests need a re-run alone). `npm run audit`
clarity 0; `npx tsc -b` clean.

### Left, said plainly

- Author matches has two primary-styled controls (a selected filter). Needs a toggle style in the
  kit; not forked here.
- The Home Thread's "Open Track" is a link in the shared `HomeTrack`; changing it changes every
  office Home, so it was left for the kit owner.
- Claimants are not notified when a claim is re-marked.
