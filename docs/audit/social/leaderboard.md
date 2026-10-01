# Audit: Leaderboard

Route `/leaderboard` (views `?view=people|departments|trend|chart|wall`). `frontend2/src/pages/leaderboard.tsx`; API `GET /api/leaderboard` (`backend/core/services/leaderboard.py`).

## 1. Who and why
Every faculty member (weekly) and every officer (when preparing a council paper). The question: "Where do I stand, and who is publishing what?" Jobs: docs/jtbd/social.md 3 and 6.

## 2. What it showed before
Screenshots: `img/leaderboard-before-1440.png`, `img/leaderboard-before-390.png` (a faculty member, 145 papers on record).

| Element | Problem |
|---|---|
| Top of the page | Three equal buttons (Print / PDF, Download CSV, How it's counted) fought for the one primary place. The reader's own place was a muted sentence: "You: joint #22 of 139 in the college · #6 in ECE · top 16% · ↓21 since the last period". |
| "↓21 since the last period" | Misleading. 2026-27 is four months old, and the server sets it against the whole of 2025-26. A fall in September read as a fall in standing. |
| Tab names | "Ranked", "Trend", "Distribution": words from a chart library, not from the reader. |
| Ten-column table | For "Overall" the value column and "Score" were the same number twice; for "Most papers" the value column and "Papers" were. "First" and "Move" were unexplained. |
| Podium | A figure with no unit ("21" what?). |
| Departments table | A lone "—" for a department with no rank. |
| Footer | "(6,981 papers)" was the whole record, while the board counted 226 in the period. |
| Prose | Two " — " fragments ("Nobody has risen yet this period — it starts…", the sheet subtitle). |

Checked against data: the row for this person shows 145 papers (all time), the same as her authorship rows and My research; ranks in `/api/leaderboard` agree with the pinned "Your place" bar.

## 3. What changes
- Standard header: title, one line of purpose, and one action ("How it's counted"). Print and CSV move below the list with the source line, where rarely used tools live.
- The answer first: three or four figures for the reader. Place in the college ("=22 of 139, level with others"), place in the department (links to that department's board), top percent (links to the spread view), places moved.
- No up or down while the year is still running: a part-year set against a whole year makes everyone fall each September. The answer shows last year's final place as a plain fact ("#1, Last year: your final place in 2025-26") and the table's last column is "Last year" with the same plain place. Arrows return only once the period has finished. Departments and the wall show no movement.
- Someone with nothing counted gets the honest answer ("Nothing counted for you in this academic year yet") and their all-time place as a link. Officers who are not on the board get college figures (people ranked, papers counted, not ranked yet).
- Tabs read People, Departments, Over the years, How it is spread, Wall of fame.
- The table drops the column that repeats the category, names "First author", "Citations", "Papers a year", "Change". The podium says "points" or "papers" under the figure.
- Departments table prints "Not ranked" instead of a dash; footer counts the papers in the period.

## 4. Evidence after
- Screenshots: `img/leaderboard-after-1440.png`, `img/leaderboard-after-390.png` (no horizontal scroll, checked in the shot script).
- Tests: `frontend2/src/pages/leaderboard.test.tsx`, 12 pass (the answer strip and its links are asserted).
- API: `/api/leaderboard` 130 to 210 ms on the full local data; unchanged.
