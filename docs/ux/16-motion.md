# 16 — Motion

The app should move like claude.ai: quiet, quick, never in the way. Motion only; colours and type live elsewhere.

## Rules
- Transform and opacity only (plus a 2px blur on arriving words). Never animate layout properties, except the sidebar width spring, which is user-triggered.
- Enter 140–240ms ease-out `[0.16, 1, 0.3, 1]`; exits faster than entrances.
- `prefers-reduced-motion`: no movement. JS surfaces check `useReducedMotion()`; CSS surfaces are disabled in `ui/motion/motion.css` and by the global rule in `styles.css`.
- Nothing may shift layout: count-ups use `.figure` (tabular numbers); staggered items keep their box from frame one.

## Where things live
| Need | Use |
|---|---|
| Durations, easings, dialog/sheet/list variants | `src/ui/motion.ts` (existing) |
| Page enter (fade + 6px rise, 200ms, keyed by pathname, no exit so back/forward is instant) | `PageTransition` in `ui/motion/page.tsx`, wrapped around `<Outlet />` in the shell |
| Sidebar collapse/expand | `sidebarSpring` on the shell's `motion.aside` |
| Sliding tab pill | `TabIndicator` (inside the selected tab; tab is `relative isolate`) |
| AI text | `StreamingText` (only new words fade in), `useTypewriter` (reveal a whole response as if streamed), `ThinkingIndicator` (dots + shimmer), `useStickToBottom` (auto-scroll unless the reader scrolled up) |
| Hero numbers | `CountUp` / `MaybeCount` (used by `StatTile`) |
| Lists on first load | `Stagger` or the `stagger-in` class; capped at `STAGGER_CAP` = 8 items, never on data tables |
| Card hover | `hover-lift` class (2px) |
| Button press | global `button:active` scale 0.98 |
| Dialogs, sheets, menus, tooltips, toasts, skeleton shimmer | already animated by `ui/dialog`, `ui/sheet`, `ui/pop.ts`, sonner, `.skeleton` |

## Applied
Shell (page transition, sidebar spring), `StatTile` (count-up, hover lift), Scout (thinking indicator, streamed summary, staggered lifted cards), Discover tabs (sliding pill).
