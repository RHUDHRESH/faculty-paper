# 03 · My papers: the full publication record

Area: **record** (navy). Route: `/papers` (`pages/papers.tsx`). Paper detail stays at
`/papers/:id`.

## Purpose
Show **every paper the person has actually published**, not only the ones they claimed. The
record comes from the Publication/Authorship tables that the data agent is building from
OpenAlex, the ERP workbook and the Scopus profile. Claims are a *state of a paper*, not the list
itself.

## What the walk found
- The page is headed "Your papers — Every paper you have filed". It is a claims table with 8
  stage tabs, most of them at 0.
- Unfiled papers are invisible. So are co-author context, citations and quartile at a glance.

## User jobs
| # | Job |
|---|---|
| J1 | See my whole record, newest first, and trust it's complete |
| J2 | Find papers I haven't claimed and file them in one click |
| J3 | Track claims in progress (stage, days waiting) |
| J4 | Fix my record: "this isn't mine" / "a paper is missing" |
| J5 | Export (CSV, BibTeX) for appraisal / NAAC |

## IA
```
DESKTOP
┌ HeroBand area=record ────────────────────────────────────────────────────────────────┐
│ My papers                                                   [Pull from Scopus ↻]      │
│ 20 papers on your record · 46 citations · since 2019        [＋ File a paper]          │
│ RecordStrip (compact, 1 row per year)                                                  │
│ Sources: ● Scopus 18  ● OpenAlex 20  ● ERP 12   · last matched 2 days ago  [What's this?]│
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ Segmented: [All 20] [Not claimed 10 ●gold] [In progress 2] [Paid 8] [Not eligible 0] ┐
│ Filters: Year ▾  Quartile ▾  Type (journal/conf) ▾  Role (first/co) ▾   ⌕ in my papers │
│ View: [Cards ▦] [Table ☰]                 Export ▾ (CSV · BibTeX · NAAC format)         │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ 2026 ───────────────────────────────────────── 3 papers                                │
│ ┌ PaperCard ─────────────────────────────────────────────────────────────────────────┐ │
│ │ 📄 Enhanced Machine Learning Framework for English Speaking Assessment…            │ │
│ │ IEEE Digital Explore · 2026 · [Q—] · author 2 of 6 · ❝ 3                           │ │
│ │ With: Dr A (Saveetha) · Dr B (Saveetha) · +3 external                              │ │
│ │ ▰▰▱▱ Under review · 68 days            [View claim]                                │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ PaperCard (unclaimed) ─ gold left rule ────────────────────────────────────────────┐ │
│ │ 📄 Generative AI for Real-Time Emotion…  · ICECA 2025 · author 3 of 6               │ │
│ │ Not claimed yet · eligible ✓                     [FilePlusCorner  File it]  [⋯]         │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ 2025 ─── …                                                                             │
└───────────────────────────────────────────────────────────────────────────────────────┘
⋯ menu: Not my paper · Duplicate of… · Copy DOI · Open on Scopus/OpenAlex

Table view = dense rows: Title | Venue | Year | Q | Pos | Cites | Claim state | Amount (only in Paid) 

PHONE: hero compact (count + strip), segmented control scrolls, cards only (no table),
sticky bottom [＋ File a paper].
```

## Interactions
- **Year grouping** has sticky year headers.
- The **"Not claimed"** tab carries a gold count dot while the count is above 0.
- **File it** navigates to `/papers/new?publication={id}`. The wizard skips method choice and
  lands on the conditions step with the paper shown.
- **Pull from Scopus ↻** POSTs `/api/me/scopus-pull` and shows a toast: "Checking Scopus for
  new papers… Found 2 new papers." New cards get a "New" chip for the session.
- **Not my paper** opens a dialog with a reason and POSTs a correction. The card fades to 40%
  with the line "Hidden — reported as not yours [Undo]".
- A **missing paper** is handled by the link under the list: "A paper is missing? [Paste its
  DOI]". This opens the File a paper DOI path, which also adds the paper to the record.
- A **stage chip** click opens the claim detail (`/papers/:claimId`).
- **Cards vs table:** the view choice is stored in localStorage.
- **URL state:** `?tab=&year=&q=`.

## Copy
- Hero sentence: "{n} papers on your record · {c} citations · since {firstYear}"
- Sources help ("What's this?"): "We build your record from Scopus, OpenAlex and the college's
  ERP. A paper appears once any one of them lists you as an author. If something is wrong,
  report it on the paper."
- Empty (no record matched yet), using `empty-papers.svg`: **"Your record will build itself"**,
  then "Once we match you to your Scopus profile, every paper you've published appears here —
  you won't have to type them in." Actions: [Connect my Scopus profile] (→ profile edit) and
  [Paste a DOI instead].
- Not claimed tab, empty: "Every paper on your record is claimed. ✓"
- Error: "Could not load your papers. The server did not answer. Nothing has been lost. [Try
  again]"

## Data
- Planned endpoint `/api/me/publications?year=&claim_state=`:
  ```json
  [{ "id","title","doi","venue":{"id","name","type","quartile"},"year","month",
     "authors":[{"name","person_id|null","saveetha":true,"position":2}],
     "my_position":2,"author_count":6,"citations":3,
     "sources":["scopus","openalex","erp"],
     "claim": null | {"id","stage","days_waiting","amount|null"},
     "eligible": true, "ineligible_reason": null }]
  ```
- Planned endpoint `/api/me/scopus-pull` (POST) returns `{job_id}`. Poll it through
  `/api/admin/jobs/{id}`, or add **NEW `/api/me/jobs/{id}`** for faculty use.
- **NEW: `POST /api/me/publications/{id}/dispute`** with body
  `{reason:"not_mine|duplicate", duplicate_of?}`.
- Existing endpoints: `/api/claims`, `/api/claims/counts`, and `/api/hod/export`-style CSV for
  export. **NEW `/api/me/publications/export?format=csv|bibtex`**.

## Acceptance
- [ ] The list comes from `/api/me/publications`. Papers without claims appear.
- [ ] The Not-claimed count matches Home's "unclaimed".
- [ ] File it opens the wizard with the paper preselected. Once filed, the card shows its stage.
- [ ] Pull from Scopus gives progress and the result in a toast. New papers are marked.
- [ ] Not my paper can be undone within the session.
- [ ] Cards and table both work. The table has no horizontal page scroll (its own scroller).
- [ ] Money appears only in the Paid tab and on the claim.
