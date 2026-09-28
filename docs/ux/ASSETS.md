# Assets: sources and licences

## Illustrations: `frontend2/public/illustrations/`

All eight illustrations are **original drawings made for this app** in the "Convocation" house
style (see `00-design-language.md` §4). They are dedicated to the public domain under
**CC0 1.0**. No third-party artwork is included, so no attribution is required and there are no
redistribution limits.

| File | Used by (spec) | Plate / ground | Notes |
|---|---|---|---|
| `hero-landing.svg` | 01 sign-in panel | **navy** `--color-brand` only. It uses white/gold ink and is invisible on light grounds. | Portico + rising papers + constellation |
| `empty-papers.svg` | 03 My papers (no record yet) | record wash `#eef2fd` | |
| `empty-search.svg` | 02 Search (no results) | record wash | |
| `scopus-pull.svg` | 04 File a paper, Pull ChoiceTile (120px) | record wash | |
| `celebrate.svg` | 04 filing receipt, 01 Moments | honours wash `#fdf6e3` / cream | |
| `ideas.svg` | 06 Discover empty/feature, 05 Future section | research wash `#e8f6f4` | |
| `network-bridge.svg` | 08 Who to work with (empty), connection help | people wash `#fcefe9` | You → X → Y |
| `empty-messages.svg` | 10 Messages (no thread selected) | people wash | |

Rules for builders:

- Use the files as `<img src="/illustrations/…svg" alt="">` (decorative, with the heading
  carrying the meaning) on a `rounded-3xl` plate of the listed wash.
- In dark mode the plate stays a *light* wash. This is deliberate, because the inks are fixed
  colours. The exception is `hero-landing.svg`, which only ever sits on navy.
- Canvas is 320×200 with a ground line at y=176. New drawings must follow the same grid and the
  three-ink rule.

## Why not unDraw or other packs
unDraw was considered (the brief suggested it). Its licence (read 2026-09-24 at
https://undraw.co/license) allows free commercial use without attribution. However, it
forbids redistributing collections and "automated or manual downloading without consent". It
also restricts compiling assets to replicate a similar service.

Because of that clause, and because the house style needs one consistent hand across empty
states and the existing `ui/art.tsx` spot art, the set was drawn in-house instead. **Nothing
was downloaded.**

If more scenes are needed later, the options are:

- Draw them to the same rules. This is preferred.
- Use an explicitly CC0 set, recording the source URL, licence and date here. Examples are
  Open Doodles (CC0) and Open Peeps (CC0), but check their current licence pages at the time.

## Fonts
| Font | Package | Licence | Status |
|---|---|---|---|
| Inter Variable | `@fontsource-variable/inter` | OFL 1.1 | installed |
| Fraunces Variable | `@fontsource-variable/fraunces` | OFL 1.1 | **to install** (honour moments only, see §2) |

## Icons
Lucide (`lucide-react`, ISC licence) is already installed. Every icon named in the specs was
checked against the installed `lucide-react.d.ts` on 2026-09-24. Note: this version exports
`FilePlusCorner` (not `FilePlus2`), `CloudDownload` (not `DownloadCloud`), and has no `History`
icon.

## Brand
`frontend2/public/brand/emblem*.png` and `wordmark.png` are Saveetha Engineering College marks,
supplied by the college. They are not covered by this CC0 dedication.

<!-- generated-art:begin -->

## Generated illustrations: `frontend2/public/illustrations/generated/`

**Source:** ChatGPT image generation (Create image tool) on the project owner's ChatGPT account, requested by the owner. Original art, no third-party characters, logos or likenesses; raw downloads are kept outside the repo in `D:/Faculty Paper/data/generated/raw/`. Machine-readable list: `generated/manifest.json` (name, purpose, files, suggested page). Pipeline: `frontend2/scripts/process-generated-art.py`; registry: `frontend2/scripts/generated-art.json`.

**Shared style block** (prefixed to every prompt):

> Style: minimal editorial illustration, soft hand-drawn ink line with gentle flat colour fills, warm off-white paper background (#F5F0E8), limited warm palette — clay/terracotta accent (#C96A4A), muted sage (#8FA58A), soft ink navy (#2F3A5C), warm sand (#E8DCC8), charcoal lines (#2B2B2B); calm, optimistic, academic; plenty of negative space; no text, no letters, no numbers, no logos, no brand marks, no real people's likenesses; consistent line weight.

- *sheet variant:* Sheet variant: background perfectly flat and untextured so items can be cut out; 3 columns x 2 rows, each item centred in its cell with wide empty gaps, no borders or dividers; every item in the same style.
- *hero variant:* Format: wide 16:9 illustration, composition weighted to the right with calm empty space on the left for a headline or card, flat untextured background.

**Processing:**

- *sheet:* Split on the grid; background flood-filled from the border (pale low-chroma pixels only, so enclosed cream fills stay opaque); 5x5 darkest-neighbour colour on soft edges (no pale fringe in dark mode); cropped with 16px pad; PNG (quantised) + WebP at max 640px, both <=150 KB; SVG via vtracer (colour, spline, hard alpha) + svgo --multipass.
- *hero:* Background kept (flat ~#F3EEE6, matches the canvas); WebP + quantised PNG at max 1600px, both <=150 KB; no SVG (too detailed to trace well).

| Sheet | Date | Prompt (subject) | Assets |
|---|---|---|---|
| sheet01 (sheet) | 2026-09-28 | Subjects (empty states, each a small scene with one gentle focal object): (1) an open empty folder with one blank sheet drifting out — 'no papers yet'; (2) an empty review tray with a small tick and a cup of tea beside it — 'nothing to review'; (3) a single quiet speech bubble with a tiny leaf sprouting from it — 'no messages'; (4) a magnifying glass over an empty dotted area — 'no results'; (5) a blank desk calendar page with a small sun beside it — 'calendar empty'; (6) a paper airplane landed beside a dashed path that stops abruptly — 'page not found'. | `empty-no-papers`, `empty-nothing-to-review`, `empty-no-messages`, `empty-no-results`, `empty-calendar`, `not-found-404` |
| sheet02 (sheet) | 2026-09-28 | Subjects: (1) a hand-drawn index-card drawer with one card being lifted out and a small check — 'pick from an indexed database'; (2) a clipboard with a small chain-link symbol and a paper slip being pasted onto it — 'paste a DOI link'; (3) a fountain pen writing lines on a sheet with a small keyboard beside it — 'type details by hand'; (4) a simple three-step podium with a laurel wreath and a small star above — 'leaderboard and honours'; (5) an open notebook with a glowing lightbulb and small constellation dots rising from the pages — 'discover research ideas'; (6) two abstract figures (no faces) jointly placing puzzle pieces into a shared open book — 'collaboration'. | `file-from-index`, `file-paste-doi`, `file-by-hand`, `leaderboard-honours`, `discover-ideas`, `collaboration` |
| hero01 (hero) | 2026-09-28 | Format: wide 16:9 page-header illustration, composition weighted to the right with calm empty space on the left for a headline, flat untextured background. Subject: 'research scout' — a small friendly paper-kite drone (abstract, no face) gliding over a gentle landscape made of stacked journals and open books, a dotted flight path linking small glowing idea points and a telescope on a hill; conveys an assistant that scouts the literature and brings back promising leads. | `hero-research-scout` |
| hero02 (hero) | 2026-09-28 | Format: wide 16:9 hero illustration for a sign-in page, composition weighted to the right with calm empty space on the left for a sign-in card, flat untextured background. Subject: a quiet, welcoming college library reading-room at golden hour seen as a simple stylised scene — tall arched window with warm light, a long wooden table with an open journal, a desk lamp, a small potted plant and a neat stack of bound research volumes; a gentle sense of arriving at one's scholarly home. No people. *ChatGPT returned an A/B pair; both kept. More painterly/detailed than the line style.* | `hero-sign-in`, `hero-sign-in-alt` |
| sheet03 (sheet) | 2026-09-28 | Page-header spot illustrations, each a small still-life with one focal object: (1) a tidy faculty desk seen from the front — open journal, mug, small plant, desk lamp — 'faculty home'; (2) a small college building with a gentle bar-chart garden of growing plants in front — 'head of department overview'; (3) a calm control desk with a ledger, a ring of keys and a small bell — 'administration home'; (4) a magnifying glass resting on an open card-catalogue drawer — 'search'; (5) a neat stack of bound papers tied with a ribbon bookmark and a sprouting plant — 'my papers'; (6) a microscope beside an open notebook with a rising line graph — 'my research'. *Drifted more detailed/painterly than sheets 01-02 (same chat as the library hero); raster only (traces >80 KB).* | `spot-home-faculty`, `spot-home-hod`, `spot-home-admin`, `spot-search`, `spot-my-papers`, `spot-my-research` |
| sheet04 (sheet) | 2026-09-28 | Page-header spot illustrations, each a small still-life with one focal object: (1) two empty chairs pulled up to a small round table with one shared open notebook and two pens — 'who to work with'; (2) an identity card with an abstract faceless portrait silhouette and a small laurel sprig — 'profile'; (3) two overlapping speech bubbles beside a sealed envelope — 'messages'; (4) a round table seen from above with several small speech bubbles rising from it — 'discussions'; (5) a gallery wall of three simple frames holding a medal, a ribbon and a star — 'wall of fame'; (6) a wall calendar with one date circled and a small flag pin — 'calendar and deadlines'. | `spot-who-to-work-with`, `spot-profile`, `spot-messages`, `spot-discussions`, `spot-wall-of-fame`, `spot-calendar` |
| sheet05 (sheet) | 2026-09-28 | Keep each item simple and minimal — few details, clear dark outlines, flat fills, no shading, no gradients, no paper texture. Page-header spot illustrations, one focal object each: (1) a small desk bell with a tiny leaf and two soft chime lines — 'notifications'; (2) two interlocking gears with a small potted sprout between them — 'settings'; (3) a rubber stamp resting beside a document with a tick mark — 'clearing and approvals'; (4) an old brass key lying across a signed document with a wax seal — 'authorisations'; (5) a sealed envelope with a plain round coin and a folded receipt, no currency symbols — 'payouts and payments'; (6) a row of four simple abstract faceless figures of different heights in palette colours — 'people directory'. | `spot-notifications`, `spot-settings`, `spot-approvals`, `spot-authorisations`, `spot-payouts`, `spot-people` |
| sheet06 (sheet) | 2026-09-28 | Keep each item simple and minimal (same clause as sheet05). Page-header spot illustrations, one focal object each: (1) an open cardboard box with sheets of paper flowing into it along a curved arrow — 'imports'; (2) a small pennant flag planted on the corner of a document — 'flags and follow-ups'; (3) two stacked archive boxes with round pull-holes and a small plant — 'archive'; (4) a magnifying glass over an open ledger with a column of tick marks — 'audit trail'; (5) a clipboard holding a simple bar chart and a pie chart — 'reports'; (6) a rosette ribbon seal on a blank certificate scroll — 'accreditation'. | `spot-imports`, `spot-flags`, `spot-archive`, `spot-audit`, `spot-reports`, `spot-accreditation` |
| sheet07 (sheet) | 2026-09-28 | Keep each item simple and minimal (same clause as sheet05). Page-header and error spot illustrations, one focal object each: (1) a glass jar of plain round coins beside a simple pie chart card, no currency symbols — 'budget'; (2) an open rule book with a ribbon bookmark and a small balance scale — 'policy'; (3) an open toolbox with a checklist card and a pencil — 'setup'; (4) a padlock inside a leaf-shaped shield — 'privacy'; (5) a friendly unplugged power cable with its plug lying loose and a small spark, calm not alarming — 'server error'; (6) a small cloud with a dotted line to a laptop broken in the middle — 'offline'. | `spot-budget`, `spot-policy`, `spot-setup`, `spot-privacy`, `error-server`, `error-offline` |
| sheet08 (sheet) | 2026-09-28 | Empty-state spot illustrations, each a small quiet scene with one gentle focal object and lots of space: (1) a desk bell resting with a tiny 'z' breath curl and a leaf, calm — 'no notifications'; (2) an empty park bench under a small tree — 'no discussions yet'; (3) an empty wooden display shelf with one small star-shaped outline waiting — 'no badges yet'; (4) a single chair beside a small table with a second chair's dashed outline — 'no collaborators yet'; (5) a flagpole with the flag lowered and folded neatly at its base, sun behind — 'no flags, all clear'; (6) an empty open wooden crate with a single leaf inside — 'nothing imported yet'. | `empty-no-notifications`, `empty-no-discussions`, `empty-no-badges`, `empty-no-collaborators`, `empty-no-flags`, `empty-no-imports` |
| sheet09 (sheet) | 2026-09-28 | Empty and error-state spot illustrations, each a small quiet scene with one gentle focal object: (1) a blank notepad with a pencil resting diagonally across it — 'no drafts'; (2) a closed arched wooden door with a small padlock and a potted plant beside it — 'access restricted'; (3) an hourglass with the sand run out and a small moon — 'session expired, please sign in again'; (4) a sheet of paper with a folded corner and a small cloud with a gentle curved return arrow — 'upload failed, try again'; (5) an empty open envelope with nothing inside and a leaf — 'no payouts yet'; (6) an empty archive box with its lid leaning against it — 'archive empty'. | `empty-no-drafts`, `error-access-denied`, `error-session-expired`, `error-upload-failed`, `empty-no-payouts`, `empty-archive` |
| sheet10 (sheet) | 2026-09-28 | Onboarding / first-run illustrations, warm and encouraging, one focal object each: (1) an open arched doorway with warm light spilling out and a doormat with a leaf — 'welcome'; (2) a chain link joining a blank identity card to a closed book — 'link your author ID'; (3) a profile card with an abstract faceless silhouette and a short checklist being ticked by a pencil — 'complete your profile'; (4) a single sheet of paper with a small sprout growing from its top edge — 'file your first paper'; (5) a sealed envelope with two small hands reaching toward it from either side — 'invite a colleague'; (6) a small pennant flag on top of a gentle hill with a winding path leading up — 'you are all set'. | `onboard-welcome`, `onboard-link-author-id`, `onboard-complete-profile`, `onboard-first-paper`, `onboard-invite-colleague`, `onboard-all-set` |
| sheet11 (sheet) | 2026-09-28 | Milestone and celebration illustrations, joyful but calm, one focal object each with a few confetti dots and small sparkles in palette colours: (1) a single research paper lifted up with confetti around it — 'first publication'; (2) a tall neat stack of bound papers with a star on top — 'ten papers milestone'; (3) a journal with a gold ribbon rosette pinned to its cover — 'top-quartile journal'; (4) a large pair of quotation marks with sparkles and a small upward arrow — 'first citation'; (5) a trophy cup with a small college building engraved as a simple shape and laurel leaves — 'department in the top ten'; (6) a paper lantern gently rising with a few stars — 'anniversary and thank-you'. *Retrieved from the ChatGPT Library after the conversation failed to load.* | `celebrate-first-publication`, `celebrate-ten-papers`, `celebrate-top-quartile`, `celebrate-first-citation`, `celebrate-top-department`, `celebrate-anniversary` |

<!-- generated-art:end -->
