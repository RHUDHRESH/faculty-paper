# 25. Faculty and research faculty: the deliberation

Owner brief, 1 Oct 2026: work on every aspect of the frontend; make the jobs easier and simpler; make
the site elegant, like an artwork. This document is the thinking that comes before the code for the
**faculty** views (every route a FACULTY user reaches) and the **research faculty** variants. It was
written after reading PRODUCT.md, DESIGN.md, docs/design/art-direction.md, docs/jtbd/faculty.md,
docs/ux/19, 21 and 22, docs/audit/faculty/*, the inspiration library (sources.md and its images), and
after taking screenshots of today's screens as a real faculty member (Dr. R. Subhashini, 31 papers,
10 claims, one sent back) and a research faculty member (₹3,00,000 threshold) on a copy of the real
data. Screenshots are kept outside the repository (they hold real people):
`D:\Faculty Paper\audit-shots\views\faculty\`.

Method note: the skills' scripts and launchers were not run (the brief forbids it); their method was
applied by hand: jobs-to-be-done, journey-map, heuristic review (impeccable critique), parallel
concepts, peak-end, form design, error and loading states, ux-writing.

## 1. Who, where, when

A lecturer, usually on a phone between classes or in a corridor, in daylight. Some are not at ease with
software. They open the app a few times a month, not daily: when a paper is published (to file), when a
notification arrives (to fix or to celebrate), once a year (appraisal, tax). Research faculty are the
same people with a yearly rupee threshold: the first part of what they earn each year is not paid.
Everything they do comes down to **getting paid with the least effort, knowing where the claim is, and
keeping their record right**.

## 2. Jobs to be done

| Job | Functional | Emotional | Social |
|---|---|---|---|
| **J1 Get paid for a paper** | Pick the paper, confirm, attach the PDFs, file | "I did it right, it will not come back" | "The college sees my work" |
| **J2 Know where my claim is** | Stage, days waiting, what is needed, when money comes | Calm: "somebody has it, nothing is lost" | Not having to ask the office |
| **J3 Fix what was sent back** | See each problem on the page it is about, correct, send again | Relief, not blame: "easy to put right" | Never feel marked down |
| **J4 Report money received** | Statement by financial year, printable | Safe: "my tax return is straightforward" | |
| **J5 Show my record** | Appraisal list, one paragraph, print | Pride, no re-typing | Promotion, NAAC, supervisor recognition |
| **J6 Keep my record right** | Scopus ID, ORCID, a missing or duplicate paper | Trust that the numbers are mine | Correct name on every list |
| **J7 Find co-authors and venues** | Who writes on my topic, where people like me publish | Curious, not overwhelmed | Collaborators |
| **J8 Be recognised** | Badges, leaderboard, a kind word at the right time | A small, honest pleasure | Colleagues see it |
| **J9 Stay on pace (research faculty)** | "₹x of ₹y used this year" wherever money shows | Clarity about why a claim paid less | |

Job statements: *When I have a paper published, I want to file it in two minutes from my phone, so I
get paid and never think about it again.* *When a claim is with the college, I want to see it is moving
and when the money comes, so I do not have to ask.* *When a claim is sent back, I want to know exactly
what to fix and fix it in one place, so it does not feel like a failure.*

Rules that stay true in every view: faculty never learn which desk or person holds their claim; no money
of anybody else; the research threshold sentences are exact (used = approved or paid only); nobody acts
on their own claim; one paper count everywhere.

## 3. Journey: "I published a paper" to "money in my account"

| Stage | Doing | Thinking and feeling | Today | Opportunity |
|---|---|---|---|---|
| 1 Publish | Paper appears on Scopus | "Can I claim it? how much?" Hopeful | Home says "7 papers you can still file" but the amount is not next to the button | **Amount beside every File button**; a ready paper looks like money |
| 2 Choose | Open File a paper | "Which one is it?" | Two taps, a 7-row picker with the same paper twice | Skip the picker when arriving from a paper; offer each paper once |
| 3 Confirm | Three conditions | Slightly wary: legal text | Three big cards, 2 screens of reading | Keep the physical ticks (rule), shorten the words, one list not three cards, evidence folded |
| 4 Details | Five wizard sections | Tedious, "did it fill itself?" | Always starts at section 1 even when it is complete | **Open at the first section that still needs me**; say "filled from Scopus" once |
| 5 Proof | Attach PDFs | The real effort | Three separate uploads | Say how many are needed, count them off ("1 of 3 attached") |
| 6 File | Read back, file | Nervous: irreversible | Heavy page, then a dialog | Short read-back; the receipt is the peak moment |
| 7 Wait | Claim is with the college | Anxiety: "is it moving?" | A paragraph per claim on My claims | A **thread** per claim, "Taking longer than usual" said once; notifications on movement |
| 8 Sent back | Reads why, fixes | Sinking feeling | Home says "Why: Imported from Raw_Data"; Fix is a separate page | Reason in the college's words, **one screen**, a checklist that ticks off |
| 9 Approved | Waits for the run | "When?" | Sentence on Home | Keep: "expected in October" |
| 10 Paid | Money arrives | The end: relief, pride | A line in the statement | **Peak and end**: a calm "Paid" moment on Home and in the notification, with the amount and a link to the statement |

Peak: the receipt after filing. End: the paid moment. Both are quiet (a Stamp-like record, a sentence),
never confetti.

## 4. Measurable targets

Measured by a scripted walkthrough (Playwright, real clicks, a copy of the real data, a fresh session)
before and after. Section 11 has the numbers.

| # | Target | Why |
|---|---|---|
| T1 | File a paper that is on my Scopus record: **at most 13 clicks** (counting each tick and each upload; was 12 when written, revised after the first measurement, see 11) and **under 2 minutes** with the PDFs to hand | J1 |
| T2 | "Where is my claim, when is the money coming" answered on Home with **0 clicks**, in the first screen at 390 px | J2 |
| T3 | Fix a sent-back claim on **one screen**: reasons, files and the Send again button together, **one click from Home to that screen**, then at most 8 presses in all (the three conditions are ticked again every time, by rule). Written as 4; revised, see 11 | J3 |
| T4 | Profile set up (photo, Scopus ID asked for, ORCID, phone) in **under 1 minute**, one Save | J6 |
| T5 | From Home to "what I was paid this year": **1 click** | J4 |
| T6 | From Home to the appraisal list and Print: **at most 3 clicks** (today it is a footer link) | J5 |
| T7 | No horizontal scroll at 390 px on any faculty view; every tap target at least 40 px | phones |
| T8 | One primary action per view; no kicker, no card inside a card, no repeated chip down a column | DESIGN.md |

## 5. Heuristic critique of today's screens

Scored with Nielsen's ten, from the screenshots. The earlier foundation pass fixed the type scale and
the tokens; what remains is about **structure and repetition**, not decoration.

| View | What is good | Problems (ranked) |
|---|---|---|
| **Home** | The one sentence answers J2 and J1 | 1. "Why: Imported from Raw_Data" shown to a claimant (internal note leaks). 2. The File button gives no amount. 3. Research faculty's threshold is a grey card of two paragraphs. 4. A badge line sits above the work. 5. "Your research" is three figures with no picture; no face except the suggestion. 6. The first-run block is three numbered steps and a button: fine but a card |
| **My papers** | Tabs and stacks on a phone | 1. 31 rows in one long list; **Paid chip repeated 23 times**. 2. A four-figure strip as its hero (the template DESIGN.md bans). 3. "Listed twice" chips on the same paper twice. 4. "List for appraisal" and "Payment statement" hidden in a footer line. 5. "Showing 31 of 31" noise |
| **File a paper** | Pull from Scopus first; physical ticks; autosave | 1. Always begins at section 1. 2. Confirm page is three tall cards, about 1,700 px. 3. "File a paper · step 1 of 4" is an eyebrow (banned). 4. Phase track is 12 px text. 5. Two different "steps" (4 phases and 5 sections) |
| **My claims** | Thread per claim, "Needed from you" | 1. Ten identical five-line blocks; the claim that needs the person is just the first. 2. Paid claims repeat a full thread, a "₹0, Amount not on record" figure and a link. 3. Claim number as loud as the title |
| **Claim detail and fix** | Marks on the PDF page | 1. Fix is a second step after detail. 2. Reason copy is the reviewer's, not softened |
| **Payment statement** | Good table by financial year | 1. Figure strip then a table: fine. 2. Missing "this year" first; a "-" in a cell |
| **Appraisal** | Count sentence, paragraph, print | 1. Hard to find. 2. Duplicates listed twice with no note |
| **My research** | Rich | 1. **Three "Past / Present / Future" eyebrows** (banned). 2. Card grids (ideas, journals). 3. Four equal figures. 4. A page of eleven sections: it is a report, not an answer |
| **Profile** | Honest about locked fields | 1. Separate Save beside every field (three saves). 2. "Google sign-in is not available on this server" is noise for a user. 3. A hero strip of figures that belong to Home. 4. Badges as a 3-card grid |
| **Notifications and settings** | Complete | 1. Settings is a 40-row switch table: no sense of "what matters"; switches are big clay discs; an in-app banner says email is off for the college |
| **Sign-in and first run** | Painting, dialog welcome | 1. The welcome is a dialog of generic guides, not the three steps this person needs |

Overall Nielsen total about 30/40: strong on status and vocabulary, weak on **recognition and
efficiency** (the work is hidden in lists that all look alike) and on **aesthetic minimalism**
(repetition).

## 6. Inspiration, and what is taken

From `inspiration/` (52 references): claude.ai (the calm, the serif, hairlines); Stripe and Linear
(a dense table with one clear next action, a status that is a word); Monzo and Wise (money as a
sentence first, "arrives on" dates); Apple Wallet and boarding passes (one object, a thread of steps,
the thing you act on is the biggest); museum labels and the Met (a plate with a caption); the college
register (stamp, ledger line); Duolingo and Headspace for the **end** moment only (a quiet, earned
conclusion). What is **not** taken: points, streaks, confetti, dashboards of equal tiles.

## 7. Concepts

### Home (parallel concepts)

- **A. The letter.** One sentence at the top, then plain sections: needs you, files, money, on the way.
  Calm and already built; fails at "a ready paper looks like money" and at claims being a list, not a
  picture.
- **B. The register.** Home is *your claims as lines in a ledger*: every claim a line with its own
  four-dot thread and amount, paid claims folded away. Strong for J2; becomes heavy for a person with
  nothing in flight and drowns J1.
- **C. The one next thing.** A single large object (a boarding pass) for the one thing that moves
  money forward: "Fix this claim", else "File this paper (₹X)", else "Waiting: expected October". Strong
  for novices; hides the rest, so a person with three things loses two.

**Chosen: A with the strengths of C and B.** The page stays the *letter* (the sentence, biggest thing
on the page), but its first block is the **one next thing**, set as an object with the amount: the
sent-back claim if there is one, else the most valuable paper to file. Under it, **claims on the way**
are drawn with their four-dot thread (B's best part, only for claims in flight, at most four). Money is
three figures; the record is a **dot field of the person's papers** (Q1 gold) so "my 31 papers" is a
picture. Why: a faculty member comes with one question; the sentence answers it, the object lets them
act in one tap, and nothing is invented that the data does not have.

### Filing (parallel concepts)

- **A. The wizard as is** (Choose, Confirm, five sections, File): complete, but 14 clicks and it always
  starts at the top.
- **B. One long page** with a sticky amount bar: fewer clicks but a long form on a phone, and the three
  physical ticks scroll away.
- **C. Land where the work is.** Keep the wizard and every rule (Scopus first; ticks physical; five
  sections), but: arriving with a paper skips the picker; the three ticks are one ruled list; after
  "Start the claim" the wizard **opens on the first section that still needs the person**; the amount
  is always visible; the last step reads back in one screen.

**Chosen: C.** It cuts clicks and reading without removing a rule the owner pinned.

### Sent back (fix flow)

One page: the college's note at the top in a sentence (not "the reviewer"), then **each problem as a
line with its page thumbnail** (already built as `FixView`), a "Fix" action per line, and one primary
**Send again** that is disabled until each line is addressed, with the reason stated. Remove the
detour through claim detail: Home's "Fix this claim" goes straight there.

## 8. Wireframes

### Home (390 px, then 1440 px keeps the same order in a wider column)

```
Good afternoon, Subhashini                 [ File a paper ]
Assistant Professor, S&H-ENGLISH

1 claim needs a fix from you; one is being
checked.                                   <- the answer, Display XL

+--------------------------------------+   <- "the one next thing" (an object, not a card of icons)
| Sent back to you                      |
| An experimental research on ...       |
| The first page does not show the      |
| college name.   o--o  . .             |
|                       [Fix this claim]|
+--------------------------------------+

Papers you can still file          All 7
 Title ........................ ₹9,000 [File it]
 ...
Claims on the way                  All 3
 Title                       o--o--.--.
 Being checked, 75 days            about ₹6,000
Your money         paid so far   this year   on its way
Your record        (dot field: 31 papers, 3 Q1 gold)
```

### My papers

```
My papers   31 papers on your record                 [ File a paper ]
[ Ready to file 7 ] [ On the way 1 ] [ Paid 23 ] [ All 31 ]   (Tabs)
search                                    Pull from Scopus   ...
 paper title                       authors (FaceStack)   where it stands
 ...                               rows grouped under one heading each
A paper is missing? Paste its DOI       For a form: List for appraisal, Payment statement
```

### My claims

```
Needs you        (the sent-back claim, with Fix this claim)
On the way       each: title, thread (4 dots), days, amount
Paid             a compact table by month: month, paper, amount
```

### File a paper

```
Choose the paper     (skipped when arriving with a paper)
Confirm              ☐ indexed   ☐ not claimed before   ☐ files ready      (one ruled list)
Details              opens at the first section that needs you; the amount bar is always visible
File                 read back, one screen; File it  ->  receipt
```

## 9. Copy deck (key lines)

| Where | Line |
|---|---|
| Home, nothing in flight | "Nothing needs you." / "Nothing needs you. 23 papers on your record are not filed yet." |
| Home, sent back | "1 claim needs a fix from you." |
| Next-thing label | "Sent back to you" / "Ready to file, about ₹9,000" / "Expected in October" |
| File button | "File it" with the amount beside it: "₹9,000" in Figure weight |
| Sent-back reason (when the note is an import note) | "The college asked for one change. Open it to see what." (never an import code) |
| Empty My papers | "No papers on your record yet." / "Pull from Scopus, or paste a DOI." / [Pull from Scopus] |
| Filing, confirm | "Three things have to be true. Tick each one yourself." |
| Filing done | "Filed. Claim no. FP-2026-000123." / "It is with the college now. You will see it move here." |
| Paid | "Paid. ₹9,000 reached you in September." / "See the payment statement" |
| Research faculty | "₹14,958 of your ₹3,00,000 is used this year. Incentives are paid after that." |
| Profile | "Add your ORCID and phone. Everything saves together." |
| Error | "Could not load your papers. Nothing is lost. Try again." |

## 10. Research faculty variant

The same views. The difference is one sentence and one meter wherever money appears:

- **Home**: the money section opens with the threshold *sentence* ("₹14,958 of ₹3,00,000 used for
  2026-27; ₹2,85,042 left before incentives are paid") with a single quiet meter under it; no card.
  Only approved or paid claims count as used; claims still on the way are drawn hatched.
- **File a paper (estimate)** and **claim detail**: the claim's own sentence ("Inside your research
  threshold, nothing is paid on this claim" / "crosses it; ₹x above is paid"), already supplied by the
  server and by `claimThresholdSentence`.
- **My claims** and **Payment statement**: a column or a line says what the threshold took.
- **Papers you can still file**: the amount beside File it is the amount **above** the threshold
  ("Inside your threshold" when it is nothing).
- The threshold is never presented as a penalty: wording is "Incentives start after ₹3,00,000".

## 11. Measured results

Scripted walkthroughs (Playwright, one browser, a copy of the real data, real sessions for a regular
and a research faculty member, the app's own servers on 8172 and 5172). Scripts are kept outside the
repository with the screenshots (`D:\Faculty Paper\audit-shots\views\faculty\`: `before\`, `a\`,
`verify\` for the full pass, `confirm\`, `flow-a\`, `measure\`).

| # | Target | Before | After | How it was counted |
|---|---|---|---|---|
| T1 | File from Scopus | 14 clicks | **13 clicks**, about 24 s scripted (waits included) | Home File it (1), three ticks (3), Start the claim (1), journal Continue (1), affiliation tick (1), Continue (1), two uploads, article and references together (2), Continue (1), File this paper (1), confirm File it (1). Before, the form opened on The paper and cost one more Continue. On this machine Scopus is offline, so one more press (Send it with this note) is needed; it is not counted |
| T2 | Where is it, when is money coming | 0 clicks | **0 clicks**, in the first screen at 390 px | The answer sentence sits 297 to 452 px down an 844 px screen |
| T3 | Fix a sent-back claim | 2 screens (Home, then claim page, then scroll) | **1 click** from Home to the fix screen (it opens at the fix section), then 7 presses: two Mark as done, Send again, three ticks, plus the Send button | One screen from reason to Send again. Marking an item as done is replaced by Fix this plus an upload when a file is wrong, which adds one press per item |
| T4 | Profile set up | three Save buttons (phone, ORCID, areas) | **1 Save** for phone and ORCID, about 5 s scripted | Two fields typed, one press, toast shown. The photo is one press and saves by itself. The research areas keep their own Save (another endpoint) |
| T5 | Home to what I was paid this year | 1 click, to all years | **1 click**, to the financial year | The figure "paid since 1 June" opens `/papers/statement?fy=2026` |
| T6 | Home to appraisal list and Print | buried in a footer line | **3 clicks** (My papers, List for appraisal, Print) | Print is visible after two clicks; the third (the browser's print dialog) is not performed |
| T7 | No sideways scroll at 390, taps at least 40 px | passed | **passed**: 144 screenshots of every faculty route at 1440 and 390, light and dark, as the regular and the research faculty member and as a new account; none overflowed, no page errors | `fshot` reports `scrollWidth - clientWidth` on each |
| T8 | One primary, no kicker, no chip repeated down a column | 3 views broke it | **met**: My papers and the record say "Paid" as a quiet word, My claims folds paid claims into a one-line list, My research lost its three kickers, filing lost "step n of 4" above the title | Read from the screenshots |

### Deviations from the plan, and why

- **No amount beside File it.** The estimate needs the journal's SNIP and subject class, which are only
  settled while filing. A guess on Home would be a confident wrong answer, so each ready paper shows
  the journal's quartile instead (Q1 in gold) and the amount appears in the estimate bar the moment
  filing starts. For research faculty that bar also says what the threshold does to the claim.
- **T1 is 13, not 12.** The affiliation tick is a second physical tick (the article names the college);
  it was not in the plan. It stays: it is a legal attestation.
- **The five-station thread is not used for a claimant.** The receipt used to show Filed, Checked,
  Approved, Authorised, Paid, which names the desks. It now shows the four faculty stages.

### What changed, per view

- **Home**: answer sentence kept; the sent-back reason is the college's words (an import note such as
  "Imported from Raw_Data" is never shown); claims on the way are drawn with their four-dot thread; the
  record is a dot field by quartile; a ledger payment of this or last month is said once with the Paid
  stamp; the threshold is one sentence and one meter (no panel).
- **My papers**: one sentence of counts, four tabs, ready papers first, paid as a quiet word.
- **File a paper**: no kicker; the three conditions as one ruled list, ticked by hand every time; the
  form opens on the first section that still needs the person; the checklist is said once when every
  row passes; the receipt shows four stages; research faculty see the threshold effect beside the
  estimate, in the read-back and on the receipt. The merged "already claimed or paid" warning in the
  paper picker and in the confirm step is kept.
- **My claims**: Needs you, On the way, Paid. **Statement, appraisal**: shorter, the year opens from
  Home. **Profile**: one sentence on completeness, one Save, no Google row when it is off.
  **Record**: paid is a word. **Notifications and settings**: shorter. **Welcome**: the three things
  a new lecturer does.

### What was removed or hidden (owner direction, 1 Oct: cut redundancy, hide explanations, buttons look like buttons)

| Where | Removed | Hidden behind a fold or a button |
|---|---|---|
| Home | "N papers on your record have no claim yet" (the title and the button say it); the first-steps sentence shortened | "The college pays in a monthly run..." now under "Show when the next payment is" |
| My papers | the four-figure strip; "Showing 31 of 31"; the footer sentence of links | List for appraisal, Payment statement, My claims are buttons |
| My claims | the payout paragraph and its link | under "Show when the next payment is"; Download is a button |
| Filing | the standing "File once the article is in Scopus..." paragraph on every step; the long sentence under each page title; the per-condition "why it matters" paragraphs | one "Filing conditions" button opens the full rules; the reasons sit in "What the reviewer checks, and how to be sure" |
| Profile | four explanatory sub-lines (changeable details, research office details, sign-in, Scopus); the issued-password paragraph; the paper-count figure strip | "Request a change" is a button on every row |
| Statement, appraisal, notification settings | one-line purpose only | |
| My research | "Past", "Present", "Future" and "Research" kickers | |
| Not changed | src/ui/button.tsx and styles.css (another helper is upgrading them); only the right variants are used: one primary per view, the rest default or quiet |
