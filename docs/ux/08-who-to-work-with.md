# 08 · Who to work with, plus person context (absorbs College network)

Area: **people** (terracotta). Route: `/collaborate` (`pages/collaborate.tsx`), renamed in the
nav to "Who to work with" (unchanged). `/network` redirects here with `?view=map`.

## Purpose
Everyone I've written with, **inside and outside the college**, and a clear answer to "how am I
connected to this person, and why do they matter?". Two-hop context: *you → X (Saveetha) → Y*.

## What the walk found
- "No co-authors yet" is shown for someone with 6-author papers, because co-authorship is
  inferred only from two people filing claims for the same paper.
- The "People you could write with" list is plain.
- The College network is a separate page drawing 2 people and 1 line.

## User jobs
| # | Job |
|---|---|
| J1 | See all my co-authors (internal + external) with how much we've done together |
| J2 | Look up a person Y and see the shortest paths from me to them, with evidence |
| J3 | Get suggestions: who complements me, who my co-authors work with |
| J4 | Act: message, ask for an intro via X, open profile |

## IA
```
DESKTOP
┌ HeroBand area=people ────────────────────────────────────────────────────────────────┐
│ Who to work with                                                                       │
│ "You've written with 14 people — 6 at Saveetha, 8 outside, across 5 institutions."    │
│ ⌕ [ Find anyone — see how you're connected ………………………… ]  (BigSearch, people scope)  │
└────────────────────────────────────────────────────────────────────────────────────────┘
┌ Tabs: [Your co-authors 14] [Suggested 12] [Map] ───────────────────────────────────────┤
├ YOUR CO-AUTHORS ─────────────────────────────────────┬ Your circle (ego graph, 360px) ─┤
│ Filter: [All] [Saveetha 6] [Outside 8]  Sort: most papers▾ │  you at centre; rings =     │
│ ┌ PersonCard ──────────────────────────────────────┐ │  1 hop (co-authors, sized by │
│ │ ◉ Dr T. Jaya · ECE · Saveetha                    │ │  papers), 2 hop faint;       │
│ │ 3 papers together · last 2025 · first 2022       │ │  terracotta = outside,       │
│ │ Together on: "Enhanced ML Framework…" +2         │ │  navy = Saveetha             │
│ │ [Message] [Profile]                              │ │  click node → select card    │
│ └──────────────────────────────────────────────────┘ │                               │
│ ┌ PersonCard external ─────────────────────────────┐ │                               │
│ │ ◉ Prof A. Kumar · IIT Madras · outside           │ │                               │
│ │ 2 papers together · also wrote with 3 colleagues │ │                               │
│ │ [OpenAlex ↗] [Invite to the app?] (disabled v1)  │ │                               │
│ └──────────────────────────────────────────────────┘ │                               │
├ SUGGESTED — grouped with reasons ───────────────────────────────────────────────────────┤
│ "Your co-authors' co-authors" (2-hop, internal first) · "Works on your topics" ·        │
│ "Complements you" (different dept, overlapping venues) · each card shows ConnectionPath │
├ MAP (replaces /network) ───────────────────────────────────────────────────────────────┤
│ Ego network only (you + 2 hops, max 60 nodes) — NOT the whole college.                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Person context panel (the "Y" view)
This opens when a person is picked from search, the list, a suggestion or the map. It is a
right Sheet on desktop and a full screen on phones. It is also embedded on `/u/:id` for anyone
who is not me.
```
┌ Sheet 480px ────────────────────────────────────────────┐
│ ◉ 72  Dr S. Kanagamalliga                                 │
│ ECE · Associate Professor · Saveetha                      │
│ 104 papers · h 12 · Signal processing, control systems    │
├ How you're connected ─────────────────────────────────────┤
│ ConnectionPath (up to 3 paths, shortest first):           │
│  (You) ──3 papers── (Dr T. Jaya, ECE) ──5 papers── (Her)  │
│  (You) ──1 paper─── (Prof A. Kumar, IITM) ──2── (Her)     │
│ No direct paper together yet.                             │
├ Why she matters to you ───────────────────────────────────┤
│ • Publishes in 2 venues you use (IEEE Access, LNNS)       │
│ • Works on signal processing — your speech-assessment     │
│   papers use it                                           │
│ • Q1 papers: 9 (you: 2)                                   │
├ Papers that connect you (the X papers) ── 3 PaperCards ───┤
├ [Message her]  [Ask Dr T. Jaya for an intro]  [Profile]   │
└───────────────────────────────────────────────────────────┘
```
"Ask X for an intro" opens Messages to X with a prefilled draft: "Hi {X}, would you introduce
me to {Y}? I'm working on {my top topic} and saw you've written {n} papers with {Y}." The user
edits it and sends it. It is never sent automatically.

## Interactions
- The search box on this page searches the People scope, internal and external. Picking a
  result opens the context Sheet.
- **Paths** come from the server as a BFS over the Authorship graph, up to 3 hops; 2 hops are
  shown by default. When the only connecting node is external, say so explicitly.
- **External people** cannot be messaged. Their card shows OpenAlex/ORCID links instead.
- **Evidence** is clickable: "3 papers" expands the papers.
- **The Map** is ego-centric, uses a force layout (existing `ui/graph.tsx`) and caps nodes at
  60. Hovering a node highlights its path to you.

## Copy
- Hero: "You've written with {n} people — {i} at Saveetha, {o} outside, across {k}
  institutions."
- Empty (no record yet), using `network-bridge.svg`: **"Your co-authors will appear here"**,
  then "We find them from your papers' author lists — no one needs to file anything. [Check my
  record]"
- No path: "No connection within 3 steps yet. You could be the first — [Message her]."
- External, not messageable: "{name} isn't on this app. [OpenAlex profile ↗]"

## Data
- Planned endpoints:
  - `/api/people/{id}/coauthors` returns
    `[{person|external, papers_together, first_year, last_year, sample_papers:[…]}]`
  - `/api/people/{id}/connection?to={id}` returns
    `{paths:[[{id,name,saveetha,evidence:{papers:3,paper_ids:[…]}}…]], direct:false}`
  - `/api/search/people-external?q=`
- Existing endpoints: `/api/collaborate/me` and `/api/collaborate/graph` (retire them once
  the Authorship-based ones land), `/api/discover/partners`, `/api/dm/with/{user_id}`.
- **NEW: `/api/people/{id}/why?for=me`** returns
  `{reasons:[{kind:"shared_venue|topic|complement|q1", text, refs}]}`. It can be derived
  server-side from overlaps.

## Acceptance
- [ ] Co-authors come from Authorship data. External co-authors are listed with their
      institution.
- [ ] Picking any person shows up to 3 connection paths with evidence counts.
- [ ] "Why they matter" shows at least 2 reasons, derived from data, not the model.
- [ ] "Ask X for an intro" opens a prefilled draft to X and never sends automatically.
- [ ] `/network` redirects to `?view=map`, which is an ego graph capped at 60 nodes.
- [ ] 390px: the Sheet is full-screen and paths wrap vertically.
