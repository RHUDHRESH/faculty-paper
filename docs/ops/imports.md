# Monthly imports

Two Excel files keep the app in step with the office. Both are checked before
anything is saved, and both can be run again safely: a second run changes
nothing.

| File | What it brings in |
|---|---|
| Faculty_List.xlsx | People: the faculty master list, designations, phone numbers, new accounts |
| Claim_Settled_Upto_<month>.xlsx | Claims already paid: the ledger and the already-paid warning |

## The routine

1. Open Admin > Imports.
2. Choose the file.
3. Press Check. Nothing is saved yet.
4. Read the summary (below). If something looks wrong, fix the file and Check again.
5. Press Import. The summary is shown again, now as done, and the import is recorded in the audit log.

Only an admin office role or the Principal can import. Faculty get a "not allowed" message.

From the command line, the same two steps are:

```
python manage.py import_faculty_list Faculty_List.xlsx            # Check
python manage.py import_faculty_list Faculty_List.xlsx --apply    # Import
python manage.py import_settled_claims Claim_Settled_Upto_Sep_2026.xlsx
python manage.py import_settled_claims Claim_Settled_Upto_Sep_2026.xlsx --apply
```

The workbook files hold real names and amounts. Keep them out of git.

## Faculty list

The workbook has an Academic sheet and a Research sheet. Sheets and columns are
found by their heading, so extra blank rows or columns do not matter.

What happens to each person:

- Their line on the master list is created or updated, and the whole row is kept.
- A person who already has an account (found by Staff-ID, then by email) gets
  the current designation and phone number from the list. A Scopus ID, email
  or Staff-ID is filled in only where the account has none.
- A different Scopus ID or email in the list is never written over the one on
  the account. It is shown under Conflicts for someone to settle by hand.
- A person with no account but a valid email gets a faculty account with a
  random password (the same kind the Issue passwords page makes). After a real
  import the page offers "Download logins (CSV)": staff_id, name, email and
  password for the new people only. The passwords are shown once and are not
  stored in readable form, logged or written to the audit trail, so save the
  file straight away; if it is lost, issue new passwords from Issue passwords.
  A Check never makes or shows passwords, and running the import again creates
  nobody, so it returns none. People on the Research sheet are research
  faculty; everyone else is regular.
- A person can sign in with the email the faculty list holds for them even if
  their account has a different one, as long as exactly one active account has
  their Staff-ID. Nothing stored is changed.
- A person with no account and no usable email appears under Needs email. Add
  the email to the list and import again.
- Nobody is switched off or removed. "Not in the list" is a count of active
  accounts the file does not mention, for you to look at.

## Settled claims

Every row is a claim that has been paid. The Check tells you, per row:

- Already recorded: the person and paper are on the ledger already, or the
  same DOI is on that person's earlier payment. Nothing is saved.
- New: not on the ledger. It will be added with the month it was paid.
- Amount differs: already on the ledger with a different amount. It is only
  reported. Money already on the ledger is never changed by an import; settle
  it by hand.
- Zero amount: a count-only row such as "No remuneration". It is added at 0.
- Unknown Faculty ID: the person is not in the app. The row is still added,
  with the name and ID as typed. Add the person to the faculty list.
- Amount not a number: a blank or text such as "N/A". The paper is remembered
  for the already-paid warning but no money is added.

When a paper's DOI is new and the same person's paper is already in the app
without one, the DOI is filled in ("DOIs filled").

Check the New total and the month-by-month list against what Finance expects
before pressing Import.
