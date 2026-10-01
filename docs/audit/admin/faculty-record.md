# Audit: Faculty record

Route `/faculty/:id`. `frontend2/src/pages/faculty-record.tsx`.

## 1. Who and why
The office opens one person to answer "what do we hold on them?": identifiers, every paper and where its claim stands, claims, payments. A head opens their own department's; a faculty member opens their own.

## 2. What it showed before
Screenshot: `img/faculty-record-before-1440.png`.

| Element | Problem |
|---|---|
| Breadcrumb "Faculty / Faculty record" and a second "All faculty" link | Two ways back, and the trail did not name the person. |
| Five figures in a row (papers, citations, h-index, claims, incentives) | Not links; h-index and citations are one idea. |
| "Not claimed" on most papers | Reads like a fault; it means no claim has been filed. |
| "Paid ₹0" on papers the accounts sheet paid nothing | A paid claim of zero looks like a lost payment. |
| "Claimed or not" filter | Unclear. |
| Header: two buttons | "Edit account" (main) and "Public profile" (quiet); kept. |

## 3. What changes
- The trail reads "Faculty / a faculty member" (`useCrumbLabel`); the duplicate back link is gone.
- The figures become the page's answer strip (four, each a link to the tab behind it): papers on record, citations with the h-index, claims filed this year, incentives paid.
- "No claim filed" replaces "Not claimed"; a paid claim of nil says "No incentive payable" instead of "₹0"; the filter reads "With or without a claim".
- Tabs, identifiers and the missing-details callout are unchanged.

## 4. Evidence after
- Screenshots: `img/faculty-record-after-1440.png`, `img/faculty-record-after-390.png`.
- Tests: `frontend2/src/pages/faculty.test.tsx` (record tests still pass).
- API: `/api/directory/faculty/<id>` about 300 ms cold (unchanged).
