# Head of Department: jobs to be done

The HOD at an Indian engineering college is not a reviewer in the incentive
chain (Faculty -> Research cell -> Principal -> Director -> Finance). They are
held accountable for their department's research *output*, and they answer for
it upward (Principal, IQAC, NBA/NAAC visits) and downward (appraisal,
mentoring). They never see money, except on their own papers.

The owner's question (2026-09-30): "What is the actual job to be done by the
HOD?" Answer in three questions, asked every month: **Is my department on
track? Who needs a push? What do I tell the Principal?** Everything on an HOD
screen exists to answer one of them, in that order.

## Where the accountability comes from (sources checked, September 2026)

- **What a head does.** College role documents give the HOD the department's
  academic administration, its budget requirement to the Principal, reports
  for AICTE, DTE and the university, and research support: finding funded
  calls, keeping a record of faculty expertise, guiding proposals, and
  encouraging faculty to start internal projects that lead to external ones.
  ([Sanjivani COE roles and responsibilities](https://sanjivanicoe.org.in/images/Roles_and_Responsibilities.pdf),
  [IARE leadership and administrative duties](https://www.iare.ac.in/?q=pages%2Fleadership-and-administrative-duties))
- **NBA SAR 2025, Criterion 5 "Faculty Information and Contributions"** is
  still the heaviest single criterion (200 marks). It now weighs quality over
  count: SCI and Scopus-indexed journals over paid open access, credible
  citations over raw numbers, faculty retention and cadre ratio, and whether
  research feeds teaching. Guides advise HODs to freeze and verify the faculty
  list and data every quarter, not in submission week.
  ([NBA SAR 2025 format](https://www.nbaind.org/files/2-SAR-UG-EG-T2-14-1-2025_Format_20250115122255.pdf),
  [SAR 2025 guide](https://www.edhitch.com/nba-sar-2025-new-format-tier-1-tier-2.html),
  [Learnqoch](https://learnqoch.com/faculty-information-and-contributions-under-nba-accreditation/),
  [SAR preparation guide](https://bgcglobal.in/sar-preparation-guide-for-nba-accreditation/))
- **NAAC Criterion 3.3 / 3.4** counts research papers *per teacher* in
  UGC-CARE / Scopus journals over five years, graded in bands (0, >0-3, 3-5,
  5-10, >=10). The data template is one row per paper: title, authors,
  department, journal, year, ISSN, link to the paper (DOI), link to the
  journal. Rows without complete links are not considered.
  ([St Wilfred's 3.3.1](https://stwilfredscollege.com/newnaac/Criterion%203/3.3%20-%20Research%20Publication/3.3.1/3.3.1%20Research%20papers%20published.pdf),
  [KITSW 3.4.3 clarification](https://www.kitsw.ac.in/NAAC/Clarifications_of_Criterion/3.4.3/3.4.3(3)_No.of%20Research%20papers%20published%20in%20UGC%20care.pdf))
- **The academic-year rhythm.** The AQAR covers a July-to-June academic year
  and is built by the IQAC from data its criterion owners (department heads
  among them) log through the year, consolidated quarterly: gaps found after
  the second quarter still leave two quarters to correct. NIRF captures
  Scopus and Web of Science data itself in February and March and shows each
  institution its numbers in May.
  ([AQAR guidelines](https://www.iitms.co.in/blog/aqar-annual-quality-assurance-report-guidlines.html),
  [IQAC guide](https://www.edhitch.com/naac-iqac-internal-quality-assurance-cell-guide.html),
  [AQAR format 2026](https://www.edhitch.com/aqar-format-2026-sections-templates.html))
- **Faculty appraisal (UGC/AICTE PBAS, API Category III)** scores research
  papers per publication (UGC-listed refereed journals weigh more); the
  self-assessment must rest on verifiable records and is forwarded through the
  HOD. ([SMVDU PBAS, UGC 2016 amendment](https://smvdu.ac.in/wp-content/uploads/2023/06/24072018_pbas_as_per_ugc_regulations_2016_4th_amendment.pdf),
  [UGC regulations 2010](https://www.ugc.gov.in/oldpdf/regulations/revised_finalugcregulationfinal10.pdf))

Local practice at Saveetha (from the repo's workflow docs and the owner's
brief): department targets are set per year, the HOD reports at the monthly
department/Principal review, and the HOD pairs juniors with seniors to get
first papers out.

## The year an HOD lives in

| When | What the HOD does | What this app must have ready |
|------|-------------------|-------------------------------|
| Every month | Reports to the Principal: what did we publish, against target, who is behind | A one-page monthly note, printable, with the pace against the calendar |
| Every week | Talks to the two or three people who are behind; pairs a junior with a senior | A push list with a reason and a suggested next step per name, one click to remind or pair |
| Each quarter (Sep, Dec, Mar, Jun) | Freezes and checks the faculty list and the paper data for IQAC/NBA | Papers missing ISSN or DOI, faculty missing a Scopus ID, listed and fixable |
| Feb-Mar | NIRF and AQAR data pulls; papers must be on Scopus/WoS | The Scopus-indexed share, the papers not yet indexed |
| June-July | New academic year: set targets, confirm the faculty list | Targets per year and per person; the department roll |
| Appraisal season | Countersigns each person's PBAS research claims | A per-person list of papers, no money |

## What the data really is (found 2026-09-30, real copy)

The old HOD screens counted **claims for the incentive** (19 for ECE), so
"ECE published 19 papers, 1st of 16" sat beside the Principal's own page for the
same department showing 373 papers in 2025 and rank 4. Two rules follow, and
every HOD figure must obey them:

1. **A department's papers are the college's publication record** (the papers
   its people wrote, from OpenAlex, Scopus and the claims), counted by the one
   function the Principal's pages use, `college_totals.papers`. A claim is a
   request for money; it is not the paper. So the HOD's figure and the
   Principal's figure for the same department and year are the same number.
2. **Claims are a separate, smaller question** ("where are my department's
   claims?"), answered on Track, never used as output.

## The jobs

| # | Job | Question asked | Decision made | Artefact handed on |
|---|-----|----------------|---------------|--------------------|
| 1 | Keep the department on target | "Are we on track for this year's target, given where we are in the year and how many months are left?" | Push harder now, or not | One line for the Principal: "261 of 300 papers, 75% of the year gone (225 expected): ahead. 39 to go in 3 months." |
| 2 | Find who needs a push | "Who has no paper this year, or nothing in a good journal, or has never led one? Whom do I talk to this week?" | Whom to remind, pair or meet | A reminder sent; a name on the meeting agenda |
| 3 | Mentor juniors into publishing | "Who should write with whom?" (a quiet junior + an active senior in the same area) | Pair them | A pairing both see on their home screen |
| 4 | Report to the Principal (monthly review) | "What did we publish, how does it compare with the same date last year, where are we against target?" | None, it is an account | A one-page A4 note |
| 5 | Feed NBA Criterion 5 / NAAC 3.3 | "Is every paper on record with ISSN, DOI, year and author, and how many per teacher? Is every teacher's Scopus ID on file?" | Chase the missing fields each quarter | Excel in the NAAC template shape, per-faculty sheet for NBA |
| 6 | Forward appraisal (PBAS / API) | "Is what this person claims on record?" | Countersign or query | Per-person list of papers (no money) |
| 7 | Watch the department's claims | "Are my people's incentive claims stuck?" | Ask a colleague to add a missing proof; nothing else (HOD is not in the chain) | None |
| 8 | File and follow their own papers | "Where is my claim, and what will I be paid?" | As any claimant | Their own claim, with their own amount |

Rules that follow from the jobs:

- **Current year first.** Every job except NAAC is about *this* year. An
  all-years default hides that a department with a strong 2022 is silent now.
- **Pace, not just progress.** 30 of 60 in March is ahead; in November it is
  behind. Show the months left and what a month must now deliver.
- **Same date, last year.** With no target, the honest comparison is this year
  to today against last year to the same day, not against a whole year.
- **Only papers that count, count.** A claim the chain rejected outright does
  not make a paper unreal, but it is not a claim the department can quote.
- **Every number opens its list of names or papers.**
- **A push list is short and has a reason and a next step per name.** When 70
  of 73 people have nothing to their name, the list is the finding ("70 have
  no paper on record in 2026"): group, do not scroll seventy identical rows.
- **Names, with faces, next to every number** the HOD must act on.
- **No money** anywhere but the HOD's own papers; **the HOD never learns
  which desk holds a colleague's claim**, only "with the college", "approved",
  "paid" in words; **nobody acts on their own claim**.
