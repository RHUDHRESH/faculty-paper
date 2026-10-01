# Base findings: page-level problems for the page helpers

Found while building the base (docs/ux/22, "1. The base"). The base does not
restyle pages; these are for whoever owns each page. Screenshots before and
after the base are in `D:\Faculty Paper\scratch\base\shots` (`before_*`,
`after_*`, at 1440 and 390 px).

The machine-checkable ones are in `frontend2/audit/clarity-baseline.json`. When
you fix a page, run `node audit/clarity.mjs --update` and commit the smaller
baseline.

## What the base now gives every page for free

- Breadcrumbs above any page inside a section ("Admin / Imports"), drawn by the
  shell from `app/crumbs.tsx`. To name the record on a detail page call
  `useCrumbLabel(name)`.
- No rule under `.page-head` / `PageHeader`; one hairline for list rows.
- `Table`: headings, "Not recorded" for blank cells (`null`, `""`, `"-"`, the
  em dash), right-aligned tabular numbers, stacked labelled rows under 640 px,
  optional sortable headings.
- Real counts (`formatCount`), no "99+" in the sidebar, the Admin hub or the bell.
- Skeletons invisible for 300 ms; `ErrorState` names what failed and always has
  "Try again".
- Two radii: `rounded-control` (8 px) and `rounded-panel` (12 px).
- Every fixed route is findable in Ctrl K by name and by job.

## Adopt (mechanical)

- **28 pages hand-build `<header className="page-head">` + `PageTitle`.** Move to
  `PageHeader` with `sub` (one sentence) and one `action`. Do not pass
  `breadcrumbs`; the shell draws them.
- **Hand-built `<table>` (19 files):** accreditation, approvals (2), author-matches,
  brief, budget (2), clearing (3), coordination-parts, data, department-glance,
  duplicates, leaderboard (2), ledger, my-record, payments (3), report-builder,
  reports, research, review-panel, statements. Use `Table` where the table is a
  plain list; otherwise add a `<thead>` and use `EmptyCell` for missing values.
- **`rounded-md` / `rounded-lg` on pages:** replace with `rounded-control` for
  anything you press or type into, `rounded-panel` for containers.
- **"Loading…" text or spinners without `Delayed`:** budget, discover, feed,
  ledger, notification-settings, people, person, profile, reference,
  report-builder, reports, statements, and `app/notifications`.

## Wrong today (in the baseline)

| Page | Problem | Fix |
| --- | --- | --- |
| Home (`home-staff.tsx`) | Every "things need attention" row ends in the word "Running" (a job state). | Say what is happening, or drop the label. |
| Batches, Jobs, Imports | "Running", "Running for 3 min", "Running, probably". | "In progress", or the plain action ("Importing 812 rows"). |
| Track (`track.tsx:560`) | Amount column is a blank cell for every imported ERP claim. Claim numbers read "ERP-RAW-3" with no explanation. | `EmptyCell` / "Not recorded"; a one-line legend "ERP-RAW-n = imported from the old ERP" once per view. |
| Author matches | Header row is a `<tr>` with no `<thead>`; last column heading is empty. | Add `<thead>`; name the column. |
| Audit log (`audit.tsx:528`) | Table column with `header: ""`. | Give it `label: "Open"` (the base now reads it aloud) or a real heading. |
| Approvals (`approvals.tsx:762`) | `<td>` prints a lone dash for a missing journal. | `EmptyCell`. |

## Confusing (not machine-checkable)

- **Admin hub, Faults row:** the badge says 167 and the line under it says
  "27 need attention now". Two numbers for one thing on one row. One service
  should count it and the hub should show one figure.
- **Admin hub, Author matches:** 2,841 is now shown in full (was "99+"). That
  number is a job for a queue with a sort, not a badge; say what the admin does
  with it.
- **Imports:** a two-paragraph intro with " — " fragments, then a panel of eight
  figures with a note about counts, then callouts inside panels (a card inside a
  card). The answer to "did my import land" is below the fold. Follow the
  anatomy: `Answer` (loaded / waiting / failed), then the three upload
  sections, then `Details` for column rules.
- **Faculty (`/faculty`):** a "What is missing" panel holds the filter chips
  and a list, then the table sits below: panel-in-panel on phones. Faces are
  initials for the 74 faculty without a photo (data, not a bug), but say so.
- **Ledger:** on a phone the first screen is a huge total and a chart; the
  list of payments is below three screens.
- **Track journey:** four stages with "0" and no zero meaning ("Nothing
  waiting").
- **Coordination** was in no sidebar door and no hub; the base added it to
  Track's "Also look at". Confirm that is where you want it.

## Tests

`src/app/nav.test.ts` had three failures before the base (the People door
was renamed Faculty; `/coordination` was unreachable). Fixed with the base.
