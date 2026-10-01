# 22 — Clarity audit: every view, every role, admin first (owner request 2026-09-30)

## What the owner asked for
"Audit every JTBD, every single button, every single divider, every single view
any user could possibly see, and drastically improve it one by one. Start with
admin. Every single view is messy, not navigable, not understandable. Simplicity
is key but we also want details. The base itself is wonky."

## The one rule: the answer first, the detail one step away
Every view answers one question for one person. The top of the view gives the
answer. The middle holds the work. Detail stays one click away and says where
it is. Nothing is hidden without a visible way in, and nothing is shown just
because the data exists.

## Page anatomy (every view, no exceptions)
1. **Title and one line saying what this view is for**, in the person's words
   (for example "Who can sign in, and what they can do"). At most one primary
   action sits top right.
2. **The answer:** 1–4 figures or one sentence that answers the view's
   question.
   - Each figure is a link to the list behind it.
   - A zero says what it means ("Nothing waiting").
3. **The work:** the list or form the person acts on, with the next action on
   every row.
4. **Detail on demand:** row open, "Show details", tabs, a side panel for
   reading (a full page for real work; see docs/ux/21).
5. **Below the fold only:** history, help and rarely used tools.

## Base rules (the "wonky base")
- **Tables:**
  - Every list with more than two attributes is a table with a heading on
    every column. Numbers are right-aligned with tabular figures.
  - A missing value reads "Not recorded" or "None"; it is never a blank cell,
    a lone dash or "- - -".
  - On phones a table becomes stacked rows that keep the labels.
- **Real counts:**
  - No "99+" on an office page: admins need the real number.
  - Counts are identical wherever the same thing is counted (one service
    computes them; the view never recounts).
- **Plain words:**
  - No internal codes or states on screen. That means no "Running", no raw
    enum values and no "ERP-RAW-3" without an explanation of what it is (a
    claim number imported from the old ERP must say so on hover or in a
    legend once per view).
  - Use the words in docs/ux/19-vocabulary.md only.
- **Dividers and containers:**
  - A hairline goes between rows of the same list. Space separates sections,
    not a rule and a card.
  - No card inside a card. At most two levels of container on any view.
  - One border radius for controls, one for panels.
- **Rows, numbers and status:**
  - Every row shows who (face), what, where it stands and how long, then its
    next action.
  - Numbers carry units (₹, days, papers).
  - Status is words plus colour, never colour alone.
- **Loading, empty and error:**
  - Skeletons appear only if the data takes more than 300 ms. An API call
    slower than 800 ms on the real local data is a bug to fix (index,
    select_related, cache), not a spinner to show.
  - An empty state says what would appear here and the one thing to do now.
  - An error names what failed and how to retry.
- **Buttons:**
  - The label says exactly what happens ("Assign 3 claims", "Retry job"), and
    the result toast uses the same verb.
  - A destructive button asks for confirmation and shows what will change,
    with counts and totals.
- **Navigation:**
  - Every view is reachable from the sidebar, a hub, or a link on a related
    view, and knows where it came from.
  - Breadcrumbs appear on detail views ("Admin / Imports / ERP workbook, 28
    Sep").
  - Ctrl-K finds every view by name and by job ("who changed", "backup").
- **Phones:** at 390 px there is no horizontal scroll, and tap targets are at
  least 40 px.
- **Faces:** a real photo wherever a person appears (docs/ux/17), never a
  hard-coded placeholder.

## Audit method (per view)
For each view a helper writes a short card in `docs/audit/<role>/<view>.md`:
1. **Who and why:** who opens it, the job they came to do, and how often.
2. **What it shows today:** a screenshot plus what is confusing, missing,
   wrong or slow. This covers every button, figure, divider and empty state,
   and it checks figures against the data.
3. **What changes:** the redesign in 3–8 bullets, including features added
   for the job.
4. **Evidence after:** screenshots at 1440 and 390, test names, and API timing.
Then the helper builds it and commits.

## The super admin's jobs (researched, then thought through for this college)
Research-administration roles centre on keeping the people, the records, the
money rules and the process right, and reporting on all of it. Admin
dashboards work when they show the few things that need action first and let
the admin drill down to detail (progressive disclosure). For this system the
super admin is hired to:

1. **Keep the chain moving:**
   - Every desk has a person: no claim stalls because nobody holds the
     Director or Finance role.
   - Nothing is stuck.
   - Faults are resolved.
2. **Keep the people right:**
   - accounts, roles and dual roles;
   - who has left;
   - research faculty (docs threshold work);
   - profile corrections;
   - author names matched to people;
   - duplicate accounts merged.
3. **Keep the record right:**
   - imports (ERP workbook, faculty list, past payments);
   - the monthly Scopus run;
   - reference data (quartiles, SNIP);
   - duplicates, data health and record quality;
   - claims imported from the old ERP with missing amounts or titles are
     found and fixed.
4. **Keep the money rules right:**
   - policy versions with a before/after preview;
   - budget;
   - the ledger agrees with paid claims (for example "paid with no ledger
     row").
5. **Keep it running and accountable:**
   - jobs;
   - backups and restore;
   - email delivery;
   - sign-in problems;
   - the audit log ("who changed this, when, from what to what").
6. **Answer any question fast:**
   - find any claim, person, paper or payment by number or name;
   - explain why a claim was paid what it was (the formula line by line);
   - view as any role.
7. **Set up each year:**
   - new faculty list, departments, roles, targets;
   - academic and financial year cutover;
   - a setup checklist that shows what is not done.

The admin's daily loop is: open Home, then "Is anything broken or stuck?",
then fix each item in at most two clicks, then done. Weekly: imports and the
monthly run. Yearly: policy, year setup and roles.

## Features to add for admin (build if missing)
- **Readiness checklist on Admin:**
  - every chain role has an active person;
  - a policy is in force;
  - the last backup is under 2 days old;
  - email is configured;
  - the worker is alive;
  - the Scopus key is set.
  Each item shows red or green and links to its fix.
- **Claim explainer:** on any claim, "Why this amount": the policy version,
  each formula term, the research threshold and the ledger rows.
- **Data-fix queue for old ERP imports:** claims that are paid with no
  amount, untitled, or have no quartile, with a fix form per row.
- **Change history on every record,** from the audit log, shown in plain words.
- **Global find** (Ctrl-K) by claim no., staff ID, Scopus ID, DOI and voucher
  no.

## Order of work
1. **The base** (one helper): the kit and shell rules above; tables, figures,
   states, breadcrumbs; and a route-wide check script.
2. **Admin** (two helpers):
   - A: Home, Admin hub, Track, Faculty, People/roster, Profile requests,
     Author matches.
   - B: Imports, Monthly runs, Reference, Record quality, Data health,
     Duplicates, Data, Jobs, Faults, Audit log, Institution, Policy, Budget,
     Ledger, Statements.
3. **Research cell and coordinator.**
4. **Principal.**
5. **Director and Finance.**
6. **HOD.**
7. **Faculty.**
8. **Shared and social pages** (search, profile, messages, discussions,
   calendar, leaderboard, notifications, settings, sign-in, errors).

Each helper owns its pages. Shared kit changes go through the base helper;
other helpers name them in their report as NEEDS.
