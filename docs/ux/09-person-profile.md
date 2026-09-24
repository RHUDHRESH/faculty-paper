# 09 · Person profile `/u/:id`: polish

Area: **people** (terracotta), with an honours strip for badges. Route: `/u/:id`
(`pages/person.tsx`, `person-social.tsx`).

## Purpose
A profile in the Google Scholar/ORCID style, for a researcher at Saveetha. It should be credible
to an outsider and useful to a colleague deciding whether to write with this person.

## What the walk found (own profile)
- The page opens with "Your profile is 14% complete" and six edit prompts. These are
  housekeeping, and they lead the page.
- Stats (followers, views, reach) come before any research.
- There is no citations chart, no co-authors column and no connection context.

## IA
```
DESKTOP
┌ Profile header (HeroBand area=people, no watermark; cover = subtle pattern of the portico)┐
│ ◉ 96  Dr. R. Subhashini  (display-honour, Fraunces)            [Message] [Follow]        │
│       Assistant Professor (SG) · S&H-English · Saveetha Engineering College              │
│       "Writes about English-language assessment with machine learning." (headline)      │
│       ORCID ⓘ · Scopus ↗ · OpenAlex ↗         Badges: 🏅 #1 dept · Q1 author · …         │
├─────────────────────────────────────────────────────────────┬───────────────────────────┤
│ StatTiles: Papers 20 · Citations 46 · h-index 3 · i10 1       │ Citations per year (bars) │
│ Tabs: [Papers] [Research] [Activity]                          │ ▂▃▅▇                       │
│ PAPERS: Pinned (up to 3, cream plates) then list by year,     ├───────────────────────────┤
│   sort: newest / most cited                                   │ How you're connected      │
│ RESEARCH: topics chips w/ bars, venues, Timeline (from spec 05)│ (viewer ≠ owner):        │
│ ACTIVITY: posts in Discussions, endorsements                  │ ConnectionPath + why      │
│                                                               ├───────────────────────────┤
│                                                               │ Co-authors (top 8)        │
│                                                               │ avatars + papers count,   │
│                                                               │ internal/external chips   │
│                                                               ├───────────────────────────┤
│                                                               │ Skills (endorse)          │
└─────────────────────────────────────────────────────────────┴───────────────────────────┘
OWN profile only: completeness becomes a slim banner under the header —
"Profile 14% · add a photo and ORCID to show up in search [Finish profile →]" (opens a Sheet
with the six steps). Private stats (views, reach) move to a collapsed "Only you see this" card
at the bottom of the right rail.

PHONE: header stacks (avatar 72 left, name right); stat tiles 2×2; right-rail cards move
below the tabs in this order: Connected → Co-authors → Citations → Skills.
```

## Interactions
- **Follow** and **Message** are existing actions. Message is hidden on your own profile, and
  so is Follow.
- The **"How you're connected"** card appears only when the viewer is not the owner. Its
  "Why" expander reuses spec 08.
- **Pinning** a paper works from the ⋯ menu on your own paper rows (max 3). This is the
  existing `PUT /people/me/pins`.
- **Headline** is editable inline on your own profile (✎). It shares its field with the My
  research headline.
- A **citations bar** click opens a popover listing the papers cited that year.
- **Scopus / OpenAlex / ORCID** links open in a new tab and carry `rel=noreferrer`.

## Copy
- Completeness banner: "Profile {p}% · add a photo and ORCID to show up in search. [Finish
  profile]"
- No papers: "No papers on {first name}'s record yet."
- Not connected: "You and {first name} aren't connected within 3 steps yet."
- Private stats card: **"Only you see this"**, then "{v} profile views and {f} new followers in
  the last 30 days."

## Data
- Existing endpoints:
  - `/api/people/{id}`, `/api/people/{id}/graph`
  - `/api/users/{id}/badges`
  - `/api/people/me/stats`, `/api/people/me/pins`, `/api/people/me/skills`
  - `/api/skills/{id}/endorse`
  - `/api/follows/people/{id}`
- Planned endpoints: `/api/people/{id}/publications`, `/api/people/{id}/coauthors`,
  `/api/people/{id}/connection?to=me`.
- **NEW fields** on `/api/people/{id}`: `metrics {papers, citations, h_index, i10}`,
  `citations_by_year`, `headline`, `orcid`, `scopus_url`, `openalex_id`.

## Acceptance
- [ ] Research leads the page: stats and papers come before any housekeeping.
- [ ] Completeness is a slim banner, and private stats are collapsed at the bottom.
- [ ] The right rail has citations per year, connection (for others), co-authors and skills.
- [ ] Figures match Home and My research for the same person.
- [ ] 390px order as specified.
