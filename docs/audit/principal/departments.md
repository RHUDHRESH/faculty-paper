# Principal: Departments (/department, now /reports/departments and /reports/departments/:name)

## 1. Who and why
The Principal, before the HODs' meeting and after the year brief raises a name. Question Q2 of docs/jtbd/principal.md: "Which departments need a push?" and then "Who in that department is publishing?". A head of department has `/department` (their own view); the Principal has all of them.

## 2. What it showed today
Screenshot: `shots/department-before.png` (a taken screenshot of the Principal opening `/department`).

- `/department` answered a Principal with the red panel "Not open to this account". A dead end, reached from the old Reports hub and by typing the word.
- Department figures existed only as a bar chart and a 25-row table on the year brief. There was no page for one department: nothing to open when the brief said "CSE - CS is down 47.6%".
- Nobody could see the people behind a department's figure (who is publishing, who has not published in five years).

## 3. What changes
- `/department` opens `/reports/departments` for the Principal (an HOD still gets their own page).
- `/reports/departments`: the answer in one sentence ("5 departments need a push in 2025: TRAINING, CIVIL, S&H-ENGLISH and others"), the push and the rising lists with their reasons, and every department in the table. Same numbers and same rules as the brief.
- `/reports/departments/:name`: one department. The sentence (papers, change, per teacher against the college, teachers with no paper in five years), four figures that each open their list (papers, per teacher, Q1 or Q2, paid), five years side by side, every teacher with a face and their papers this year, last year and in five years ("No paper in five years" said in words), and the journals the year's papers appeared in.
- "Download the papers of 2025" gives an Excel with the college name and the filter on top.
- Breadcrumbs "Reports / Departments / BME" come from the shell.

## 4. Evidence after
- `shots/departments-after-1440.png`, `shots/department-bme-after-1440.png`, mobile `shots/department-bme-after-390.png`.
- Tests: `test_department_page` and `test_lists_refuse_faculty` in `core/test_principal_brief.py`. API: `/api/reports/department` about 250 ms once the shared paper list is cached.
