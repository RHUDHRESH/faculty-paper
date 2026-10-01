# Principal: The year in brief (/reports/brief)

## 1. Who and why
The Principal, before each governing council or trustee meeting and again for the IQAC when it prepares the AQAR. Question Q1 and Q3 of docs/jtbd/principal.md: "Are we better than last year, and where?" and "What goes in the council pack, and is it ready?". Perhaps six times a year, always with the PDF as the goal.

## 2. What it showed today
Screenshot: `shots/brief-before.png`.

- The sentence and four figures were good, but no figure could be opened. "1,586 papers" and "57% in Q1 or Q2" were dead text, so "can I quote this?" had no answer.
- "In Q1 or Q2 journals 57%" hid its base: a quartile is recorded for only 449 of 1,586 papers (28%). A council member would read it as 57% of the college.
- "No budget set for this year" appeared as a footnote inside a figure. Nothing said what else was unready (208 papers with no department, UGC-CARE list not loaded).
- The ranking chart and the table said the same thing twice, and 25 rows were laid out one after another with no answer to "which departments need a push?".
- The table had spelling duplicates as separate departments: "Civil" and "CIVIL", "S&H - Maths" and "S&H-MATHS", and "Not Found". Each showed 0 teachers and a few papers, and the real department looked smaller.
- Blank-looking values: "–" for missing change, "Not set" repeated 25 times in a Budget column.
- On a phone the table scrolled sideways.
- The PDF: page 2 was almost empty (only the notes), "–" in cells, no quartile base, no push list.
- Buttons: "Council PDF" (clear), "Excel (NAAC 3.3.1)" (clear), "Print" (clear). Three equal buttons at the top right; no primary one.

## 3. What changes
- Page anatomy of docs/ux/22: title and one line ("Are we better than last year, and where?"), one primary action (Download council PDF), the sentence, then four figures that each link to the list behind them (`/reports/papers?year=…`).
- Every base is stated: "of the 449 papers with a quartile recorded", "paid in FY 2025-26; no budget is set for it".
- New section "Before you hand this over": five checks (full year, budget set, every paper has a department, every paper has a quartile, UGC-CARE list loaded), each in words with a link to fix it, computed on the server.
- New sections "Departments that need a push" (with the reason in words) and "Departments to praise". Rules are on the page and in the code (`needs_a_push`, `rising`): three teachers or more, and no papers, a fall of a fifth, or under half the college rate.
- Department spellings are merged onto the roll's own spelling and "Not Found" is not a department (`college_totals.canonical_departments`), so one department is one row everywhere, including the papers list and the payments.
- The ranking chart is folded into the table (a bar with last year as a tick); a Budget column appears only if any department has one; missing values read "None", "Not set" or "New this year".
- On a phone the table is two lines per department that say the same in words.
- PDF: two A4 pages, the answer on page 1 (against last year, five years, where to look, NAAC 3.3.1) and the department table plus sources on page 2. Excel gains a "Needs a push" column.

## 4. Evidence after
- Screenshots: `shots/brief-after-1440.png`, `shots/brief-after-390.png`; PDF pages `shots/brief-pdf-1.png`, `shots/brief-pdf-2.png`.
- Tests: `core/test_principal_brief.py` (figures, FY boundary, list totals equal the brief per department, spellings, push and pack, refusals). API timing on the 8,466-paper record: first call about 2 s while the shared cache fills, then 30 to 250 ms.
