# The Principal: jobs to be done

Who: the Principal of Saveetha Engineering College. In the chain (docs/WORKFLOWS.md) she approves claims the research cell has cleared, before the Director authorises and Finance pays. She also answers upward for the college's research: to the governing council and trustees, to NAAC, NIRF and AICTE, and to the affiliating university. She files papers of her own, and someone else decides those.

The approval desk is covered elsewhere (/approvals, page queue #17). This document is about everything she has to **report**. Each job gives the question she asks, the decision she makes from the answer, and the artefact she hands on.

## Sources consulted (web search, 2026-09-28)
- NAAC affiliated-college manual, Criterion 3. Metric 3.3.1 is *number of research papers per teacher in UGC-CARE journals over the last five years*, scored 4 at 10 or more, 3 at 5 to 10, 2 at 3 to 5, 1 above 0 and under 3. Metric 3.3.2 covers books, chapters and conference papers per teacher. Institutional affiliation and links are required. (kwc.ac.in 3.3.2 SSR support PDF; psgtech.edu NAAC criteria 3; nmims.edu criterion-3.)
- NIRF Engineering, Research and Professional Practice (RP). PU = 35 × f(P/FRQ), where P is weighted publications and FRQ is the faculty requirement at 1:15 FSR. QP = 20 × f(CC/FRQ) + 20 × f(TOP25P/P). So NIRF wants papers **per faculty**, plus citations and top-quartile share. (nirfindia.org/Home/parameter; nirfindia.org/Docs/Engineering.pdf.)
- AICTE Approval Process Handbook 2024-27, and typical governing-body terms of reference. The governing body approves the annual budget and reviews academic performance. The institution publishes annual reports that include research publications. (aicte.gov.in approval process; amreddyengineering.ac.in governing body PDF.)

Existing code already records the NAAC 3.4.3 / NIRF column orders (backend/core/services/reporting_pack.py).

## Jobs

| # | Job | Question she asks | Decision she makes | Artefact she hands on |
|---|---|---|---|---|
| J1 | Report the year to the governing council / trustees | "Did we publish more than last year, per teacher? What did the incentive scheme cost, and against what budget?" | Keep, raise or cut next year's incentive budget; decide which departments to praise or question | A clean one-to-two page A4 PDF with the college header: headline sentence, year against last, five-year trend, department table |
| J2 | Hold departments to account | "Which departments carry research and which lag, **per teacher**, not by size? Who slipped since last year?" | Where to push HODs; targets for next year | The department ranking table from the same PDF and Excel, taken into the HODs' meeting |
| J3 | Budget vs spend | "How much of this financial year's allocation is gone, how much is committed, and what does a paper cost us?" | Whether to ask the trust for more money or slow approvals | The budget page, plus figures in the council PDF |
| J4 | NAAC SSR / AQAR, Criterion 3 | "What is our papers-per-teacher over five years (3.3.1), and can I give the IQAC the per-paper list (3.4.3 format)?" | Whether the metric is at risk; chase UGC-CARE checks | An Excel sheet in NAAC's layout: year-wise papers, teachers, ratio, and the paper list |
| J5 | NIRF data capture (RP) | "Publications per faculty, Q1/Q2 share, for the last three years" | What to push: quantity or quality | An Excel/CSV with year-wise counts and quartile split |
| J6 | AICTE / university annual return | "Total publications and faculty in the year" | None; it is a compliance return | The same Excel |
| J7 | Approve claims (desk) | "What's waiting, oldest first; is anything flagged?" | Approve, send back or hold | None (action in the app) |
| J8 | Look at integrity | "Any duplicate payments or contested flags?" | Escalate to the research cell | None |

**Principle for her screens:** answer first, one sentence. Then the evidence, comparable year on year and ranked per teacher. Then the download, which should be the artefact itself rather than raw rows.
