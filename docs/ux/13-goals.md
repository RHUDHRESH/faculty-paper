# 13 · My goals: decision to CUT and fold

Route: `/goals` (`pages/goals.tsx`, `ui/goal-rings.tsx`).

## Decision
**Cut the page.** The owner called it "the dumbest thing". Here is what it does:

- It asks a faculty member to type four numbers (papers, Q1, first-author, citations) for a
  year.
- It then draws rings against them.
- The numbers are private, so nobody else sees them. Nothing reacts to them either: no
  reminders, no comparison and no suggestions.

A self-entered target with no consequence is a form, not a feature. Home currently gives a full
section to "Set a number of papers for 2026", and the walk showed it empty.

## What replaces it: "This year" (inside My research, Future section)
The question a goal page was reaching for is *"am I on track this year?"*. That can be answered
**without typing anything**:

```
┌ This year ─────────────────────────────────────────────────────────┐
│ 3 papers so far in 2026          ▁▂▃ vs ▃▅▆ last year by this date │
│ You're 2 behind last year's pace. 1 paper is under review.         │
│ ○ Personal target: 8  [edit]  ◔ 38%     (optional, one number)     │
│ Nearest deadline: Q3 window closes Fri 3 Oct →                      │
└────────────────────────────────────────────────────────────────────┘
```
- **Automatic comparison:** this year to date against last year to the same date. This is the
  motivating fact, and it needs no input.
- **One optional personal target** (papers only). It keeps the existing ring component and the
  existing `/api/me/goals` storage, using only the `papers` field.
- **The link to action** is the next calendar deadline, plus "1 under review", which links to
  My papers.
- **HOD targets** (`/api/hod/targets`) are a different, real feature for department heads.
  They stay on the HOD home and are unaffected.

## Changes
- Remove the `/goals` nav item. `/goals` redirects to `/research?tab=me#this-year`.
- Remove the "Your goals for 2026" section from Home. If a target is set, Home's hero may show
  a small ring beside the papers figure.
- Keep the `/api/me/goals` endpoint, now used only for `papers`. The Q1, first-author and
  citation targets are dropped from the UI, and their data is kept.

## Copy
- "{n} papers so far in {year}." followed by one of:
  - "You're {k} ahead of last year's pace."
  - "You're {k} behind last year's pace."
  - "Same pace as last year."
- No papers yet this year: "No papers yet in {year} — last year you had {m} by now."
- Target unset: "Set a personal target (only you see it)".

## Acceptance
- [ ] `/goals` redirects, and the nav item is removed.
- [ ] The "This year" card renders with zero input, from publication dates.
- [ ] The optional single target works, and existing saved `papers` goals are shown.
- [ ] HOD target features are untouched.
