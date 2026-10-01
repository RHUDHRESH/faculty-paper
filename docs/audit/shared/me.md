# Audit: Your account (`/me`)

Built in `frontend2/src/pages/profile.tsx`. Read as a faculty member and as the research cell.

## 1. Who and why
Somebody who wants to change a phone number or password, ask for a name or staff ID to be corrected, or check where they stand. A few times a year, and once when they first sign in.

## 2. What it showed before
Screenshot: `img/me-before-1440.png` (full page, 3,000 px tall).

| Part | Problem |
|---|---|
| Title | "Your profile", the same words as the public page at `/u/me`, and no link between the two. No face on a page about you. |
| Order | Badges and goals first, before the things the page is for. |
| Details the office keeps | Ten rows, each stacked (label, value, note, button), two screens tall. |
| Words | "the research cell does it directly" and "deliberately not by the research cell, the cell processes the claims" told a faculty member how the office is split. Six dashes in prose. "Declined" (vocabulary: "Not accepted"). "Research Cell · Research cell" printed twice for the cell's own account. |
| Phone | The title and the button squeezed the name to one word per line (found at 390 px while checking the fix). |

## 3. What changed
- Title "Your account" with your face, name, email and role. One primary button: "See your public profile".
- Order: what you can change, what the office keeps, sign-in, your record, your Scopus profile, then goals and badges (three, "Show all N badges").
- The office-kept rows are label, value, action on one line from 640 px up (about half the height); on a phone they stack as before.
- Copy: "Email: to change it, ask the research office"; "Faculty type: regular or research faculty, changes how much a paper pays, so the college administrator sets it". "Not accepted" replaces "Declined". Dashes removed. Designation and role are not printed twice.

## 4. Evidence after
- Screenshots: `img/me-after-1440.png`, `img/me-after-390.png` (no horizontal scroll).
- Tests: `profile.test.tsx` and `profile.scopus.test.tsx` pass unchanged.
