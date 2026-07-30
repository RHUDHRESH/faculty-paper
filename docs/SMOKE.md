# Role smoke checklist (prod)

App: https://faculty-paper.vercel.app · API: https://faculty-paper-api.onrender.com/api/health

## Faculty
- [ ] Sign in
- [ ] New ticket: step through Publication → Authors → Review
- [ ] Submit (or Send anyway with note) → ticket `FP-YYYY-######`
- [ ] My tickets master–detail shows status timeline
- [ ] Paid ticket shows “Payment cleared” banner

## HoD
- [ ] Queue shows SUBMITTED for department
- [ ] Contest note / verification callouts visible
- [ ] Approve → Principal

## Principal
- [ ] Queue shows HOD_APPROVED
- [ ] Overview pipeline counts load
- [ ] Approve → Finance

## Finance
- [ ] Payment orders list (cards on mobile)
- [ ] Mark paid with voucher confirmation
- [ ] Ledger filter + CSV export

## Admin
- [ ] Overview stats
- [ ] Formula preview calculator returns amount
- [ ] Save policy creates new version
- [ ] Users create / reset password
- [ ] Audit shows claim transitions after approve/pay
