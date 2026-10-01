# 00 · Design language: Claude-like (supersedes "Convocation")

> **Update 2026-10-01.** The palette, type, shape, motion and illustration rules below are
> superseded by [`DESIGN.md`](../../DESIGN.md) (the art direction, with the reasons in
> [`docs/design/art-direction.md`](../design/art-direction.md)). What still stands from this page:
> the Claude-like manners, the page specs in this folder, the navigation grouping (§9), the icon
> map (§3) and the shared component list (§8). Where this page and DESIGN.md disagree, DESIGN.md
> wins.


This is the direction for the frontend2 redesign. Every page spec in `docs/ux/` assumes it.
It covers what the page looks like and which parts builders must reuse. It does not replace
`frontend2/src/ui/CONVENTIONS.md` (elevation ladder, "a shadow must name its claim"). It adds to it.

## Why the redesign

The owner's verdict on the current build, which I walked on 2026-09-24 as a real faculty
account against a copy of `real.sqlite3`:

- **Bland.** Every page has the same layout: a 26px title, a grey sub-line, then hairline rows.
  Home, My research, Leaderboard and Calendar are hard to tell apart as thumbnails. Colour
  appears only on the primary button.
- **No flow.** The sidebar lists 19 destinations with no hierarchy. Nothing tells a faculty member
  what to do next. The sign-in panel promises "File the paper once… Get paid", and then the home
  page opens on three ₹ tiles.
- **Unintuitive.** Some pages repeat each other and some contradict each other:
  - "Colleagues", "Who to work with", "College network", "The college's research" and "Discover"
    overlap.
  - The Impact card says **20 papers**, while Home and My research say **10**.
  - The Leaderboard says "You have no papers counted in this period" and then lists you at =54.
  - College network draws **2 people and 1 line** for a college of about 400.
  - "Who to work with" says "No co-authors yet" for someone with six-author papers.
- **Nothing to be proud of.** The Impact card is the closest thing, but it is a navy rectangle
  with a yellow pill.

## The direction in one paragraph (revised 2026-09-28: "Claude-like")

**The owner's direction overrides "Convocation": the app should look and feel like Claude
(claude.ai).** Patterns only, never Anthropic assets, logos or fonts. A warm off-white canvas,
warm-grey surfaces with hairline borders, one warm clay accent, an elegant serif for page titles
and hero numbers, Inter for everything else, soft radii, almost no shadows, generous whitespace,
a calm slim sidebar, and a centred content column. Motion (`src/ui/motion/*`) is unchanged.

- **No heavy colour bands.** Heroes are calm: a serif title, a muted sub-line, the answer as a
  serif figure. No navy fields, no gradients, no watermarks competing with content.
- **Area colours survive only as muted warm hints** (an icon, a chip), never as page grounds.
- **Brand navy is not a UI colour.** It may appear only inside the Saveetha emblem.

## 1. Palette

Tokens live in `frontend2/src/styles.css` (`@theme` for light, `:root[data-theme="dark"]`
for dark). Token names are unchanged so every component reflows.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-bg` | `#faf9f5` | `#262624` | Canvas |
| `--color-surface` | `#fdfcfa` | `#2c2c2a` | Cards, fields, menus |
| `--color-sunken` | `#f3f1ea` | `#1f1e1d` | Sidebar, table heads, wells |
| `--color-hover` / `-active` | `#efece4` / `#e6e2d8` | `#33322f` / `#3b3a37` | Pointer states, active nav pill |
| `--color-line` / `-edge` | `#ece8df` / `#e2ddd2` | `#353431` / `#3e3d39` | Hairlines |
| `--color-fg` / `-muted` / `-subtle` | `#2b2a27` / `#6b6862` / `#9a968e` | `#ece9e2` / `#a8a49b` / `#7a766e` | Ink |
| `--color-accent` (+`-hover`) | `#c96a4a` (`#b25a3c`) | `#d97757` (`#e48a6b`) | The one accent: primary actions, focus, links |
| `--color-brand` | `#2b2a27` | `#1f1e1d` | Former navy field; now warm ink |

Area tokens (`--color-area-{record,research,people,honours,time}`) are muted warm variants:
record clay-brown, research sage, people terracotta, honours old gold, time slate. Status
colours (positive, caution, critical) are warm-shifted and still hold 4.5:1 as text.

## 2. Type

| Role | Face | Notes |
|---|---|---|
| Page titles, hero headline, hero numbers (`.display`, `.honour`, `--font-display`) | **Source Serif 4 Variable** (OFL, `@fontsource-variable/source-serif-4`), Fraunces as fallback | weight 500, tracking −0.015em |
| UI, body, tables, labels | **Inter Variable** | 14/24 body, 13 dense, 12 meta |

## 2a. Shape and depth

- Radii: controls 8px, cards and panels 12–14px (`--radius-xl`), pills and search full.
- Shadows: none on cards, controls or bands. Only `pop` (menus, popovers, toasts) and `modal`
  carry a very soft shadow plus a hairline.
- Layout: content column max 1100px (`--page-max`), centred. Sidebar slim, sunken warm grey,
  rounded active pill, small muted section labels, collapse button, Saveetha emblem + name in
  the header. Home opens on a centred composer-style search.



## 3. Iconography

We use Lucide, which is already installed (`lucide-react`). Stroke is 1.75 at ≤ 24px and 1.5
at 32px and above. Icons come in four sizes:

| Size | px | Where |
|---|---|---|
| `icon-sm` | 16 | Inline with text, row metadata, chips |
| `icon-md` | 20 | Buttons, nav |
| `icon-lg` | 32 | Stat tiles, entity-card leading icon, empty states |
| **`icon-xl`** | **48, inside an 88×88 `rounded-3xl` area-wash tile** | **Big choice tiles** (File a paper method picker, Home "next step" tiles, Search empty-state shortcuts) |

Every concept has one icon, and every page must use this mapping:

| Concept | Icon | | Concept | Icon |
|---|---|---|---|---|
| Paper / publication | `FileText` | | Person | `UserRound` |
| File a paper | `FilePlusCorner` | | Co-author | `UsersRound` |
| Pull from Scopus | `CloudDownload` | | Two-hop connection | `Waypoints` |
| Paste DOI | `ClipboardPaste` | | Message | `MessageCircle` |
| Journal | `BookOpen` | | Department | `Building2` |
| Topic / area | `Sparkles` (research) / `Tag` (chip) | | Calendar event | `CalendarDays` |
| Citation | `Quote` | | Deadline | `AlarmClock` |
| Q1 | `Gem` | | Leaderboard | `Trophy` |
| First author | `PenLine` | | Wall of fame | `Award` |
| Paid / money | `IndianRupee` | | Impact card | `BadgeCheck` |
| Waiting / on the way | `Hourglass` | | Idea / future | `Lightbulb` |
| Verified | `ShieldCheck` | | Trend up / down | `TrendingUp` / `TrendingDown` |
| Search | `Search` | | Action (palette) | `CornerDownLeft` |

## 4. Illustration style

The house set is in `frontend2/public/illustrations/`. The files are drawn for this app and
licensed CC0 (see `ASSETS.md`). The style rules:

- **Geometric and flat.** No outlines on filled shapes, and no people's faces. Figures are
  abstract: paper sheets, arches, nodes and constellations, echoing the portico mark in
  `ui/art.tsx`.
- **Three inks only:** navy `#2b398f`, one area accent and gold `#e0a82e` for the single spark
  or highlight. Mass is `#dfe5f7` (navy at 12%), and paper is `#ffffff` or `#fbf8f1`.
- **Canvas is 320×200** on a shared ground line at y=176, the same principle as the 72×56
  spot art in `art.tsx`.
- **Placement.** Illustrations sit on a **plate**: a `rounded-3xl` area-wash rectangle. The
  plate keeps the fixed-colour SVG legible in dark mode, where the plate becomes
  `--area-*-wash` dark.
- **Where they appear:**
  - Empty states: up to 200px wide.
  - The File a paper method picker: 120px.
  - The landing hero: 480px.
- **Where they never appear:** in tables, or more than one per viewport.
- **Keep the small spot art.** `ui/art.tsx` `<Art>` stays for inline empty rows. The new
  scenes are for full empty pages and heroes.

## 5. Motion

Uses `motion` (installed) and the existing `ui/motion.ts`.

| What | Duration | Easing | Rule |
|---|---|---|---|
| Hover/press on controls | 120ms | ease-out | Colour only. Never lift or scale on hover (existing rule). |
| Palette / sheet / dialog in | 160ms | `cubic-bezier(.2,.8,.2,1)` | Fade + 8px rise. Out is 120ms. |
| Hero figure count-up | 700ms | ease-out | Only on first view of a session. Skipped under `prefers-reduced-motion`. |
| Record strip cells | 20ms stagger, max 400ms total | linear | Once. |
| Tick of an eligibility box | 180ms | spring (stiffness 500, damping 30) | The check draws its stroke. It is the only "delight" on the filing page. |
| Share card reveal | 500ms | ease-out | The card slides up and the ribbon shimmers once. |
| Route change | none | – | Pages do not animate between routes. |

`prefers-reduced-motion: reduce` turns every row except colour hover into an instant change.

## 6. Density

There are two densities, chosen per region, not per page:

- **Showcase** (hero, stat tiles, choice tiles, profile header): 32px section gaps, 24px card
  padding, figures at `figure`/`figure-xl`.
- **Work** (tables, lists, feeds, forms): 44px rows (40px dense tables), 16px card padding,
  hairline separators. This is the existing Stripe/Notion rule and it is unchanged.

The content column is max 1200px with 32px gutters on desktop, and 16px on phones. Phone width
is 390px, and nothing scrolls horizontally except a table inside its own scroller.

## 7. Empty, loading and error states

- **Empty.** Use an illustration on its plate, then a heading that says *what will be here*,
  then one sentence on *how it gets here*, then one primary action. Never say "No data".
  Example: "Your record will build itself — Once we match you to your Scopus profile, every
  paper you have published appears here. [Connect Scopus profile]".
- **Loading.** Show skeletons of the real shape, as now. The hero figure shows `—`, never 0.
- **Error.** Say what failed, that nothing was lost, and offer Retry. Keep the current copy
  style, which is good. Errors stay inline with the region that failed, never full-page.
- **Partial truth.** If the data is known to be incomplete (for example "10 of 10 papers have
  no subject area"), say so as a caution chip beside the number, not as a paragraph under it.

## 8. Shared components (build once in `frontend2/src/ui/`, every page reuses)

| Component | File | Contract |
|---|---|---|
| `HeroBand` | `ui/hero.tsx` | Props: `area`, `eyebrow`, `title`, `figure?` (number + label), `sentence?`, `actions?`, `aside?` (ReactNode: illustration, avatar or strip). Tinted gradient, emblem watermark at 5% opacity bottom-right, 3px area-colour top rule. `variant="solid"` only on Home and Landing. |
| `StatTile` | `ui/stat.tsx` | Icon (`icon-lg`, area colour), figure, label, optional delta (`TrendingUp` +n vs last year) and optional caution chip. It is a link when `to` is given. Tiles come in rows of 3–4. |
| `ChoiceTile` | `ui/choice.tsx` | 88px icon tile (`icon-xl`), title, one-line description, optional "Recommended" gold chip. Radio semantics in a group. The whole tile is clickable, and the focus ring is the area line. |
| `BigSearch` | `ui/big-search.tsx` | 64px tall input, `rounded-2xl`, 20px text, leading `Search` 24px, trailing `Ctrl K` kbd. Scope chips under it (All · Papers · People · Journals · Topics · Departments · Pages). The same result renderer as the palette. |
| `PaperCard` | `ui/entity.tsx` | Title (2 lines max), journal · year · quartile chip, author line with *you* bolded and position "2 of 6", source chips (Scopus/OpenAlex/ERP), and claim state (a mini `StageTrack` or "Not claimed — File it"). Dense row variant for lists. |
| `PersonCard` | `ui/entity.tsx` | Avatar, name, dept · designation, "Saveetha" or external-affiliation chip, 1-line context ("3 papers together · last 2025"), and actions (Message, View). The connection variant shows the `ConnectionPath`. |
| `JournalCard` | `ui/entity.tsx` | Name, publisher, quartile/SNIP chips, "N colleagues published here", subject areas. |
| `Chip` | `ui/chip.tsx` | Tones: neutral, area, gold (honour), caution, positive. 24px high, 12px text, optional 16px icon. |
| `RecordStrip` | `ui/record-strip.tsx` | GitHub-style grid: columns are years (last 10) and rows are months, or a compact one-row-per-year variant of 12 cells. Cell shade is the area colour at 5 steps by papers/month. Hover or tap shows "Mar 2024 · 2 papers" and clicking filters the list. |
| `ConnectionPath` | `ui/connection.tsx` | `You → X → Y` as avatars joined by a line with a `Waypoints` icon, each hop labelled with its evidence ("3 papers", "same dept"). Up to 3 alternative paths, stacked. |
| `Timeline` | `ui/timeline.tsx` | Vertical, year markers, events (paper, first Q1, citation milestone, award) with area-coloured dots. Used on My research and Person. |
| `Charts` | existing `ui/chart.tsx` | Reuse `Trend`, `RankedBars`, `MixBar` and `Distribution`. Add `Sparkline` (48×16) for stat tiles. Colour charts with the page's area token, never a rainbow. |
| `SharePlate` | `ui/share-plate.tsx` | The cream plate with gold ribbon used for the Impact card preview and Wall of fame tiles. |

## 9. Navigation (applies to every spec)

The sidebar drops from 19 items to **four groups and ten items** for faculty:

```
[emblem] Publications
  ⌕ Search            Ctrl K        ← BigSearch page; palette anywhere
  ⌂ Home
  RECORD   (navy)
    My papers
    File a paper       (+ button style, gold dot when a draft waits)
  RESEARCH (teal)
    My research        (absorbs "The college's research")
    Discover
  PEOPLE   (terracotta)
    Who to work with   (absorbs Colleagues + College network)
    Messages
    Discussions
  HONOURS  (gold)
    Leaderboard        (absorbs Wall of fame as a tab)
    Impact card
  Calendar  (sky)      ← pinned above the account block
```

The group heading carries a 6px dot in its area colour. The active item uses `--area-*-wash`
as its background, not `selected`.

**Removed from the nav:**

- **Colleagues** (`/u`): folded into Search. Its route redirects to `/search?scope=people`.
- **College network**: cut (see `11-network.md`).
- **The college's research**: merged into My research as a tab (see `05-my-research.md`).
- **My goals**: cut as a page and replaced by a "This year" card on My research (see
  `13-goals.md`).
- **Wall of fame**: becomes a tab of Leaderboard. Its route stays for deep links.

## 10. Accessibility floor

- Every area colour meets 4.5:1 as text. Chips put text on wash at ≥ 4.5:1.
- Focus rings use the 2px area line and a 2px offset.
- Icon-only buttons need `aria-label`.
- `RecordStrip` cells are real buttons with names like "March 2024, 2 papers".
- Hero figures have a text equivalent.
- Motion respects reduced-motion.

## Index of specs

| # | Spec |
|---|---|
| 01 | `01-landing-home.md` — sign-in and Home |
| 02 | `02-search.md` — Search page and Ctrl-K palette (absorbs Colleagues) |
| 03 | `03-my-papers.md` |
| 04 | `04-file-a-paper.md` |
| 05 | `05-my-research.md` (+ the college's research decision) |
| 06 | `06-discover.md` |
| 07 | `07-leaderboard-reports.md` |
| 08 | `08-who-to-work-with.md` (+ person context) |
| 09 | `09-person-profile.md` |
| 10 | `10-messages.md` |
| 11 | `11-network.md` (decision: cut) |
| 12 | `12-calendar.md` |
| 13 | `13-goals.md` (decision: cut and fold) |
| 14 | `14-wall-of-fame.md` |
| 15 | `15-impact-card.md` |
| – | `ASSETS.md` — illustration sources and licences |
