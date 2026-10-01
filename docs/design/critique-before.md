# Critique of the app before the art-direction pass

Method: impeccable's critique, run by hand. Two passes that did not see each other's output:
(A) a design review of the rendered views, and (B) measurements read from the live DOM. The
sub-agent and detector scripts were not run (the brief said not to run the launcher), so this is
a single-context critique and says so.

Evidence: 12 views, signed in as each role on a copy of `data/local-full.sqlite3` (8,466 papers,
real faces), at 1440 and 390 px, light and dark. The screenshots are in
`docs/design/shots/before/` (named `<view>-<width>-<scheme>.webp`). Measurements are in
"What the DOM says" below.

Scope: Faculty, the Research cell and coordinator (the research office), Admin, Principal and
Director. HOD and Finance share the same kit and show the same faults.

## Verdict in one paragraph

The app is already calm, warm and tidy, and the clarity audit (docs/ux/22) made it honest. What it
is not, yet, is *designed*: it has the grammar of claude.ai without its decisions. Every page is
the same four things (a 28 px serif title, a grey line, four equal figures, a list), so Home,
My papers, the desk queue and the Admin page cannot be told apart at thumbnail size. Nothing on
a page is bigger than anything else, colour carries no meaning beyond "clay", and the one thing
this product is about, a claim travelling a chain of desks until money is paid, appears nowhere
as a picture. The 213 generated illustrations are the best asset in the repository and they are
shown as 96 px clip-art in a corner. The single biggest opportunity: **one confident type scale, one
signature picture of the chain, and illustrations shown at the size of a picture.**

## What the DOM says

| Measure | Faculty Home | Desk queue | Admin Home | Principal Home | My papers |
|---|---|---|---|---|---|
| Page title | 28 px serif | 28 px serif | 28 px serif | 28 px serif | 28 px serif |
| Biggest figure | 28 px serif | none | 28 px serif | 28 px serif | 28 px serif |
| Text nodes at 13 px | 28 of 51 | 180 of 291 | 43 of 85 | 18 of 40 | 381 of 593 |
| Text nodes below 12 px | 0 | 7 | 0 | 0 | 90 (10 px) |
| Illustration shown | none | 96 px | 240 px | 240 px | 104 px |
| Faces on the page | 1 | 26 | 4 | 0 | 43 |

Reading it: the title and the answer figures are the same size, so there is no step above the
page title and no focal point. 13 px text is the dominant volume on every dense page, and the
90 nodes at 10 px on My papers are the initials fallbacks (below the 12 px floor).

## Design health (Nielsen, scored honestly)

| # | Heuristic | Score | Key issue |
|---|---|:-:|---|
| 1 | Visibility of system status | 3 | Stage words and days waiting are good. Approving a claim only toasts; nothing says "this is now done" in the place you did it. |
| 2 | Match with the real world | 3 | Plain Indian-English vocabulary (docs/ux/19). The office's real mental model, a file moving from desk to desk, is not drawn anywhere. |
| 3 | User control and freedom | 3 | Back, cancel and Undo exist. The mobile queue gives five filter fields before the first claim. |
| 4 | Consistency and standards | 3 | One kit, but figures are serif in the Answer strip and bold Inter on Reports; the same illustration stands for Admin and the Research cell. |
| 5 | Error prevention | 3 | Confirmations and counts on destructive actions. |
| 6 | Recognition over recall | 3 | Faces and labels everywhere except Principal and Director Home (no faces). |
| 7 | Flexibility and efficiency | 3 | j/k/x/Enter shortcuts and Ctrl-K are real. Not shown to a newcomer. |
| 8 | Aesthetic and minimalist design | 2 | Minimal, but flat: every region has the same weight, so nothing is chosen for you. |
| 9 | Error recovery | 3 | Errors name the problem and the retry. |
| 10 | Help and documentation | 3 | Help, guides, tour. |
| | **Total** | **29/40** | Good foundation, weak design. The low score is hierarchy, not function. |

## Ranked problems

### P1, fix in the foundation

**1. No focal point (typography and hierarchy).**
Title 28, figure 28, section title 16, body 14, dense 13. There is no size above 28, so the
page's answer, its name and its list compete at one volume. `docs/ux/22` asks for the answer
first; the answer is first in *position* but not in *weight*. Fix: a display scale with real
contrast (40 to 56 px serif) used decisively on the page title and on one answer sentence, a
UI scale that keeps 13 to 16 px, and nothing between 16 and 32.

**2. Every view is the same template (rhythm and composition).**
Title, grey line, four equal figures, list. The four-figure strip is the hero-metric template and
is used on Home, Discover, My papers, Research, Reports and every desk. Rhythm is one value:
about 40 px between everything. Fix: one answer, not four equal figures; a wider range between
tight groups and generous separations; a header that changes character on Home.

**3. The product's mechanism is not drawn (signature).**
A claim goes Filed, Checked, Approved, Authorised, Paid and the office's whole job is to move
claims along that chain. The faculty member sees a 4-step `ClaimTrack` at 12 px; the desk roles
see counts in prose. Nothing a thumbnail could identify as *this* product. Fix: one signature
element, a thread with stations, that is the picture of where claims are, for one claim and for
all of them.

**4. Colour does one thing (colour).**
Warm cream plus clay for everything: links, primary buttons, selected chips, the unread dot,
the "Urgent" tag, the error tone. Clay (#a84f31) and critical (#b23b2e) are 9 degrees of hue
apart, so "do this" and "this is wrong" look alike. The illustrations are drawn in navy, sage,
sand and clay, and only clay ever reaches the interface. Status is text only. Fix: let the
illustration inks be the palette (navy ink, sage, clay, gold), give each a job, and move critical
well away from clay.

**5. Illustrations are decoration, not artwork (illustration use).**
They are 96 to 104 px in a header corner (2 of every 3 pages), and the same drawing stands for
two different roles (the book and keys on both Admin and Research cell Home). The best piece,
the sign-in library, is shown as a 480 px thumbnail with a wasted half-empty panel beside it.
Fix: a plate treatment (a mounted picture with a caption line), larger, one per view, with
a specific drawing per role, and a big treatment on sign-in and empty states.

**6. Faces are inconsistent (people).**
Principal and Director Home show no person at all, although the first thing either does is
decide about a named colleague. The initials fallback is 10 px. Fix: avatars at four deliberate
sizes, a face stack, and a portrait variant for profiles, with a readable fallback.

**7. The desk queue is dense in the wrong places and impossible on a phone (density).**
At 1440 the queue is good but each row repeats a "No amount" chip and the monospaced claim
number is as loud as the person. At 390 the page opens with two paragraphs of introduction and five
filter fields (about 250 px) before claim one. The review workspace shows a 40 per cent blank pane when nothing is attached.
Fix: filters collapse to one line on phones; the person and the paper lead each row; repeated
chips become a single sentence above the list.

### P2, fix in the kit or the shell

**8. The shell is long and generic.** 256 px sidebar; a staff member sees 6 doors plus a folded
9 item "Research" group; the faculty sidebar has 12 items in four groups. Mobile header is a
bare "Publications". Fix: a calmer rail (paper, ink, a user card), clearer active state, the
college's emblem, a header that says where you are.

**9. Buttons all weigh the same.** Primary clay, outlined clay "Reject outright", outlined
neutral "Send back" and "Hold", plain "Flag". A disabled primary at 50 per cent reads as broken
(Institution, "Save changes"). Fix: one filled ink primary, a quiet default, a clear danger,
and a disabled state that says why.

**10. Forms are thin.** 36 px fields with an 8 px radius and no resting presence; labels 13 px; a
4-step wizard drawn at 12 px. The File a paper picker, with its three illustrated choices, is the
best form in the app and the exception. Fix: 44 px fields (48 on phones), 10 px radius, labels
at 14, helper text in place, a stepper with presence.

**11. Tables are correct and plain.** Sentence-case heads on a sunken band, 57 px rows, numbers
right-aligned. Missing: a sticky head with the one permitted shadow, a visual hold on the money
column, and a hover that shows the next action. Fix in `Table`.

**12. Charts are one area chart in clay.** Reports puts figures in bold Inter while Home puts the
same kind of figure in serif. There is no unit idiom: 145 papers could be 145 dots. Fix: a
palette of six distinguishable inks, direct labels, and a dot field as the house chart.

### P3, polish

**13. Motion is only a skeleton sweep.** No authored moment. A decision (Approve, Authorise,
Pay) is the one ritual in this product, and it ends in a toast. Fix: a single stamp moment.

**14. Settings and secondary pages.** Correct, quiet, nothing to remember. Settings would
benefit from the new field sizes and a calm two-column grid; no new idea needed.

**15. Dark mode is competent and flat.** Warm charcoal with cream plates behind the pictures
that look like stickers. Fix: a navy-black night, and plates that read as mounted prints.

**16. Sign-in.** Good words ("Your research, on the record."), small art, a half-empty left
panel. Fix: the library painting at full height, a very large headline, and the form on paper.

## What is working (keep)

- The answer-first anatomy of docs/ux/22 and the plain vocabulary of docs/ux/19.
- The hairline between rows instead of boxes; no card inside a card.
- Real faces from the server wherever a person appears in a list.
- The File a paper method picker (illustrated choices) as the model for a form.
- Ctrl-K, j/k/x queue keys, tabular numerals, the rupee subset fonts.
- Focus rings, 40 px tap targets on phones, reduced motion, contrast at AA.

## Persona red flags

- **Alex (the research office clerk clearing 14 claims a day).** The queue is keyboard-friendly,
  but the first thing on a phone is five filter fields and the loudest thing in each row is the
  claim number, not the decision.
- **Jordan (a first-time lecturer, on a phone).** Home is a list of text with no picture of
  where the money is; "File it" appears 3 times with the same weight and no estimate of the
  amount beside the button.
- **Sam (keyboard and screen reader).** Fine on structure; 10 px initials and 13 px muted text
  on the sunken sidebar are the weak spots.
- **The Principal (opens the app to decide a few claims, briefly).** Home opens on "0 waiting for your approval"
  and then three more blocks about the year. When there is nothing to do, the page should say
  so in one calm sentence and stop.

## Questions that decided the direction

- What if the page's answer were the biggest thing on it, and everything else were quiet?
- What if a claim's journey were a picture a person could point at?
- What if the illustrations were treated like the prints in a college library, mounted and
  captioned, instead of stickers?
