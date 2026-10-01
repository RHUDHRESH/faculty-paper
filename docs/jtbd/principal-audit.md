# Principal: audit against her jobs (docs/jtbd/principal.md)

> Superseded on 2026-09-30 by the per-view cards in `docs/audit/principal/` (home, hub, brief, departments, papers, accreditation, figures, build, publications, money). Items 7 to 12 below are closed there: the claim-only downloads are labelled for what they hold, department spellings are merged, the builder's headline and running year are fixed, and the NAAC list states its row basis.

Method: I signed in as a throwaway Principal (`e2e_session --role PRINCIPAL`) on a scratch DB seeded with `manage.py seed_demo` (six departments, 68 teachers, 2022-2026 publications, 260 ledger payments, budgets for FY 2024-25 to 2026-27). I screenshot every page she reaches at 1280 and 390 px and read the endpoints behind them. "Before" shots are not committed; the "after" shots are in `shots/principal/`.

Status: **FIXED** on branch `audit/principal`, **OPEN** means a gap is still there.

## Home (/)
1. FIXED. "The college" showed one number, *Paid to date* (all-time ledger total). No council question is answered by that. It now shows the year brief's headline sentence, with *Open the year brief*, *Council PDF*, *NAAC and NIRF tables* and *Budget*. (J1)
2. The approval queue on Home is good: oldest first, amounts and waiting days are shown. (J7)

## Reports (/reports)
3. FIXED (via the new /reports/brief). There was no per-teacher figure anywhere. Every department chart ranked by raw count, so the biggest department always "led". (J2, NAAC 3.3.1, NIRF PU)
4. FIXED (via the brief). There was no year-against-last for the college as a whole. *2025 against 2024* compares claims only (4 against 2), not the publication record (91 against 86). (J1)
5. FIXED (via the brief). Money and papers were never shown on the same axis of time. *Paid by month* is a 50-month line, and nobody can read a year off it. The brief shows papers by calendar year and paid by financial year, side by side, with values labelled. (J1, J3)
6. FIXED (via the brief). There was no budget in reports; the budget lives on /budget only. (J3)
7. OPEN. The downloads (Excel/CSV) on /reports give one row per *claim*, not the report on screen. The artefact she hands on is the brief PDF/Excel, so this is now secondary, but the label "Also download as" still promises the report.
8. OPEN. Department names can appear twice, e.g. "Computer Science and Engineering" and "CSE". The record uses both spellings in real data. No alias map is applied in `college_totals`, so a department splits across two bars. This needs an office-maintained alias table (data fix, not UI).
9. OPEN. The *Who is publishing* and *What is waiting* sections sit below the charts. They answer office questions, not hers. They are fine but long; she does not need them to report.

## Report builder (/reports/build)
10. OPEN (bug). The headline reads "Computer Science and Engineering leads with **123 of 13** publications": a count from the record (123) is put against a scope counted from claims (13). The numerator and denominator need to come from the same source.
11. OPEN. The year line chart joins 2022 to 2026 as a continuous line, and 2026 is a part year, so the line shows a fall that has not happened. The brief marks a running year as "to date" and does not compare it; the builder should do the same.

## Accreditation (/accreditation)
12. PARTLY FIXED. The NAAC 3.4.3 table lists only claims (13 rows) against a record of 380+ papers. The per-teacher metric 3.3.1 is now in the brief and its Excel (sheet "NAAC 3.3.1"). The paper-list table is still claims-only: OPEN.
13. It is good that the page states "No UGC-CARE list is loaded" instead of pretending.

## Budget (/budget)
14. Good: allocated, paid, committed and left, per department.
15. OPEN (minor). Department rows render in a faded text colour that reads as disabled. There is no link from a department row to its papers.

## Leaderboard (/leaderboard)
16. OPEN. The default "This academic year" showed 0 for every person on the seeded data (the seeded publications carry a year but no date). Check whether real record rows without `date` drop out of academic-year windows as well. The *Departments* tab is the nearest thing to accountability, but it has no per-teacher normalisation.

## Journals, Archive, Flags, Search, own papers
17. Journals, Archive and Flags open and render for her (Flags are visible to the Principal, as the server rule requires). They serve J8 and are not reporting artefacts. No gaps against her reporting jobs beyond the above.
18. Own papers: Home states "Another officer, or the super admin, decides each one, never you". The server rule is preserved.

## Correctness notes (brief)
- Papers come from `college_totals.papers()` (record plus recognised claim papers), counted once for the college and once in each author department. Money comes from `college_totals.payments()` (ledger plus orphan paid claims), bucketed by April-March FY. This is tested in `core/test_principal_brief.py`, including the March/April FY boundary and a shared paper.
- The teacher count is today's roll. No headcount history exists, and the page, PDF and Excel all say so.
- The default year is the last complete year. A running year is labelled "to date" and not compared with the year before.
