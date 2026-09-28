# 00 · Design language: "Convocation"

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

## The direction in one paragraph

**Convocation.** The app should feel like a college's graduation day, not like a SaaS
dashboard: deep navy gowns, a gold ribbon for honours, cream paper for certificates, and a
confident serif used *only* for honour moments. Everyday work (filing, lists, search) stays
quiet, dense and Inter. Two things change the whole feel:

1. **Every area has its own colour.** You always know where you are. Record is navy, Research
   is teal, People is terracotta, Honours is gold, Time is sky.
2. **Every page opens with a Hero band.** It is a tinted band that answers the page's question
   in one big number or sentence, and it carries the Saveetha emblem as a faint watermark.

The hero is where flow and appeal live. The body of the page underneath stays calm.

Patterns borrowed, not looks:

- **Linear and Raycast:** one palette for everything (search, pages, actions) with grouped
  results and keyboard hints.
- **GitHub:** the contribution graph, a year of activity readable at a glance. It becomes
  our **Record strip**.
- **Google Scholar and ORCID:** a profile made of metrics, a citations-per-year chart and
  co-authors on the side.
- **LinkedIn:** "2nd-degree via X" connection context.
- **Spotify Wrapped:** share cards built for 9:16 and 1:1, with the user as the main character
  and one surprising stat.
- **Cal.com and Notion Calendar:** a month/week grid, quick-add, and subscribe by link.
- **Stripe:** report tables with aligned numerals and a quiet chrome.

## 1. Palette

The brand navy is unchanged: `--color-brand` and `--color-accent` are `#2b398f`. The additions
below go in `frontend2/src/styles.css` under `@theme`, with dark values in the existing dark
block. Contrast figures are for text on `#ffffff`, and each text token is ≥ 4.5:1.

| Area | Used by | `--area-*` (text/icon) | `--area-*-wash` (fill) | `--area-*-line` | Dark text | Dark wash |
|---|---|---|---|---|---|---|
| **record** (navy) | Home, My papers, File a paper | `#2b398f` | `#eef2fd` | `#c8d3f7` | `#8fa5ff` | `#1a2341` |
| **research** (teal) | My research, Discover, Search topics | `#0b6e67` | `#e8f6f4` | `#b5e2dc` | `#4fd1c1` | `#0e2826` |
| **people** (terracotta) | Who to work with, Profiles, Messages | `#b04a2f` | `#fcefe9` | `#f3cbbd` | `#ff9a7a` | `#2e1911` |
| **honours** (gold) | Leaderboard, Wall of fame, Impact card | `#8a6410` (text) / `#e0a82e` (fill/ribbon) | `#fdf6e3` | `#f1dca3` | `#f5c451` | `#2a220c` |
| **time** (sky) | Calendar | `#1b6fa3` | `#e8f3fb` | `#b9dbf1` | `#6cc0f5` | `#0f2230` |

Other colour rules:

- **Cream paper** `--color-paper: #fbf8f1` (dark: `#1b1a16`). It is used only for certificate
  surfaces: the impact card preview plate, Wall of fame tiles and the "you were cited" moment.
- **Gold ribbon** `--gradient-ribbon: linear-gradient(90deg, #e0a82e, #f5d27a 50%, #e0a82e)`.
  It is a 3px top border on honour surfaces and nowhere else.
- **Hero gradient** per area: `linear-gradient(135deg, var(--area-X-wash) 0%, var(--color-bg) 70%)`.
  The record-area hero on Home and on Landing is the one exception. It uses a *solid navy*
  field, `--color-brand`, with white type.
- **Status colours** (positive, caution, critical) are unchanged and are never used as area
  colours.
- **Rule:** a page uses exactly one area colour, plus navy for actions. Gold appears only when
  something is an honour.

## 2. Type

| Token | Size / line | Face | Use |
|---|---|---|---|
| `display-honour` | 44/48, weight 600, tracking −0.02em | **Fraunces Variable** (add `@fontsource-variable/fraunces`, OFL) | Landing hero, Impact card name, Wall of fame month titles, profile name. Nowhere else. |
| `display` | 32/38, weight 650 | Inter | Hero band headline (the answer) |
| `figure-xl` | 56/56, weight 700, `tabular-nums` | Inter | The one number in a hero |
| `figure` | 28/32, weight 650, tabular | Inter | Stat tiles |
| `title` (existing `text-xl`) | 26/32 | Inter | Page title above the hero |
| `section` (`text-lg`) | 16/24, weight 600 | Inter | Section heading |
| `body` (`text-base`) | 14/24 | Inter | Body |
| `meta` (`text-sm`/`xs`) | 13 and 12 | Inter | Metadata, column heads (12px caps, tracking +0.04em) |

The existing comment in `styles.css` says a serif made "a working tool read like an article".
That is right for working pages, so the serif is restricted to honour moments, where reading
like a certificate is the point.

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
