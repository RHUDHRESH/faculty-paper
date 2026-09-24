# 05 · My research: past, present, future (absorbs "The college's research")

Area: **research** (teal). Both pages live in `pages/programme.tsx` today:

- `Programme` is at `/programme` and is titled "{name}'s research".
- `CollegeResearch` is at `/research` and is titled "The college's research".

Today, the nav label "My research" points to `/programme` and "The college's research" points
to `/research`, which is confusing. **Final:** one page at `/research` with tabs
`?tab=me|college`. `/programme` redirects to `/research?tab=me`.

## Decision on "The college's research"
It is **merged, not kept**. In the walk it was three skeleton lists and an AI paragraph, with no
figure, no picture and no way to act. Its useful parts, the areas the college works in, who
works near your areas and what to try next, belong either in the context of *my* research or in
Discover. The page becomes a tab of My research with a real picture (see below). The "What to
try next" AI block moves to Discover.

## Purpose
One page that answers three questions:

- **Validate my past:** a record I am proud of, in numbers and in a timeline.
- **Inform my present:** what I work on now, where I publish and how it is going.
- **Give ideas for my future:** open directions, venues and people, each with a reason.

## What the walk found
- It shows "10 papers · 0 Q1 · 2 first author · **0 subject areas**", and then a paragraph
  explaining that all 10 have no area. The one analytic section is empty for this user.
- The published work list duplicates My papers.
- There is no chart, no timeline and no future.

## IA
```
DESKTOP
┌ HeroBand area=research ──────────────────────────────────────────────────────────────┐
│ My research                                   [Your public profile] [Impact card]     │
│ [Me] [The college]  ← tabs                                                            │
│ "You write about English-language assessment with machine learning."  (display, 1 line│
│  generated from top keywords; editable ✎ by the user → saved as profile headline)     │
│ StatTiles: 20 papers ▁▃▅▇ · 46 citations ↑12 this yr · h-index 3 · 2 Q1 · 6 first-author│
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ PAST — "Your record" ──────────────────────────────┬ Citations per year (Trend chart)──┐
│ Timeline (vertical, year markers):                  │ ▂▃▅▇ bars, teal, 2019→2026        │
│ 2026 ● 3 papers · first Q2 in IEEE Digital Explore  │ "Most cited: Transformative       │
│ 2025 ● 9 papers · ★ most-cited paper (12 cites)     │  Approach in Engineering Curricula│
│ 2024 ● 5 papers · first paper with an external      │  — 12 citations"                  │
│        co-author (IIT M)                            │                                   │
│ 2019 ● First paper                                  │ RecordStrip (full, 10 yrs)        │
├ PRESENT — "What you work on now" ──────────────────────────────────────────────────────┤
│ Topic cloud → as ranked chips w/ bars (RankedBars): Language assessment 8 · NLP 6 · …  │
│ (derived from OpenAlex concepts/keywords of MY papers, not journal areas)              │
│ Where you publish: JournalCards ×3 (venue, count, quartile)  · Conf vs journal MixBar  │
│ Who you write with: top 5 co-authors avatars (→ Who to work with)                      │
├ FUTURE — "Ideas for what's next" ──────────────────────────────────────────────────────┤
│ 3 IdeaCards (Lightbulb, teal wash):                                                    │
│  ◆ Topic rising near you: "Speech assessment with LLMs" — 14 papers at Saveetha in     │
│    2026, 3 by people you've written with. [See papers] [Follow topic]                  │
│  ◆ A Q1 venue that fits: Computer Assisted Language Learning (Q1) — publishes your     │
│    top 2 topics; 1 colleague published there. [Journal]                                │
│  ◆ A partner who completes you: Dr S. Kanagamalliga (ECE) — signal processing +        │
│    your assessment work. You → Dr T. Jaya → her. [Profile]                             │
│ This year (replaces My goals — see 13-goals.md): "3 papers so far in 2026. Last year   │
│ by now: 5." + optional personal target ring.                                           │
│ [More ideas in Discover →]                                                             │
└────────────────────────────────────────────────────────────────────────────────────────┘

TAB "The college"
┌ Hero: "Saveetha published 1,240 papers across 23 departments" ─────────────────────────┐
│ Topic map: treemap of top 24 topics (size = papers, teal shades), your topics outlined │
│ in navy — click a tile → Search topic scope                                            │
│ Departments × topics heat grid (rows depts, cols top 10 topics)                         │
│ "Near you": 5 PersonCards working on your topics (reason line each)                     │
│ Rising this year: 5 topics with ↑ growth vs last year                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘

PHONE: hero figures 2×3 grid; sections stack; timeline full width; treemap becomes a
ranked list with bars; IdeaCards swipeable horizontal (scroll-snap) with dots.
```

## Interactions
- **Headline sentence** is generated server-side from the top 2 topics. The ✎ control lets the
  user overwrite it, and the result is saved to their profile headline.
- A **timeline event** click scrolls to or filters that year in My papers (a link).
- A **citations bar** click opens a popover listing the papers cited that year.
- A **topic chip** click opens `/search?scope=topics&q=`.
- **Follow topic** POSTs `/api/follows/topics`.
- **Idea cards** always show a *reason* line and a source chip, "Counted" or "Suggested by the
  model". The model-written ideas keep the existing "Suggested, not counted" honesty rule.
- **Tabs** persist in `?tab=`.

## Copy
- Past heading: **"Your record"**. Present: **"What you work on now"**. Future: **"Ideas for
  what's next"**.
- No topics yet: "We'll learn your topics from your papers' keywords once your record is
  matched. [Check my record]". This replaces the current "0 subject areas" paragraph.
- No citations known: the tile shows "—" with the caption "Citations arrive with your Scopus
  record".
- Idea card, when the model is off: the card is hidden, and the counted ideas still show.
- College tab error: "Could not load the college picture. Your own record is unaffected.
  [Retry]"

## Data
- Existing endpoints:
  - `/api/programme/me`, `/api/programme/around`
  - `/api/trends/me`, `/api/trends/openings`
  - `/api/discover/directions`, `/api/discover/partners`
  - `/api/reports/areas`
  - `/api/me/interests`
  - `/api/me/goals`
- Planned endpoints: `/api/me/publications`, `/api/people/{id}/coauthors`.
- **NEW: `/api/me/research`**
  ```json
  { "headline": "…", "headline_is_custom": false,
    "metrics": {"papers":20,"citations":46,"h_index":3,"q1":2,"first_author":6,
                "citations_this_year":12},
    "citations_by_year": [{"year":2024,"count":10}],
    "timeline": [{"year":2025,"kind":"most_cited|first_q1|first_paper|external_coauthor|milestone","text":"…","ref":"pub-id"}],
    "topics": [{"id","label","papers":8}],
    "venues": [{"id","name","quartile","papers":3}],
    "mix": {"journal":12,"conference":8},
    "this_year": {"papers":3,"same_date_last_year":5} }
  ```
- **NEW: `/api/college/research`** returns
  `{totals, topics:[{id,label,papers,growth}], dept_topic:[{dept,topic,papers}], near_me:[person…]}`.

## Acceptance
- [ ] `/programme` redirects to `/research?tab=me`. The nav has one item, "My research".
- [ ] The hero shows a sentence and 5 stat tiles from `/api/me/research`, and the counts match
      Home.
- [ ] Past, Present and Future sections are all present. Each shows a helpful empty state,
      never a bare 0.
- [ ] Topics come from paper keywords/concepts, not only journal subject areas.
- [ ] Every idea has a reason line and a counted/suggested chip.
- [ ] The College tab shows the treemap, heat grid and near-me people, with the user's topics
      outlined.
- [ ] 390px layout as specified, with no horizontal scroll.
