# Real-data design QA

Run 2026-09-29 against a copy of `data/local-full.sqlite3` (17,375 publications,
3,043 ledger rows, 412 people, real photos from `repo/backend/media`). Sessions:
`e2e_session` for FACULTY, HOD (CSE), RESEARCH_CELL, RESEARCH_COORDINATOR,
PRINCIPAL, DIRECTOR, FINANCE, SUPER_ADMIN, plus a real faculty member
(joyalisac@saveetha.ac.in) on the copy only. Every sidebar route per role and
five extras (`/research`, `/wall`, `/u/:id`, `/me`, `/notifications`, and one
paper detail) were shot at 1280 and 390: 514 screenshots, with per-page
horizontal overflow, broken images, NaN text, failed and slow API calls measured
in the browser.

No broken images anywhere: photos load from the shared media root. No
`NaN`/`undefined` text. Every long list (people 421, publications, ledger 3,043,
accreditation 6,330, author matches 2,840, audit, duplicates) is server-paged
with "1–50 of N".

## Findings

| Route | Role | Problem with real data | Fix |
|---|---|---|---|
| `/ledger` | Finance, Director, Super admin @390 | The 30-month chart's bars got the phone tap-target `min-width: 40px`, so the page was **890 px wider than the screen** | Fixed: tap rule skips controls marked `min-w-0` (`styles.css`) |
| `/papers` | real faculty @390 | Same rule on the papers-per-year bars, 80 px overflow | Fixed by the same rule |
| `/u/:id` | all @390 | Citations-per-year bars overflowed 34 px | Fixed (`min-w-0 tap-exempt`) |
| `/ledger` | Finance, Director, Super admin | Page 1 was all ₹0 "Not recorded" rows: 242 ERP quota rows are stamped with the import month (2026-09) and sorted first | Fixed: ₹0 rows sort last (`finance.py`) |
| `/ledger` | Finance, Director, Super admin | By-department split one department across spellings: `S&H-MATHS` / `S&H - Maths`, `AI&ML` / `AI & ML`, `CIVIL` / `Civil`, `AGRI` / `Agri`, `S&H-CHY` / `S&H - Chemistry`, `EIE` / `E&I`, plus a "Not Found" department | Fixed: merged under the most-used spelling, filter matches every spelling, "Not Found" is shown as No department. Test added |
| `/ledger` vs Home | Finance, Research cell | Total ₹2,65,57,834.**74** on the ledger vs **.73** on Home (float sum) | Fixed: rounded to paise |
| `/faults` | Office, Principal | "Waiting to clear over 14 days: **0**" while Home lists tickets waiting 77–90 days: it measured `updated_at`, which the import reset | Fixed: measured from `submitted_at` / `cleared_at` (now 13 of 14) |
| `/`, `/department` | HOD | "Who needs a push" said **"Nothing on record, ever"** for 53 of 55 CSE staff, several of whom have 4–8 papers on the leaderboard. The brief counts filed claims (95 college-wide), not the 6,981-paper record | Wording fixed: "Has never filed a paper here" / "Nothing filed since". **Not fixed:** the brief should probably count the publication record. That is a product decision |
| `/people/matches` | Office | "M. Selvi" (28 papers) and "K. Selvi" showed "No likely match" beside Dr. M. Selvi on the roster: "Selvi" is on the honorific list, so the name had no words | Fixed: an honorific that is the only name word is kept. Test added |
| `/people/matches` | Office | "G. Bhuvaneswari" (16 papers) is not matched to roster "Dr. G. Bhuaneswari" (roster typo). Candidate lookup is by exact token, so the one-edit fuzz never runs | Not fixed. Correct the roster name, or add fuzzy candidate lookup |
| `/journals` | staff | A 120-character conference name pushed the Papers and Paid columns off screen, so the list looked like names only | Fixed: journal cell takes the spare width and truncates |
| `/publications` | HOD | "Indexed in" (`SCI, Scopus, AU Annexure, UGC`) ran over the Progress column (`truncate` on an inline span) | Fixed: wraps to 2 lines |
| `/publications` | Office, Principal | 61 paid ERP claims show **₹0** beside "Paid" (the Faults page calls them "Paid, but for nothing") | Fixed: shows "Not recorded". The data gap remains on Faults |
| `/` (What moved), all claim lists | Office | An imported paper titled "-" shown as a bare dash | Fixed: `paperTitle()` reads "-", "NA", "nil" as Untitled (16 pages) |
| `/reports` (Highest paid) | staff | Top-by-amount list padded with ₹0 people | Fixed: ₹0 rows dropped |
| `/duplicates` | Office | Vouchers shown as `1802.0` (float from the ERP import) | Fixed in display |
| `/papers/:id` | Office | Button said **"Message Mr."** (first word of "Mr. S. Joyal Isac"); chat "Seen by Dr." likewise | Fixed: uses `firstName()` |
| `/u/:id`, `/research` | all | "1 citations" | Fixed |
| Home | Director | "The institution: Publications **95**" beside a brief saying 1,586 papers in 2025 alone. 95 is filed claims | Fixed: label now "Papers filed for incentive" |
| `/` vs `/department` | HOD | Q1 rate 8.3% (college 15.8%) on Home, 10% (18.2%) on My department. Different scopes (all years vs chosen year); both are labelled but read as a contradiction | Not fixed. Consider one scope |
| `/publications` → `/papers/:id` | HOD | Department rows link to a paper page that answers 403 (by design: no money for heads). The message explains, but the row is a dead end | Not fixed. Needs `owner_id` on the HOD row to link only the head's own papers |
| `/papers` | real faculty | "Demarcation of non-carcinogenic risk zones…" listed twice in 2022 (two record copies, 0 and 6 citations), so the count is 28 not 27 | Not fixed: record de-duplication |
| `/ledger` | Finance | After the ₹0 fix, page 1 opens on the 80 rows with no recorded month | Not fixed. "Recorded month" lives in `raw_json`, not a column |
| `/reports*`, `/accreditation`, `/leaderboard`, `/research` | staff | Slow on 17k rows: `/api/reports/build` 3–4.7 s, `/reports/brief` 2–4 s, `/reports/pack/rows` 2–3.7 s, `/me/research` up to 4.7 s, `/leaderboard` ~2 s, `/people/:id/connection` 2.8 s. Skeletons show for that long | Not fixed: needs caching or precompute |
| `/policy` | office | `POST /api/calculate` 403 | Test artifact: CSRF trusted origins do not include QA port 5113. Not a product bug |

## Screenshot notes

Full-page captures draw sticky bars (leaderboard "Your place", table scroll
shadows) at the 900 px line and make table rows look faded. A normal-viewport
check showed rows at full contrast (`rgb(43,42,39)`), so these are artifacts,
not defects.
