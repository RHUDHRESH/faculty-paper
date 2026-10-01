# Foundation handoff: how to build a view in the new system

For the five view builders (Faculty, Research office and research faculty, Admin, Principal,
Director). Read this, then DESIGN.md (the rules) and docs/design/art-direction.md (the why).
The foundation is done: tokens, fonts, the kit, the shell and the sign-in page. You build
views out of it. If you need something the kit does not have, say `NEEDS: <what>` in your
report; do not fork a component into a page.

## The concept in one breath

The college's research on warm paper in navy ink: **one answer, the biggest thing on the page;
one thread that shows where every claim is; a face for every name; the college's own drawings
shown as mounted prints; one stamp when something is decided.** Quiet everywhere else.

## Page recipe (docs/ux/22 anatomy, in the new weights)

```tsx
<div className="page space-y-14">                        {/* 56px between sections */}
  <PageHeader                                            {/* ui/page-header */}
    title="Clearing queue"                               {/* Display, 32-40px serif */}
    sub="Submitted claims, oldest first."                 {/* the lead: one sentence */}
    action={<Button kind="primary">Review the 3 ready</Button>}
    spot="spot-audit"                                     {/* Home views and hubs only */}
  />

  {/* The answer: ONE of these, never both */}
  <AnswerLine>Nothing needs you. One claim is <AnswerWord tone="sage">being checked</AnswerWord>.</AnswerLine>
  <Answer items={[{ value: 14, label: "Waiting to clear", to: "/clearing", zero: "Nothing waiting" }]} />
  <Thread counts={…} you="filed" to={…} late={…} />       {/* when position is the answer */}

  <Section title="Oldest waiting" action={<Link to="/clearing">All 14</Link>}>
    <Table … />                                           {/* or Rows for a short list */}
  </Section>

  <Details count={12} label="history">…</Details>         {/* detail on demand */}
</div>
```

Rhythm: 8 px in a group, 16 px between related groups, 40 px under the header, 56 px between
sections. More above a heading than below it. Header to first section is the 40.

## Tokens: what each is for

Full list and the audit rules are in `frontend2/src/ui/CONVENTIONS.md`. The jobs:

| Token (Tailwind name) | Job |
|---|---|
| `bg-bg` / `bg-surface` / `bg-sunken` | the page / a panel, table, field, menu / a well, the rail |
| `bg-hover` `bg-active` `bg-selected` | pointer on, pointer down, chosen |
| `border-line` / `border-edge` / `ring-field` | between rows / around a region / around an input |
| `text-fg` `text-fg-muted` `text-fg-subtle` | text, secondary, tertiary (all 4.5:1 on every surface step) |
| `text-accent` `bg-accent-wash` | **clay**: links, focus, "needs you", selected chip, the stamp. Never an error. |
| `bg-action text-action-fg` | the primary button (navy ink). Use `Button kind="primary"`; do not hand-roll it. |
| `text-navy` `bg-navy-wash` | the record, the first chart series, a calm highlight |
| `text-positive` `bg-positive-wash` | done, paid |
| `text-caution` `bg-caution-wash` | taking longer, past the service level |
| `text-critical` `bg-critical-wash` | wrong, refused, destructive. Never filled red. |
| `text-area-honours` `bg-area-honours-wash` | honours (Q1, a badge). Gold is for honours only. |
| `--chart-1` to `--chart-6` | chart inks: navy, clay, sage, gold, slate, plum |

Type: `text-display-xl` (+ `.display .display-xl`) the one answer sentence; `text-display`
(+ `.display`) the page title; `text-figure` (+ `.figure`) a figure that is an answer;
`text-lead` the line under a title; `text-lg` section title; `text-base` body (14, 15 on a
phone); `text-sm` dense; `text-xs` meta. **There is nothing between 16 and 32.**
Radius: `rounded-control` 10 px (anything you press or type in), `rounded-panel` 16 px (anything
that holds things), dialogs `rounded-xl`. Motion: `--dur-1..5` = 80, 140, 220, 360, 640 ms.

## The kit, by job

| Need | Use | Notes |
|---|---|---|
| Page top | `PageHeader` | `title`, one `sub`, one `action`, optional `spot`. Do not pass `eyebrow` (banned). |
| The answer as a sentence | `AnswerLine`, `AnswerWord` (`ui/answer`) | Two short clauses. One word may be a pill: `tone` clay/sage/amber/crimson/navy. `role="status"`. |
| The answer as figures | `Answer` | 1 to 4 figures, each a link, a zero says what it means. Each hangs from a hairline. |
| Where claims are | `Thread` (`ui/thread`) | `counts` from `HOME_DATA.stageCounts` (`/api/claims/counts`) or `/api/track`; `you` = the reader's station (`filed` for the office, `checked` Principal, `approved` Director, `authorised` Finance). `HomeTrack` already draws it on every office home. |
| Where one claim is (staff) | `ClaimThread` | Five dots, `at` = the station. Faculty see `ClaimTrack`/`Journey` (four stages, no desk). |
| A decision | `toast.stamp("Cleared", "…")` (`ui/toast`), or `<Stamp verb date>` in place | Clear, Approve, Authorise, Pay only. The stamp is already wired into those four actions. |
| A count of things | `DotField` (`ui/dot-field`) | One dot per paper/claim, grouped, named once beneath with real counts. At most four groups. |
| A picture | `Plate` (`ui/plate`) | A mounted print. Width in px; add `caption` from 240 px up. |
| A person | `Avatar` (24/32/40/64/96), `FaceStack`, `Portrait` (`ui/person`) | Real photo from `photo_url`; initials fallback. Never "?". |
| A list of records | `Table` (`ui/table`), `Rows` (`ui/section`) | Sentence-case heads, 52 px rows, right-aligned tabular numbers. |
| The same thing, cut differently | `Tabs` (`ui/tabs`) | ARIA keyboard pattern; a real count. Four at most. Routes are links, not tabs. |
| Status word | `Chip` (`ui/chip`) | tones: neutral, area, gold, caution, positive, critical, navy, clay. Say it once above a list, not on eight rows. |
| Empty | `EmptyState` (`ui/state`) | `size="page"` (whole view), `"region"` (default), `"compact"` (inside a table or card). |
| Error / loading | `ErrorState`, `InlineError`, `Skeleton*`, `Delayed` | Unchanged API. |
| Filters | `className={filterBar}` (`ui/filter-bar`) | On a phone the search takes a row and the rest sit two to a row. |
| Buttons | `Button` | `primary` navy (one per view), `default`, `quiet`, `danger` (crimson text, never filled). 40 px, 44 on phones. |
| Fields | `Field`, `Input`, `Textarea`, `SelectField`… (`ui/field`) | 44 px (48 on phones), 10 px radius, 14 px labels. |

## Illustration and photographs

- **One plate per view.** `spot` in a header is a plate; so is an empty state. Never two in a
  viewport, never in a table, never on a card, never under 96 px.
- **One drawing per role** (do not reuse across roles): Faculty `spot-home-faculty`; Research
  office `spot-audit`; Admin `spot-home-admin`; Principal `spot-approvals`; Director
  `spot-authorisations`; Finance `spot-payouts`; HOD `spot-home-hod`. Pages inside a role keep
  their own `spot-*` (My papers `spot-my-papers`, Reports `spot-reports`, …) but only on a Home
  or hub.
- Empty states pick `empty-*` or `spot-*` for the situation (`ART_ILLUSTRATION` in `ui/state`).
- **Faces beat drawings for people.** Wherever a named person appears (a claimant, a co-author,
  the signed-in user) it is their photograph. Never a drawing of a person for a named person.
  Principal and Director Home had no face at all: the claim waiting is *someone's*; show them.
- The sign-in painting is the only large picture (it needs no frame; see `pages/sign-in.tsx`).

## Motion (two moments, nothing else)

1. **The Thread draws itself**, once per session, 640 ms, left to right (done in the component).
2. **The Stamp** lands on a decision, 360 ms (done in `toast.stamp`).

Everything else: a tone change on hover/press (80 to 140 ms), a drawer or menu (220 ms). No
motion between pages, no lift on hover, no bounce, no looping animation. Reduced motion is
handled globally.

## Voice

Plain Indian English, sentence case, the vocabulary of docs/ux/19. A button says what happens
("Assign 3 claims") and the toast repeats the verb ("Assigned"). A zero says what it means. No
em dashes, no exclamation marks, no "Oops". Money is `money()` (₹1,09,265).

## Do and don't (the short list)

Do: make the answer the biggest thing; use the Thread when position is the answer; put a face
by every name; keep clay for links, focus and "needs you"; give a plate its mount; use `Table`
and `Rows`; write the empty state's next action.

Don't: build a card grid or a card in a card; use `text-xl`/`2xl`/`3xl` for a heading or a figure
(use the display scale); set a column of money in the serif; add a kicker or all-caps label; use
a coloured side stripe on a row, card or alert; fill a button red; shrink a picture into a corner;
add a second animation; invent a colour (add a token with a comment saying its job).

## Per-view briefs

**Faculty** (a lecturer on a phone). The answer is the sentence on Home (`display-xl`, already
wired). Next: "Papers you can still file" with the *amount* beside each File button; "Your
money" as three Figures; the record as a `DotField` by quartile (Q1 gold); "Claims on the way"
with `ClaimTrack`. Plate `spot-home-faculty`. My papers: `Tabs` for the states, a table that stacks
on a phone, faces for co-authors (`FaceStack`). File a paper keeps its three illustrated choices
(they are the model for a form). Cut: the badge row on Home unless there is a new one.

**Research office and research faculty.** Home is the `Thread` with "Your desk" at Filed plus the
oldest-waiting list. The queue keeps its j/k/x keys; make the person (face, name, department) lead
each row and the claim number a quiet meta; say "No amount recorded" once above the list, not on
every row. On a phone: search plus Filters, then rows (the `filterBar` already does two to a
row). Review workspace: `ClaimThread` in the header, the history as numbered notes with initials
and dates (docs/art-direction C), and the Clear button stamps. The selected row in the left rail
still has a coloured left stripe (a ban): use `bg-selected`. Research faculty (the yearly rupee
threshold): one sentence, "₹x of ₹y used this year", and a single quiet meter; no card.

**Admin.** Answer: one sentence ("Everything is healthy" or "3 things need you") over the
readiness list, then the `Thread` (Where every claim is), then data health. Plate
`spot-home-admin`. Tables for People, Imports, Jobs with right-aligned tabular numbers; settings
forms in a single 40 rem column with the 44 px fields, one primary button that says what it does.

**Principal.** Answer: "N claims, ₹X, are waiting for you." or "Nothing is waiting for your
approval." and stop. The waiting claims show the claimant's face and the amount; Approve stamps.
The year is one `DotField` or one sentence, not three blocks. Plate `spot-approvals`.

**Director.** Answer: what needs the signature, and what it does to the budget. The month's
statement is the one primary button ("Statement to sign"). `Thread` with "Your desk" at Approved.
Plate `spot-authorisations`. Authorise stamps.

## Known leftovers for you to clean up

- Older pages still set figures in `text-2xl font-semibold` Inter or use `text-xl` headings
  (Reports, Money). Move them to `Answer`/`Figure`.
- The review workspace's left-rail selected row has a coloured left border.
- Filter bars with five fields still ask for a lot on a phone; consider one search plus a
  Filters sheet where a page has more than three.
- Several pages still pass `spot` on non-Home views; drop it where the view also has an empty
  state or a Thread.
- `@fontsource-variable/fraunces` and `source-serif-4` are no longer imported; remove them from
  `package.json` in a dependency pass.

## Verify

```
npm run audit            # tokens, routes, clarity (must stay green)
npx tsc -p tsconfig.app.json --noEmit
npx vitest run <files> --maxWorkers=1
```

Screenshots at 1440 and 390, light and dark: `audit/shots.mjs` (see its header), or the scripts
described in docs/design/shots/README.md. Contrast is checked per token pair in
`DESIGN.md`; add a pair there when you add a token. If you serve a worktree whose `node_modules`
is a junction, Vite refuses the font files unless `server.fs.allow` includes the real path.
