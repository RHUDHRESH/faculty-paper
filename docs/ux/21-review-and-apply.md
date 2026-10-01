# 21 — Apply and get paid; review properly (owner direction 2026-09-30)

"The JTBD is apply and get remuneration — so many people, many different
views: ease and understanding for the applicant, and ease for the reviewer.
The reviewer has to open the PDFs, mark things if needed, send back, check,
see all of it, process a whole bunch, see claim numbers and past cases, and
supervise and coordinate research. Right now it's a side-bar pop-up to view
the papers — this is injustice."

## The two jobs
1. **Applicant (faculty, and every officer filing their own paper):**
   - File a claim with the least effort.
   - Always understand where it is and what's needed from them.
   - Fix anything that comes back, exactly and quickly.
   - Know how much they'll be paid and when.
2. **Reviewer (research cell first, then Principal and Director on the same
   workspace with their own actions):**
   - Open every document properly, full screen, never in a side pop-up.
   - Compare the claim with the record and the PDFs.
   - Mark problems on the document and the checklist.
   - Send back with a precise reason built from those marks, or clear it.
   - Process a whole queue fast, see claim numbers and past cases, and
     supervise and coordinate the desk.

## A. The review workspace (replaces the side sheet)
- **Route and layout:** a full page at `/review/:claimId` (with
  `?queue=clearing|approvals|authorisations&filter=…` for context). It has
  three resizable areas, and it keeps the page on phones as stacked tabs:
  1. **Queue rail (left, collapsible):** the current queue with claim no.,
     claimant face and waiting days. j/k move through it and Enter opens.
  2. **Document viewer (centre, the largest area):** a real PDF viewer
     (pdfjs-dist). It has one tab per attachment (published paper, each SEC
     reference with its reference number) and supports:
     - page thumbnails, zoom, fit-width, rotate and full screen;
     - text search inside the PDF, with a "find affiliation" shortcut that
       searches "Saveetha Engineering College" and its variants;
     - download.
     Images get the same zoom and pan.
  3. **Review panel (right):**
     - claimant (face, department, links to profile and past cases);
     - the claim against the record (SNIP, quartile, author position,
       affiliation, DOI, ISSN, indexing), with differences highlighted;
     - the three confirmations with the time each was ticked;
     - a checklist in which each item can be marked OK, Issue or Needs info,
       with a note;
     - past cases (see C), flags and history.
- **Marks (see B):** select a region or a text span in the PDF and add a mark
  (Issue, OK or Note). Choose whether it is for the claimant or staff only,
  with the default set by kind. Marks are listed in the panel and jump to
  their page.
- **Decision bar (always visible):** Clear, Send back, Hold, Reject outright
  and Flag.
  - **Send back** pre-fills the reason from the open claimant-facing marks and
    checklist issues. The reason stays editable and is shown to the faculty
    member exactly as written.
  - **After any decision** the next claim in the queue opens, with an undo
    toast where the server allows it.
- **Rules kept:**
  - Nobody acts on their own claim: the decision bar is absent, with the
    reason why.
  - Director and Finance never see flags.
  - Faculty never learn which desk has the claim.
- **Performance:** the workspace loads the claim in one request, and the PDF
  streams page by page. It is keyboard first:
  - j/k: move through the queue;
  - c: clear;
  - s: send back;
  - h: hold;
  - m: add a mark;
  - [ ] : previous/next document.

## B. Marks (backend + shared component)
- A `ReviewMark` model:
  - claim; upload (nullable, for checklist-only marks); page; rect (x, y, w,
    h as fractions of the page) and/or quoted text;
  - kind (ISSUE, OK, NOTE) and audience (CLAIMANT, STAFF);
  - checklist key (affiliation, author_position, sec_refs, indexing,
    quartile, duplicate, other);
  - body; author; created_at; resolved_at and resolved_by;
  - resolved_in_resubmission (bool).
- **API:** list, create, update and resolve on a claim, with staff-only
  visibility enforced. Claimants see only CLAIMANT marks, and never the
  author's name: they see "the college".
- The send-back reason is composed from open CLAIMANT marks and failed
  checklist items.
- On resubmission, marks carry over and the reviewer sees them as "fixed?"
  to confirm.

## C. Queue, bulk, claim numbers, past cases
- **Queue pages** (clearing, approvals, authorisations): a dense table with
  claim no., claimant face, paper, journal and quartile, amount, waiting days
  and flags. Row click opens the workspace, never a side sheet.
- **Bulk actions:**
  - select many, or use "Ready to clear" (all checks pass and nothing is
    watch-listed), then act with a summary (count, total, exceptions);
  - bulk send back is not allowed (every send-back needs its own reason);
  - bulk hold is allowed.
- **Claim numbers everywhere:** search by claim no. from Ctrl-K, the queue and
  the archive; every screen shows the claim no., which can be copied.
- **Past cases** for the claimant, from `/api/claims/{id}/context`:
  - their previous claims with outcomes, amounts where the role may see money,
    and send-back reasons;
  - the same paper claimed by co-authors;
  - the same journal's history at the college;
  - any duplicate or ledger matches.

## D. Supervise and coordinate (research coordinator, research cell lead, super admin)
- **`/coordination`:**
  - workload per reviewer, and throughput per week;
  - ageing buckets and service-level breaches (e.g. more than 14 days);
  - where claims are stuck across desks (counts only, in line with the role
    rules);
  - assigning and reassigning claims to reviewers (an `assigned_to` field;
    assignees see "Assigned to me" first);
  - a monthly processing report.
- **Research coordination** (in the same area): research-faculty ticks and
  quotas, final-year project teams, and journal watch-list management.

## E. The applicant's side
- **A "My claims" tracker:**
  - every claim as a clear timeline, using faculty stages only (Submitted,
    Being checked, Approved for payment, Paid; plus Sent back and Not
    accepted);
  - days since filing;
  - the expected amount (an estimate until paid) and the month paid;
  - what's needed from you, in one sentence.
- **Sent back:**
  - a fix view that lists each claimant-facing mark;
  - where a mark sits on the PDF, the page is shown with the marked region;
  - a "Fix this" action per item (replace a file, correct a field or add a
    reference);
  - "Send again" once every item is addressed.
- **Filing ease:** the filing flow stays as is (Pull from Scopus first, the
  three conditions ticked every time). Add inline help for the conditions,
  and a pre-submit check that lists what the reviewer will look for, so fewer
  claims come back.
- **Money:** a link to the payment statement, and a plain sentence on when the
  next payout month is.

## Build order (Sonnet builders, parallel)
1. The workspace shell and PDF viewer (A), consuming B's marks component
   through the contract below.
2. Marks: backend and a shared `src/ui/review-marks.tsx` (B).
3. Queue pages, bulk, claim-no. search and the past-cases endpoint and
   component `src/ui/past-cases.tsx` (C).
4. Coordination (D).
5. The applicant's side (E).
Principal and Director variants of the workspace follow once A lands.

### Contract between 1, 2 and 3
- `src/ui/review-marks.tsx` exports:
  - `<MarkList claimId>`;
  - `<MarkLayer claimId uploadId page scale>`, an overlay the PDF viewer
    renders over each page;
  - `useMarks(claimId)`;
  - `composeSendBackReason(marks, checklist)`.
- `src/ui/past-cases.tsx` exports `<PastCases claimId role>`.
- The workspace (1) owns `src/pages/review/*` and the route. The queue pages
  (3) own `clearing.tsx`, `approvals.tsx` and `authorisations.tsx` and link
  to `/review/:id`. Until 2 and 3 land, 1 uses stubs with the same exports.
