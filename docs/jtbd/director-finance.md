# Jobs to be done: the Director and Finance

The chain is: faculty file, the research cell clears, the Principal approves,
**the Director authorises**, **Finance pays**. Both roles are "contest-blind":
they never see flags, duplicate findings or contest notes (`core/visibility.py`,
`CONTEST_BLIND_ROLES`). A payment is never held back by a flag they cannot see;
where a second signature is needed they are told what is missing, not why.

Sources used for the practice described here (retrieved 2026-09-28):
- Bulk NEFT/RTGS upload formats (Union Bank of India CSV demo, ICICI CIB bulk
  transfer format 3.3): each row carries payment type, beneficiary name,
  account number, IFSC, amount and a remark/narration.
  <https://www.unionbankonline.co.in/InternetBankingProductDemos/BULK_NEFT_RTGS_DEMO/NEFTRTGS_format_CSV.pdf>,
  <https://www.icici.bank.in/managed-assets/docs/form-center/File_Format_Bulk_%20Transfers_3.3.pdf>
- TDS: section 194J (professional fees) does not apply to payments to the
  college's own teachers (ITAT Hyderabad, reported by Taxmann/Taxscan); an
  incentive to an employee is salary income taxed through payroll (section 192).
  <https://www.taxmann.com/post/blog/sum-paid-to-contract-teachers-cant-be-treated-as-fee-for-professional-services-no-sec-194j-tds/>,
  <https://cleartax.in/s/section-194j>

Assumptions (each with how to falsify it):
- A1. Incentives go out through payroll or a bulk NEFT file, and TDS is
  deducted by payroll under section 192, so this app does not compute tax.
  *Falsify:* ask Accounts whether incentives are paid gross by a separate
  voucher with 194J deduction. If so, a TDS column must be added.
- A2. The app holds no bank account numbers or IFSC codes (true today: the
  `User` model has neither). The bank file therefore carries staff id, name,
  amount and narration, with the account and IFSC columns left for Accounts
  to fill from the payroll master. *Falsify:* grep `models.py` for `ifsc`.
- A3. The financial year is April to March (`budget.financial_year_of`).

## The Director

| # | Job | Question they ask | Decision | Artefact handed on |
|---|-----|-------------------|----------|--------------------|
| D1 | Authorise the month's approved claims against the budget | "Can the college afford what the Principal approved, and what is left after it?" | Authorise all, some, or send a question to the Principal | Authorisation recorded against each claim (who, when, amount), which is what Finance pays against |
| D2 | Sign the monthly payout statement | "What went out this month, to whom, from which department, and does it add up?" | Sign, or ask Finance to explain a line | A4 payout statement (college header, month, rows, department subtotals, total in figures and words, signature block) filed with the accounts |
| D3 | Answer governing-body and audit questions | "What did we spend this year, on whom, against what budget?" | Raise or hold next year's allocation | Budget vs spend by month for the financial year; ledger export |
| D4 | Keep an audit trail an auditor can follow | "Who approved and who authorised this payment, and when?" | None: evidence | Statement rows show ticket, authorised-on date and voucher; the audit log holds each step |
| D5 | File their own papers | "Where is my own claim?" | None: they never decide their own | My papers, like any claimant |

## Finance

| # | Job | Question they ask | Decision | Artefact handed on |
|---|-----|-------------------|----------|--------------------|
| F1 | Pay what the Director authorised | "What is payable now and what does it come to?" | Pay one, or a confirmed batch | A voucher per payment and a ledger row; nothing paid without the Director's authorisation |
| F2 | Make the monthly payout batch | "What goes into this month's bank upload, and does the total equal the statement?" | Release the batch to the bank / payroll | Bank/accounts CSV for the month (one row per payment, narration with ticket and month) |
| F3 | Reconcile with the accounts ledger | "Does every paid ticket have exactly one ledger row for the same amount? What came from the ERP import rather than the app? What was reversed?" | Chase a mismatch with the super admin (Finance cannot undo a payment) | Reconciliation sheet for the month |
| F4 | Produce the statutory/internal audit pack | "Show the auditor every payment of the year with its voucher and approvals." | None: evidence | Ledger CSV, monthly statements PDF |
| F5 | Watch the budget | "How much of this year's allocation is paid, committed and left?" | Warn the Director before authorisations run past it | Budget page, budget vs spend chart |
| F6 | File their own papers | as D5 | | |
