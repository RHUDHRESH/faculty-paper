# Principal: Build a report (/reports/build)

## 1. Who and why
The Principal (or the IQAC) when the year brief and the papers list do not cut the record the way a council member asked ("papers by quartile for CSE, 2023"). A few times a term; the output is an Excel, PDF or Word she can hand over.

## 2. What it showed today
Screenshot: `shots/build-before.png`.

- The headline was wrong: "By department, ECE leads with **1,744 of 95** publications." The bar counts came from the publication record (8,466 papers), the "95" from the claim search (the few months of claims). The same 95 sat under "Publications in scope" and ₹2,43,355 under "Paid and committed", against a table that said 8,466 papers and ₹2,65,57,834.73 paid.
- The Year line joined the running year (2026, months old) to the full years, so it ended in a fall that has not happened, and it drew "Not recorded" (papers with no year) as its last point.
- Clicking a bar opened a side sheet of claims (95 of them), not the papers the bar counted.
- Five equal download buttons ("Excel PDF Word JSON Print") under "Also download as".
- "Publications" for papers throughout; a bordered card (`rounded-xl`) around the steps.

## 3. What changes
- One source for everything: papers in scope come from the papers service, paid and awaiting payment from the ledger report. The headline now reads "ECE leads with 1,744 of 8,466 papers".
- "Papers in scope" and "Paid" replace the claim-based figures, and the paid hint says what is still awaiting payment.
- The year line leaves out papers with no year and says how many there are; a note says that the running year is a part year, not a fall.
- Year, department and quartile bars open the list of papers they count (/reports/papers). Other bars keep the claim sheet.
- One download button named for what it does ("Download as Excel"), the other formats quieter.
- "Papers" for papers, and the steps panel uses the panel radius.

## 4. Evidence after
- `shots/build-after-1440.png`, `shots/build-after-390.png`.
