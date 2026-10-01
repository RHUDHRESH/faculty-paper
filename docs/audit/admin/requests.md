# Audit: Profile requests

Route `/requests`. `frontend2/src/pages/requests.tsx`; API `GET/POST /api/admin/profile-requests`.

## 1. Who and why
The super admin (and the research coordinator, for department changes) decides changes people cannot make to their own profile: name, staff ID, Scopus link, role. It is a queue. Weekly, sometimes daily around joining time.

## 2. What it showed before
Screenshot: `img/requests-before-1440.png` (the real copy has no pending request, so this is the empty state; the after shot uses two requests added to the scratch copy).

| Element | Problem |
|---|---|
| Sub line | 30 words and a " — " fragment. |
| "Pending" and "0 requests waiting" | Two words for one thing, and the count sat beside the heading instead of being the answer. |
| Empty state: "Every request has been decided. That is good news — come back when the next one lands." | A " — " fragment, and it did not say what would appear. |
| Row: field name first, the person's name and email as grey text | No face, and the field name (not the person) led. |
| Buttons "Decline" and "Approve" | "Approve" is the Principal's word (docs/ux/19). The model's own state for an applied request is "Applied". |
| Dialog "Approve — Role?" and toast "Approved. Role → “x”" | " — " fragments, and the verb did not match the button. |
| "Only a super admin can act on this — it decides pay or identity, not routing." | A fragment, in the faintest grey. |
| Decided requests always open under the queue | History above the fold. |

## 3. What changes
- Title, one sentence ("Name, staff ID and Scopus corrections that people cannot make themselves. Applying one changes the record.") and the answer: requests waiting, waiting over a week (in red), and how many only a super admin can decide. Each zero says what it means.
- A row leads with the person's face and name, then "Wants to change their Scopus author ID", then the change as old value to new value, the reason they gave, and the two buttons "Decline" and "Apply".
- One verb throughout: "Apply" button, "Apply this change to X's staff ID?" dialog, "Applied." toast, "Applied" tag on a decided request.
- The empty state says what would appear ("A request appears here when someone asks to change their name, staff ID or Scopus link on their profile").
- Decided requests are behind "Show requests already decided (N)".

## 4. Evidence after
- Screenshots: `img/requests-after-1440.png`, `img/requests-after-390.png`.
- Tests: `frontend2/src/pages/requests.test.tsx` (updated to the "Apply" verb; 3 pass).
- API: `/api/admin/profile-requests?status=ALL` about 30 ms.
