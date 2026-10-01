# Audit: Sign in

Built in `frontend2/src/pages/sign-in.tsx`; server messages in `backend/core/api/auth.py`.

## 1. Who and why
Five hundred people on a Monday morning: get in.

## 2. What it showed before
- The page is good: two fields and one button first, remembered email, show-password, caps lock note, Google and Clerk only when configured.
- Words for people who are not yet signed in named "the research cell" (the page, the forgot-password help, three server messages, and two error rewrites). Faculty-facing wording is "research office".
- The lockout message used a dash: "Too many failed sign-ins — locked for about 5 more minutes".

## 3. What changed
- "Use the email and password the research office gave you", "Passwords are reset by the research office", "Every account here was made by the research office".
- Server: invalid credentials, lockout, no-account and profile-correction messages say "research office"; the lockout is two sentences. The front end recognises either wording.

## 4. Evidence after
`img/sign-in-after-1440.png`, `img/sign-in-after-390.png` (form first, no sideways scroll). Tests: `sign-in.test.tsx`, `sign-in-errors.test.ts` pass.
