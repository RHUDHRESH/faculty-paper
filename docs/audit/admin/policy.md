# Policy (`/policy`)

## Who and why
Finance and the super admin publish; the research cell, the Principal and others read. Yearly, and whenever the council changes a rate: "What does a paper pay now? If I change a rate, whose unpaid claims change and by how much?"

## What it showed before
![before](shots/policy-before-1440.png)

- The top said "Active policy: Policy v1 v1" (name and version said twice) and "No start date recorded", which reads as a fault.
- A red "This field does not parse" box in Author points, when the real cause was that no policy version has been published yet (the calculator uses built-in shares). It told the admin the college's calculations were broken when they were not.
- The answer to "what does a paper pay?" was the worked example, and the four rates most people ask about were a scroll away in eight sections of rows. A rule above and below every list.
- "History" was a link to the audit log with the filter typed into the URL, and the log showed the change as `{"version": 2, "name": "Policy v2"}`: no rate, no before or after.
- The publish confirmation already showed a before/after for unpaid claims (the totals and a list of claims). It did not say in a sentence what was being changed, and it used " — ".
- The live example said "Priced by the server against Policy v1 v1 — the policy that is live right now".

## What changed
- One line saying what the page is for and the one primary action ("Publish a new version").
- **The answer:** the version in force (v1), the rate per SNIP point (₹55,000), the Q1 bonus (₹50,000), and the second-signature threshold (or "Off"), plus one line: the policy name, and "In effect from 1 Jan 2026" or "In force now".
- Rows keep one hairline between them and no rule around a list.
- **Before/after in words** in the confirmation: for each rate that moves, "The Q1 bonus goes up ₹5,000 (₹50,000 to ₹55,000)", then "34 unpaid claims gain, 1 loses. The total goes up ₹1,69,000." above the existing figures. Paid claims keep what they were paid, as before.
- **Change history in words** at the foot: "Show the policy's change history (N)" lists each version, who published it, every rate that moved and the reason given. The audit entry now records before and after for every rate and rule (`FORMULA_UPDATE`), so the audit log shows "Q1 bonus: ₹50,000 to ₹55,000" too.
- The author-points box says "The built-in shares are in use" when no version has been published, and only says "does not parse" for a value that truly does not parse.
- The name and version are not said twice; " — " is gone from what I touched.

## Evidence after
- `shots/policy-after-1440.png`, `shots/policy-after-390.png`. No sideways scroll.
- Tests: `src/pages/policy-words.test.ts` (rates and impact in words, including the "34 unpaid claims gain" sentence), `src/pages/policy.test.tsx` and `policy-cutoff.test.tsx` unchanged and passing, `backend/core/test_admin_b.py::test_publishing_a_policy_records_what_moved_in_words`.
- API: `/api/admin/formula` 20 ms. The preview call (`/api/admin/formula/preview`) is unchanged.
