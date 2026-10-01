# The Principal: jobs to be done

Who: the Principal of Saveetha Engineering College. In the chain (docs/WORKFLOWS.md) she approves claims the research cell has cleared, before the Director authorises and Finance pays. She also answers upward for the college's research: to the governing council and trustees, to NAAC (through the IQAC), NIRF and AICTE, and to the affiliating university. She files papers of her own, and someone else decides those.

The approval desk is covered elsewhere (/approvals). This document is about everything she has to **report**. Each job gives the question she asks, the decision she makes from the answer, and the artefact she hands on.

## Sources consulted (web search, 2026-09-28 and 2026-09-30)
- NAAC affiliated-college manual, Criterion 3. Metric 3.3.1 is *research papers per teacher in UGC-CARE-listed journals over the last five years*: scored 4 at 10 or more, 3 at 5 to 10, 2 at 3 to 5, 1 above 0 and under 3, 0 for none. Only papers with the institution's affiliation and inside the assessment years count. Entries without a working link to the paper and the journal page are not counted. Metric 3.3.2 covers books, chapters and conference papers per teacher. (kwc.ac.in 3.3.2 SSR support PDF; titsbhiwani.ac.in criterion 3.3; stwilfredscollege.com 3.3.1.)
- NIRF Engineering, Research and Professional Practice (RP = PU 35 + QP 35 + IPR 15 + FPPP 15). PU is publications per faculty; QP is citations per faculty and the share in the top 25 percentile. NIRF reads **Scopus and Web of Science only**, captures them itself in Feb to Mar and shows each institution its numbers in May, and since 2025 takes marks off for retracted papers and self-citation. So her own list matters for checking, not for submission. (nirfindia.org parameters; IR2025 report; studiumtech.in and vajiramandravi.com summaries.)
- AICTE approval handbook and governing-body terms of reference: the body approves the budget and reviews academic performance; the IQAC's yearly AQAR goes to it, and incentive schemes for papers, books and patents are reviewed there. (aicte.gov.in; hitam.org and karpagam AQAR PDFs.)

Existing code already records the NAAC 3.4.3 / NIRF column orders (backend/core/services/reporting_pack.py).

## The questions she actually asks
She does not ask for "reports". She asks these, in about this order of how often:

| # | Her question | Decision | What she hands on |
|---|---|---|---|
| Q1 | **Are we better than last year, and where?** Papers, papers per teacher, Q1/Q2 share, against last year. | Praise or question; raise or hold next year's budget. | The year brief (A4 PDF with college header, one to two pages). |
| Q2 | **Which departments need a push?** Per teacher, not by size; who slipped; who has no papers. | Which HODs to call; what to set as the target. | The department table, taken into the HODs' meeting. |
| Q3 | **What goes in the council pack, and is it ready?** | Whether anything is missing (a budget not set, papers with no department) before the meeting. | The pack: brief PDF, department table, budget position, NAAC sheet. |
| Q4 | **Where do we stand for NAAC 3.3.1 and NIRF, and what would weaken it?** Five-year papers per teacher, UGC-CARE not yet checked, records missing an ISSN or link, retractions. | Whom to chase in the research cell before the IQAC submits. | Excel in NAAC's layout: year-wise papers, teachers, ratio, and the paper list. |
| Q5 | **What did the scheme cost, against the budget, and what did it buy?** Paid, committed, left, ₹ per paper. | Ask the trust for more, or slow approvals. | The budget position in the pack. |
| Q6 | **Can I trust this figure?** Every number opens the papers behind it. | Whether to quote it. | None. |
| Q7 | Approve claims (desk) and integrity flags. | Approve, send back or hold. | None (action in the app). |

**Principle for her screens:** the question in her words, the answer in one sentence, then the evidence (this year against last, ranked per teacher), then the list behind each figure. A download is the document itself, not raw rows.

## Data caveats she should never have to discover
- Teachers are today's roll; no headcount history is stored. Earlier years are divided by today's roll and the page says so.
- Some papers have no department; the count is shown beside the department table, not hidden.
- NAAC counts UGC-CARE only, NIRF counts Scopus and Web of Science only. The college record counts everything, so its figure is an upper bound until each list is applied.
- A year still running is labelled "to date" and is never compared with a full year.
