# Faculty: jobs to be done

Who: every teaching member of staff, and every officer (HOD, Principal, Director,
research cell) when filing their own papers. Faculty never see which desk holds
their paper, only the stage (Filed, Checked, Approved, Authorised, Paid).

Outside rules that shape these jobs (retrieved 2026-09-28, see Sources):
- CAS promotion and appraisal count research under API/PBAS Category III. For
  promotion and recruitment, the UGC 2018 rules accept papers in Scopus or Web of
  Science indexed journals. Points depend on the author's role: first/principal and
  corresponding authors share a larger part than other co-authors. Colleges set
  their own point values.
- PhD supervisor recognition (UGC): an Assistant Professor needs a PhD, five years'
  experience and at least three papers in peer-reviewed journals. Associate
  Professors and Professors need five papers after the PhD.
- An incentive payment is income. The faculty member reports it for the financial
  year (April to March) it was paid in.

| # | Job | Question they ask | Decision it drives | Artefact the app must give |
|---|-----|-------------------|--------------------|----------------------------|
| 1 | Get paid for my paper with the least effort | "Which of my papers can I still claim, and how much will I get?" | Whether to file now, and which paper first | Pull from Scopus as step 1. Unfiled eligible papers listed on Home and My papers. Estimate shown before filing. The three filing conditions ticked every time. |
| 2 | Know where my claim is and when the money comes | "Is it moving? Do I need to do anything?" | Whether to chase or fix a sent-back claim | A stage track (never the desk), days waiting, a "sent back to you" notice with the reason, a notification when it is paid |
| 3 | Report money received | "How much did the college pay me in FY 2025-26?" | Income tax return, personal records | **Payment statement** by financial year: month, paper, voucher, amount, total. Prints to PDF and downloads as CSV (`/papers/statement`). |
| 4 | Show my record for appraisal and CAS promotion | "List my papers from 2021 to 2025 the way the PBAS form asks" | What goes into the appraisal or promotion file | **Publication list for appraisal**: authors in order (me in bold), title, venue, year, type, Scopus indexing, quartile, DOI, my role, citations, with a year range. Prints to PDF and downloads as CSV (`/papers/appraisal`). The CSV and BibTeX of My papers stay. |
| 5 | Check PhD supervisor eligibility | "Do I have three (or five) journal papers?" | Whether to apply for supervisor recognition | The appraisal list's "Journal papers only" filter and its count sentence |
| 6 | Find co-authors and venues | "Who in college works on my topic? Where do people like me publish?" | Whom to write to, where to submit | Who to work with, Research scout, Discover, Messages |
| 7 | Be recognised | "Does anyone see my work?" | Keep publishing, share results | Leaderboard, badges and celebrations, feed posts, profile |

## Sources
- [PBAS proforma for API score, Category III (RIT Goa)](https://ritgoa.ac.in/wp-content/uploads/2020/07/RIT_Format_API_Category_-III.pdf)
- [API under research and academic contribution (BIT Mesra)](https://bitmesra.ac.in/UploadedDocuments/pratyush_869/files/GUIDELINE%20FOR%20CALCULATEING%20ACADEMIC%20PERFORMANCE%20INDICATORS%20(API)%20UNDER%20CATEGORY%20%E2%80%93%20RESEARCH%20AND%20ACADEMIC%20CONTRRIBUTION.pdf)
- [PBAS as per AICTE 2012 norms (SMVDU)](https://smvdu.ac.in/wp-content/uploads/2023/06/24072018_pbas_as_per_aicte_2012_norms.pdf)
- [UGC Regulations 2018, minimum qualifications and CAS (MANUU copy)](https://manuu.ac.in/Circular/UGC%20Regulations%202018%20%20Minimum%20qualification,%20CAS%20etc-57-111.pdf)
- [UGC eligibility to be a research supervisor (PhDTalks summary)](https://phdtalks.org/2023/03/ugc-eligibility-criteria-to-be-a-research-supervisor.html)
