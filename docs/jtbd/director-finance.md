# Jobs to be done: the Director and Finance

The chain is: faculty file, the research cell clears, the Principal approves,
**the Director authorises**, **Finance pays**. Both roles are "contest-blind":
they never see flags, duplicate findings, the watch-list or contest notes
(`core/visibility.py`, `CONTEST_BLIND_ROLES`). A payment is never held back by
a flag they cannot see; where a second signature is needed they are told what
is missing, not why.

## How it works in a private engineering college (researched, 2026-09-30)

What the sources say, and what we take from each. Nothing here is a claim about
this college until Accounts confirms the assumptions below.

1. **Claims are paid by the office that pays salaries, after a chain of
   signatures.** Published research-incentive schemes at Indian colleges
   (KIET, Crescent, Thiagarajar) say the same shape: a claim within a month of
   publication with proof of indexing, countersigned by the head of
   department and dean, approved by the head of the institution, then paid by
   the registrar's or HR office "following usual procedure". None of them
   names a voucher form or a bank format, which is the point: the payment step
   is ordinary accounts work, so the app must produce what an accounts clerk
   already handles (a voucher number, a month, a bank file, a signed sheet).
   - <https://www.old.kiet.edu/incentive-for-researchers>
   - <https://bsacist.crescent.education/research/about-us/research-incentive-scheme/>
   - <https://www.tce.edu/sites/default/files/naac/criteria-3/3.3.1/3.3.1.pdf>
2. **The person who authorises is not the person who pays or the person who
   reconciles.** Institutional finance rules ask that no one person holds
   authorisation, signing, recording and bank reconciliation (segregation of
   duties), and that a payment voucher, once approved, goes to accounts
   payable, is paid by transfer, and is stamped paid with its number so every
   ledger entry links to a voucher. This is why Finance cannot undo a payment
   (a super admin does, leaving a reversing row) and why nobody pays or
   authorises their own paper.
   - <https://www.haringey.gov.uk/sites/default/files/2024-03/gr_3_-_bank_account_administration.pdf>
     (a school-governance rule; used for the principle, not for Indian law)
   - <https://www.bajajfinserv.in/investments/what-is-voucher>
3. **The monthly run ends in a bank upload.** Corporate banking takes one
   file per run (NEFT/RTGS/bulk IMPS): each row is beneficiary name, account
   number, IFSC, amount and a narration; the bank returns a status per row.
   Failures are almost always data (wrong IFSC, closed account, name mismatch)
   and a failed transfer is returned to the college's account, not lost. So the
   Finance officer's real worry is not "did I click Pay" but "does the file I
   upload equal what I authorised, and what do I do with the rows that bounce".
   - <https://www.icici.bank.in/business-banking/cms/payment-solutions/bulk-payments>
   - <https://www.unionbankonline.co.in/InternetBankingProductDemos/BULK_NEFT_RTGS_DEMO/NEFTRTGS_format_CSV.pdf>
   - <https://ifscnow.com/blog/neft-failed-return-reasons>
4. **Tax.** An incentive to a regular employee is salary: TDS under section 192
   through payroll, not section 194J. The decisive test is the employer-
   employee relationship (contract of service), not attendance rules; a
   visiting or consultant faculty member is different. The 2026 Cochin ITAT
   summary does not address incentives specifically.
   - <https://www.taxscan.in/salary-teachers-lectures-staff-college-subject-tds-192-fts-itat/37937>
   - <https://thetaxtalk.com/2026/07/tds-on-faculty-payments-salary-under-section-192-or-professional-fees-under-section-194j-itat-cochin-clarifies-the-law/>
5. **The month closes with a signed statement and a reconciliation.** The
   accounts side reconciles the college's book to the bank (a bank
   reconciliation statement) each month, and the Director's signature on the
   month's payment statement is the evidence that what left the bank was
   authorised.

### Assumptions (each with how to falsify it)

- A1. Incentives go out through payroll or a bulk NEFT file and TDS is deducted
  by payroll (section 192), so this app does not compute tax. *Falsify:* ask
  Accounts whether incentives are paid gross by a separate voucher with 194J
  deduction; if so a TDS column is needed on the statement and bank file.
- A2. The app holds no bank account numbers or IFSC codes (the `User` model has
  neither). The bank file carries staff id, name, amount and narration; account
  and IFSC are left for Accounts to fill from the payroll master. *Falsify:*
  `grep -i ifsc backend/core/models.py`.
- A3. The financial year is April to March (`budget.financial_year_of`).
- A4. Finance marks a claim paid at the moment it releases the bank file, not
  after the bank confirms. A transfer that bounces is put right by a super
  admin's undo. *Falsify:* ask Accounts whether they wait for the bank's
  confirmation reference before recording payment; if so add an optional bank
  reference to the payment (NEEDS: backend).
- A5. One voucher may legitimately cover several claims of the same person in a
  month. So a repeated voucher number is a warning when it belongs to a
  different person, never a block.

## The Director

The Director opens the app when the Principal has approved a batch, usually a
few times a month, and once at month end to sign the statement. They decide in
minutes, from a phone as often as a desk. They are not an accountant and do
not want to reconcile; they want to know they are not authorising money the
college does not have, or money that is wrong.

| # | Job | Question | Decision | What must be on screen | Artefact |
|---|-----|----------|----------|------------------------|----------|
| D1 | Authorise the Principal's approved claims | "How much is waiting, what does it do to the budget, who has waited longest, is anything unusual?" | Authorise all, some, or send back with a reason | Count and total, longest wait, budget left before and after, the three largest, any claim where the research threshold reduces the amount | Authorisation on each claim (who, when, amount) |
| D2 | Sign the month's payment statement | "What went out, to whom, does it add up?" | Sign, or ask Finance to explain | The statement PDF one tap away from Home once a month is fully paid, total in figures and words, department subtotals | Signed A4 statement |
| D3 | Answer governing-body and audit questions | "What did we spend this year, on whom, against what?" | Raise or hold next year's allocation | Year to date paid, committed, left; by department; by month | Budget page, ledger export |
| D4 | Be able to show who authorised what | "Who approved and authorised this payment, and when?" | None: evidence | On any claim: Principal, Director, Finance, dates, voucher | Statement rows, audit log |
| D5 | File their own papers | "Where is my own claim?" | They never decide their own | My papers | |

## Finance

Finance works to a calendar, not a queue. There is a monthly payment run and
a few off-cycle payments. The job is exactness: the right amount, once, to the
right person, with a voucher, and a file the bank accepts.

| # | Job | Question | Decision | What must be on screen | Artefact |
|---|-----|----------|----------|------------------------|----------|
| F1 | Prepare the run | "What is payable now, what does it total, what is blocked and why, and does the budget cover it?" | Which claims go into this run | Payable count and total, blocked with the reason, the month it will be paid in, budget left | The batch |
| F2 | Pay, once, at the right amount | "Is this claim already paid? Is the amount the policy amount? Is this voucher already used?" | Pay one, or a confirmed batch | The three checks named, the amount, and for research faculty the threshold held back | A voucher on each payment; one ledger row |
| F3 | Release the bank file | "Does the file equal what I just paid?" | Send to the bank | The month's bank file and statement one tap from the run's result, the total in the file against the total paid, empty account and IFSC columns named | Bank CSV, statement PDF |
| F4 | Reconcile | "Does every paid claim have exactly one ledger row for the same amount? What was imported? What was reversed?" | Chase a mismatch with the super admin | The statement's reconciliation with each exception listed and linked to the claim | Reconciliation for the month |
| F5 | Handle a bounce | "A row came back from the bank. What now?" | Ask a super admin to undo it and pay again | Who can undo, and the payment it would reverse, named | Reversing ledger row |
| F6 | Produce the audit pack | "Show the auditor every payment of the year with its voucher and approvals." | None: evidence | Ledger with filters and CSV, monthly statements | Ledger CSV, PDFs |
| F7 | Watch the budget | "How much of this year is paid, committed, left?" | Warn the Director | Same three figures as the Director sees, same source | Budget page |
| F8 | File their own papers | as D5 | | | |

### What both roles must never be shown or asked

- Flags, the watch-list, duplicate findings and contest notes. The screens
  carry none of them, and a "needs a second approver" block says what is
  missing, never why.
- A button that acts on their own paper.
- A raw status code, a claim number from the old ERP without saying what it is,
  or a blank cell for a figure that was never recorded.

### Where each job lives (this audit)

| Job | View |
|-----|------|
| D1 | Director Home, then Authorisations (owned by the queue helper) |
| D2 | Monthly statements |
| D3, F7 | Budget, Ledger, Money hub |
| F1, F2 | Payments |
| F3 | Payments (result), Monthly statements |
| F4 | Monthly statements |
| F5, F6 | Paid, Ledger |
