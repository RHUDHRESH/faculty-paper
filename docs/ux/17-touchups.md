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
