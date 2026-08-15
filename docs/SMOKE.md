# Role smoke checklist (prod)

App: https://faculty-paper.vercel.app · API: https://faculty-paper-api.onrender.com/api/health

## Faculty
- [ ] Sign in
- [ ] Summary strip shows received / in review / needs action
- [ ] New ticket: eligibility gate → Identity → Publication → Claim → Evidence → Review
- [ ] Draft autosaves ("Draft saved · time" appears after typing)
- [ ] Submit (or Send anyway with note) → ticket `FP-YYYY-######`
- [ ] My tickets master–detail shows status timeline and history sentences
- [ ] Paid ticket shows the "Paid" banner; a SUBMITTED one offers Withdraw & edit

## Admin / research cell
- [ ] Overview stats; "To clear" links to the clearing queue
- [ ] Clearing queue: Clear shows the recalculated amount before confirming
- [ ] "Set verified values" dialog saves with a source note and recalculates
- [ ] Bulk clear skips changed-amount rows with reasons
- [ ] Users create / reset password (reset also unlocks a locked account)
- [ ] Audit shows entity + expandable detail; filters work

## Principal
- [ ] All-tickets pipeline loads; overview counts load
- [ ] Second-approve button appears on high-value cleared claims

## Finance
- [ ] Payment orders list (cards on mobile); high-value rows show
      "Awaiting 2nd approval" with Pay disabled
- [ ] Mark paid with voucher confirmation (amount is the confirmed amount)
- [ ] Bulk pay: select → review table with per-row vouchers → confirm
- [ ] Processed payments: Void writes a reversing ledger row
- [ ] Ledger month/department pickers + CSV export; Reports has Excel export
