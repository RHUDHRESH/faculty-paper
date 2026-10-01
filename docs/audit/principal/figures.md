# Principal: Analysis page (/reports, "Analysis" in the sidebar)

## 1. Who and why
Whoever is asked something the year brief does not answer: "how much did we pay for journals in Q1 in 2024?", "what is ECE's output by month?". The Principal opens it a few times a term, the research cell and Finance far more. It is the office's page that the Principal also has; her first stop is the year brief.

## 2. What it showed today
Screenshot: `shots/reports-before.png` (6,698 px tall).

- Title "Reports" while the hub and the sidebar call it "Analysis". A reader who had just clicked "Analysis" landed on "Reports".
- Six parts in one column with no way to jump: paid by month, where it comes from, which way it is going, what we research, who is publishing, what is waiting. A Principal looking for departments scrolled past a 50-month chart.
- "Where it comes from: By department" ranks by raw count, so ECE (72 teachers) always leads. Nothing said this ranks size, not effort.
- The "Also download as Excel / CSV" promised the report on the page. The files are one row per claim (the 95 claims), not the 8,466 papers on the page.
- "8,466 publications on record", a paper elsewhere. A note ("2,37,690 in 80 payments has no month recorded") printed on top of the chart title (a negative margin overlapped them).
- Paid shown to the paisa (₹2,65,57,834.73).
- A long lower half about the office (Who is publishing, What is waiting) that she does not need to report.

## 3. What changes
- Title "Analysis" with one line saying what it is for and pointing to the year brief for the council's questions; one primary action "Download the claims as Excel", which says what the file holds.
- "On this page" jump links to each of the five parts.
- The department bars carry a sentence: "This ranks departments by how many papers they have, so a large one leads. To compare them fairly, see papers per teacher", linking to /reports/departments.
- "papers" throughout, rupees without paise, and the overlapping note fixed.
- Everything else (drill-down sheet, filters, charts) is unchanged, so the research cell and Finance lose nothing. Tests: `reports.test.tsx` (18 pass).

## 4. Evidence after
- `shots/analysis-after-1440.png`, `shots/analysis-after-390.png`.
- Not done: the lower half (who is publishing, what is waiting) is still on the page for every role. It answers the office's questions; a role-aware trim needs the research cell's say.
