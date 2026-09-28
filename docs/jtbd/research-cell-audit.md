# Research cell and coordinator: audit against the jobs

Jobs are numbered as in `research-cell.md`. Audited on branch
`audit/research-cell` (from `complete-frontend2` at fcee252), with
`manage.py seed_demo` data, as RESEARCH_CELL.

| Surface | Jobs | What was there | Gap | Status |
|---|---|---|---|---|
| Clearing queue (`/clearing`) | 7, 8 | Oldest first, waiting days coloured, department chips, verification filter, bulk clear with per-ticket skips, CSV | No ageing buckets to work by; no way to show only clean tickets before a batch | **Fixed**: ageing chips (a week or less / 8-14 / 15-30 / over 30 days) as a filter; "Ready to clear" filter (verified, no duplicate, no contest, affiliation not missing, not watched, priced) |
| Ticket sheet (claim review) | 1-4, 6 | Claimed vs record table (SNIP, quartile, author position, affiliation), duplicate panel, flags, hold, send back, reject outright, second signature | Author position "record" repeats the claim; quota and FYP rules not shown at all | **Fixed**: "Scheme rules on this ticket" (research quota N, paper k of year, inside/outside, the note; FYP: one per team, mentor, Rs 15,000, team and mentor). Author position: remains (needs the Scopus author list stored separately) |
| Journal standing | 5 | Scopus discontinued and UGC-CARE lists (`JournalStanding`) | No college-kept watch-list for clones and doubtful venues | **Fixed**: `JournalWatch` model, `/api/admin/journal-watch` (list, add with reason, remove, audit-logged); section on `/journals` for clearers; "Watched journal" flag on queue rows and a callout on the ticket; bulk clear skips watched journals |
| Reports | 9 | College reports (money, departments, months) | Nothing about the desk's own throughput | **Fixed**: `/api/admin/clearing-report?month=` (received, cleared + amount, sent back, not accepted, median days to decide, within a week, per person, ageing of what waits) and `format=csv`; shown under the queue with a month picker |
| Queue payload | 12, 13 | Quota decided server-side (`_quota_state`, `quota_position`), FYP scheme priced separately | `quota_applied`, `quota_note`, `quota_position`, faculty type and quota were not in `claim_to_dict`, so no screen could show them | **Fixed** |
| Own claims | 14 | Excluded from the queue; server refuses (`rbac.is_own_claim`); callout if opened | None found | Tested again (`test_research_cell_desk`) |
| Flags, Duplicates, Archive, Author matches, Imports | 5, 6, 11 | Pages exist and have their own tests | Not changed in this pass | Not re-audited in depth |
| People (quota / research faculty) | 12 | Quota shown and editable on People | None found | No change |
| Messages from faculty | 10 | Messages page | No link from a ticket to the claimant's thread | **Remaining** |
| Home (staff) | 7, 9 | Counts and links | Does not show the ageing split or this month's report figures | **Remaining** |
| Demo data | all | `seed --demo` (15 papers at every stage) | No suspicious tickets | **Fixed**: `manage.py seed_demo` adds affiliation missing, duplicate DOI (co-author), inflated quartile (Q1 claimed, Q3 on record), and a watch-listed clone journal |

## Remaining
- Author position is not checked against a stored Scopus author list; the
  table shows the claim twice.
- No ticket-to-message link; Home does not carry the ageing split.
- A watched journal is matched per ticket with one query each (fine at the
  200-row queue cap; cache it if the list grows past a few hundred).
