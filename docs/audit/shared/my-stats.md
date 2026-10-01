# Audit: Your stats (`/u/me/stats`)

Built in `frontend2/src/pages/stats.tsx`.

## 1. Who and why
A faculty member checking "does anyone see my work". Private to them. Occasionally.

## 2. What it showed before
Screenshot: `img/stats-before-1440.png`.

| Part | Problem |
|---|---|
| The answer panel | Right idea (six figures). The fifth figure, the share who reacted, printed a lone dash when nobody had been reached. |
| Top of the page | Only the privacy line under the title; nothing said what the numbers are. |
| Empty sections | "Profile views", "How people reacted", "Your top posts" each explain their own emptiness and offer the next action. Kept. |

## 3. What changed
- One line under the title says what the page shows: who looked at your profile and how far your posts reached, over the last 30 days. The privacy line stays under it.
- The dash is "Not yet" with "Shown once a post reaches someone" beneath.

## 4. Evidence after
Screenshot `img/stats-after-1440.png`; social-plus tests pass.
