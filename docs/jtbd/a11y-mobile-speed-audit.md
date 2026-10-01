# Accessibility, phones and speed audit (2026-09-28/29)

Method: `frontend2/e2e/audit-collect.spec.ts` (run with `AUDIT=1`) opened every
sidebar route for all 8 roles at 375, 390, 768 and 1280 px, plus 390 and 1280
in dark mode. It recorded page overflow, phone tap targets under 40 px, axe-core
WCAG 2.1 A/AA results (at 390 and 1280, plus colour contrast in dark mode), a
Tab walk for focus rings, images without alt, console errors, failed API calls,
time to settled content, and per-request API timings. Server timings came from
the `core.log request ... in Nms` lines and from a Django test-client timer.
The baseline was a build of `complete-frontend2@196fc7a`. The gate is
`frontend2/e2e/sweep-a11y.spec.ts`: 8 roles × {390, 1280, 375-dark}. After the
merge of `complete-frontend2` on 09-29, all **24/24 pass**.

## Findings

| Route | Roles | Issue | Fix | Status |
|---|---|---|---|---|
| all (≈40 routes) | all | Accent `#c96a4a` text/buttons 3.2–3.7:1 (axe color-contrast, serious) | Token `--color-accent` → `#a84f31` (4.7:1 on wash, 5.4:1 under white); dark `#e08466` | fixed |
| all | all | `fg-subtle` 2.6–2.8:1 light, 3.1–3.7:1 dark (sidebar section labels, hints) | `--color-fg-subtle` → `#6f6c66` / dark `#9a968f` | fixed |
| /, /clearing, /faults, /reports | RC, Principal, Finance | `text-caution` 4.3:1 on caution-wash | `--color-caution` → `#8a5f10` | fixed |
| /research, /discover and others | all | Links in muted text told apart by colour only (link-in-text-block, 1.5:1) | In-text accent links underlined (styles.css) | fixed |
| /search, /discover, /messages | all | `aria-label` on a role-less div (the lazy-load placeholder) | `role="status"` on `PageLoading` (shell.tsx) | fixed |
| /reports/brief and every `TableScroller` | RC, Principal, Director | scrollable-region-focusable | Scroller gets `tabIndex=0` (ui/table.tsx) | fixed |
| /budget (statements), chart "Show the numbers" | RC, Finance | scrollable-region-focusable | Focusable named regions | fixed |
| /research (dark) | all | White text on light area colour, 1.95:1 | `dark:text-sunken` on the area tabs and cells | fixed |
| /leaderboard @768 | all | Page 992 px wide (10-column table from `sm`) | Table from `lg`, list below it | fixed |
| /clearing @768 | RC | Page 1180 px wide (a sticky/absolute child escaped the scroller) | `relative` on the TableScroller | fixed |
| / @768 (Finance), /reports, /people @768 | Finance, Principal | 791–810 px: 4- or 3-column figure grids from `sm` | `sm:grid-cols-2 lg:grid-cols-{3,4}` | fixed |
| every page, phones | all | Hundreds of controls 28–36 px tall (Button sm/md/icon, Field, raw `h-7`/`h-8` tabs, chips, selects) | Button/Field `max-sm:h-10`/`size-10`; a phone-only CSS rule sets `min-height`/`min-width: 2.5rem` on buttons, tabs, selects and button-like links; standalone text links get padding | fixed |
| /research, /me (record strip) | all | 12×12 heat-map month cells | Left as they are: a dense glyph grid, and the same months can be reached from the list | remaining |
| /discussions, /leaderboard (axe, mid-animation) | all | Contrast sampled while avatars and cards fade in | Sweeps run with `reducedMotion: "reduce"`; no failure at rest | not a defect |
| — | all | Focus rings | The global `:focus-visible` outline was present on every element the Tab walk reached | none found |
| — | all | Images without alt | 0 found | none found |
| /budget, /policy, /statements | RC, Principal | 404 `/api/payouts/financial-year`, `/months`; 403 `/api/calculate` | Baseline only: the endpoints existed on the merged backend (200, 4–5 ms). The 403 is Policy's preview for a role without money | resolved by merge / by design |

## Speed

| Endpoint | Before (worst observed) | After | Cause / fix |
|---|---|---|---|
| `/api/trends/me` | 3,640 ms (cold 1.1–1.7 s) | 11–35 ms warm; the probe runs at most once every 20 s | A network health probe of the model service on every call. Now remembered for `AI_HEALTH_TTL_SECONDS` (20 s) in `core.services.ai._probe`; test `core/test_ai_health_memo.py` |
| `/api/discover/status` | 1,234 ms | 9–44 ms | same probe |
| `/api/me/research` | 12,109 ms (once, under sweep load) | 17 ms, 18 queries | Not reproducible in isolation; recorded as a load outlier |
| Everything else | ≤ 783 ms in the browser under load | 2–35 ms server-side | No query fix needed |

The slowest time to first content was `/reports/build`: 3.5 s at baseline, most of it waiting on the endpoints above.

Screenshots: `docs/jtbd/shots/a11y-leaderboard-390.png`, `a11y-leaderboard-1280.png`.
