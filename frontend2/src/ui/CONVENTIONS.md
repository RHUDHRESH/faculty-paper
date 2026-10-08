# House rules for `src/ui`

Read this before writing a component here. It is the whole design language;
anything not covered by it should match `button.tsx`, `text.tsx` and
`paper.tsx`, which are the reference implementations.

## The rule everything follows

> **Borders and shadows are expensive. Whitespace is free. Depth is earned by
> the one object on a page that answers its question.**

The first two clauses are the original rule and they still stand. The third
was added because the first two, applied to *everything*, produced a real
complaint: the app read as empty. Not sparse — empty. On a payments screen the
total owed, the filter bar and a paragraph of help text all sat on the same
white at the same weight, and a reader looking for the number had to read the
page to find it. "No hierarchy" is not the same virtue as "no decoration".

So the system now has two things it did not have: a stack of surface tones,
and an elevation scale in which every step is a claim about where a thing is.
What has **not** changed is that both are rationed. The default is still flat.

- A border still means "these two things are genuinely different regions".
  `--color-line` for a rule between rows, `--color-edge` to bound a region.
- Elevation is still forbidden on almost everything — see the table below.
- Space, weight and colour still do most of the separating.

## Surfaces

Five tones, in a measured ladder (the L\* figures are in `styles.css`). They
are a stack, and the order is the point:

| Token             | What it means                                            |
| ----------------- | -------------------------------------------------------- |
| `--color-surface` | An object: a panel, a table, a menu, a control            |
| `--color-bg`      | The page the objects rest on                             |
| `--color-sunken`  | A ground something sits *in*: a well, a sidebar, a head   |
| `--color-hover`   | The pointer is on this                                   |
| `--color-active`  | The pointer is down on this                              |

`--color-bg` is no longer pure white. That single change is what lets a table
or a panel read as an object without anyone adding a box to a page: until the
page stopped being the same white as the things on it, `surface` meant nothing.

Three utility classes name the three things a region can be doing. Prefer them
to reassembling the same string of utilities on every page — the difference
between them *is* the hierarchy, and a page that gets the first two the wrong
way round has two answers on it, which is a page with none.

- **`.panel`** — an ordinary region that is genuinely separate from the region
  above it. Surface, hairline, **no shadow**. A page of eight identically
  floating cards is the flatness problem inverted, not solved.
- **`.panel-lead`** — the one region that carries the answer. Accent-tinted
  ground fading into surface, an accent hairline, and the single permitted
  `lift`. **At most one per page.** A second one cancels the first.
- **`.well`** — a ground something sits in: a filter bar, a read-only block
  quoting what was submitted, a strip of segmented controls.
- **`.hairline`** — a rule that fades out at both ends, for a break between two
  stretches of the same kind of thing. A full-width rule compartmentalises the
  page; this leaves it open.

## Elevation

Six steps. Each one is a **sentence about where a thing is**, not a number on
a ramp. If you cannot say which sentence applies, the answer is no shadow.

| Token            | The claim it makes             | Allowed on                                  |
| ---------------- | ------------------------------ | ------------------------------------------- |
| `--shadow-well`  | content sits *in* this         | a control you type into; `.well`            |
| `--shadow-raise` | you can press this             | a button, a filter chip, the chosen segment — nothing else. `--shadow-action` is the navy button's own, `--shadow-press` is what pressing spends |
| `--shadow-lift`  | this is the page's answer      | `.panel-lead`, one per page                 |
| `--shadow-under` | content passes beneath this    | a pinned head or sticky bar, **while** something is under it |
| `--shadow-pop`   | this left the page             | menu, popover, tooltip, toast               |
| `--shadow-modal` | this took the page             | dialog, sheet, palette                      |

### Still forbidden, and these are the ones that matter

1. **Never lift on hover.** Unchanged and non-negotiable. Hover is a
   background change (`--color-hover`). A row that rises under the pointer
   makes a fifty-row list twitch. A button *deepens* its colour and edge on
   hover and spends its height on press (`active:shadow-press`, one pixel
   down) — a press loses height, it never gains it.
2. **Never put `raise` on something inert.** The shadow is the affordance, so
   a raised non-control is a lie about what happens when you click. `quiet`
   and `danger` buttons stay flat on purpose: quiet is flat at rest and gets
   a wash and an outline on hover, and a destructive action wears a crimson
   wash and only fills crimson under the pointer.
3. **Never elevate a card, a panel or a row.** `.panel` has no shadow. The
   tone step and the hairline are the whole treatment.
4. **Never show `under` permanently.** It describes an occlusion. Wire it to
   scroll position — `TableScroller` sets a `data-scrolled` flag for exactly
   this — or leave it off. A permanent one is a drop shadow wearing a hat.
5. **Never stack two steps on one element.** If it needs two, one of them is
   wrong.
6. **Never invent a seventh.** Six sentences is the whole vocabulary.

## Type

Two families (DESIGN.md, "Typography"). **Inter** for the whole interface;
**Brygada 1918** (`--font-display`) for the page title, the one answer
sentence on a page, and figures that are answers. Nothing else is set in it.

The UI scale is 12 / 13 / 14 / 16 (`text-xs sm base lg`), with `text-lead` (18)
for the one sentence under a title. Phones get a half-step up (the same names,
different numbers, in `styles.css`). The display scale is `text-display`
(32 to 40, fluid: the page title), `text-display-xl` (40 to 60, fluid: the
answer sentence), `text-figure` (36) and `text-figure-xl` (56).

**There is no size between 16 and 32.** A 22px heading is the lukewarm size
that made every old page read at one volume. A step is a UI step or a display
step. `text-xl` and `text-2xl` are no longer used anywhere; `text-3xl` is not
used in new work.

Classes: `.display` (page title), `.display-xl` (answer sentence; always pair
with `.display`), `.figure` (a number that is an answer; tabular, lining).
Emphasis in the display face is the italic (`<em>`) and nothing else, never
bold.

7. **Never set a number in a list in the display face.** A column of money is
   Inter, right-aligned, tabular. Only a figure that is *the answer* is
   `.figure`.
8. **Never use the display face below 22px**, and never for a section heading,
   a label, a button or body copy.
9. **Never use uppercase + letterspacing for a heading.** Use `<SectionTitle>`.
   Uppercase is only for a column head in a data grid, and the app no longer
   draws those: column heads are sentence case (`<ColumnLabel>`).

Weight is a real axis here. Both faces are variable; `.display` is 500,
`.display-xl` is 450, `.figure` is 500. If you need a weight between two named
steps, use the number and say why in a comment.
## Numbers

This app is about money, so a figure is not a string that happens to be
digits.

- `<Figure>` for a number that is an **answer** — a total, a balance, a count
  of things waiting on you. It is tabular by construction, weighted a real
  step above a heading at the same size, and carries the only sanctioned way
  to colour a number (`tone`).
- `.tabular` for a number that lives **in a list**, so it lines up with the
  one above it. Every `<td>` and `<th>` gets this already.
- Right-aligned means numeric. `Table` sets right-aligned cells `font-medium`
  so the eye can run down the amounts without reading the names.

10. **Never let colour be the only thing saying a figure is bad news.** The
    sign, the label or the word has to say it too. `tone` is a second signal
    for people who can use it, not the signal.

## Never do these

1. **Never invent a colour.** Only the tokens listed below exist. No
   `bg-slate-50`, no `#fff`, no `rgb()`. If a shade seems missing, it is
   deliberate — pick the nearest token. New tokens go in `@theme`, with a
   comment saying what they are for; that is the sanctioned mechanism and the
   audit accepts them once declared.
2. **Never lift on hover.** (See Elevation, above.)
3. **Never remove a focus ring.** `:focus-visible` is styled globally. If a
   component needs its own, it replaces it, never deletes it.
4. **Never use a radius above `--radius-panel`** except on a dialog/palette
   (`--radius-xl`), and never a fourth corner: controls are `rounded-control`,
   panels are `rounded-panel`.
5. **Never render an error as an empty state.** "Could not load" and "nothing
   here" are different sentences and a reader must be able to tell them apart.
   The empty state in `Table` is drawn sunken partly for this reason — an
   empty tray does not look like a banner.
6. **No `any`.** No `!` non-null assertions except on `getElementById("root")`.

## Tokens — the complete list

Colour (every one has one job; DESIGN.md names it): `--color-bg --color-fg
--color-fg-muted --color-fg-subtle --color-surface --color-sunken
--color-hover --color-active --color-selected --color-line --color-edge
--color-field` (paper and ink); `--color-accent --color-accent-hover
--color-accent-fg --color-accent-wash --color-accent-line` (clay: links, focus,
"needs you"); `--color-action --color-action-hover --color-action-fg` (the
primary button); `--color-navy --color-navy-wash --color-navy-line` (the
record, the first chart series); `--color-positive[-wash|-line]
--color-caution[-wash|-line] --color-critical[-wash|-line]` (state);
`--color-area-*`, `--color-paper --color-plate --color-hero-paper
--color-gold`; `--chart-1` to `--chart-6` (chart inks).

Shape: `--radius-sm --radius-md --radius-lg --radius-xl`, and the two a page is
built from, `--radius-control` (10px) and `--radius-panel` (16px)
Elevation: `--shadow-well --shadow-raise --shadow-lift --shadow-under
--shadow-pop --shadow-modal`
Motion: `--ease-out --ease-in-out --dur-1 --dur-2 --dur-3 --dur-4 --dur-5`
(80, 140, 220, 360 and 640ms)
Type: `--font-sans --font-display --font-mono`,
`text-xs text-sm text-base text-lg text-lead text-display text-display-xl
text-figure text-figure-xl` (`text-xl` and `text-2xl` are no longer used anywhere)
Every one of those is declared in `@theme`, so Tailwind generates a real
utility for it. Drop the `--color-` / `--radius-` / `--shadow-` prefix and
write the plain name: `bg-hover`, `text-fg-muted`, `border-line`, `ring-field`,
`rounded-md`, `shadow-pop`, `shadow-raise`, `font-display`, `ease-out`.

**Never write the bracket form.** `bg-[--color-hover]` is not valid v4 — it
emits `background-color:--color-hover`, which is not a value, so the browser
drops the declaration and the colour silently does nothing. If you catch
yourself typing `-[--`, you want the bare utility instead.

`--dur-*` is the one exception: it is not a Tailwind namespace, so it has no
generated utility and needs the function spelled out — `duration-[var(--dur-1)]`.

Utilities in `styles.css`: `.row` (hover wash), `.reveal` (actions that appear
on row hover/focus), `.page` (the page column), `.tabular` (tabular numerals),
`.panel` / `.panel-lead` / `.well` / `.hairline` (surfaces), `.plate` (a print's
mount), `.display` / `.display-xl` (titles), `.figure` (a number that is an
answer), `.stamp`, `.thread-draw`, `.thread-pop` (the two authored motions),
`.skeleton` (a placeholder).

## Page anatomy and the base (docs/ux/22)

Every view answers one question for one person: the answer first, the detail
one step away. The kit gives each part of that a component, so a page cannot
invent its own.

| Part | Component | Rule |
| --- | --- | --- |
| Title, one line of purpose, one primary action, breadcrumbs | `PageHeader` (`ui/page-header`) | `sub` is one sentence in the person's words. `action` is one button. No rule under it. |
| The answer | `Answer` (`ui/answer`) | 1 to 4 figures, each a link to the list behind it, a zero says what it means (`zero: "Nothing waiting"`). Flat: no card. |
| The work | `Section`, `Rows` (`ui/section`), `Table` | Sections are separated by space, not by a rule and a card. |
| Detail on demand | `Details` (`ui/section`) | "Show details (12)": the count says what is behind the door. |
| Where you are | `Breadcrumbs` (`ui/breadcrumbs`), drawn by the shell | Do not draw your own. A detail page names its record with `useCrumbLabel(name)`. |

**Tables.** Use `Table`. Every column has a heading (a column that must look
blank gets a `label` for screen readers and the phone layout). A number is
`align: "right"`. A cell with nothing to show returns `null` (or `"-"`) and the
table prints "Not recorded"; set `empty: "None"` when absence is a fact. Under
640 px the rows stack and keep their labels; opt out with `stack={false}` only
for a true grid. Give a sortable column `sortable` and the table `onSort`. For a
hand-built `<table>` you still need a `<thead>`, and `EmptyCell` for a missing
value. Give the empty list an `EmptyStateProps`: what would be here, and one
action.

**Counts.** Real numbers, always: `formatCount(n)` from `lib/count` ("1,284"),
never "99+". Two pages that count the same thing use the same service.

**States.** A skeleton is invisible for its first 300 ms (a CSS delay in
`.skeleton`, so it holds its space and never flickers); for a hand-built
spinner wrap it in `<Delayed>`. An empty state says what would appear and the
one thing to do. An error names what failed (`what="the import history"`) and
always has "Try again" (it reloads if the page gave no retry).

**Dividers and containers.** One hairline (`divide-y divide-line`, or `Rows`)
between the rows of a list. Space, not a rule, between sections. No card inside
a card; at most two levels of container on a view. **One radius for controls
(`rounded-control`, 10 px)**: buttons, fields, sidebar links, filters. **One for
panels (`rounded-panel`, 16 px)**: tables, menus, empty states, `.panel`.
Chips are pills (`rounded-full`); a dialog is `--radius-xl`. Do not use
`rounded-md` or `rounded-lg` on a new control or panel.

**Findable.** A new route is added to `PAGES` in `app/nav.ts` with a label, a
purpose and keywords in the words of the job (`findOnly: true` keeps it out of
the sidebar). `npm run audit` fails if a fixed route is not findable, and
`audit/clarity.mjs` fails on a new "99+", "Running", a run of three dashes, a
table without a head, or a blank column heading. Its baseline
(`audit/clarity-baseline.json`) lists what still breaks a rule; fix a page and
run `node audit/clarity.mjs --update` to lock it in.

## Sizes

Buttons are 32px (`sm`, 40px on a phone), 40px (`md`, 44px on a phone), 48px
(`lg`) tall; `loading` swaps the leading icon for a spinner; a `<Kbd>` inside a
button is the key hint; secondary text goes behind `InfoTip` (`ui/info`) or
`Details` (`ui/section`), never in a second line under the title; fields are 44px (48px on a phone). Body text is `text-base` (14px,
15px on a phone). Dense rows and secondary text are `text-sm` (13px, 14px on a
phone). Metadata is `text-xs` (12px).

## Behaviour

- Radix supplies behaviour (focus traps, keyboard, dismissal). You supply
  every pixel. Do not use a Radix default style.
- Everything reachable by keyboard, in a sensible tab order. Decorative
  controls beside an input get `tabIndex={-1}`.
- `aria-*` where a role is not obvious from the element.
- Motion respects `prefers-reduced-motion` (handled globally in `styles.css`,
  but do not fight it with inline JS animation).

## Fonts

Inter comes from `@fontsource-variable/inter` over npm. Brygada 1918 is
self-hosted in `src/assets/fonts/` (SIL OFL, licence beside it): Latin, an
italic, Latin extended, and a 900-byte rupee-only subset, declared by hand in
`styles.css`. Both faces have a rupee subset because U+20B9 sits in the
Latin-extended range, so without it every page showing money downloads 33 KB
(Brygada) or 85 KB (Inter) for one glyph. Never link a CDN.

The display face is `font-display: swap`, with a fallback face (`Brygada
Fallback`: Georgia scaled to Brygada's metrics) so the swap does not reflow a
page. Any face added later gets the same treatment: a real fallback stack and,
for a serif, a metric-matched local fallback.
## Writing

- Every exported component gets a docstring saying **what it is for and what
  goes wrong without it** — a concrete failure, not a description of the code.
- Comments explain *why*, never *what*.
- British spelling in prose. No em dashes inside code identifiers.

## Verifying

Before you call anything done:

    npm run check

That is the token audit, the route audit, a full typecheck and the linter. The
two audits exist because both bugs they catch are invisible in review and
invisible in a typecheck — a colour that silently does nothing, and a sidebar
item that bounces the reader home. A machine has to be the one that notices.

Then `npx vite build`, and look at the CSS it emits. Tailwind only emits the
theme variables something actually references, so a token you added and did
not use will not appear — which is the fastest way to find out that the
utility you thought you were writing does not exist.

Run `npx tsc --noEmit -p tsconfig.app.json` before you finish. Several agents
may be working at once, so if it reports an error in a file you did not touch,
ignore that one and make sure your own files are clean.
