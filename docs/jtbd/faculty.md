# Faculty: jobs to be done

Who: every teaching member of staff, and every officer (HOD, Principal, Director,
research cell) when filing their own papers. Faculty never see which desk holds
their paper, only the stage (Filed, Checked, Approved, Authorised, Paid).

Sharpened 2026-09-30 with a second round of research (sources at the end). The
first round fixed the outside rules; this one asks what an Indian engineering
teacher actually does with their publication record across a year.

## Outside rules that shape these jobs
- **Appraisal (API/PBAS).** Every teacher fills a yearly self-appraisal. Research
  counts under Category III: refereed journal papers, conference papers,
  books and projects, each with a points value the college or university sets.
  The form asks for authors in order, title, journal, ISSN, year, indexing,
  impact factor or quartile, and the teacher's role (principal or co-author).
- **CAS promotion (UGC 2018).** Promotion to Associate Professor and Professor
  needs a consolidated score (300 and 400 points from Categories II and III in
  the older tables) and a minimum number of papers in Scopus or Web of Science
  indexed journals. Papers count only if indexed, so "is this paper indexed, and
  in which quartile?" is a question the teacher asks before every claim and
  every appraisal.
- **NAAC, NBA and NIRF data.** The college reports "papers per teacher in the
  last five years" (NAAC 3.4.x) and citation counts from Scopus and Web of
  Science. The research office asks each teacher to confirm a list, usually
  in the same week as the appraisal, and needs every paper attributed to the
  right person with the college named in the affiliation.
- **PhD supervisor recognition (UGC).** An Assistant Professor needs a PhD,
  five years' experience and at least three papers in peer-reviewed journals.
  Associate Professors and Professors need five papers after the PhD.
- **Incentive schemes in colleges like this one.** The amount depends on
  Scopus quartile (a typical ladder runs from a few thousand rupees for Q4 to
  fifteen thousand for Q1). Claims must be made within a month or so of
  publication, with evidence of indexing, the paper's first page showing the
  college affiliation and, at many colleges, a countersignature from the
  head. Missing the window or a document is the commonest reason a claim is
  refused, so the teacher wants to be told what is still unclaimed.
- **Tracking output.** Teachers keep their record in three places at once:
  the Scopus author profile (a Scopus ID, sometimes two when the profile has
  split), ORCID, and a hand-kept list or CV. The recurring pain is the
  duplicate and the missing paper: a preprint and the published version both
  appear, or a conference paper is filed under a spelling of the name Scopus
  did not merge. They want to fix the record once and have every form read from it.
- **Tax.** An incentive payment is income. The teacher reports it for the
  financial year (April to March) it was paid in. Form 16 covers tax
  deducted, not the payment list.

## Jobs

| # | Job | Question they ask | Decision it drives | Artefact the app must give |
|---|-----|-------------------|--------------------|----------------------------|
| 1 | Get paid for my paper with the least effort | "Which of my papers can I still claim, and how much will I get?" | Whether to file now, and which paper first | Pull from Scopus as step 1. **My papers** opens with a sentence and figures: how many papers are ready to file, how many are on their way, how many paid. Each ready paper has one "File it" button. The estimate and the three filing conditions come with filing. |
| 2 | Know where my claim is and when the money comes | "Is it moving? Do I need to do anything?" | Whether to chase or fix a sent-back claim | A stage track (never the desk), days waiting, a "sent back to you" notice with the reason, a notification when it is paid. On **My papers** each row says its stage in words and how long. |
| 3 | Report money received | "How much did the college pay me in FY 2025-26?" | Income tax return, personal records | **Payment statement** by financial year: month, paper, amount, total (voucher only when the college recorded one). Prints to PDF and downloads as CSV (`/papers/statement`). |
| 4 | Show my record for appraisal and CAS promotion | "List my papers from 2021 to 2025 the way the PBAS form asks" | What goes into the appraisal or promotion file | **Publication list for appraisal**: authors in order (me in bold), title, venue, year, type, Scopus indexing, quartile, DOI, my role, citations, with a year range and journal-only filter. Prints to PDF and downloads as CSV (`/papers/appraisal`). A one-paragraph summary I can paste into the form. |
| 5 | Check eligibility for a step up (supervisor recognition, CAS) | "Do I have three (or five) journal papers? How many in Scopus, in Q1 or Q2?" | Whether to apply for supervisor recognition or promotion now | The appraisal list's count sentence and "Journal papers only" filter, with the tally (journals, first-author, Q1, Q2) read from the same record. |
| 6 | Keep my record right | "Is anything missing, wrong, or twice? Is my Scopus ID and ORCID on file?" | Whether to report a paper that is not mine, add an ID, or file the missing paper | **My papers** ("Not my paper", "Paste its DOI", "Pull from Scopus"), **Your profile** (Scopus ID request, ORCID, photo, research areas), and one paper count that agrees on Home, My papers, My research and the record page. |
| 7 | Find co-authors and venues | "Who in college works on my topic? Where do people like me publish?" | Whom to write to, where to submit | **My research** (past, present, future) with topics, who I write with, where I publish and ideas; Who to work with, Research scout, Discover, Messages. |
| 8 | Be recognised | "Does anyone see my work?" | Keep publishing, share results | Leaderboard, badges and celebrations, feed posts, public profile, **Your stats** (who looked, how far posts reached). |
| 9 | Stay on pace | "Am I on track this year? Do I owe the college papers (research faculty)?" | Whether to file or write more before the year ends | The "this year" line on **My research** (papers so far against last year), the research threshold sentence wherever money shows (`ui/research-threshold`). |

## What each owned view is for
- `/papers` My papers: jobs 1, 2, 6. The list of every paper, filed or not.
- `/papers/appraisal` List for appraisal: jobs 4, 5.
- `/papers/statement` Payment statement: job 3.
- `/research` My research: jobs 7, 9 (and pride in job 8).
- `/me` Your profile: job 6 (IDs, photo, areas) and account safety.
- `/faculty/me` Your full record: the one page that holds everything about me
  in the college's words (IDs, figures, claims, payments), the source the
  forms above read from.
- `/u/me/stats` Your stats: job 8.

## Sources
- [PBAS proforma for API score, Category III (RIT Goa)](https://ritgoa.ac.in/wp-content/uploads/2020/07/RIT_Format_API_Category_-III.pdf)
- [API under research and academic contribution (BIT Mesra)](https://bitmesra.ac.in/UploadedDocuments/pratyush_869/files/GUIDELINE%20FOR%20CALCULATEING%20ACADEMIC%20PERFORMANCE%20INDICATORS%20(API)%20UNDER%20CATEGORY%20%E2%80%93%20RESEARCH%20AND%20ACADEMIC%20CONTRRIBUTION.pdf)
- [PBAS as per AICTE 2012 norms (SMVDU)](https://smvdu.ac.in/wp-content/uploads/2023/06/24072018_pbas_as_per_aicte_2012_norms.pdf)
- [PBAS proforma for promotion (University of Kashmir)](https://uok.ac.in/pdf/UOK-PBAS%20Proforma.pdf)
- [UGC Regulations 2018, minimum qualifications and CAS (MANUU copy)](https://manuu.ac.in/Circular/UGC%20Regulations%202018%20%20Minimum%20qualification,%20CAS%20etc-57-111.pdf)
- [UGC eligibility to be a research supervisor (PhDTalks summary)](https://phdtalks.org/2023/03/ugc-eligibility-criteria-to-be-a-research-supervisor.html)
- [Faculty incentive for research publications (RNSIT policy)](https://www.rnsit.ac.in/wp-content/themes/rnsit/documents/policy-document-rnsit-publication-incentive.doc)
- [Research incentive scheme (KIET)](https://www.old.kiet.edu/incentive-for-researchers)
- [3.4.3 Number of research papers per teacher (NAAC, Sadakath College)](https://sadakath.ac.in/naac/criterion_iii/3.4.3_Number_research%20papers_per_teacher.pdf)
