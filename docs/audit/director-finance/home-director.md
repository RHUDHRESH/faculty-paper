# Audit: Director Home (`/`)

## Who and why
The Director, a few times a month when the Principal has approved a batch, and
once at month end to sign the statement. The question: "how much is waiting on
my signature, what does it do to the budget, is anything unusual?" (D1, D2.)

## What it showed before
Screenshot: `D:\Faculty Paper\scratch\dirfin\shots\before_director_d_home.png` (`_m_` for 390 px).

| Part | Problem |
| --- | --- |
| Header | Greeting with a 240 px picture; the one action ("Authorise all 6 · ₹3,15,370") sat under the sentence. |
| Sentence | The decision ("the budget is already over…") sat between the header and the figures, above the answer it explains. |
| Figures | Waiting on you / Worth / Longest wait, then the same numbers again under "The institution" (Committed, Left this year, Paid to date, Publications). "Longest wait" printed "—" for zero. |
| Queue | `DeskQueue`: amounts with no research-threshold effect. |
| Half the page | "What we research": subject-area bars and a caution about a 52% coverage, which is not the morning question. Publications count repeated a Track figure. |
| Statement | Signing the monthly statement (D2) was reachable only through a Help guide. |
| "Where everything is" | Stage counts and other desks' waiting list, in full, mid-page. |

## What changed
1. `PageHeader` with the primary action top right.
2. **Answer**: Waiting for you to authorise, Worth (released to Finance), Days the longest has waited (a zero says "Nothing is waiting"), and Left in the budget counting these (red "Over…" with the word).
3. The decision as one sentence under the figures: what authorising releases, what the year would still have, the three largest as links, and, if the research threshold has cut amounts, how many claims and how many rupees ("the amounts shown are what will be paid").
4. **Longest waiting**: six rows with the threshold beside each amount and an Authorise button; empty state in words with `ComingUp`. The batch dialog is the Authorisations page's `BulkAuthoriseDialog`, unchanged (count, total, departments).
5. **The month's statement** (new, D2): the two newest months with "Statement to sign (PDF)", the ledger check in one sentence, and a link to the statement. No bank file for the Director.
6. Research areas and "where every claim is" are behind "Show …" lines; the areas load only when opened, with their coverage figure in the sentence beside them.
7. The duplicate institution figures are gone; Budget and Track are one link away.

## Evidence after
Screenshots: `shots\c_director_d_home.png`, `cf_director_m_home.png`.
Tests: `src/pages/home-money.test.tsx` ("leads with what is waiting, what it releases and what the budget keeps").
Backend: `/api/director/queue` `totals` now carries `held_back` and `held_back_count` (`core/services/payments_desk.py`, tested).
