# 06 · Discover

Area: **research** (teal), with a light violet accent for model suggestions
(`--color-suggest: #6d4bc2`, used only on the "Suggested by the model" chip). Route: `/discover`
(`pages/discover.tsx`, `for-you.tsx`, `follow-topics.tsx`).

## Purpose
My research is about *me*. Discover is about *out there*: new topics, venues, people and
papers worth my attention this week. It should feel like a magazine front page made for one
reader, not a settings form.

## What the walk found
- The page shows a long vertical list of sections: "New things to work on", people and a
  domains form.
- Errors and "switched on?" states sit in the main flow.
- There are no visuals, and cards are text rows.
- The domain-selection form sits in the middle of the page.

## User jobs
| # | Job |
|---|---|
| J1 | "What should I read / work on next?" |
| J2 | "Where could my current paper go?" (venue finder) |
| J3 | "Who should I meet?" (people with a reason) |
| J4 | Tune what I'm shown (topics followed) |

## IA
```
DESKTOP
┌ HeroBand area=research ──────────────────────────────────────────────────────────────┐
│ Discover                                            Tuned to: [Language assessment ×] │
│ "This week: 3 new directions, 12 fresh papers, 4 people near your work."  [+ topic]   │
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ Tabs (pill, big icons 20): [Compass For you] [Sparkles Directions] [BookOpen Venues]  │
│                            [UsersRound People] [FileText Fresh papers]                 │
├ FOR YOU (default) — magazine grid ─────────────────────────────────────────────────────┤
│ ┌ Feature card (2/3 width, teal wash, illustration ideas.svg 160px) ──┐ ┌ Venue card ─┐│
│ │ DIRECTION · Counted                                                 │ │ Q1 · 🎯fits  ││
│ │ Speech assessment with LLMs                                         │ │ CALL journal ││
│ │ 14 Saveetha papers in 2026 (↑ 180%) · 3 by your co-authors          │ │ 2 of your    ││
│ │ Why you: you've written 8 papers on spoken-English assessment.      │ │ topics       ││
│ │ [See the 14 papers] [Follow]                                        │ │ [Open]       ││
│ └─────────────────────────────────────────────────────────────────────┘ └──────────────┘│
│ ┌ Person ──────────┐ ┌ Person ──────────┐ ┌ Fresh paper ─────┐ ┌ Suggested ◇ model ─┐ │
│ │ ◉ Dr S. Kanaga…  │ │ ◉ Ext: Prof …    │ │ 📄 title…        │ │ "Try a cross-dept  │ │
│ │ ECE · 2 hops     │ │ IIT M · wrote w/ │ │ by Dr X (CSE)    │ │ study with MECH on…"│ │
│ │ why: signal proc │ │ 2 colleagues     │ │ in your topic    │ │ checked ✓ against  │ │
│ └──────────────────┘ └──────────────────┘ └──────────────────┘ │ our records        │ │
│                                                                └────────────────────┘ │
├ VENUES tab: venue finder ──────────────────────────────────────────────────────────────┤
│ "Where could this paper go?"  [paste title + abstract ……………] [Find venues]            │
│ Streaming ranked JournalCards: fit score bar · quartile · APC? · colleagues published  │
├ PEOPLE tab: PersonCards grid (internal + external), filter: Saveetha / outside / both  │
├ DIRECTIONS tab: list of topics with growth sparkline, papers, your overlap             │
├ FRESH PAPERS tab: newest papers at Saveetha in followed topics (PaperCard list)         │
└────────────────────────────────────────────────────────────────────────────────────────┘
Tuning (topics followed, domains) moves to a Sheet opened by "Tuned to: … [+ topic]".

PHONE: hero 2 lines; tabs scroll; For-you grid → single column feed, feature card first;
tuning sheet full-screen.
```

## Interactions
- **For you** mixes item types in a fixed rhythm: 1 feature, then 1 venue, then 3 people or
  papers, then 1 model suggestion. This gives variety without chaos.
- Every card has a **Why** line. Cards can be dismissed from the ⋯ menu ("Not interested" hides
  similar items). The dismissal is stored server-side.
- **Model suggestions** are always chipped "Suggested by the model · checked against our
  records". Existing honesty rule: anything named is verified.
- **The venue finder** streams from `/api/discover/venues/stream` and can be cancelled
  (existing).
- **When suggestions are disabled** by the institution, the model card is hidden, and the
  counted content stands alone. The page must never show "Could not tell whether suggestions
  are switched on" in the main flow; that message goes to the console or telemetry.

## Copy
- Hero: "This week: {d} new directions, {p} fresh papers, {n} people near your work."
- No topics followed and no record yet: **"Tell us what you work on"**, then "Pick two or three
  topics and Discover fills up. You can change them any time." Button: [Choose topics]. Use
  `ideas.svg`.
- Venue finder empty: "Paste a title and abstract — we'll rank journals that publish work like
  it, and show who here has published there."
- Error per card region: "Couldn't load {section}. The rest of the page still works. [Retry]"

## Data
Existing endpoints:

- `/api/discover/next`, `/api/discover/directions`, `/api/discover/partners`
- `/api/discover/venues[/stream|/cancel]`, `/api/discover/status`
- `/api/feed/for-you`
- `/api/follows`, `/api/follows/topics`
- `/api/trends/openings`

Planned endpoint: `/api/search/people-external`, for external people.

New endpoints:

- **NEW: `/api/discover/for-you?cursor=`** returns
  `[{kind:"direction|venue|person|paper|suggestion", id, title, why, source:"counted|model", payload:{…}}]`,
  in the rhythm order on the server.
- **NEW: `POST /api/discover/dismiss`** with body `{kind,id}`.

## Acceptance
- [ ] For-you renders a mixed magazine grid, and every card has a why line.
- [ ] Tuning lives in a sheet, not inline.
- [ ] Model suggestions are visibly distinguished and hidden when disabled.
- [ ] The venue finder streams and can be cancelled.
- [ ] External people appear in People, with an affiliation chip.
- [ ] 390px: single-column feed and no horizontal scroll.
