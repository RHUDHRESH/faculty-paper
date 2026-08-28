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
| `--shadow-raise` | you can press this             | a filled or bordered button — nothing else  |
| `--shadow-lift`  | this is the page's answer      | `.panel-lead`, one per page                 |
| `--shadow-under` | content passes beneath this    | a pinned head or sticky bar, **while** something is under it |
| `--shadow-pop`   | this left the page             | menu, popover, tooltip, toast               |
| `--shadow-modal` | this took the page             | dialog, sheet, palette                      |

### Still forbidden, and these are the ones that matter

1. **Never lift on hover.** Unchanged and non-negotiable. Hover is a
   background change (`--color-hover`). A row that rises under the pointer
   makes a fifty-row list twitch. `active:shadow-none` on a button is the
   opposite move and is fine — a press *spends* height, it does not gain it.
2. **Never put `raise` on something inert.** The shadow is the affordance, so
   a raised non-control is a lie about what happens when you click. `quiet`
   and `danger` buttons stay flat on purpose: quiet must not compete, and a
   destructive action should not look inviting to press.
3. **Never elevate a card, a panel or a row.** `.panel` has no shadow. The
   tone step and the hairline are the whole treatment.
4. **Never show `under` permanently.** It describes an occlusion. Wire it to
   scroll position — `TableScroller` sets a `data-scrolled` flag for exactly
   this — or leave it off. A permanent one is a drop shadow wearing a hat.
5. **Never stack two steps on one element.** If it needs two, one of them is
   wrong.
6. **Never invent a seventh.** Six sentences is the whole vocabulary.

## Type

The scale is 12 / 13 / 14 / 16 / 26 / 28 / 36. Body is 14; dense rows and
secondary text are 13; metadata is 12.

**Two families.** Inter for the entire interface. `--font-display`
(Newsreader) for **page titles only** — that is `PageTitle`, and nothing else.
Size alone could not make a title win on a screen whose chrome is 13px and
14px Inter from the sidebar to the last cell; family can, without shouting.

7. **Never set a number in the display face.** Its figures do not line up in a
   column, and a column that lines up is worth more here than a nice 7.
8. **Never use the display face below 22px**, and never for a section heading,
   a label, a button or body copy. One use, one place.
9. **Never use uppercase + letterspacing for a heading.** Use `<SectionTitle>`.
   Uppercase is only for a column head in a data grid — use `<ColumnLabel>`.

Weight is a real axis here, not three named steps. Both faces are variable and
the values are chosen for the size they are set at: `.display` is `560`,
`.figure` is `620`. If you need a weight between two named steps, use the
number and say why in a comment.

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
4. **Never use a radius above `--radius-lg`** except on a dialog/palette
   (`--radius-xl`).
5. **Never render an error as an empty state.** "Could not load" and "nothing
   here" are different sentences and a reader must be able to tell them apart.
   The empty state in `Table` is drawn sunken partly for this reason — an
   empty tray does not look like a banner.
6. **No `any`.** No `!` non-null assertions except on `getElementById("root")`.

## Tokens — the complete list

Colour: `--color-bg --color-fg --color-fg-muted --color-fg-subtle
--color-surface --color-sunken --color-hover --color-active --color-selected
--color-line --color-edge --color-field --color-accent --color-accent-hover
--color-accent-fg --color-accent-wash --color-accent-line --color-positive
--color-positive-wash --color-caution --color-caution-wash --color-critical
--color-critical-wash`

Shape: `--radius-sm --radius-md --radius-lg --radius-xl`
Elevation: `--shadow-well --shadow-raise --shadow-lift --shadow-under
--shadow-pop --shadow-modal`
Motion: `--ease-out --ease-in-out --dur-1 --dur-2 --dur-3`
Type: `--font-sans --font-display --font-mono`,
`text-xs text-sm text-base text-lg text-xl text-2xl text-3xl`

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
`.panel` / `.panel-lead` / `.well` / `.hairline` (surfaces), `.display` (a page
title), `.figure` (a number that is an answer), `.skeleton` (a placeholder).

## Sizes

Controls are 28px (`sm`), 32px (`md`), 40px (`lg`) tall — match `button.tsx`.
Body text is `text-base` (14px). Dense rows and secondary text are `text-sm`
(13px). Metadata is `text-xs` (12px).

## Behaviour

- Radix supplies behaviour (focus traps, keyboard, dismissal). You supply
  every pixel. Do not use a Radix default style.
- Everything reachable by keyboard, in a sensible tab order. Decorative
  controls beside an input get `tabIndex={-1}`.
- `aria-*` where a role is not obvious from the element.
- Motion respects `prefers-reduced-motion` (handled globally in `styles.css`,
  but do not fight it with inline JS animation).

## Fonts

Both families come from `@fontsource-variable/*` over npm. Never link a CDN
and never commit a font file by hand.

The display face is declared by hand in `styles.css` rather than by importing
the package stylesheet, because fontsource ships `font-display: swap` and a
swap reflows every title on the screen a beat after the page paints.
`optional` is the one value that cannot shift layout: the browser gives the
file about 100ms, and if it is not ready it uses the fallback for that page
load and never swaps. Any face added later gets the same treatment and a real
fallback stack. A title is not worth a reflow.

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
