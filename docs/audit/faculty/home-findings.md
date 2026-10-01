# Faculty Home: findings for later

`home-faculty.tsx` is being finished by another builder, so nothing here was edited. Seen on a faculty member's real record (145 papers), at 1440 and 390 (`/` signed in as her). Checked against the record views.

## Agrees with the record views
- 145 papers, 540 citations, h-index 12: same as My papers, My research, the record page and the profile (see `backend/core/test_paper_count.py`).
- "24 papers on your record are not filed yet": same rule and number as My papers "Not claimed" and the new "ready to claim" figure.
- "Paid to you so far ₹3,96,703.75, 89 payments": same as the statement.

## Findings
| # | Where | Finding | Suggestion |
|---|---|---|---|
| 1 | "4 things to celebrate" | Four badge rows, each with the same paper title, fill 330 px above the fold, pushing "Needs you" (the job that earns money) below it. | One line ("4 new badges", link to the shelf), or show the newest one and a count. |
| 2 | Three searches | The sidebar Search, the big search box on Home, and Ctrl K. | Drop the big box; the sidebar item and Ctrl K remain. |
| 3 | "Good afternoon, Kanagamalliga" | Drops "Dr. S." and reads oddly in the display face at 44 px. | Use the profile name the person set. |
| 4 | Two "File" actions | Primary "File a paper" in the hero and a "File" per unfiled row (label differs from My papers, which now says "File it"). | Use "File it" on the row; keep one primary. |
| 5 | Duplicate rows | The same ZIGBEE paper is listed twice under "Needs you" (two Zenodo uploads). My papers now says "Listed twice" and offers to report it. | Show the same chip, or collapse identical titles. |
| 6 | "1 paper on the way, longest 91 days" and again "On the way" below | Said twice. | Keep the lower one. |
| 7 | On the way card | "ERP-RAW-3" is an import code; "Not worked out yet" for the amount reads as a fault; "Approved for payme…" is cut off on the track. | Say "Old ERP, RAW-3"; say "The amount is worked out when it is checked"; shorten the label or wrap. |
| 8 | 91 days waiting | No word about what to expect or what to do. | A line: "Most claims are checked within N days. Write to the research office if yours is older" (faculty never learn the desk, only the office). |
| 9 | Money figures | "Paid to you so far" (all time), "Since 1 June 2026" (academic year) and, on the record page, "Incentives paid in 2026" (calendar year), the statement (April to March). Four year definitions for one person's money. | Name the year in words on each, and prefer the financial year everywhere money is reported (the statement's). |
| 10 | Hero picture | The desk illustration is about 200 px of the first screen. | Smaller, or drop it on phones. |
