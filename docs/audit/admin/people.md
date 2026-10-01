# Audit: People (roster) and the person's account

Routes `/people` and `/people/:id`. `frontend2/src/pages/people.tsx`; API `GET /api/admin/users` (`backend/core/api/admin.py`).

## 1. Who and why
The super admin (and the research coordinator) open People to answer "who can sign in, and what can they do?": to create an account, change a role, switch off a leaver, reset a password, view the app as someone. Weekly, more at the start of a term.

## 2. What it showed before
Screenshots: `img/people-before-1440.png`, `img/person-before-1440.png` (a faculty member).

| Element | Problem |
|---|---|
| Roster: title, filters, list | No answer at the top. The admin could not see, without paging through 21 pages, whether any desk (Principal, Director, Finance) had a person, or how many had left. |
| "Inactive" | Not the word for someone who left (their papers stay on record). |
| The list had no status filter | Leavers could not be listed. `?role=DIRECTOR` was ignored by links from elsewhere; it works, and Admin now links to it. |
| Person page: "Publication record: Publications 0, Paid 0, In review 0", then "No history yet", "Nothing to rank yet", "Nothing published yet." | False. Dr Athiraja has 62 papers on the record. These figures came from claims only, and she has filed none. Two pages disagreed on the same person. |
| Person page: back link "People" over a breadcrumb "Faculty / People / Person" | Two ways back; the trail did not name the person. |
| Person page: order | The form (the work) comes first, then the audit, then a long tail of empty charts. |

## 3. What changes
- **People opens with the answer:** four figures, each a link: active accounts (413), who has left (1), desks with nobody on them (2, in red, links to the readiness checklist on Admin), research posts (0, "Nobody on a research post").
- A status filter (Any / Active / Has left); "Has left" replaces "Inactive". The counts are whole-roster figures from the server, not recounted in the page.
- The one primary action is "New account".
- **The person page reads the record where it is kept:** a "Their record" answer (papers on record, citations, claims this year, paid this year) from the same service as the Faculty record, with "Open the full record". The empty charts and the claims-only table are gone for the office; the Principal, Director and Finance still get them.
- The trail names the person ("Faculty / People / a faculty member"); the duplicate back link is removed.
- The account form, "Who changed what", reset password, view as and link a duplicate are unchanged.

## 4. Evidence after
- Screenshots: `img/people-after-1440.png`, `img/people-after-390.png`, `img/person-after-1440.png`.
- Tests: `frontend2/src/pages/people.test.tsx` ("People, the answer first"; "Person, the office reads the record where it is kept"); all 23 pass.
- API: `/api/admin/users?limit=20` about 90 ms with the counts (four small counts added).
