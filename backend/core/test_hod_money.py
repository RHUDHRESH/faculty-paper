"""`MONEY_KEYS` has to name every word the code actually emits.

`without_money()` is a denylist, and a denylist is only as good as its
knowledge of the vocabulary. The set listed `base_amount` and `qf_amount` --
the names those figures carry on a `Claim` -- and not `base` and `qf`, the
names `discover.estimate_payout` gives the same two numbers. So a payout
estimate routed through the filter arrived at a head of department with the
base amount and the quartile factor intact, and only the total removed. That
is most of the way back to the total for anybody who can multiply.

Nothing was leaking in production: `/discover/venues` is behind
`_require_may_see_money`, which refuses a head outright. But the filter is the
last line rather than the only one, and it was quietly holed.

These tests are generative on purpose. Asserting "base is in MONEY_KEYS" would
have to be written again for the next short key somebody invents; asking the
functions themselves what they emit does not.
"""
from __future__ import annotations

import json

from django.test import TestCase

from core.hod import MONEY_KEYS, without_money
from core.models import FormulaConfig
from core.services.discover import estimate_payout
from core.services.remuneration import DEFAULT_AUTHOR_POINTS


class MoneyKeyVocabularyTests(TestCase):
    """Every money-bearing key a service emits must be one the filter knows."""

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
            active=True,
            name="Policy v1",
            version=1,
        )

    def test_estimate_payout_emits_nothing_the_filter_cannot_see(self):
        """The regression this file exists for.

        Asks the function for its own key set rather than hardcoding one, so a
        figure added to the estimate later is covered the day it is added.
        """
        payout = estimate_payout(quartile="Q1", snip=1.0, total_authors=1, author_position=1)
        self.assertIsInstance(payout, dict)

        # Every key this function emits, not only the numeric ones. Its whole
        # job is pricing, so a sentence it returns ("carries no remuneration")
        # is as money-revealing as the figure it explains -- and `category` is
        # the payout band written as a roman numeral.
        unguarded = set(payout) - MONEY_KEYS
        self.assertEqual(
            unguarded,
            set(),
            f"estimate_payout emits {sorted(unguarded)}, which without_money() "
            "does not know about -- a head of department would receive them",
        )

    def test_the_whole_estimate_is_stripped_not_merely_the_total(self):
        payout = estimate_payout(quartile="Q1", snip=1.0, total_authors=1, author_position=1)
        stripped = without_money({"title": "A Journal", "quartile": "Q1", "payout": payout})

        self.assertEqual(stripped["quartile"], "Q1", "the academic fact should survive")
        self.assertEqual(
            stripped["payout"], {},
            "a figure survived the filter; the estimate is still readable",
        )

    def test_both_spellings_of_the_same_two_figures_are_listed(self):
        """`base`/`qf` and `base_amount`/`qf_amount` are the same numbers under
        the names two different modules give them. Listing one pair and not the
        other is exactly how this went wrong."""
        for short, long in (("base", "base_amount"), ("qf", "qf_amount")):
            self.assertIn(long, MONEY_KEYS)
            self.assertIn(
                short, MONEY_KEYS,
                f"{long!r} is guarded but {short!r} is not, and they are the same figure",
            )

    def test_the_filter_reaches_into_nested_structures(self):
        """A key one level down is the case a flat filter misses."""
        stripped = without_money(
            {
                "rows": [
                    {"title": "One", "payout": {"base": 55000.0, "qf": 50000.0}},
                    {"title": "Two", "amount": 12345.0},
                ]
            }
        )
        raw = json.dumps(stripped)
        for figure in ("55000", "50000", "12345"):
            self.assertNotIn(figure, raw, f"{figure} survived inside a nested structure")
