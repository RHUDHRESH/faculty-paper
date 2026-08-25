# House rules for `src/ui`

Read this before writing a component here. It is the whole design language;
anything not covered by it should match `button.tsx`, `text.tsx` and
`paper.tsx`, which are the reference implementations.

## The rule everything follows

> **Borders and shadows are expensive. Whitespace is free.**

- `--shadow-pop` / `--shadow-modal` are ONLY for things that genuinely leave
  the page: menus, dialogs, popovers, the palette. Never on a card, a panel, a
  row, or a hover state.
- A border means "these two things are genuinely different regions". Use
  `--color-line` for a rule between rows, `--color-edge` to bound a region.
- Everything else is separated by space, weight and colour.

## Never do these

1. **Never invent a colour.** Only the tokens listed below exist. No
   `bg-slate-50`, no `#fff`, no `rgb()`. If a shade seems missing, it is
   deliberate — pick the nearest token.
2. **Never lift on hover.** Hover is a background change (`--color-hover`).
   A row that rises under the pointer makes a fifty-row list twitch.
3. **Never use uppercase + letterspacing for a heading.** Use `<SectionTitle>`.
   Uppercase is only for a column head in a data grid — use `<ColumnLabel>`.
4. **Never remove a focus ring.** `:focus-visible` is styled globally. If a
   component needs its own, it replaces it, never deletes it.
5. **Never use a radius above `--radius-lg`** except on a dialog/palette
   (`--radius-xl`).
6. **Never render an error as an empty state.** "Could not load" and "nothing
   here" are different sentences and a reader must be able to tell them apart.
7. **No `any`.** No `!` non-null assertions except on `getElementById("root")`.

## Tokens — the complete list

Colour: `--color-bg --color-fg --color-fg-muted --color-fg-subtle
--color-surface --color-sunken --color-hover --color-active --color-selected
--color-line --color-edge --color-field --color-accent --color-accent-hover
--color-accent-fg --color-accent-wash --color-accent-line --color-positive
--color-positive-wash --color-caution --color-caution-wash --color-critical
--color-critical-wash`

Shape: `--radius-sm --radius-md --radius-lg --radius-xl`
Elevation: `--shadow-pop --shadow-modal`
Motion: `--ease-out --ease-in-out --dur-1 --dur-2 --dur-3`
Type: `text-xs text-sm text-base text-lg text-xl text-2xl text-3xl`

Every one of those is declared in `@theme`, so Tailwind generates a real
utility for it. Drop the `--color-` / `--radius-` / `--shadow-` prefix and
write the plain name: `bg-hover`, `text-fg-muted`, `border-line`, `ring-field`,
`rounded-md`, `shadow-pop`, `ease-out`.

**Never write the bracket form.** `bg-[--color-hover]` is not valid v4 — it
emits `background-color:--color-hover`, which is not a value, so the browser
drops the declaration and the colour silently does nothing. If you catch
yourself typing `-[--`, you want the bare utility instead.

`--dur-*` is the one exception: it is not a Tailwind namespace, so it has no
generated utility and needs the function spelled out — `duration-[var(--dur-1)]`.

Utilities in `styles.css`: `.row` (hover wash), `.reveal` (actions that appear
on row hover/focus), `.page` (the page column), `.tabular` (tabular numerals).

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


Run `npx tsc --noEmit -p tsconfig.app.json` before you finish. Several agents
may be working at once, so if it reports an error in a file you did not touch,
ignore that one and make sure your own files are clean.
