"""What a Head of Department may see: their own department, and no money.

The HoD role existed as a relic with no permissions at all -- an account
holding it could sign in and do nothing. It now has a real job: a head needs
to know what their department is publishing, where, and by whom, and to pull
that into a spreadsheet for a review meeting.

What they must never see is what anybody was paid. That is somebody's
remuneration, and a head is not in the payment chain. So money-blindness is
enforced here, in one place, rather than by remembering to leave a column out
of each of four endpoints:

- MONEY_KEYS lists every key that carries a rupee figure or reveals that a
  payment happened. `without_money()` removes them from anything on its way
  out, and a test asserts that no HoD response anywhere contains one.
- Status is translated rather than passed through. "PAID" tells a head their
  colleague was paid; "Completed" tells them the ticket finished, which is
  the part that is their business.

Academic metrics stay: quartile, SNIP, indexing, counts. Those are what the
department is actually being asked about, and they are properties of the
journal rather than of somebody's bank account.
"""
from __future__ import annotations

from typing import Any

#: Every key carrying a rupee figure, or revealing that money moved.
MONEY_KEYS = frozenset({
    "remuneration",
    "remuneration_category",
    "remuneration_note",
    "remuneration_is_estimate",
    "qf_amount",
    "base_amount",
    # The same two figures under the names `discover.estimate_payout` gives
    # them. It returns `amount`, `author_point`, `base` and `qf`; only the
    # first two were listed here, so a payout estimate routed through
    # `without_money` arrived with the base amount and the quartile factor
    # intact and just the total removed -- which is most of the way to the
    # total, for anybody who can multiply.
    #
    # A short key is easy to miss precisely because it does not look like a
    # money field. That is the argument for listing both spellings rather than
    # renaming one: this set has to match the words the code actually emits.
    "base",
    "qf",
    # And the rest of that same dict. `category` is the payout band ("Category
    # I"), `note` and `why_not` are sentences about whether money is due and
    # why -- "carries no remuneration" tells a head exactly what the figure
    # would have been for. Their long forms `remuneration_category` and
    # `remuneration_note` were already listed, which is the tell: the same
    # facts under shorter names, missed because the short names do not read
    # like money.
    "category",
    "note",
    "why_not",
    "author_point",
    "voucher_number",
    "paid_at",
    "payout_month",
    "amount",
    "amount_paid",
    "total_amount",
    "extra_amount",
    "recovered_amount",
    "paid_amount",
    "committed",
    "allocated",
    "spent",
})

#: What a head sees instead of the workflow's own status names. A head needs
#: to know whether a ticket is done, not which desk it is on -- and "PAID"
#: says a colleague was paid.
PROGRESS = {
    "DRAFT": "Not yet filed",
    "SUBMITTED": "Under review",
    "CLEARED": "Under review",
    "PRINCIPAL_APPROVED": "Approved",
    "DIRECTOR_APPROVED": "Approved",
    "PAID": "Completed",
    "REJECTED": "Sent back",
    "HOD_APPROVED": "Under review",
    "RESEARCH_APPROVED": "Under review",
    "FINANCE_APPROVED": "Approved",
}


def without_money(value: Any) -> Any:
    """The same structure with every money-bearing key removed.

    Recursive on purpose: a claim arrives as a dict, a list of claims as a
    list of them, and a report as a dict of lists. Filtering only the top
    level would have let an amount through inside any nested row.
    """
    if isinstance(value, dict):
        return {
            k: without_money(v)
            for k, v in value.items()
            if k not in MONEY_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [without_money(v) for v in value]
    return value


def progress_of(status: str | None) -> str:
    return PROGRESS.get(status or "", "Under review")


def department_of(user) -> str:
    """The one department a head may look at.

    Read from their own account and never from a request parameter: a head
    asking for another department's figures is not a filter, it is a
    different question with a different answer.
    """
    return (getattr(user, "department", "") or "").strip()
