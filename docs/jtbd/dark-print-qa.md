# Dark mode and print QA (2026-09-29)

Scratch copy of `local-full.sqlite3`, API :8121, Vite :5121, one Chromium.

## Dark mode

`frontend2/e2e/shots-dark.mjs`: every sidebar route for all 8 roles, at 1280 and 390 px, with
`theme=dark`. Each screen is screenshotted, then axe `color-contrast` runs on it.

- 388 screens. After the fix below, axe found 0 colour-contrast failures.
- Found and fixed: the Home "Waiting" ageing chips with a count of 0 used `opacity-60`, which gave
  2.98:1 in dark (5 hits). They now use `text-fg-subtle` with no opacity.
- Hard-coded colours: the two illustration plates (`#f5f0e8` and `#EFE8DC`) are now one token,
  `--color-plate` / `bg-plate`. Kept on purpose:
  - the gold, silver and bronze leaderboard plinths, which set their own text colour
  - the journal-cover quartile colours (SVG covers)
  - the white plate behind the sign-in logo (the logo art is on white)
  - the quick guide's `text-black`, which only shows in print
- Known limitation: the e2e accounts have not dismissed the first-sign-in welcome, so it covers
  the middle of most screens. axe still checks the page under it, but whatever the dialog hides
  was only looked at on screens where it was out of the way.

## Print

`frontend2/e2e/print-pdfs.mjs` opens each page in dark mode, fires `beforeprint`, then prints it
to PDF. The first page of each is in `docs/jtbd/shots/print/`, plus pages 2 and 3 where the
document runs that long.

| Document | Route | Pages | Paper |
|---|---|---|---|
| Year brief | /reports/brief | 3 | A4 |
| HOD report | /reports | 4 | A4 |
| Report builder | /reports/build | 1 | A4 |
| Appraisal list | /papers/appraisal | 1 | A4 |
| Payment statement | /papers/statement | 1 | A4 |
| Monthly statement | /statements | 9 | A4 |
| Payments register | /payments/done | 10 | A4 |
| Quick guide | /help | 1 | A4 |
| Leaderboard | /leaderboard | 6 | A4 landscape (on purpose) |
| Paper receipt | /papers/:id | 3 | A4 |

Fixed:

- **Dark ink on paper.** A dark-mode user printed light text on dark panels. `index.html` now
  switches to the light theme on `beforeprint` and restores the user's theme on `afterprint`. In
  print, the page and panel tokens are also forced to white.
- **Welcome dialog on paper.** The welcome dialog and its grey backdrop printed over the
  document. `ui/dialog.tsx` is now `print:hidden`.
- **Blank quick guide.** The quick guide printed with empty steps. The list stagger animation
  starts when the print-only block appears, and the PDF caught its first frame (opacity 0). All
  animations and transitions are now off in print.
- **Page numbers.** Every sheet now has "Page n of m" through a global `@page` A4 rule with
  14 mm margins.
- **Rows and headings.** Table headers repeat on each page. `tr`, `li` and figures do not split
  across pages, and headings do not break away from what follows. Scroll containers no longer
  clip.
- **College header.** The payments register, monthly statement and paper receipt now carry
  `PrintStamp`. The leaderboard's hard-coded "Saveetha Engineering College" line is replaced by
  `PrintStamp`, its hero band is hidden in print, and its landscape `@page` is no longer
  overridden by the stamp.
- **Screen controls.** The back link on the receipt and the month picker and buttons on the
  statement are hidden in print.

Open:

- The appraisal list header reads "Publication list of E2E Faculty · 0". The scope shows a bare
  count when the record is empty.
- The monthly statement also has a server-generated PDF ("Statement to sign"). That PDF was not
  checked here.
- Black-and-white: the text is black or dark grey. Chart bars are terracotta and print as
  mid-grey, which stays readable.
