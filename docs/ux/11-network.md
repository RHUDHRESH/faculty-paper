# 11 · College network: decision to CUT

Route: `/network` (`pages/network.tsx`, `ui/graph.tsx`).

## Decision
**Delete the College network as a page.** Keep the graph component, and reuse it as the ego
**Map** tab inside Who to work with (spec 08). `/network` redirects to
`/collaborate?view=map`, and the nav item is removed.

## Evidence from the walk (2026-09-24, real data copy)
- The drawing shows **"2 people and 1 connections"** for a college of about 410 faculty. The
  edges came only from two people filing claims for the same paper, or from an agreed
  collaboration. Almost nobody qualifies, so the picture says "nobody here collaborates",
  which is false.
- Even with full Authorship data, a whole-college hairball of 400+ nodes answers no question a
  faculty member has. Force-directed graphs of that size are unreadable without heavy
  filtering. They look impressive in a demo and then go unused.

## What replaces its "real use"
| Question the network hinted at | Where it is answered now |
|---|---|
| Who have I written with? | Who to work with → Your co-authors (list + ego graph) |
| How am I connected to Y? | Connection Sheet, `you → X → Y` paths with evidence (spec 08) |
| Which departments work together? | Leaderboard → Departments view; the "The college" tab of My research gets a **department chord/heat grid** (dept × dept co-authored papers). A matrix is readable where a hairball is not. |
| Who bridges departments? | "Connectors" list on the College tab: people with co-authors in ≥3 departments |

## If the owner wants to keep a picture
There is an alternative that keeps a picture with a real use: a **department chord diagram**
on the College tab. It has 23 arcs, and ribbons sized by co-authored papers between
departments. Clicking a ribbon lists those papers. This is one SVG, needs no physics, and
answers "which departments collaborate?". It uses the planned Authorship data:

- **NEW:** `/api/college/dept-links` returns `[{a:"CSE", b:"ECE", papers:42}]`.

## Acceptance
- [ ] `/network` redirects to `/collaborate?view=map`, and the nav item is gone.
- [ ] `ui/graph.tsx` is reused by the ego map. No page draws the whole college.
- [ ] (Optional) the chord diagram on the College tab, with click-through to papers.
