# Audit: Privacy (`/privacy`)

Built in `frontend2/src/pages/privacy.tsx`. Public: opened from the sign-in page and from Google's consent screen, and inside the app.

## 1. Who and why
Somebody deciding whether to trust the system with their details, or a reviewer at Google. Once.

## 2. What it showed before
Screenshot: `img/privacy-before-1440.png`.

| Part | Problem |
|---|---|
| Who sees it | Named the order a claim travels in ("the research office checks claims, the Principal approves them, the Director authorises them and Finance pays them"). A page every faculty member can read published the chain the college keeps from them. |
| Header | Inside the app it drew the college mark and name a second time under the app's own sidebar. |
| Layout | A rule above every section (space separates sections), and no way to jump. |
| Corrections | "your profile page": the page is now "your account page", and it was not a link. |

## 3. What changed
- "Only the people who act on a claim see it, and only what their part needs. Heads of department see their department's publications but no amounts. Colleagues see your published papers, never what they were paid."
- The mark shows only to a visitor with no account.
- Four short sections with space between them, and a row of jump links at the top.
- "account page" links to `/me` when signed in.

## 4. Evidence after
Screenshots `img/privacy-after-1440.png`, `img/privacy-after-390.png`; test `shared-views.test.tsx` ("does not spell out the order offices see a claim in").
