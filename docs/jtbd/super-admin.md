# Super admin: jobs to be done

The super admin runs the system for the college. They never file papers. Every job below is written as the question they ask, the decision it leads to, and the artefact that proves it was done.

## 1. Keep people and roles right
| Job | Question | Decision | Artefact |
|---|---|---|---|
| Issue accounts and passwords | Who joined and cannot sign in? | Create the account or reset the password | People > person admin; audit row `USER_CREATE` / password reset |
| Assign desk roles | Who is the Research cell, Director or Finance this term? | Change the role (confirmed as "Change role") | Person page; audit row with before and after |
| Deactivate leavers | Who left, and do their papers stay on record? | Deactivate (confirmed as "Deactivate") | Audit row; the person's papers are kept |
| Profile corrections | Which staff ID, name or Scopus fixes are waiting? | Approve or refuse | Requests; audit row |
| View as, for support | What does this person actually see? | Look read-only, then stop | Audit rows for start and stop of impersonation |

## 2. Keep data right
| Job | Question | Decision | Artefact |
|---|---|---|---|
| ERP and payment-history imports | What will this file change before I commit it? | Preview (dry run), then import or fix the file | Imports report; batches list; audit origins |
| Scopus and OpenAlex harvests | Did the harvest run, and what did it add? | Re-run or leave | Batches, jobs |
| Author matching | Which college author names are credited to nobody? | Match, mark ambiguous, or hide | People > matches; undo available |
| Duplicates | Was anyone paid twice for one paper? | Confirm, dismiss, record recovery | Duplicates page |
| Data health | Are there broken links, duplicate IDs, missing files? | Run a named fix or fix by hand | Data health report; audit row per fix |

## 3. Keep money right
| Job | Question | Decision | Artefact |
|---|---|---|---|
| Policy and formula versions | If I change a rate, whose unpaid claims change and by how much? | Publish a new version or not | Policy history; before/after preview; audit `FORMULA_UPDATE` |
| Budget | Is the allocation right for each head? | Allocate, adjust, remove | Budget page |
| Undo a wrong payment | Was this paid in error? | Undo with a reason (Finance cannot) | Reversing ledger row; audit row |

## 4. Keep it running
| Job | Question | Decision | Artefact |
|---|---|---|---|
| Health at a glance | Is anything wrong right now, and why? | Open the item and fix it | Home attention list |
| Faults | What has stalled or does not add up? | Fix the record or chase the desk | Faults page |
| Backups | Is there a recent backup I could restore? | Take one now, download it | Data health > backups |
| Jobs queue | Did the background job finish or fail? | Re-run or investigate | Job status |
| Who changed what | Who touched this claim or person, and when? | Answer the inquiry; export for an auditor | Audit log filtered by person, claim, dates; CSV |
