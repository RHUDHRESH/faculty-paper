# 07 · Leaderboard: report-grade, many categories, many views

Area: **honours** (gold). Route: `/leaderboard` (`pages/leaderboard.tsx`), with tabs
`?view=people|departments|wall` (Wall of fame joins as a tab, see `14-wall-of-fame.md`). Staff
`/reports` keeps its builder, but reuses the chart and table components specified here.

## Purpose
A leaderboard that a principal could print for a council meeting and that a faculty member
checks every week. It has to be accurate, fair, explainable and multi-dimensional.

## What the walk found
- Rows have no podium and no charts. The table header overlaps rows when scrolled.
- The banner says "You have no papers counted in this period yet", and then the table shows
  the same user at "=54" with 0. The copy and the data contradict each other.
- There is one "rank by" select, and categories are hidden in a dropdown.
- "How this is counted" is good, but it is a wall of bullets at the bottom.

## Categories (each is a board)
| Category | Metric | Icon |
|---|---|---|
| Overall score | Q1=4, Q2=3, Q3=2, Q4=1, other indexed=1 (existing formula) | `Trophy` |
| Most papers | count | `FileText` |
| Q1 papers | count | `Gem` |
| First-author papers | count | `PenLine` |
| Most cited (period) | citations received in period | `Quote` |
| Rising | score this period − score same period last year | `TrendingUp` |
| Most collaborative | distinct co-authors (internal + external) | `UsersRound` |
| Newcomer | first paper within the last 24 months, ranked by score | `Sprout` |

Period options: this academic year (default), last academic year, calendar year, last 12
months, all time. Scope options: college, or one department.

## Views
1. **Podium + table (default).** The top 3 sit on a podium (cream plates, gold/silver/bronze
   ribbons, avatars 72px, figure), then a dense table.
2. **Departments.** Ranked bars per department (score, and papers per faculty member for
   fairness), plus a small-multiples trend of 5 years per department.
3. **Chart.** A distribution (histogram of scores) with "you are here" marked, and a
   percentile line: "You're in the top 12% of the college".
4. **Wall of fame** (tab): see spec 14.

## IA
```
DESKTOP
┌ HeroBand area=honours (gold ribbon) ──────────────────────────────────────────────────┐
│ Leaderboard                                      [Export ▾ PDF · CSV]  [How it's counted]│
│ You: #12 of 410 in the college · #1 in S&H-English · top 3% · ↑4 since last month      │
└────────────────────────────────────────────────────────────────────────────────────────┘
┌ Category rail: big chips with icon 20 ────────────────────────────────────────────────┐
│ [Trophy Overall] [FileText Papers] [Gem Q1] [PenLine First author] [Quote Cited]       │
│ [TrendingUp Rising] [UsersRound Collaborative] [Sprout Newcomers]                      │
│ Period ▾  This academic year · Scope ▾ College · View: [Podium][Departments][Chart][Wall]│
├ PODIUM ──────────────────────────────────────────────────────────────────────────────┤
│            ┌──────┐                                                                     │
│   ┌──────┐ │ ◉ 1  │ ┌──────┐                                                            │
│   │ ◉ 2  │ │ gold │ │ ◉ 3  │   each: avatar, name, dept, figure, sparkline             │
├ TABLE (sticky header that sits correctly; zebra none; hairlines) ─────────────────────┤
│ #  Name / dept           Score  Papers  Q1  First  Cited  Trend(spark)  Move           │
│ 4  Dr …                    38     11     3    2     40    ▁▃▅▇         ↑2              │
│ …                                                                                      │
│ ─ your row pinned at bottom when off-screen (sticky, navy wash) ─                      │
└────────────────────────────────────────────────────────────────────────────────────────┘
│ How it's counted → right-side Sheet with the formula, sources, exclusions (existing text)│

PHONE: hero 2 lines; category chips scroll; podium compressed (1 large + 2 small);
table → ranked list rows (rank, avatar, name, figure, move); your row sticky bottom.
```

## Interactions
- Category, period, scope and view all live in the URL, so a board can be shared as a link.
- A row click opens the person's profile. Hovering the figure shows its breakdown ("11 papers:
  3×Q1, 4×Q2, 4×other").
- **Ties** are shown as `=4`, and the tie rule is explained in the Sheet.
- **Your row** is always visible, pinned to the bottom when it is off-screen.
- **Zero-state honesty:** when you have 0 in the period, the hero says "No papers counted for
  you in {period} yet — your all-time rank is #n". Your row still appears in the table with a
  muted "—" rank, **not "=54"**, because ranking zeros produces misleading ties.
- **Export PDF** is a print stylesheet (A4 landscape) with the college wordmark, period,
  category and generated date. Export CSV is the existing export.

## Copy
- Hero: "You: #{r} of {n} in the college · #{dr} in {dept} · top {p}% · {move} since last
  month"
- Rising empty: "Nobody has risen yet this period — it starts counting once two periods have
  papers."
- Error: "Could not load the leaderboard. Nothing has changed. [Try again]"
- Footer line: "Counted from filed papers and the college's publication record. No money is
  shown."

## Data
- Existing endpoints: `/api/leaderboard?period=&rank_by=&department=`,
  `/api/reports/*` (staff), and `/api/wall`.
- **NEW params:** `/api/leaderboard?category=score|papers|q1|first|cited|rising|collab|newcomer&period=&scope=&view=people|departments`.
  The response adds:
  ```json
  { "me": {"rank":12,"of":410,"dept_rank":1,"dept_of":6,"percentile":3,"move":4,"value":38},
    "podium":[…3 rows…], "rows":[{"rank":"=4","person":{…},"value":38,"breakdown":{"q1":3,"q2":4,"other":4},"spark":[…5 periods…],"move":2}],
    "distribution":[{"bucket":"0","count":210},…],
    "departments":[{"dept","score","papers","faculty","per_faculty","trend":[…5 years…]}] }
  ```
- Papers must come from the **same Publication source** as Home and My papers (see spec 01).

## Acceptance
- [ ] 8 categories, 5 periods, 2 scopes and 4 views, all URL-addressable.
- [ ] A podium for the top 3, and the table has a sticky header that does not overlap rows.
- [ ] Zero-value people are not given tied ranks. The hero copy matches the table.
- [ ] Your row is pinned when off-screen.
- [ ] The Departments view shows per-faculty normalisation.
- [ ] Print/PDF produces a clean A4 report with the title, period and date.
- [ ] 390px list view with no horizontal scroll.
