# 04 · File a paper

Area: **record** (navy), with the gold ribbon at submit. Route: `/papers/new`
(`pages/file-paper.tsx`, `pages/filing/*`, `ui/eligibility.tsx`, `ui/wizard.tsx`).

## Purpose
Turn a published paper into a claim with the least typing, while making sure every claimant
**reads and physically ticks the three eligibility conditions each time**. This is the
college's legal protection.

## Owner's rules (non-negotiable)
1. **"Pull from Scopus"**, which means picking one of *my* papers from my record, is the
   **first** step and the default. Pasting a DOI is the alternative.
2. **The three conditions are shown in full every time.** Nothing folds away after the first
   filing. The current `claim-rules-read` localStorage fold must be **removed**.
3. **All three must be ticked, one by one, by the person**, for *this* article. There is no
   "tick all", nothing is pre-ticked and nothing is remembered.
4. The owner wants **huge icons and more variety**, so the page should be visually rich.
5. The existing five form steps keep all their fields (the owner's earlier rule in the code
   comment). They are re-sequenced after the new steps 1 and 2.

## New flow (7 steps; the stepper shows them as 4 phases)
```
PHASE A  Choose the paper    1 Pick from my record   (or 1b Paste a DOI / link)
PHASE B  Confirm             2 The three conditions  ← about THIS paper, shown in full
PHASE C  Details             3 The journal · 4 You and the claim · 5 The proof
PHASE D  File                6 Check and file  → 7 Receipt (celebration)
```
Why the conditions come after the choice: every condition is about **one article**.
Ticking them with the article's title in front of the person is stronger evidence than
ticking them in the abstract. It also means the gate can say "*Generative AI for Real-Time
Emotion…* is indexed in Scopus", not just "the article".

## IA: Step 1 (method + pick)
```
DESKTOP
┌ HeroBand area=record, compact ───────────────────────────────────────────────────────┐
│ ← My papers                                                                           │
│ File a paper                     ●━━━━○────────○────────○                              │
│ Start from your record — it fills almost everything.  Choose · Confirm · Details · File │
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ Two ChoiceTiles, side by side, 50/50, 220px tall ────────────────────────────────────┐
│ ┌───────────────────────────────────┐   ┌───────────────────────────────────┐        │
│ │ [ 88px tile · CloudDownload 48 ]  │   │ [ 88px tile · ClipboardPaste 48 ] │        │
│ │ Pull from my Scopus record        │   │ Paste a DOI or link               │        │
│ │ Pick one of your 10 unclaimed     │   │ For a paper that isn't on your    │        │
│ │ papers. Journal, authors and      │   │ record yet.                       │        │
│ │ quartile fill themselves.         │   │                                   │        │
│ │ ★ Recommended (gold chip)         │   │ illustration: none                │        │
│ │ illus scopus-pull.svg 120px       │   │                                   │        │
│ └───────────────────────────────────┘   └───────────────────────────────────┘        │
├ When "Pull" is selected (default): picker list below ────────────────────────────────┤
│ ⌕ Filter your papers…                     [↻ Check Scopus for new papers]             │
│ ◉ Generative AI for Real-Time Emotion- and Culture-Aware Storytelling                 │
│    ICECA 2025 · author 3 of 6 · Scopus ✓ · eligible ✓                                 │
│ ○ A Deep Learning Model Integrating RL for Personalized English… · ISAC3 2025         │
│ ─ Already claimed (8) ─ collapsed, greyed, each with "View claim"                      │
│ ─ Not eligible (0) ─ with reason, e.g. "No Saveetha affiliation on the paper"          │
│                                                        [Continue →]                    │
└───────────────────────────────────────────────────────────────────────────────────────┘
"Paste" selected → existing PasteBox (finder.tsx) inline, 56px input, same Continue.
```

## IA: Step 2 (the three conditions): the gate
```
┌ Confirm three things about this paper ───────────────────────────────────────────────┐
│ ┌ selected paper, PaperCard compact, cream plate ─────────────────────────────────┐   │
│ │ 📄 Generative AI for Real-Time Emotion- and Culture-Aware Storytelling  [Change]│   │
│ └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                        │
│ ┌──────────┬────────────────────────────────────────────────────────────────────┐     │
│ │ [ShieldCheck│ 1  Indexed in Scopus, on my own Author Profile                      │     │
│ │  48, navy  │ This article is officially indexed in Scopus and linked to MY Scopus │     │
│ │  wash tile]│ Author Profile. A claim filed before indexing cannot be processed.   │     │
│ │            │ Wrong or duplicate Scopus ID? Fix it first in the Scopus Author      │     │
│ │            │ Feedback Wizard ↗ — nobody at the college can do it for you.         │     │
│ │            │ Evidence we found: ✓ Scopus EID 2-s2.0-… lists you (author 3)        │     │
│ │            │ ┌────────────────────────────────────────────────────────────────┐   │     │
│ │            │ │ ☐  I confirm this is true for this article                     │   │     │
│ │            │ └────────────────────────────────────────────────────────────────┘   │     │
│ └──────────┴────────────────────────────────────────────────────────────────────┘     │
│ ┌ 2 [CopyX 48] No incentive claim has been filed for this article before ──────────┐   │
│ │ …by you or any co-author. Duplicates are traced against the paid ledger.         │   │
│ │ Evidence: ✓ No claim found for this DOI in our records   ☐ I confirm …          │   │
│ └──────────────────────────────────────────────────────────────────────────────────┘   │
│ ┌ 3 [FileStack 48] I have the article PDF and 2 SEC-affiliated cited reference PDFs ┐  │
│ │ …each with its number from the reference list. Affiliation must read             │   │
│ │ "Saveetha Engineering College".                                   ☐ I confirm …  │   │
│ └──────────────────────────────────────────────────────────────────────────────────┘   │
│ Rules also cover: claim reason & SNIP · affiliation   [Read the full filing rules ▾]  │
│ (expander, shows ClaimRulesPanel; closed by default but the 3 above are ALWAYS open)  │
│                                                                                        │
│ [ Start the claim → ]   0 of 3 confirmed    Not yet — back to my papers                │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
Each condition is a large card (min 120px). A 48px icon sits in an 88px navy-wash tile. The
checkbox is 24px, and its label spans the full row, so the whole bottom band is the hit target.

When a box is ticked, the card border turns `--color-positive`, the icon tile turns positive
wash, and the check draws with the 180ms spring (motion spec).

The counter reads "0 of 3 confirmed". Pressing Start with boxes still unticked keeps the
existing behaviour: it focuses an alert that names the outstanding items and gives "what to do
if you can't".

## Steps 3–6
These are the existing steps (journal, you and the claim, proof, check and file) with their
fields unchanged, restyled as follows:

- Each step heading has an `icon-lg` icon: `BookOpen`, `PenLine`, `FileStack`, `Send`.
- Fields prefilled from the record are marked with a small teal "From Scopus" chip. Editing
  one keeps the chip and adds "edited".
- The live estimate (`filing/estimate.tsx`) sits in a sticky right rail on desktop, in the
  honours gold wash: "Estimated incentive ₹ 7,926 · Q2 · author 3 of 6". On phones it is a
  collapsible bottom bar.
- Step 6 repeats the **three confirmations read-only**, with timestamps: "Confirmed 14:02 ·
  24 Sep 2026". It adds the line: "By filing you declare these are true. They are stored with
  the claim."
- **Step 7 receipt:** a cream plate with the gold ribbon and the `celebrate.svg` illustration.
  - Heading "Filed. It's with the research cell."
  - The ticket number, big, in mono, with a copy button.
  - The StageTrack at Submitted.
  - Actions: [Track it] [File another from my record (n left)].

## Phone
- The ChoiceTiles stack. Each is 140px tall with a 72px icon tile, and the illustration is
  hidden.
- The picker list is full width.
- Condition cards are full width with the icon on top (48px). The checkbox band is 56px tall.
- A sticky bottom bar holds the Continue/Start button and "n of 3".

## Interactions and rules
- The default method is Pull when `unclaimed > 0`. Otherwise the default is Paste, and the Pull
  tile shows "No unclaimed papers on your record. [Check Scopus for new ones]".
- `?publication={id}` preselects the paper and opens Step 2.
- **"Change"** on Step 2 returns to Step 1 and **clears all three ticks**.
- **Ticks are never persisted client-side.** A reopened draft (`?draft=`) shows Step 2 again
  with the boxes unticked, but only if the draft has no server-side acknowledgement for its
  current DOI. If the DOI changed, the boxes must be re-ticked.
- **Evidence lines** are read-only facts we found, such as the Scopus EID listing the person,
  or no claim for the DOI. They never tick a box for the user. When evidence *contradicts* a
  condition, for example "A claim for this DOI was filed by Dr X on 3 Mar 2025", show a
  critical callout, and block Start with "This article already has a claim — open it instead."
- Ctrl-Enter continues (existing).

## Copy (exact)
- Step 1 title: **"Choose the paper"**. Sub-line: "Start from your record — it fills almost
  everything."
- Pull tile: **"Pull from my Scopus record"** / "Pick one of your {n} unclaimed papers.
  Journal, authors and quartile fill themselves." / chip "Recommended".
- Paste tile: **"Paste a DOI or link"** / "For a paper that isn't on your record yet."
- Step 2 title: **"Confirm three things about this paper"**. Sub-line: "All three have to be
  true. Tick each one yourself — they are recorded with your claim."
- Condition labels: keep `confirmations()` in `ui/eligibility.tsx` verbatim, but render the
  checkbox label as **"I confirm this is true for this article"**, with the condition as the
  card heading. The exact condition wording stays under the owner's control in one file.
- Button: **"Start the claim"**. Counter: "{k} of 3 confirmed".
- Picker empty: "Nothing to pick yet — your record hasn't been matched to Scopus. [Paste a DOI
  instead]".
- Scopus check failed: "Couldn't reach Scopus just now. Your record from the last check is
  shown. [Try again]".

## Data
- Existing endpoints:
  - `/api/lookup/paper`, `/api/lookup/verify`, `/api/lookup/file-check`
  - `/api/prior/check` (duplicates)
  - `/api/calculate`
  - `/api/claims/upload`
  - `/api/meta/filing-rules` (condition text, min references)
- Planned endpoints: `/api/me/publications?claim_state=none` (the picker) and
  `/api/me/scopus-pull`.
- **NEW, legal record:** the claim payload gets
  ```json
  "confirmations": [{"id":"indexed","text_version":"2026-09","ticked_at":"2026-09-24T14:02:11+05:30"},
                    {"id":"no-duplicate",...},{"id":"documents",...}]
  ```
  The server rejects a filing that lacks any of the three, or whose `text_version` is not
  current. It stores them on the claim, and they are shown on claim detail and in audit.
  `text_version` comes from `/api/meta/filing-rules`.
- **NEW: `GET /api/me/publications/{id}/evidence`** returns
  `{scopus_eid, lists_me, my_position, existing_claim:{id,owner,filed_at}|null, affiliation_found}`.

## Acceptance
- [ ] Step 1 is the Pull/Paste choice, and Pull is the default when unclaimed papers exist.
- [ ] The picker lists unclaimed papers from the record. Claimed and ineligible papers are
      shown separately with a reason.
- [ ] Step 2 shows all three conditions **expanded, every time**, including on the 2nd and
      nth filing and on reopened drafts. `claim-rules-read` is removed.
- [ ] Every box starts unticked. There is no select-all. "Change paper" clears the ticks.
- [ ] The filing request carries three confirmations with timestamps, and the server refuses
      it without them (test).
- [ ] An existing claim for the DOI blocks Start with a link to that claim.
- [ ] The three icons are 48px in 88px tiles, and the ChoiceTiles are at least 200px tall on
      desktop.
- [ ] The receipt shows the gold-ribbon plate and the ticket number.
- [ ] Keyboard only: Space ticks, Tab moves card to card, Ctrl-Enter continues.
- [ ] 390px: no horizontal scroll, and the bottom bar does not cover the last checkbox.
