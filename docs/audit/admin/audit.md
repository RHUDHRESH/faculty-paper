# Audit log (`/audit`)

## Who and why
The super admin, and read-only for the research cell, the Principal, the Director and Finance: "Who changed this, when, and from what to what?" Used to answer an inquiry, and to check an import or a fix. Finance and the Director never see flag entries.

## What it showed before
![before](shots/audit-before-1440.png)

- The actor column was an email address, with no face, for a page whose whole subject is people.
- Every action showed its code under the sentence (`BACKUP_STORED`, `CLAIM_FLAG_RAISE`), and the entity column showed `User · 0228f4c3891e4fbfb02eb29f949c...`, a record id nobody can read.
- "What changed" was in the side sheet only, behind a "View" button: from the list you could not see that an amount changed from ₹0 to ₹15,000.
- Five unlabelled or placeholder-labelled controls in a wrapping row (search, action, from, to, "Who (name or email)", "Claim number or ID") plus a CSV button in the same row.
- "Where the record came from" (four import events) sat above the log, so the first thing on the page was not the log; it used " — ".
- No figure said how many entries there are, how many are from people and how many from the system.
- The last column had an empty heading (a clarity baseline entry).

## What changed
- Title, one sentence (Who changed what, when, and from what to what; nothing can be edited or removed). The one action is Download CSV, with the real count ("newest 50,000 of N" past the cap).
- The answer: entries in all (or matching), in the last 7 days, made by people, made by the system. The server counts them over the same filtered rows as the list (`summary`).
- One search box. The rest (what happened, who did it, claim number, from, to) is "Show more filters", which opens by itself when one is set. The "what happened" list holds only the kinds of entry the log actually has (`/api/admin/audit/actions`).
- The list is a table: When, Who (face and name, or "The system"), What happened (a sentence, then "Amount: ₹0 to ₹15,000", then the reason given), Record (claim number or person's name as a link), More. On a phone each row stacks and keeps its labels.
- The side sheet shows the sentence, who, the record, the full before and after, the reason, and the entry as recorded (action code, record id, raw JSON) behind "Show the entry as recorded".
- "Where the record came from" moved below the list into "Show where the record came from (4)".
- Runs of the same automatic entry in one minute still fold into "raised a flag × 43".

## Evidence after
- `shots/audit-after-1440.png`, `shots/audit-after-390.png`. No sideways scroll.
- Tests: `src/pages/audit.test.tsx` (3), `backend/core/test_admin_b.py` (the list speaks in words and counts what it lists; actions list only what the log holds), `core.test_super_admin_tools`, `core.test_audit_origins`. Clarity baseline: the empty header entry is gone.
- API: `/api/admin/audit?limit=50` 110 ms on the real data (two extra COUNTs and two page-wide lookups).
