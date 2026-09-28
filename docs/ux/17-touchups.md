# 17 — Touch-ups, round 2 (owner feedback 2026-09-28)

Owner verdict: Research scout, Discover, Calendar, Leaderboard, Discussions,
Messages, Who to work with and Your circle all need a touch-up; "I can't see
people's faces in half the stuff".

## The standard (every page)
- Look and feel of claude.ai: warm canvas, calm serif page title (HeroBand /
  PageHeader — titles are 32px now; a tailwind-merge bug used to shrink them),
  muted sentence, one clay accent used sparingly, generous whitespace, hairline
  dividers over boxes-in-boxes. No SaaS card grids of identical boxes.
- **Faces everywhere a person appears.** Use `<Avatar person={...}>` from
  `@/ui/person` with `photo_url`. The server now adds `photo_url` + `initials`
  to every dict with `user_id` + `name` (backend/core/faces.py); for dicts keyed
  by `id`, map to `{name, initials, photo_url}` yourself. Never draw "?".
- Illustrations: `<Picture name="..."/>` from `@/ui/picture` (catalogue:
  frontend2/public/illustrations/generated/manifest.json — spot-*, empty-*,
  topic-*, celebrate-*, icon-*). One meaningful picture per section at most,
  shown big enough to read, never as clip-art confetti.
- Real data only. An empty state names the next action and uses an empty-*
  picture.
- Motion only in answer to an action (open, expand, confirm).
- Copy: plain sentence case, active verbs, no "—" fragments, no ALL CAPS labels.

## Lessons from round 2 reviews (apply before reporting)
- **Phones (375 and 390 px):** no horizontal page scroll, ever. Every page's
  root uses the `page` class (side padding) — never a bare `mx-auto max-w-*`.
  Every `grid` gets `grid-cols-[minmax(0,1fr)]` below its breakpoint, or a long
  title stretches the column past the screen. Chips and button rows must wrap.
  Measure: `document.documentElement.scrollWidth === clientWidth`.
- **Photos:** never hard-code `photo_url: null`; pass what the API sends.
  `<Avatar>` falls back to initials on a failed image by itself.
- **Counts agree across pages** (Home, My papers, File a paper, Leaderboard,
  map vs list). If two places count the same thing, they use the same rule.
- **No ALL-CAPS labels, no " — " fragments, no raw markup** (e.g. mention
  codes) visible to people.
- **Your screenshot must show the loaded page.** A "Loading…" shot is not a
  review; wait for network idle and look again.
