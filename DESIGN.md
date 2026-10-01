---
name: Saveetha Publications
description: The college's research record on warm paper in navy ink, with one thread that shows where every claim is and a face for every name.
colors:
  paper: "#F8F5EE"
  surface: "#FEFCF8"
  sunken: "#F0ECE2"
  hover: "#EAE5D9"
  active: "#E1DBCC"
  selected: "#E6E0D1"
  line: "#E7E1D3"
  edge: "#DAD3C2"
  field: "#968D79"
  ink: "#1B1F2E"
  ink-muted: "#55596B"
  ink-subtle: "#595D70"
  clay: "#9E4527"
  clay-deep: "#873A20"
  clay-wash: "#F7E9E1"
  clay-line: "#E8C5B4"
  navy: "#263050"
  navy-deep: "#1B2340"
  navy-ink: "#34406A"
  navy-wash: "#E9EBF2"
  sage: "#366748"
  sage-wash: "#E8F0E7"
  amber: "#82560A"
  amber-wash: "#F8EFD9"
  crimson: "#B0233F"
  crimson-wash: "#FAE8EB"
  gold: "#D4A24A"
  gold-ink: "#7A5B14"
  gold-wash: "#F6EDD6"
  slate: "#3B6577"
  mount: "#EFE8DC"
  night-paper: "#1A1D27"
  night-surface: "#222633"
  night-sunken: "#141720"
  night-ink: "#EDE8DC"
  night-clay: "#E88F6E"
typography:
  display-xl:
    fontFamily: "Brygada 1918 Variable, Georgia, serif"
    fontSize: "clamp(2.25rem, 1.5rem + 3.4vw, 3.75rem)"
    fontWeight: 450
    lineHeight: 1.04
    letterSpacing: "-0.02em"
  display:
    fontFamily: "Brygada 1918 Variable, Georgia, serif"
    fontSize: "clamp(2rem, 1.5rem + 1.6vw, 2.5rem)"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.018em"
  figure:
    fontFamily: "Brygada 1918 Variable, Georgia, serif"
    fontSize: "2.25rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontFeature: "'tnum', 'lnum'"
  lead:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.65
  title:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.25
  meta:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.125
rounded:
  control: "10px"
  panel: "16px"
  dialog: "20px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  section: "56px"
components:
  button-primary:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.navy-deep}"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.crimson}"
    rounded: "{rounded.control}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 12px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  chip:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 8px"
---

# Design System: Saveetha Publications

## Overview

**Creative North Star: "The Well-Kept Register."**

The college's research, kept the way a good office keeps a register: warm paper, navy ink, a
rubber stamp when something is decided, and a thread that shows where every claim is. It looks
like claude.ai (the owner's brief) in its manners: calm, serif, hairlines instead of boxes. It
is not claude.ai in its decisions. Those come from this college: the navy and gold of its own
colours, the hand-drawn pictures it already owns, the rupee, and the faces of 412 colleagues.

The page is quiet almost everywhere and bold in two places. **Boldness one: type.** The page
title and the one answer sentence on a page are set large in a display serif; nothing else on
the screen is anywhere near that size, so the eye never has to look for the point. **Boldness
two: pictures.** The generated illustrations are shown at the size of a picture, mounted like a
print in a college library with a caption beneath, one per view. Everything else (the lists, the
tables, the forms) is Inter at 13 to 16 px on paper, divided by one hairline.

Density is chosen per region, not per page. A **showcase** region (the answer, the thread, a
portrait) breathes: 56 px between sections, 40 px under the header. A **work** region (a table,
a queue, a form) is tight: 52 px rows on desktop, hairlines, tabular figures, the next action on
every row.

**Key characteristics**

- Warm paper ground; ink is a navy-black, not brown. A cool ink on warm paper reads as printing.
- One clay accent (links, focus, "needs you"); a navy ink for the primary button; sage for done;
  gold for honours; crimson for wrong. Each colour has exactly one job.
- Brygada 1918 for the title and for figures, Inter for everything else.
- No shadows on content. Depth is a tone step, a hairline, or a mount.
- A single signature element, **the Thread**: five stations (Filed, Checked, Approved,
  Authorised, Paid) with the claims sitting on it.
- One authored motion moment, **the Stamp**, when a decision is made.

## Colors

The palette is the colour of the drawings the college already owns: navy ink, sage, clay, sand,
gold. It is *Restrained* with a deliberate second voice (navy), and every colour has a job.

### Neutrals (paper and ink)

- **Paper** (#F8F5EE): the page. A warm off-white a step deeper than claude.ai's, matching the
  paper of the illustrations so a drawing sits on the page without a box.
- **Surface** (#FEFCF8): a panel, a table, a menu, a field. The one lighter value; it is what
  makes a table an object without a border.
- **Sunken** (#F0ECE2): a ground something sits in: the sidebar, a table head, a well.
- **Hover** (#EAE5D9), **Active** (#E1DBCC), **Selected** (#E6E0D1): the pointer is on it, the
  pointer is down on it, this one is chosen. Three different facts, three different tones.
- **Line** (#E7E1D3) between rows of one list; **Edge** (#DAD3C2) around a region; **Field**
  (#968D79, 3.2:1 on a field's surface, so the boundary of an input can be seen) around an input.
- **Ink** (#1B1F2E): text. A navy-black. **Ink muted** (#55596B) and **ink subtle** (#595D70) are
  secondary and tertiary text; both hold 4.5:1 on every step of the ladder down to Active.

### Accent: Clay

- **Clay** (#9E4527) with **Clay deep** (#873A20), **Clay wash** (#F7E9E1), **Clay line**
  (#E8C5B4): links, the focus ring, the unread dot, "needs you", the selected chip, the stamp.
  Not the primary button (that is navy), and never the error colour.

### The second voice: Navy

- **Navy** (#263050) and **Navy deep** (#1B2340): the primary button, the sign-in field, the
  Thread's ink. **Navy ink** (#34406A) with **Navy wash** (#E9EBF2): the "record" area, charts'
  first series, a quiet highlight.

### Meaning

- **Sage** (#366748, wash #E8F0E7): done, paid, positive.
- **Amber** (#82560A, wash #F8EFD9): caution, taking longer than usual.
- **Crimson** (#B0233F, wash #FAE8EB): wrong, refused, destructive. 27 degrees of hue from clay (the old pair were 9): "do
  this" and "this is wrong" must never look alike.
- **Gold** (#D4A24A; ink #7A5B14; wash #F6EDD6): honours only (Q1, a badge, the spark in a
  celebration), and the college's own golden yellow.

### Night (dark theme)

A navy-black night, not a charcoal: **Night paper** (#1A1D27), **Night surface** (#222633),
**Night sunken** (#141720), **Night ink** (#EDE8DC), **Night clay** (#E88F6E). The primary button
inverts to a paper-coloured button with navy text. Illustrations sit on a light **mount**
(#EFE8DC) so cream-filled drawings read as prints, not as stickers.

### Contrast, measured

Computed with the WCAG formula from the token values (script kept in the art director's
scratch; re-run it when a token changes). "Ladder" is the worst case across the six surfaces from
Paper to Selected.

| Pair | Light | Night |
|---|---|---|
| Ink on the ladder | 11.9 | 9.4 |
| Ink muted on the ladder | 5.0 | 5.5 |
| Ink subtle on the ladder | 4.7 | 4.6 |
| Clay on the ladder | 4.6 | 4.7 |
| Navy on the ladder | 7.3 | 5.8 |
| Sage, amber, crimson on the ladder | 4.8, 4.6, 4.8 | 5.8, 6.5, 4.9 |
| Clay, sage, amber, crimson on their washes | 4.9, 5.3, 5.4, 5.6 | 5.3, 6.9, 7.4, 6.2 |
| Primary button text on its fill | 12.2 | 13.7 |
| Text on a clay fill (`accent-fg`) | 5.8 | 6.9 |
| Input boundary (`field`) on a field's surface | 3.2 | 3.2 |
| Chart inks on paper, lowest (gold) | 3.4 | 7.3 |

### Named Rules

**The One Voice Rule.** Clay is used on 10 per cent of a screen or less. Its rarity is the point:
a clay mark means "look here" or "you can act".

**The Two Reds Rule.** Clay and crimson are 27 degrees of hue apart in the palette, not 9. A
destructive action is crimson text on a quiet button; it is never clay and never a filled red.

**The Ink-On-Paper Rule.** Text is navy-black on warm paper. Never pure black, never pure
white, never a grey: secondary text is `ink-muted`, which is the ink thinned, not a different
colour.

**The Job Rule.** If you cannot say what a colour is *for* in this screen (act, record, done,
wrong, honour, caution), the element should be ink on paper.

## Typography

**Display and figures:** Brygada 1918 Variable, self-hosted (Latin, Latin extended, italic, and a
rupee subset). **Everything else:** Inter Variable, self-hosted, with a rupee subset.

**Character:** Brygada is a revival of a Polish book face: warm, slightly irregular, like type set
by hand, with an italic that has real calligraphic life. Against Inter's neutral precision it
gives the page one voice that is not a machine's. Chosen over Source Serif 4 (the previous
face: correct and anonymous), Literata (sturdy, reads as an e-reader), Libre Caslon (reads as a
university prospectus) and Young Serif (too heavy for a calm product). It carries ₹ in its Latin
extended range, so the subset works the same way as before.

### Hierarchy

- **Display XL** (450, clamp 36 to 60 px, 1.04, -0.022em): the answer sentence on Home and the
  sign-in headline. One per screen. Italic for a name or one emphasised phrase.
- **Display** (500, clamp 32 to 40 px, 1.1, -0.018em): the page title. The only thing on most
  pages in this face.
- **Figure** (500, 36 px, 1, tabular lining): the figures of the Answer strip and any number that
  is the answer. **Figure XL** (56 px) for a page's single hero number.
- **Lead** (Inter 400, 18 px, 1.65): the one sentence under a page title. 65 characters wide at
  most.
- **Title** (Inter 600, 16 px): a section heading.
- **Body** (Inter 400, 14 px, 1.5): everything you read. 15 px on phones (13 becomes 14, 12 becomes 12.5).
- **Label** (Inter 500, 13 px): a field label, a column head, a button.
- **Meta** (Inter 400, 12 px): dates, counts, claim numbers. Never below 12.

### Named Rules

**The Nothing-In-Between Rule.** There is no type size between 16 and 32 px. A step is either a
UI step or a display step; a 22 px heading is the lukewarm size that made every old page read
at one volume.

**The Figure Rule.** A number that is an answer is Figure (serif, tabular). A number in a list is
Inter tabular and right-aligned. A column of money never uses the display face.

**The No-Shout Rule.** No uppercase and no letter-spaced labels, anywhere. A heading is sentence
case; a column head is sentence case.

## Layout

A content column of 1100 px, centred, with 40 px gutters on desktop and 16 px on phones. A
256 px sidebar rail on sunken paper. Home and the desk queues use the whole column; reading
pages (policy, help, a long form) use a 44 rem measure inside it.

Rhythm is deliberately uneven: 8 px inside a group, 16 px between related groups, 40 px under the
page header, 56 px between sections. More space above a heading than below it. Spacing is a
4-point scale: 4, 8, 12, 16, 24, 40, 56, 72.

Responsive behaviour is structural, not shrinking: a table becomes stacked rows that keep their
labels; a filter bar becomes one search field and a "Filters" button; the thread becomes a
vertical list; the sidebar becomes a drawer opened from a header that says where you are. At
390 px nothing scrolls sideways and every control is at least 40 px.

## Elevation & Depth

Flat by default. Depth is a tone step (surface over paper, sunken under it), a hairline, or a
**mount** (an illustration's paper margin). The six elevation steps of the previous system
remain: `well`, `raise`, `lift`, `under`, `pop`, `modal`, and the rule remains that content
(cards, rows, panels) is never elevated. Menus, popovers, toasts and dialogs carry the only
shadows: `0 4px 20px -6px rgb(27 31 46 / 0.12)` for pop and `0 16px 40px -12px rgb(27 31 46 / 0.2)`
for modal, each with a 1 px hairline ring.

**The Mount Rule.** An illustration is never a bare floating sticker and never on a card. It sits
on a mount: a sand-coloured margin with a hairline, a 16 px radius, and a caption line beneath
in muted ink. In dark mode the mount stays light.

## Shapes

Soft but not round. Controls 10 px, panels 16 px, dialogs 20 px, chips and avatars full. No
square corners on anything you press. Hairlines are 1 px. Avatars are always circles except the
**portrait** variant (4:5, 12 px radius) used on profiles and person cards.

## Components

### Page header

Title in Display, one Lead line under it, one primary action at the right, breadcrumbs above on a
detail view. A picture (a mounted illustration) may sit at the right at 120 to 168 px on a Home view or a
hub, and nowhere else unless the view has no other plate (an empty state is a plate). No kicker or eyebrow above the title.

### Answer

An answer is either a **sentence** (Display XL, the page's answer in one or two short clauses,
with a live status chip allowed inside it) or **one to four figures** (Figure, label beneath,
each a link to the list behind it, a zero saying what it means). Never both on one view, never
more than four figures.

### The Thread

Five stations on a hairline: **Filed, Checked, Approved, Authorised, Paid.** Each station is a
dot with a count beneath in Figure; the station where *you* work is ringed in clay and labelled
"Your desk". The claims waiting at a station pile above it as small dots (up to ten; past that a
dot is a few claims and the caption says so); the ones past the service level are amber and sit
at the bottom. **Paid is history, not a queue:** it has no pile, does not set the scale, and its
dot is sage. On a
phone the thread stands up. For one claim the same drawing shows five dots with the first
`n` filled in navy and the current one ringed in clay. The thread draws itself once, left to
right, the first time it appears in a session.

### Buttons

- **Primary:** navy fill, paper text, 40 px (44 on phones), 10 px radius. One per view. Disabled is
  a flat hover-toned shape with muted text, never a washed-out navy.
- **Default:** surface with a hairline ring. **Quiet:** text only until hovered.
- **Danger:** crimson text on a quiet button; confirms with counts. Never filled.
- **Disabled:** 50 per cent and a visible reason in a title or helper line. Never the only cue
  that a form is incomplete.

### Fields and Select

44 px (48 on phones), surface fill, 1 px `field` ring, 10 px radius. Label above at 14 px,
helper below at 13 px in muted ink, error in crimson with an icon and a sentence. Focus is a 2 px
clay ring with a 2 px offset. A native select is a field with a chevron; no custom listbox unless
it searches.

### Table

Sentence-case heads at 13 px muted, no band; a hairline under the head and between rows; rows 52
px (44 dense), the whole row hovers to the hover tone; numbers right-aligned and tabular; the
money column is Medium weight; the head sticks with the `under` hairline once something scrolls
beneath it. On a phone each row is a block of labelled lines.

### Avatar and face stack

Circles at 24, 32, 40, 64 and 96 px with a 1 px inner ring. The fallback is initials in the
person's tone (never "?"), 12 px at least. A **face stack** overlaps up to four faces by 8 px
with "+n". A **portrait** (4:5) is for profiles and a person's card.

### Chip

24 px, pill, one tone: neutral, area, gold, caution, positive, critical, clay. Text 12 px medium.
A chip never repeats down a column of eight rows; say it once above the list.

### Dialog, sheet, menu, toast, tooltip

Dialog 20 px radius on a 45 per cent navy-ink scrim (no blur). A sheet comes from the right on a
desktop and from the bottom on a phone. Menus and toasts are the only shadows. A toast says what
changed in the verb of the button that caused it. After a decision (Clear, Approve, Authorise,
Pay) the confirmation is **the Stamp**.

### The Stamp

A rounded rectangle with a double hairline in clay, the verb in italic Brygada ("Approved") and the
date beneath in Inter, rotated by -3 degrees, multiplied into the paper. It lands in 360 ms:
scale 1.14 to 1, opacity 0 to 1, a 1 px blur to sharp. It appears once, in the confirmation toast beside its receipt in words (it stays 6 s), or in place
where a view wants it. With reduced motion it appears without movement.

### Empty, error and loading states

Empty: a large mounted illustration (not a thumbnail), a Display-sized sentence that says what
will be here, one Lead line on how it gets here, one action. Error: says what failed, that nothing
was lost, and Retry, inline at the region. Loading: skeletons of the real shape, only after
300 ms. Never a spinner on a page.

### Charts

Six inks in this order: navy ink (#34406A), clay (#B5603A), sage (#5B8A6F), gold (#A6801F),
slate (#4A7E92), plum (#7C5A86). At most four series; direct labels instead of a legend;
gridlines in the `line` tone; the zero line in `edge`; every colour also differs in lightness
or shape. The house chart is the **dot field**: one dot per paper, grouped and coloured, a unit
chart a person can count. A single series is navy ink; a range of one hue (a ramp) is sage.

### Iconography

Lucide, stroke 1.75 at 16 and 20 px, 1.5 at 32 px and above, one meaning per icon (the map in
docs/ux/00 §3 stands). No emoji. Where an illustration spot icon (`SpotIcon`) is used it takes the
colour of the text beside it.

### Illustration and photographs

- Illustrations are the 213 drawings in `public/illustrations/generated`. They are the art of the
  product. **Placement:** one mounted plate per view, 150 px in a page header on a Home view,
  240 to 360 px in an empty state, 560 px or more on sign-in. Never inside a table, never on a
  card, never two in one viewport, never below 96 px.
- Choose the drawing for the **role or the situation**, never one drawing for two roles.
- **Faces** are photographs of the real people, supplied by the server. A person is always a face
  plus a name. A drawn person is never used for a named person.
- Photographs get a 1 px inner ring and `object-fit: cover`; initials appear only when the photo
  is missing or fails to load.

### Motion

Tokens: 80 ms (a press), 140 ms (a state), 220 ms (a menu, a drawer), 360 ms (a stamp, a sheet),
640 ms (the thread draws). Ease-out expo `cubic-bezier(0.16, 1, 0.3, 1)`; exits are faster than
entrances. Nothing moves between pages. Hover is a tone change, never a lift. Under
`prefers-reduced-motion` movement is removed and state changes stay.

### Voice

Plain Indian English, sentence case, active verbs, the vocabulary of docs/ux/19. A button says what
happens ("Assign 3 claims"); the toast repeats the verb ("Assigned"). A zero says what it means
("Nothing waiting"). No em dash fragments, no exclamation marks, no "Oops".

## Do's and Don'ts

### Do

- **Do** put the answer first and make it the biggest thing on the page (Display XL sentence or
  Figure strip).
- **Do** show a face with every name and the real photo wherever the server has one.
- **Do** use the Thread wherever a claim's position is the answer.
- **Do** give every illustration a mount (a caption too once it is 240 px or more), and choose it
  for the role.
- **Do** keep clay for links, focus and "needs you"; navy for the one primary button.
- **Do** keep money columns right-aligned, tabular, Inter, in en-IN grouping.

### Don't

- **Don't** build a wall of equal cards, a four-tile metric row on every page, or a card inside a
  card.
- **Don't** use a colored side stripe on a card or alert, gradient text, glass, hard offset shadows,
  neon on dark, or emoji as icons.
- **Don't** put a kicker, eyebrow, section number or all-caps label above a heading.
- **Don't** use clay for a destructive action, or crimson for anything that is not wrong.
- **Don't** shrink an illustration into a corner thumbnail or reuse one drawing for two roles.
- **Don't** animate between pages, lift on hover, or add a second authored motion.
- **Don't** use the display face for a column of money or below 22 px.
- **Don't** invent a colour: new tokens are added to `styles.css` with a comment saying their job.
