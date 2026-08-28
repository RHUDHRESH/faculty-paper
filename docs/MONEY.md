# Decisions about money

A record of choices that change, or deliberately do not change, what somebody
is paid. Money decisions outlive the conversation they were made in, and a
system holding 3,141 settled payments across 351 people needs its reasoning
written down rather than reconstructed from a diff.

Figures here were read from the live database on 2026-08-28 and are stated with
the query that produced them, so they can be re-checked rather than believed.

---

## Almost no paid amount was produced by this formula

**This is the first thing to know before reading anything else here.**

```
PAID claims                3,141
  with a priced breakdown      4
  historical, no breakdown 3,137
```

3,137 of 3,141 settled claims carry no `base_amount`, no `qf_amount` and no
`remuneration_category`. Their amounts arrived through `rebuild_from_erp` as
figures the previous ERP had already decided. This system stores them; it did
not work them out.

So "would the fixed formula pay this differently?" is, for almost every settled
claim, the wrong question — there is no old formula output to differ *from*.
The comparison only becomes meaningful for the 4 priced claims and for
everything filed from here on.

---

## The cliff, and the sixteen claims sitting in it

Property testing found the payout curve was not monotonic across zero. A
journal with **no** SNIP fell to Category II's flat ₹5,000; a journal with a
genuine but small SNIP was priced `SNIP × 55,000`, which is less than ₹5,000
for every SNIP below `5000/55000 = 0.0909`. A journal was therefore worse off
for having earned a modest SNIP than for having none at all. Category III had
the same cliff at `4000/55000 = 0.0727`.

Fixed with a floor: Category I never pays less than the no-SNIP rate the same
article would have fallen back to.

**Sixteen paid claims sit in that SNIP band** (`0 < snip < 0.0909`), all Q4, at
SNIP 0.068–0.08. Every one of them has `remuneration_category = None` — they
are historical ERP rows, so the cliff never applied to them and the floor
changes nothing about what they were paid.

The narrower figure worth recording is that **six** of them would compute a
different amount if they were priced today. They will not be: every recompute
path refuses a settled claim before reaching the formula — `recalculate_claim`
and `_verify_claim` both raise on `status == PAID`, manual verification does
the same, and clear/approve/pay each gate on their predecessor status.

That leaves a decision nobody should take on a claimant's behalf:

- **Leave them.** They were paid what the previous system decided. Nothing in
  this application is inconsistent; only history and a formula that never
  priced them disagree.
- **Reprice and pay the difference.** Defensible only if the research cell
  decides the old ERP figure was itself wrong, which is a much larger question
  than this defect.
- **Record the divergence on each ticket** so it is visible where the claim is,
  not only in this file.

The research cell and finance own that choice. It is written down here so it
is a decision somebody makes rather than one that quietly makes itself.

## Fixes that were checked for reaching settled money, and did not

Every money fix in this round was tested against the live database for whether
it could move a settled amount. The check matters more than the answer, so
both are here.

| Fix | Could it reach a paid claim? |
|---|---|
| Largest-remainder share allocation | **No.** All 3,141 paid claims are single-author, and a sole author's share is the whole base. The allocation cannot change any of them arithmetically. |
| SNIP floor | **Sixteen paid rows sit in the band, six would price differently** — see above. All PAID, all historical, all unreachable behind `status == PAID` guards. |
| Quota gap / year-change / race | **No.** Zero claims in the database carry a `quota_position`, so none of it touches a live row. |
| `normalize_doi` idempotence | **No**, but it changes duplicate *detection*: a doubled `https://doi.org/` prefix previously defeated it, so the same paper could be paid twice. Nothing is repriced; a hole is closed. |

The quota renumbering additionally refuses to run at all if any paper whose
position would move is `PAID`. Renumbering only moves positions down, and down
can only move a paper from outside a quota to inside it — a downward
repricing of money already gone. Where that would happen, the gap is left open
instead.

---

## The ₹0 filing trap

**Status: closed, by refusing the submission.**

Three rules disagreed about what evidences an SEC-affiliated reference:

- `_check_mandatory_fields` was satisfied by `claim.sec_refs` (a text field) or
  a `sec_proof_url`
- `_apply_calc` counted only `SEC_REFERENCE` attachments carrying a
  `ref_number`, and wanted `min_sec_references` of them

So a claim passed every gate, reached Finance, and was worked out as **₹0**,
with a note telling the claimant they had cited 0 references while the form in
front of them said 3.

The formula is the policy, so the gate was the thing that was wrong. It now
asks for what the formula counts.

**No claim's amount changed.** The claims this refuses were already paying
nothing; the difference is that the claimant is told while the paper is still
open in front of them rather than a month later. `COUNT_ONLY` remains the
supported way to file a paper for the record with no money attached, and is
exempt.

---

## Money-blindness is a denylist, and denylists rot

`hod.MONEY_KEYS` names every key that carries a rupee figure or reveals that
money moved; `without_money()` strips them on the way out. It is only as good
as its knowledge of the vocabulary, and it was found holed: it listed
`base_amount` and `qf_amount` — the names those figures carry on a `Claim` —
and not `base` and `qf`, the names `discover.estimate_payout` gives *the same
two numbers*. Same for `category` and `note`.

A payout estimate routed through the filter therefore reached a head of
department with the base amount and the quartile factor intact and only the
total removed, which is most of the way back to the total.

Nothing was leaking in production, because `/discover/venues` refuses a head
outright. But the filter is the last line rather than the only one.

**If you add a field that carries or implies an amount, add its name here** —
including the short form, if a service emits the same number under a different
word. `core/test_hod_money.py` asks `estimate_payout` what it emits rather
than hardcoding a list, so that particular function is now self-policing; no
such guard exists for the others.
