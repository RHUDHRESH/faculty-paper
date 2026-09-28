# 01 · Landing: sign-in and Home (faculty)

Area: **record** (navy, solid hero). Routes: `/sign-in`, `/` (faculty home, `pages/home-faculty.tsx`).
Staff homes (`home-staff`, `home-director`, HOD, officer) keep their own layouts but adopt `HeroBand`.

## Purpose
The first two screens decide whether the app feels alive. Sign-in should say *what this is
for you*. Home should answer three questions in order:

1. **Where do I stand?** My record: papers, citations and a rank in one line.
2. **What needs me?** Drafts, returned claims, papers I have not filed.
3. **What is new?** Something to be proud of, or a nudge.

## What the walk found
- The sign-in panel is decent (navy panel, stage bars) but generic. The four stage bars carry
  the same weight as the headline.
- Home opens with three ₹ tiles, two of them showing ₹0. Money leads, yet the owner wants
  pride and flow.
- "Your goals for 2026" is an empty prompt that takes up a full section.
- The "Paid" list repeats My papers.
- Nothing links to research, people or honours, so the page is a dead end.

## User jobs
| # | Job | Today | New |
|---|---|---|---|
| J1 | Sign in quickly | ok | unchanged fields, better framing |
| J2 | See my standing at a glance | ₹ tiles only | Hero: papers · citations · h-index · dept rank + Record strip |
| J3 | Act on what is waiting | "On the way" cards | "Needs you" rail: returned claims, drafts, **unclaimed papers from my record** |
| J4 | File a new paper | button | Big `FilePlusCorner` action in hero + "N papers on your record are not claimed yet" |
| J5 | Feel good / come back | – | "Moments" card: new citation, entered Q1, top-3 in dept, colleague cited you |
| J6 | Money status | 3 tiles | One compact money strip (received this year · on the way), link to My papers |

## IA: sign-in
```
DESKTOP 1440                                             PHONE 390
┌───────────────────────────────┬──────────────────────┐ ┌──────────────────────┐
│ [emblem] Faculty Publications │                      │ │ ███ navy band 280px  │
│          Saveetha Engg College│   [wordmark]         │ │ [emblem]             │
│                               │                      │ │ Your research,       │
│  Your research,               │   Sign in            │ │ on the record.       │
│  on the record.   (Fraunces)  │   Use the email and… │ │ ✦ constellation art  │
│                               │   Email [          ] │ ├──────────────────────┤
│  ✦ illustration hero-landing  │   Password [     ][👁]│ │ [wordmark]           │
│    (papers rising into an     │   □ Remember me      │ │ Sign in              │
│     arch/constellation)       │   [   Sign in    ]   │ │ Email / Password     │
│                               │   ─── or ───         │ │ [ Sign in ]          │
│  1,240 papers · 410 faculty · │   [G Continue w/ Google] (if configured) │ │ live stats line      │
│  23 departments  (live, gold) │                      │ └──────────────────────┘
│ Signing in never creates…     │   Privacy            │
└───────────────────────────────┴──────────────────────┘
```

## IA: Home (faculty)
```
DESKTOP
┌ HeroBand variant=solid (navy, emblem watermark, gold ribbon top) ──────────────────────┐
│ Good morning, Subhashini            (display-honour, white)          [＋ File a paper] │
│ S&H-English · Assistant Professor (SG)                               (gold button)     │
│                                                                                        │
│  20            46           3            #1 in S&H-English                              │
│  papers        citations    h-index      this academic year ↑2                          │
│  ▁▂▃▅▇ Record strip (last 10 years × 12 months, white-on-navy cells)                   │
└────────────────────────────────────────────────────────────────────────────────────────┘
┌ Needs you (3) ─────────────────────────────┐ ┌ Moments ──────────────────────────────┐
│ ⚠ Sent back · "Enhanced ML…" · fix 1 file  │ │ ❝ Cited 4 times this month            │
│ 📄 10 papers on your record aren't claimed │ │ 🏆 You're #1 in S&H-English           │
│    [Review them →]                         │ │ ✦ Dr X (ECE) published in your area   │
│ ⏳ 2 papers on the way · 68 days           │ │ [See your impact card →]              │
└────────────────────────────────────────────┘ └───────────────────────────────────────┘
┌ Next steps: 4 ChoiceTiles (icon-xl) ───────────────────────────────────────────────────┐
│ [CloudDownload] Claim from   [Sparkles] See what you  [UsersRound] Find a   [CalendarDays]│
│  your record                  work on                  co-author            3 deadlines  │
└────────────────────────────────────────────────────────────────────────────────────────┘
┌ Money (compact strip, one row) : ₹0 received this year · ₹0 on the way · ₹1,22,931 to date → My papers ┐
└ Recent from colleagues (3 PaperCards from dept, "Published this week") ────────────────┘

PHONE: hero stacks (greeting, 2×2 figures, strip scrolls horizontally inside hero),
then Needs you, Moments, Next steps as 2×2 tiles (72px icon tiles), money strip, recent.
Sticky bottom bar: [＋ File a paper].
```

## Interactions
- Clicking a hero figure deep-links: papers → `/papers`, citations → `/research#citations`,
  h-index → `/research#metrics`, rank → `/leaderboard?dept=mine`.
- Clicking a Record strip cell goes to `/papers?month=2024-03`.
- "N papers not claimed" goes to `/papers?filter=unclaimed`. Each row there has "File it",
  which opens File a paper with that paper preselected (step 1 is done, step 2 is the
  conditions).
- **Needs you** is sorted in this order: returned claims, then drafts, then unclaimed, then on
  the way. If it is empty, the card shows "Nothing needs you. ✓" at 13px, and the card
  shrinks to one line.
- **Moments** holds a maximum of 3. Each can be dismissed with ✕, which POSTs
  `/me/celebrations/seen`.
- **Greeting** follows the time of day in IST: "Good morning" before 12:00, "Good afternoon"
  before 17:00, otherwise "Good evening".
- **Count-up** runs once per session.

## Copy
- Sign-in headline: **"Your research, on the record."**
- Sign-in sub-line: "Every paper you have published, where each claim stands, and who you could
  write with next."
- Sign-in stats line: "{papers} papers · {faculty} faculty · {depts} departments — and counting".
- Home hero sub-line, when there is no Scopus match yet: "We are still matching you to your
  Scopus profile — figures may be low. [Check my profile]".
- Needs you, empty: "Nothing needs you. ✓"
- Unclaimed row: "{n} papers on your record aren't claimed yet" / "Review them".
- Moments, empty: the card is hidden.
- Error (hero): "Could not load your record. Nothing has been lost — your papers and payments
  are safe. [Try again]". This is the existing copy and is kept.

## Data
- Existing endpoints:
  - `/api/dashboard` (money, on the way)
  - `/api/me/impact` (papers, Q1, rank)
  - `/api/me/celebrations`
  - `/api/claims?status=RETURNED|DRAFT`
  - `/api/calendar?from=today&days=30` (deadline count)
  - `/api/feed?scope=department` (recent)
- **NEW: `/api/me/summary`.** One call for the hero, to stop four queries racing:
  ```json
  { "papers": 20, "papers_source": "record|claims", "citations": 46, "h_index": 3,
    "dept_rank": {"rank":1,"of":6,"dept":"S&H-ENGLISH","delta":2},
    "strip": [{"month":"2024-03","papers":2}, ...],   // last 120 months, sparse
    "unclaimed": 10, "returned": 1, "drafts": 0, "on_the_way": 2,
    "money": {"this_year": 0, "on_the_way": 0, "to_date": 122931} }
  ```
  The counts come from `/api/me/publications`, the Publication/Authorship tables. **The Impact
  card, Home, My research and the Leaderboard must all read papers from this one source.**
  This fixes the 10-vs-20 contradiction.
- **NEW: `/api/public/stats`** (unauthenticated, cached for 1h), returning
  `{papers, faculty, departments}` for the sign-in stats line.

## Acceptance
- [ ] Sign-in renders the Fraunces headline, the illustration and the live stats line.
      Without the stats endpoint, the line is hidden rather than showing 0.
- [ ] The Home hero shows 4 figures and the Record strip. Every figure is a link.
- [ ] The same paper count appears on Home, My research, Impact card and Leaderboard (test
      with the same fixture).
- [ ] Needs you lists unclaimed papers from the record, and "File it" preselects the paper.
- [ ] Money is one row and never the first thing on the page.
- [ ] At 390px there is no horizontal scroll, and the File a paper bar sticks to the bottom.
- [ ] Reduced motion means no count-up.
