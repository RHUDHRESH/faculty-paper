# Audit: First-run setup (`/setup`)

Built in `frontend2/src/pages/setup.tsx`. Shown only while the system has no accounts; otherwise it says "Already set up".

## 1. Who and why
The person installing the system for a college, once.

## 2. What it showed before
- It said "3 steps left", but the third step drew nothing: after the administrator details the card held only the button "Create the system", with no summary of what was about to be created.
- The fields sat outside the `<form>`, so Enter in a field did nothing.
- The title stayed "Set up your college" on every step; dashes in the hints; a shadowed card of its own.

## 3. What changed
- "Step 1 of 3" above a title that says what the step is (the college, the first administrator, check and create). Step 3 lists the college, administrator, sign-in email and the password length, then "Create the system".
- One form around the fields and the buttons, so Enter continues.
- Dashes removed, panel container, error is a `role="alert"`.

## 4. Evidence after
`img/setup-after-390.png` (the "Already set up" state, which is all a seeded copy can show). Test: `shared-views.test.tsx` walks the three steps and checks the review lists what was typed.
