# Walkthrough findings and the 100 improvements

Local run 2026-09-23: Django (SQLite, seed + HOD/Director/Research accounts)
on :8000, frontend2 on :5174. Evidence: a hand walkthrough in the browser
pane, `scripts/sweep.mjs` (7 roles × every sidebar page, desktop + 390px,
console + failed API calls), the repo's Playwright suite (49 specs), and two
code reviews. `[x]` = done and verified in the running app or by tests; `[~]` = frontend done, server half in progress; ~~struck~~ = checked and not a defect.

## Defects found

| # | Where | What | Evidence |
|---|---|---|---|
| [x] D1 | Backend tests | 67 tests patched names the api split had moved; suite 69 red | test run |
| [x] D2 | Admin edit | Could set `status=PAID` with no Director and no ledger row | superadmin.py |
| [x] D3 | Clearing | No Scopus key / Scopus outage → **nobody can clear anything**; Clear stays disabled | e2e money-chain fail, screenshot |
| [x] D4 | Nav | "Institution" was a copy of Policy's entry: offered to Principal/Director/Finance, server 403s | sweep, 3 e2e fails |
| [~] D5 | Nav | Director and Finance get "Duplicates" — contested flags must be hidden from both | sweep |
| [~] D6 | Ticket API | `get_claim` returns `actor_name` for every step to faculty — names who holds the paper | journals.py:186 |
| [x] D7 | Sign-in | Tells faculty "every paper shows which desk it is sitting on" | screenshot |
| [ ] D8 | Filing | No Scopus → "Scopus is down right now" (it is unconfigured); no Crossref/OpenAlex fallback | walkthrough |
| [x] D9 | Approvals | "Waiting days" label drawn over its own placeholder | screenshot |
| [x] D10 | Shell | Two "Search" entries in every sidebar | screenshot |
| ~~D11~~ | Shell | *False positive:* the sidebar is sticky; full-page screenshots cut it | re-checked |
| [x] D12 | Money | `money()` decides paise from an unrounded float | review |
| [x] D13 | Cache | Director authorise doesn't refresh Finance's queue; void doesn't refresh clearing/principal | review |
| [x] D14 | Prod | `/gallery` dev page reachable signed-out | review |
| [x] D15 | Bundle | No route splitting; 1.34 MB main chunk | build |
| [ ] D16 | Seed | Only 4 accounts; README promises HOD + research logins | walkthrough |
| [x] D17 | Copy | "1 departments", "1st of 1" | HOD screenshot |
| [x] D18 | Filing | Heading flips to "Edit your draft" after first autosave; no "step n of 5" | walkthrough |
| [x] D19 | Look | Sign-in half empty; homes are bare numbers on grey; serif titles read as a blog | screenshots |
| [x] D20 | Faculty screens | `stageOf().who` told claimants "Waiting for the Principal / Director / with Finance" on home, My papers and the ticket page | code |
| [x] D21 | Finance | Finance's home and payments said a paper is payable once "the Principal" approves it — it is the Director's authorisation | screenshot |
| ~~F5~~ | Filing | *False positive:* the DOI input is labelled; the browser tool named it by placeholder | checked in page |

## The 100 improvements

### Everybody
1. [x] Light / dark / follow-system theme in the account menu
2. [x] One Search entry in the sidebar, with the Ctrl K hint on it
3. [x] `?` opens a keyboard-shortcut sheet
4. [x] Dates show relative ("3 days ago") with the exact date on hover
5. [x] Copy button beside every ticket number
6. [x] Type a ticket number in Ctrl K and jump straight to it *(already existed — verified)*
7. [x] Notifications: "Mark all read" *(already existed — verified)*
8. [x] Notifications grouped Today / Earlier
9. [x] Sign-in remembers the email on this device
10. [x] Sign-in: "Forgot password?" says who to ask, from the Institution settings
11. [ ] Warning two minutes before the session expires — *not built on purpose: sessions are a fixed 12 h, the filing form autosaves, and an expired session is already announced once*
12. [x] Leaving a half-filled form asks first *(already existed — verified)*
13. [x] Each page sets the browser tab title
14. [x] Breadcrumbs on every detail page *(already existed as a back link on every detail page — verified)*
15. [x] Print stylesheet for a ticket
16. [ ] Empty states carry the one action that fills them
17. [x] Every input has a real label (screen readers, autofill)
18. [x] Money always ₹ with Indian grouping and correct paise
19. [x] Saveetha branding: name, logo slot, one brand colour token
20. [x] Faster first load: pages load on demand

### Faculty
21. [x] Home leads with a journey tracker per paper: stage + days waiting, never the desk
22. [x] Home "Needs you" lists each sent-back paper with its reason and a Fix button
23. [ ] DOI lookup falls back to Crossref / OpenAlex when Scopus is unavailable
24. [ ] Lookup says "not configured" vs "down" honestly
25. [x] Filing rules text folds away for repeat filers ("Read the conditions again"); the three per-article confirmations are still asked every time — remembering them would let a second article be filed unattested
26. [x] Wizard shows every step's name and "Step n of 5"
27. [x] Wizard step rail stays pinned while scrolling
28. [x] Ctrl Enter continues to the next step
29. [x] Download a paid paper's payment advice
30. [x] "Received this academic year" total on home
31. [x] Export my papers to Excel
32. [x] Drafts list with "last edited" and Resume
33. [ ] Discard a draft
34. [x] Start a new claim from a previous one (same journal, co-authors)
35. [ ] Pick your author position from the author list
36. [x] Upload checks type and size before sending, with a clear message
37. [x] Drag and drop files onto the upload area
38. [ ] Typical time to payment, from the college's own history
39. [x] Profile completeness: Scopus ID, staff id, department
40. [x] Scopus author profile link on the profile
41. [x] "Request a correction" pre-fills the field and current value *(already existed — verified)*
42. [ ] Calendar shows payout-run dates automatically
43. [x] Faculty ticket view shows vague stages, no names (server strips them)
44. [ ] Paper detail: "Why this amount" collapsed — *left open on purpose: it is short, and it is the answer people open the page for*
45. [x] Duplicate warning names the matching paper and lets you contest in one step *(already existed — verified)*

### Research supervisor (the office desk)
46. [x] Clearing queue running total of what is selected *(already existed — verified)*
47. [x] Filters: department, verification passed/failed, contested
48. [x] "Failed" verification explains why on hover
49. [ ] Put on hold, with a reason; resume later
50. [ ] Return one step / return to faculty, with the reason required
51. [x] Saved reasons for sending back (pick, edit, send)
52. [x] After acting, the next ticket opens automatically
53. [x] Declared vs verified values side by side *(already existed — verified)*
54. [x] Duplicate match links to the other ticket
55. [x] Contested badge in the queue
56. [x] Waiting time coloured: 7+ days amber, 14+ red
57. [ ] Claim a ticket so two officers don't work the same one
58. [x] Export the queue to Excel
59. [x] Count per department above the queue
60. [x] Scopus outage no longer stops clearing (stored verified values, audited)
61. [x] "Open in Scopus" link on each ticket
62. [x] Office-only notes on a ticket *(already existed — verified)*

### Principal
63. [x] Ledger-style list: claimant, department, journal, quartile, amount, waiting *(already existed — verified)*
64. [x] Claim drawer: the faculty member's past claims
65. [x] Claim drawer: this journal's history at the college
66. [x] Claim drawer: department trend
67. [x] Claim drawer: red-flag summary
68. [ ] Hold / return one step / return to faculty / reject
69. [x] Approve selected, with the total shown before confirming *(already existed — verified)*
70. [x] Filter by amount range
71. [x] Fix the overlapping "Waiting days" filter
72. [x] Export the approvals list

### Director
73. [x] Summary: budget impact of what is waiting
74. [x] Summary: research output this period
75. [ ] Summary: accreditation effect
76. [x] Summary: highest-value items (no contested flags shown)
77. [x] Authorise the whole batch with one confirmed total
78. [x] Open any claim read-only from the summary
79. [x] Forward only: no send-back
80. [x] No Duplicates page

### Finance
81. [x] Pay-only screen: selected total, vouchers *(already existed — verified)*
82. [x] Voucher numbers generated on request
83. [x] Bank payment file export (CSV)
84. [x] Void moves to super admin only
85. [x] No Duplicates page
86. [x] Monthly paid summary
87. [x] Printable payment register
88. [ ] Payment date defaults to today, changeable

### Head of department
89. [ ] Assign tasks to staff, with status
90. [ ] Paper targets with deadlines per person
91. [ ] Co-author pairing from suggestions
92. [ ] Department research areas / vision statement
93. [ ] Department ticket tracker (no money)
94. [ ] Nudge staff who have filed nothing (in-app notification)
95. [ ] Export the department report

### Super admin
96. [x] Full ticket timeline: every step, every actor *(already existed — verified)*
97. [x] "View as" another account, with a banner
98. [x] SCImago download in one click — *from the officer's browser, not the server: SCImago answers a server with HTTP 403 and a Cloudflare challenge (checked 2026-09-23), so the old server-side sync button could never succeed*
99. [x] Export one faculty member's record
100. [ ] Demo seed with every role and a ticket at every stage, for training
