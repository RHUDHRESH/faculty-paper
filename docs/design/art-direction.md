# Art direction: the well-kept register

Inputs: PRODUCT.md, docs/design/critique-before.md, 52 references in
`D:\Faculty Paper\inspiration\` (not in the repository; `sources.md` lists each URL and what we
take), docs/ux/22 (answer first), docs/jtbd/*.

## The concept, in one sentence

**The college's research on warm paper in navy ink, with one thread that shows where every claim
is, a face for every name, and the hand-drawn pictures it already owns shown as prints.**

## Who is looking, and where

A lecturer on a phone in a corridor between classes, in daylight. A clerk at a desk, all day, on a
monitor, clearing fourteen claims by keyboard. A Principal for four minutes. An administrator
checking that nothing is stuck. Light theme by default (daylight, offices, printed statements);
dark for evenings and for people who choose it.

The category's default (the "dashboard"): a grey or dark field, a row of four metric cards, a
chart in blue. Its predictable opposite: a hero-less cream page with a serif heading and a
terracotta button. The second is what this app already is, and it is also what every product
that "looks like claude.ai" ends up as. Both are the rut.

## What the audience knows by heart (seven candidates)

Chosen from the world of an Indian college office, its graphic traditions and its
rituals, not from software:

1. **The office register**: a ledger kept in ink, ruled lines, an accession number, the initials
   and date of whoever handled it. *Carries the mechanism (every claim a line, every handler a mark).*
2. **The rubber stamp** ("Approved", with the date and initials) on a file: the one ritual of
   deciding that every office in India shares.
3. **The file noting**: the green notesheet clipped to a file, numbered paragraphs, a signature per
   desk, the file moving from desk to desk. *The real mental model of the chain.*
4. **Silk-border textiles** (Kanchipuram): a field with a contrasting woven border; saturated
   jewel colours. *Cultural home, high risk of costume.*
5. **The kolam**: a dot lattice drawn at the door every morning; dots joined by one continuous
   line. *A counting idiom (one dot per thing) and a thread through stations.*
6. **The library print** (a plate in a bound volume, mounted, with a caption): botanical and
   architectural plates. *Exactly how the 213 drawings want to be shown.*
7. **The convocation gazette**: serif, rules, notices, serial numbers; the college's printed
   voice. *Authority; risks stiffness.*

Material families spanned: ledger and paper (1, 3, 7), ritual and stamp (2), pattern and textile
(4, 5), print and plate (6). The final direction takes the **register** as its world, the **stamp**
as its one ritual, the **kolam** as its counting idiom and thread, and the **print** as the way
pictures are shown. Textile borders (4) and the gazette's rules (7) are declined: a woven border
is wallpaper on a working screen, and gazette rules compartmentalise the page.

## Three directions

### A. The Well-Kept Register (chosen)

Paper, navy ink, a display serif for the answer, a thread with stations as the signature, prints
for the pictures, one stamp when something is decided.

```
Faculty Home, 1440 (content column 1100, sidebar at left)

 Good morning, Kanagamalliga.                                     [ File a paper ]
                                                      ┌────────────────────────┐
 Nothing needs you.                                   │ [ mounted print:       │
 One claim is [being checked].  <- chip inside        │   the desk and lamp ]  │
                                                      │ A desk, as it should be│
 ●────────●────────○────────○────────○                └────────────────────────┘
 Filed   Checked  Approved Authorised Paid
 0        1 ←you   0         0         81 (your 145 papers: 119 paid)

 Papers you can still file                                       All 24 papers →
 ────────────────────────────────────────────────────────────────────────────────
 [Q3] A zigbee and embedded based security monitoring…    Zenodo · 2026   [ File it ]
 [Q1] IoT-Based Automated Electricity Billing …           ICC-CNS · 2026  [ File it ]

 Your money
 ₹3,96,703      paid so far, 89 payments      · ₹4,800 since June · ₹0 on its way
 ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ●  145 papers, one dot each
 ● ○ ○  Q1 12 · Q2 31 · Q3 40 · Q4 ...
```

```
Research office, desk queue, 1440

 Clearing queue                                              [ Review the 1 ready ]
 Submitted claims, oldest first. The one that has waited longest is next.

 14 waiting · oldest 92 days · ₹5,665 across the 1 priced
 ●────────●────────○────────○────────○      (the Thread, your station ringed)
 Filed   Checked 14  Approved  Authorised  Paid

 [ Search claim, title, claimant ]  [ Department ▾ ]  [ More filters ]
 ──────────────────────────────────────────────────────────────────────────────
 (face)  Dr. S. Kanagamalliga · ECE      Secure and Intelligent Indoor …    92 days  [ Review ]
         IEEE Xplore · ERP-RAW-3         No amount recorded
 (face)  Ms. G. Arokia Nerling Rasoni    Deep Learning-Based Multi-Class …  90 days  [ Review ]
```

Why: answer-first made literal (the biggest thing is the answer), the product's mechanism drawn
once and reused everywhere, and the college's own drawings finally given a place to be looked at.
It stays inside what the owner asked for (claude.ai manners) and avoids its defaults by choosing
navy ink, a specific serif, a counting chart and a ritual.

### B. The Gallery (declined)

White ground, edge-to-edge images, every paper a large cover tile in a masonry wall, portraits
of colleagues at 160 px. Modelled on museum collection pages and a Godly-style image wall.

```
Faculty Home
 ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
 │ cover │ │ cover │ │ cover │ │ cover │     <- 145 papers as a wall
 │  Q1   │ │  Q3   │ │  Q2   │ │  Q1   │
 └───────┘ └───────┘ └───────┘ └───────┘
 Good morning, Kanagamalliga · 24 papers you can file · ₹3.97 lakh paid

Research office, desk queue
 ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 │ (face) │ │ (face) │ │ (face) │ │ (face) │ │ (face) │   <- 14 claims as portrait tiles,
 │ Dr. K  │ │ Ms. G  │ │ Bharathi│ │ Ms. D  │ │ Dr. M  │      oldest first, a clay
 │ 92 d   │ │ 90 d   │ │ 89 d   │ │ 85 d   │ │ 83 d   │      corner mark for "late"
 └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
```

Declined: beautiful for browsing a collection, wrong for the desk queue (a clerk needs rows, not
portrait tiles; fourteen tiles hide the oldest, and a keyboard cannot walk a masonry), expensive to build for 650 routes, and it would make the claim chain secondary.
Kept: the portrait tile, for profile and "who to work with".

### C. The Notesheet (declined as a page, kept in one place)

The page is a green notesheet: ruled, numbered paragraphs, a margin for initials, the file as a
stack on a table. Modelled on how Indian offices actually move files.

```
 ┌───────────────────────────────────────────────┐
 │ 1. Claim FP-2026-000001 received. -- Faculty   │
 │ 2. Checked; no objection.          -- RC  3 Oct │
 │ 3. Approved for ₹4,000.            -- Principal │
 │ 4. ______                                       │
 └───────────────────────────────────────────────┘

Research office, desk queue: a stack of files on the table
 ┌─ FP-2026-000014 ─────────────────────────┐
 │  Dr. S. Kanagamalliga, ECE      92 days   │   <- the top file; the rest peek out
 ├─ FP-2026-000010 ─────────────────────────┤      below it, each a tab
 ├─ FP-2026-000012 ─────────────────────────┤
 └───────────────────────────────────────────┘     (put up / seen / approved in the margin)
```

Declined: a stack of files shows one and hides thirteen, so "oldest first" becomes "only first".
It is the right model for *one claim's history* and the wrong model for a Home, a list
or a form (a skeuomorphic page makes every screen look like the same sheet, and costume risk is
high). Kept: the claim history on the review workspace and the claim page reads as numbered notes
with initials and dates, set in the normal type (no green sheet).

## Why A, in four sentences

A is the only direction that makes the answer the biggest thing on every page without adding a
single new component the user has to learn; it gives the product a picture of its own mechanism;
it uses the illustrations at the size they were drawn for; and it costs one new type scale, one
palette, one component (the Thread) and one motion, not a new UI. B and C each solve one screen.

## Where the boldness is spent

1. **Type.** Display XL for the one answer sentence on Home and the sign-in headline; Display for
   every page title; Figure for numbers that are answers. Nothing else on a screen is within 16 px
   of these sizes.
2. **Pictures.** One mounted print per view, big enough to read, chosen for the role. The sign-in
   page is the one place a picture is allowed to dominate.

Quiet everywhere else: hairlines, paper, ink, 13 to 16 px Inter.

## The signature and the ritual

- **The Thread.** Five stations, claims as dots, your station ringed. It is the answer to "where is
  everything" for a desk, "where is my claim" for faculty, "is anything stuck" for the admin.
- **The Stamp.** A decision lands as a stamp in the row where it was made. It replaces the toast
  for Clear, Approve, Authorise and Pay, and nowhere else.
- **The dot field.** One dot per paper (or per claim): the house chart, a unit chart a person can
  count. Echoes the kolam without drawing a kolam.

## How it stays simple (docs/ux/22)

- Every page keeps the five-part anatomy; only the weight changes: part 2 (the answer) becomes the
  biggest thing on the page.
- No new navigation. The sidebar loses weight (quieter, fewer visual groups), not items.
- No new concepts for a lecturer: the Thread shows the same four stages the faculty already see,
  with the same words.
- The Stamp and the dot field are decoration that carries information; neither blocks a task.

## Bans (this app, in addition to impeccable's)

1. A kicker, eyebrow, section number or all-caps label above a heading.
2. Gradient text; glass or blur as decoration; hard offset shadows; neon-on-dark.
3. A coloured side stripe on a card, row or alert.
4. A grid of identical metric cards; a card inside a card.
5. Emoji, or a Unicode glyph, as an icon.
6. An illustration under 96 px, on a card, in a table, or two in one viewport; one drawing used for
   two roles; a drawn person standing in for a named person.
7. Clay for a destructive action; a filled red button.
8. The display face for a column of money, for text under 22 px, or for a label.
9. A second authored motion, motion between pages, lift on hover, a bounce.
10. Costume: no woven borders, no kolam wallpaper, no paisley, no saffron-and-green; the local
    identity is the college's navy and gold, the rupee, the faces and the hand-drawn pictures.

## What changes in the code (foundation scope)

Tokens and fonts; the kit (PageHeader, Answer, Section, Table, Button, Field, Select, Dialog,
Sheet, Tabs, Chip, Avatar, charts' palette, EmptyState and error and loading states, Toast);
the shell (sidebar, header, breadcrumbs, palette); the sign-in page; and four new pieces:
`Thread`, `Stamp`, `Plate` (the mounted illustration) and `DotField`. The five view builders
then compose these. See docs/design/foundation-handoff.md.
