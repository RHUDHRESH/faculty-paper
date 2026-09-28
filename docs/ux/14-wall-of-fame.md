# 14 · Wall of fame

Area: **honours** (gold, cream paper). Route: `/leaderboard?view=wall` (tab). `/wall` stays as
an alias for deep links and for TV display (`pages/wall.tsx`).

## Purpose
Celebrate new publications month by month, the way a department corridor noticeboard would. It
should be good enough to put on the **TV in the department lobby** (there is a kiosk mode).

## What the walk found
- The wall is a department selector, then month headings with counts, then plain rows.
- It looks like an audit log, not a celebration.

## IA
```
DESKTOP
┌ HeroBand area=honours (gold ribbon) ─────────────────────────────────────────────────┐
│ Wall of fame                         Dept ▾ Whole college   [▶ Display on a screen]   │
│ "September 2026 — 7 new papers, 2 in Q1 journals."   (Fraunces month title)           │
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ Month ribbon: [Sep 7] [Jun 4] [May 1] [Apr 2] … (horizontal, scrollable)  ─────────────┐
├ Masonry of SharePlate tiles (cream, gold top ribbon for Q1, navy for others) ──────────┤
│ ┌───────────────────────────┐ ┌──────────────────┐ ┌──────────────────┐               │
│ │ Q1 ◆ gold ribbon           │ │ ◉◉ 2 authors     │ │ ◉ Dr …           │               │
│ │ ◉◉◉ avatars (Saveetha only)│ │ Paper title in   │ │ Paper title      │               │
│ │ Paper title in Fraunces    │ │ Inter semibold   │ │                  │               │
│ │ 20px, 3 lines max          │ │ Journal · Q2     │ │ Conference 2026  │               │
│ │ Journal name · Q1          │ │ [👏 12]          │ │ [👏 3]           │               │
│ │ CSE · ECE                  │ └──────────────────┘ └──────────────────┘               │
│ │ [👏 Congratulate 24]       │                                                         │
│ └───────────────────────────┘   Q1 tiles span 2 columns                               │
└────────────────────────────────────────────────────────────────────────────────────────┘
PHONE: month ribbon scrolls; tiles single column; Q1 tiles full width with ribbon.
KIOSK (/wall?display=1): full-screen, no chrome, auto-advances one tile every 8s in a
large 16:9 layout, month title + college wordmark, cycles back after the month; exits on Esc.
```

## Interactions
- **Congratulate** (👏) uses the existing reactions on the feed share post
  (`/api/feed/share/{claim_id}` and `/reactions/clap`). The count is shown, and each person can
  react once.
- A **tile click** opens the paper. Clicking an author avatar opens their profile.
- **Pin** (`/api/wall/pin`) is office/HOD only. It features a tile at the top of the month with
  a "Featured" chip.
- **Month ribbon** selection is kept in `?month=`.
- **Display mode:** in `?display=1` a tile shows **no names of non-consenting people**. It
  respects each person's social privacy setting (existing `/people/me/social-settings`).

## Copy
- Month title: "{Month Year} — {n} new papers, {q} in Q1 journals."
- Empty month: "No new papers yet this month — the first one filed will lead the wall."
- Congratulate a11y label: "Congratulate the authors of {title}".

## Data
- Existing endpoints: `/api/wall?department=&month=`, `/api/wall/pin`, and feed reactions.
- **NEW fields** on wall items: `quartile`, `authors:[{id,name,avatar}]` (Saveetha only),
  `departments`, `reaction_count`, `me_reacted`, `featured`.

## Acceptance
- [ ] Masonry tiles, with Q1 tiles double-width and gold-ribboned.
- [ ] Congratulate works once per person and shows the count.
- [ ] Kiosk mode runs unattended, hides chrome and respects privacy settings.
- [ ] Reachable as the Leaderboard tab and at `/wall`.
