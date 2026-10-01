# Audit: The welcome dialog

Built in `frontend2/src/app/welcome.tsx`. Opens once on a first sign-in, then never (`welcome_seen_at`).

## 1. Who and why
Somebody signing in for the first time: what is this, where do I start.

## 2. What it showed before
It works: three jobs of the person's role, each a link, "All help guides" and "Got it". The line under the title read "Faculty. You file your papers here...", the role as a lone word before the sentence.

## 3. What changed
- The sentence stands on its own: "You file your papers here and get paid for them. You can always see which stage each claim is at."
- Tests: `e2e_session` now sets `welcome_seen_at`, so the dialog no longer sits over the first click of every browser test. The dialog has its own spec.

## 4. Evidence after
`img/welcome-after-1440.png`.
