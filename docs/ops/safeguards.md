# Money safeguards: every risk, the guard, the gap, the fix, the test

Owner's brief: "checking the DB for already-submitted applications, or Finance giving money again
and again, and other stuff". This is the audit of every integrity safeguard, end to end, with the
database holding what it can and the screens saying it in words.

Line numbers are in `backend/core/` and were read on 2026-10-01 (migration 0075).

## The layers, in the order a request meets them

1. **The screen** says it before the click: the filing form when the paper is picked, the pay
   dialog when it opens (`GET /claims/{id}/pay-check`), the statement before the bank file.
2. **The endpoint** refuses with a sentence and a `code` (`PayRefusal`, `api/common.py:710`).
3. **The row lock**: the claim is read `select_for_update` inside one transaction. PostgreSQL makes
   a second session wait; SQLite has no row lock, so there layer 4 is what holds.
4. **The database** refuses what must never exist (migration 0075): one payment per claim per
   cycle, one reversal per payment, one filed claim per person per DOI, a unique idempotency key,
   and (PostgreSQL) an append-only audit log.
5. **The daily check** (`services/safeguards.py`, schedule `safeguards-daily`, 03:45) recomputes
   everything from the rows, because a constraint a migration had to skip, a restore, a shell or an
   import can all get round layers 1 to 4. It raises Faults and writes the Safeguards page.

## 1. The same paper claimed twice

| Risk | Current guard | Gap found | Fix | Test |
|---|---|---|---|---|
| Same person, same DOI, second claim while the first is in the chain | `verify.check_already_paid` (`services/verify.py:50`) compared only against **paid** claims and the old workbook | A second claim beside one still in the chain was never detected; nobody knew until both were paid | `claim_standing.own_standing` (`services/claim_standing.py:92`) is the one answer; `create_claim` / `patch_claim` refuse with 409 in plain words (`api/journals.py:272`, called at `:240`, `:559`); DB unique index `one_filed_claim_per_person_per_doi` (`models.py:926`); a race that slips past gets a sentence, not a 500 (`journals._submit_claim`) | `test_safeguards_claims.SamePersonSamePaper` |
| Same person, same title, no DOI | none | title was only a fuzzy hint on paid rows | exact normalised title of 16+ characters matches when either side has no DOI; a short generic title ("Introduction") is not evidence | `...test_the_same_long_title_with_no_doi_is_the_same_paper`, `...test_a_short_generic_title_is_not_evidence` |
| Conference paper and its journal extension (same title, two DOIs) | none | would have been blocked by a naive title rule | allowed; the research cell gets an automatic DUPLICATE flag (`claim_standing.routing_notes`, `journals._raise_routing_flags`) | `...test_the_same_title_with_two_different_dois_is_two_papers_the_cell_is_told` |
| Co-authors at the college both claim the paper | `DuplicateFinding` CROSS_PERSON sweep (`management/commands/find_duplicate_payments.py`) after payment only | nothing at filing. **Policy reading:** the sweep's own docstring and `docs/jtbd/research-cell.md` row 6 say co-authors are "usually right, each paid by author position" but the research cell "rejects the duplicate, pays one". Not settled, so not invented | **Not blocked.** Filing raises one automatic DUPLICATE flag per other claim for the research cell; two people at the **same author position** get the stronger note. The claimant, the Director and Finance never see it (`core.visibility`), and the claimant is not told a colleague claimed | `test_safeguards_claims.CoAuthorsAtTheCollege` |
| Re-filing a paper already paid (here, or in the old workbook) | `/me/scopus-pull` greyed paid papers, nothing on the server | the server accepted the claim | `own_standing` returns "You were paid for this paper in May 2026" for the person's own PAID claim and for a `PriorPayment` with the same DOI or exact title **and the same staff id** (never fuzzy, never a colleague's) | `test_safeguards_claims.AlreadyPaidOrRefused` |
| Re-filing a paper that was sent back or not accepted | `patch_claim` refused editing a refused claim | **Owner's rule: a refusal never blocks filing again** | `own_standing` ignores REJECTED claims entirely (sent back and not accepted), and the DB rule leaves REJECTED out for the same reason; a later resubmit of the old claim beside a new filed one gets a plain 409 | `AlreadyPaidOrRefused.test_a_rejected_or_not_accepted_claim_never_blocks_filing_again`, `core.tests.AuthorProfileBrowseTests.test_a_rejected_ticket_does_not_block_refiling` |
| Two drafts, or two submits racing | `_check_mandatory_fields` only | race unguarded | a draft is **told, never refused** (a submit that fails its checks leaves one behind, and the retry must work); only a filed claim holds the paper, and the unique index decides a race | `SamePersonSamePaper.test_a_draft_is_told_not_refused...`, `...test_the_database_holds_when_two_requests_race...` |
| The form must tell the claimant at the moment they pick the paper | `lookup/paper` returned `already_filed` for the DOI only; `lookup/candidates` only own non-rejected claims | no paid, sent-back, not-accepted or ledger state; no sentence | both endpoints use `own_standing`; `already_filed` and each candidate carry `code`, `message`, `blocks`; the finder (`pages/filing/finder.tsx`) shows the sentence and disables filing. No desk named: the stage is the faculty stage | `WhatTheFilingFormSays`, `frontend2/src/pages/filing/finder.test.tsx` |
| Old ERP repeats (the 7 low-confidence earlier-payment candidates in `erp-amount-matches.csv`, read only) | `DuplicateFinding` sweep, run by hand | the sweep was never scheduled, and nothing showed its open count beside the money | the daily job runs `find_duplicate_payments` (idempotent, keeps reviewed decisions) and the check `repeat_payments` lists open SAME_PERSON findings with the repeated sum; fix link `/duplicates`. Imported (`ERP-`) claims are **excluded** from the DB unique index on purpose: the workbook records real double payments and a rebuild must keep every one so its total reconciles | `test_safeguards_checks.SgChecks.test_papers_paid_twice_come_from_the_sweep`, `test_safeguards_claims...test_the_database_rule_is_case_blind_and_leaves_drafts_sent_back_and_history_alone` |
| A duplicate warning set aside by one person | `_needs_second_approval` (`api/common.py:620`), `_guard_self_cleared_override` (`api/journals.py:812`) | enforced at pay time only | the check `override_unseconded` finds any that reached approval or payment without a different second approver | `SgChecks.test_a_warning_set_aside_with_no_second_approver` |

## 2. Paying twice

| Risk | Current guard | Gap found | Fix | Test |
|---|---|---|---|---|
| Double-click | claim row lock; status check (`api/director.py:482`) | on SQLite nothing but the status read | one live payment per claim: partial unique index `one_payment_per_claim_cycle` (`models.py:1236`) over `(claim, cycle)` where kind is PAYMENT; refusal says "Already paid in October" with the date, code `already_paid` | `test_safeguards_pay.DoubleClickAndRetry`, `TwoSessionsAtOnce` |
| Two Finance sessions at once | `select_for_update` (a no-op on SQLite) | on SQLite the second request could pass every check | the index catches it and the loser gets `already_paid`, one row on the ledger. On PostgreSQL the lock makes it wait; a threaded test runs there | `TwoSessionsAtOnce.test_a_request_that_passed_every_check_still_cannot_pay_twice`, `TwoSessionsOnPostgres` (skipped on SQLite) |
| Retry after a timeout | none: the retry got "Already processed" and the person could not tell if it had worked | no idempotency | the dialog makes a key once and resends it; the key is stored **on the ledger row the payment wrote** (`models.py:1213`, unique), so a retry gets the first answer back (`replayed: true`). A key reused for another claim is refused | `DoubleClickAndRetry` |
| Bulk pay replay | per-row guards; skipped rows named | a replay of a half-finished batch had no memory | one key per batch, derived per claim (`api/director.py:802`); the replay reports `paid`, `replayed`, `skipped` with codes | `BulkReplay` |
| Re-pay after void | void wrote a negative row; pay checked the **net** | a double void, or pay-void-pay-pay, relied on the claim status alone | ledger rows are append-only with a `cycle`: PAYMENT n, REVERSAL n, PAYMENT n+1. `one_reversal_per_claim_cycle` stops a double void; the second re-pay is `already_paid` | `RePayAfterVoid` |
| Amount changed after authorisation | `_guard_recomputed_amount` compared with what **the screen** showed | a figure that moved since the Director signed was paid if Finance's screen was fresh | the Director's step writes `authorised_amount` (`models.py:817`, `api/director.py:103`, `:292`). At pay time any difference in the policy amount sends the claim back to the Principal, writes `PAYMENT_BLOCKED_AMOUNT_CHANGED`, tells the Principal and pays nothing. The research threshold's own re-ordering moves only the split, never this figure | `AmountLockedAtAuthorisation` |
| Paying an inactive person | none | Finance could pay an account that was switched off | Finance is refused (`owner_inactive`); a super admin may, with a reason of 10+ characters recorded in the `LEDGER_PAYMENT` audit row | `InactiveAndSeparation` |
| A ledger row with no claim that is the same paper, same person | `ledger_checks.matches_for_claim` showed it to the cell | pay did not look | pay (and `pay-check`) look at the same person's other paid claims and the workbook's payments (`services/payment_guards.py`); 409 `paid_before` "already on the payment ledger, paid in March 2025". Passes only if the warning was set aside **and** a different second person agreed. A co-author's payment never matches. Wording says "ledger", never "flagged" (`core.visibility`) | `AlreadyOnTheLedger` |
| Money on the ledger for a claim not marked paid (half-written state) | none | pay would pay on top | `already_paid_answer` refuses; the daily check lists it (`ledger_unpaid`) | `HalfWrittenState`, `SgChecks.test_money_on_the_ledger_for_a_claim_not_paid` |
| A correction or a linked row becoming a second payment | `ledger_checks.add_missing`, `link_row`, `claim_fixes`, admin edit wrote plain positive rows | would now collide with the index, or silently double | corrections are kind ADJUSTMENT (`payment_guards.attach_row`, `ledger_checks`, `claim_fixes`, `api/superadmin.py`); an orphan linked to a claim that already has a payment becomes an ADJUSTMENT | `TheImporters.test_a_linked_ledger_payment...` |
| Bank file generated twice for the same run | none | a second download is how a month is paid twice | `BankExport` records each file and the ledger rows it carried. The first file is plain; after that the file is refused (409 `already_exported`, "already generated on 3 May by X, 2 payments since") until the person picks **new only** or **the whole month again with a reason**; each is an audit row. Two people pressing together take turns (row lock) | `TheBankFile` |
| Status rescue putting a refused claim back beside a filed one | `override_status` (`api/director.py:985`) | would 500 on the new index | 409 with the reason | covered by `SamePersonSamePaper` race tests |

## 3. Separation of duties

| Risk | Current guard | Gap found | Fix | Test |
|---|---|---|---|---|
| Nobody acts on their own claim | `_refuse_own_claim` (`api/common.py:395`) on every desk action, void, link, add-row, pay | the new `pay-check` and bank paths | `pay-check` answers `own_claim`; no new path touches a claim without the guard. Every path checked: clear, bulk-clear, approve, bulk-approve, authorise, bulk-authorise, pay, bulk-pay, void, override-status, second-approve, link row, add row, data fix, admin edit | `InactiveAndSeparation.test_nobody_pays_their_own_claim...`, `test_dual_roles`, `test_security_rules.OwnClaim` |
| The person who authorised also pays | none | a super admin could authorise and pay in two clicks | refused unless a super admin stands in **with a recorded reason**; Finance never. Reason is in the `LEDGER_PAYMENT` audit row; the check `self_paid` lists the cases | `InactiveAndSeparation`, `SgChecks.test_paid_by_the_person_who_authorised_it` |
| Voids | super admin only, reason 10+ characters (`api/director.py:914`) | verified; the reversal now also writes `LEDGER_REVERSAL` | unchanged rule, one more audit row | `RePayAfterVoid.test_a_void_needs_a_reason_and_a_super_admin` |
| Issuing passwords twice | super admin only, rate limit 5 an hour, not while viewing as someone (`api/admin.py:412`) | a double-click replaced the passwords the first click had just handed out, so the downloaded list stopped working | same scope by the same person within 2 minutes is refused (409) and the audit row is written in the same transaction as the passwords | `test_issue_passwords.RealRun` |

## 4. Audit

| Risk | Current guard | Gap found | Fix | Test |
|---|---|---|---|---|
| A money-moving act with no record | `_transition` writes `ClaimAction` + `AuditLog` (`api/journals.py:686`) | the audit row said the status moved, not what was paid | `LEDGER_PAYMENT` (amount, cycle, authorised, voucher, key, stood-in reason), `LEDGER_REVERSAL`, `BANK_EXPORT`, `PAYMENT_BLOCKED_AMOUNT_CHANGED`, `SAFEGUARD_CHECK`; ledger link/add rows already audited | `TheAuditTrail.test_every_money_moving_action_writes_its_own_audit_row` |
| Audit rows edited or deleted | the data explorer and data removal refuse (`api/data_removal.py:30`) | nothing at the model or database | model `save`/`delete` refuse; queryset `update`/`delete` refuse (`models.py:1291`); on PostgreSQL a trigger (migration 0075) refuses UPDATE and DELETE except Django's SET NULL when an account is removed; no API route can edit or delete (asserted from the OpenAPI schema). The trigger could not be run here (no PostgreSQL), so it is installed inside a savepoint and its test is skipped on SQLite | `TheAuditTrail` |
| Silent drift: claims PAID without ledger, ledger without claim, duplicate live rows, amount mismatches, threshold over-absorption | `integrity.run_audit` (nightly data health) had some | no check for duplicate live payments, drift, threshold, bank repeats, missing DB rules | `services/safeguards.py`: 17 checks, scheduled daily (`core.tasks.run_safeguard_check`, migration 0075), stored, audited, notifies super admins only when errors increase. Shown on **Safeguards**, the readiness checklist, and the Faults screen (group "Money safeguards": counts from the last run, one stored read, so the screen stays cheap; the list behind each count is the live query) | `SgChecks`, `TheReportAndWhoSeesIt` |
| A migration skipping a constraint because bad data existed | 0062 pattern: print and carry on | nobody reads a deploy log | the migration never fails; the check `db_constraints` reports each missing rule every day, with the command to add it once the rows are resolved | `TheMigrationIsSafeOnBadData` |
| A backup from before 0075 that cannot be restored | none | old ledger rows all load as "payment, cycle 1" and collide | `services/restore_upgrade.py` gives them the kind and cycle migration 0075 would have | `RestoringAnOldBackup` |

## 5. Imports and bulk tools

| Risk | Current guard | Gap found | Fix | Test |
|---|---|---|---|---|
| `rebuild_from_erp --confirm` wipes every claim and ledger row | `--confirm` flag | it also erased payments Finance had made here, which the workbook does not contain, so the next run paid them again | refused when any `MARK_PAID` or `LEDGER_PAYMENT` record exists unless `--erase-live-payments` | `TheImporters` |
| Re-running the payment-history import | skip rows with the same title, DOI and amount | two co-authors paid the same amount for one paper: the second was dropped | the key includes the person | `TheImporters.test_the_payment_history_import...` |
| Calculator "check every claim" | read only | none found | asserted read only | `TheImporters.test_the_calculator_check_of_every_claim_writes_nothing` |
| Bulk clear / authorise / hold | one transaction and one lock per row, own claims and changed amounts skipped with a reason | none found | unchanged; authorise now records the amount | `test_chain_rules`, `test_queue_tools` |

## What is deliberately not done

* **No block on co-authors.** Policy is unclear; see section 1. The cell is told, the claimant is not.
* **No SQLite audit trigger.** A SQLite trigger would break the three `TransactionTestCase` flushes; the model and queryset guards still hold there.
* **Claims authorised before this release** are backfilled with the amount they stand at; any left null are not locked.
* The unique index on filed claims leaves `ERP-` claims out (history, not filings).

## Running it

* Nightly at 03:45 (`safeguards-daily`), or **Check now** on the Safeguards page.
* `manage.py shell -c "from core.services import safeguards; print(safeguards.run_audit()['problems'])"`.
* A missing database rule: resolve the rows the check lists, then
  `python manage.py migrate core 0074 && python manage.py migrate`.
