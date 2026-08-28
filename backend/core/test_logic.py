"""Property-based and boundary tests for the pure money logic.

These are deliberately not more example tests. `core/tests.py` already pins
down what the calculator does for the cases somebody thought of. What follows
asserts the *shape* of the answer over whole input spaces — that it is money at
all, that it moves the direction the policy says it moves, and that it lands on
the boundary rather than one side of it.

Where a property genuinely does not hold, the test is kept and marked
`@expectedFailure` with a comment naming the defect, so the suite stays green
while the defect stays on the record. Search this file for "DEFECT" to find
them all.

The remuneration and normalisation tests use `SimpleTestCase` (no database) so
Hypothesis can drive thousands of examples without a transaction per example.
Example budgets are kept small on purpose — the rest of the suite is long
enough already.
"""
from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from unittest import expectedFailure

from django.test import SimpleTestCase, TestCase
from django.contrib.auth import get_user_model

from hypothesis import HealthCheck, assume, given, settings, strategies as st

from core.services.remuneration import (
    CATEGORY_LABELS,
    DEFAULT_AUTHOR_POINTS,
    MAX_ELIGIBLE_AUTHORS,
    MIN_SEC_REFERENCES,
    Category,
    FormulaConfigInput,
    author_point,
    calculate_remuneration,
    format_inr,
    formula_from_model,
    qf_for,
    round2,
    snapshot_formula,
)
from core.services.normalize import (
    issn_check_digit_ok,
    normalize_doi,
    normalize_issn,
    normalize_title,
    title_tokens,
    titles_rough_match,
)

User = get_user_model()

#: Bounded and derandomised: a payroll test that gives a different answer on
#: every run is a test nobody will trust the day it does fail.
PROP = settings(
    max_examples=60,
    deadline=None,
    derandomize=True,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much],
)
WIDE = settings(
    max_examples=200,
    deadline=None,
    derandomize=True,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much],
)

CFG = FormulaConfigInput()

QUARTILES = ["Q1", "Q2", "Q3", "Q4"]
PUB_TYPES = [
    None,
    "Journal",
    "Conference Proceeding",
    "Book Series",
    "Book Chapter",
    "Other",
    "Journal, Book Series",
]
INDEXING = [None, "Scopus", "SCIE", "ESCI", "Scopus, SCIE", "Web of Science", "UGC Care"]
ENG = [None, "Engineering", "Non-Engineering"]


def price(**kw):
    """`calculate_remuneration` with keyword-only positional arguments."""
    return calculate_remuneration(
        kw.pop("snip", None),
        kw.pop("quartile", None),
        kw.pop("total_authors", 1),
        kw.pop("author_position", 1),
        kw.pop("cfg", CFG),
        **kw,
    )


def is_money(x) -> bool:
    """A number that could be printed on a payment advice."""
    return isinstance(x, (int, float)) and math.isfinite(x) and x >= 0


# ---------------------------------------------------------------------------
# 1. calculate_remuneration — the amount is always money
# ---------------------------------------------------------------------------


class AmountIsAlwaysMoneyTests(SimpleTestCase):
    """Whatever goes in, what comes out is a non-negative finite rupee figure
    or an explicit refusal — never a negative, never NaN, never infinity, and
    never an exception."""

    @WIDE
    @given(
        snip=st.one_of(
            st.none(),
            st.floats(allow_nan=True, allow_infinity=True),
            st.integers(min_value=-10**6, max_value=10**6),
        ),
        quartile=st.one_of(st.none(), st.sampled_from(QUARTILES), st.text(max_size=8)),
        total_authors=st.one_of(
            st.integers(min_value=-5, max_value=40), st.none(), st.text(max_size=3)
        ),
        author_position=st.one_of(
            st.integers(min_value=-5, max_value=40), st.none(), st.text(max_size=3)
        ),
        student=st.booleans(),
        pub=st.one_of(st.sampled_from(PUB_TYPES), st.text(max_size=20)),
        idx=st.one_of(st.sampled_from(INDEXING), st.text(max_size=20)),
        eng=st.one_of(st.sampled_from(ENG), st.text(max_size=20)),
        refs=st.one_of(st.none(), st.integers(min_value=-5, max_value=20)),
    )
    def test_amount_is_never_negative_nan_or_infinite(
        self, snip, quartile, total_authors, author_position, student, pub, idx, eng, refs
    ):
        r = price(
            snip=snip,
            quartile=quartile,
            total_authors=total_authors,
            author_position=author_position,
            is_student_publication=student,
            publication_type=pub,
            indexing_level=idx,
            engineering_class=eng,
            sec_reference_count=refs,
        )
        for name in ("base", "remuneration", "qf", "point"):
            v = getattr(r, name)
            if v is None:
                continue
            self.assertFalse(isinstance(v, float) and math.isnan(v), f"{name} is NaN")
            self.assertTrue(math.isfinite(v), f"{name} is infinite: {v!r}")
            self.assertGreaterEqual(v, 0.0, f"{name} is negative: {v!r}")

    @WIDE
    @given(
        snip=st.one_of(st.none(), st.floats(min_value=0, max_value=30, allow_nan=False)),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
        eng=st.sampled_from(ENG),
    )
    def test_a_refusal_carries_a_reason_and_no_number(
        self, snip, quartile, total, pub, idx, eng
    ):
        """If the calculator declines to price something it must say so, and
        must not leave a half-computed amount behind."""
        r = price(
            snip=snip,
            quartile=quartile,
            total_authors=total,
            author_position=total,
            publication_type=pub,
            indexing_level=idx,
            engineering_class=eng,
        )
        if r.error:
            self.assertIsNone(r.remuneration)
            self.assertIsNone(r.base)
        else:
            self.assertIsNotNone(r.remuneration)
            self.assertIn(r.category, CATEGORY_LABELS)

    @PROP
    @given(
        snip=st.one_of(st.none(), st.floats(min_value=0, max_value=30, allow_nan=False)),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pos=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
        eng=st.sampled_from(ENG),
        refs=st.one_of(st.none(), st.integers(min_value=0, max_value=5)),
    )
    def test_remuneration_is_exactly_base_times_point(
        self, snip, quartile, total, pos, pub, idx, eng, refs
    ):
        """The ticket shows base, point and amount. They must agree, or the
        explanation on the ticket is a fiction."""
        assume(pos <= total)
        r = price(
            snip=snip,
            quartile=quartile,
            total_authors=total,
            author_position=pos,
            publication_type=pub,
            indexing_level=idx,
            engineering_class=eng,
            sec_reference_count=refs,
        )
        if r.error:
            return
        self.assertAlmostEqual(r.remuneration, round2(r.base * r.point), places=6)

    @PROP
    @given(
        snip=st.one_of(st.none(), st.floats(min_value=0, max_value=30, allow_nan=False)),
        quartile=st.sampled_from([None] + QUARTILES + ["", "Others", "junk"]),
        total=st.integers(min_value=1, max_value=9),
        pos=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
        eng=st.sampled_from(ENG),
        refs=st.one_of(st.none(), st.integers(min_value=0, max_value=5)),
        student=st.booleans(),
    )
    def test_the_same_input_twice_gives_the_same_rupee_figure(
        self, snip, quartile, total, pos, pub, idx, eng, refs, student
    ):
        kw = dict(
            snip=snip,
            quartile=quartile,
            total_authors=total,
            author_position=pos,
            publication_type=pub,
            indexing_level=idx,
            engineering_class=eng,
            sec_reference_count=refs,
            is_student_publication=student,
        )
        a, b = price(**kw), price(**kw)
        self.assertEqual(a, b)
        # Also stable against a freshly built config with the same defaults.
        self.assertEqual(a, price(cfg=FormulaConfigInput(), **kw))


# ---------------------------------------------------------------------------
# 2. Author position and the author-point share table
# ---------------------------------------------------------------------------


class AuthorShareTests(SimpleTestCase):
    def test_shares_for_an_author_count_never_exceed_the_whole_paper(self):
        """The whole point of the table: the paper is divided, not multiplied."""
        for total in range(1, MAX_ELIGIBLE_AUTHORS + 1):
            shares = []
            for pos in range(1, total + 1):
                pt, err = author_point(total, pos)
                self.assertIsNone(err, f"{total} authors, position {pos}: {err}")
                shares.append(pt)
            self.assertLessEqual(
                sum(shares), 1.0 + 1e-9, f"{total} authors share more than the paper"
            )

    def test_being_an_earlier_author_never_pays_less(self):
        for total in range(1, MAX_ELIGIBLE_AUTHORS + 1):
            prev = None
            for pos in range(1, total + 1):
                pt, _ = author_point(total, pos)
                if prev is not None:
                    self.assertLessEqual(
                        pt, prev, f"{total} authors: position {pos} beats position {pos - 1}"
                    )
                prev = pt

    @PROP
    @given(
        snip=st.floats(min_value=0.1, max_value=30, allow_nan=False),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
        eng=st.sampled_from(ENG),
    )
    def test_earlier_author_never_paid_less_in_rupees(
        self, snip, quartile, total, pub, idx, eng
    ):
        amounts = []
        for pos in range(1, total + 1):
            r = price(
                snip=snip,
                quartile=quartile,
                total_authors=total,
                author_position=pos,
                publication_type=pub,
                indexing_level=idx,
                engineering_class=eng,
            )
            if r.error:
                return
            amounts.append(r.remuneration)
        for i in range(1, len(amounts)):
            self.assertLessEqual(
                amounts[i], amounts[i - 1] + 1e-9, f"position {i + 1} beats position {i}"
            )

    def test_position_beyond_the_author_count_is_refused(self):
        pt, err = author_point(3, 4)
        self.assertIsNone(pt)
        self.assertIn("cannot exceed", err)

    def test_zero_and_negative_positions_are_refused(self):
        for total, pos in ((0, 1), (-1, 1), (3, 0), (3, -2)):
            pt, err = author_point(total, pos)
            self.assertIsNone(pt, f"({total}, {pos}) priced")
            self.assertTrue(err)

    def test_a_scalar_author_point_rule_applies_to_every_position(self):
        cfg = FormulaConfigInput(author_points={"3": 0.4})
        for pos in (1, 2, 3):
            self.assertEqual(author_point(3, pos, cfg), (0.4, None))

    def test_a_default_rule_does_not_pay_a_position_it_has_no_row_for(self):
        cfg = FormulaConfigInput(author_points={"default": [0.6, 0.4]})
        self.assertEqual(author_point(2, 2, cfg), (0.4, None))
        pt, err = author_point(5, 4, cfg)
        self.assertIsNone(pt)
        self.assertIn("position 4 of 5", err)


class MaxEligibleAuthorsBoundaryTests(SimpleTestCase):
    """`MAX_ELIGIBLE_AUTHORS` is a cliff, so it is tested on the cliff."""

    def _paid(self, total, cfg=None):
        return price(
            snip=1.0,
            quartile="Q1",
            total_authors=total,
            author_position=1,
            cfg=cfg or CFG,
            publication_type="Journal",
            indexing_level="Scopus",
        )

    def test_nine_authors_is_eligible_and_ten_is_not(self):
        self.assertEqual(MAX_ELIGIBLE_AUTHORS, 9)
        self.assertIsNone(self._paid(9).error)
        self.assertIsNotNone(self._paid(9).remuneration)
        over = self._paid(10)
        self.assertIsNone(over.remuneration)
        self.assertIn("more than 9 authors", over.error)

    def test_the_limit_moves_with_the_configured_limit(self):
        cfg = FormulaConfigInput(
            max_authors=4, author_points={str(n): [1.0 / n] * n for n in range(1, 6)}
        )
        self.assertIsNone(self._paid(4, cfg).error)
        self.assertIn("more than 4 authors", self._paid(5, cfg).error)

    def test_a_zero_limit_falls_back_to_the_policy_ceiling(self):
        cfg = FormulaConfigInput(max_authors=0)
        self.assertIsNone(self._paid(9, cfg).error)
        self.assertIn("more than 9 authors", self._paid(10, cfg).error)


# ---------------------------------------------------------------------------
# 3. SEC references
# ---------------------------------------------------------------------------


class SecReferenceBoundaryTests(SimpleTestCase):
    def _paid(self, refs, cfg=None):
        return price(
            snip=2.0,
            quartile="Q1",
            total_authors=3,
            author_position=1,
            cfg=cfg or CFG,
            publication_type="Journal",
            indexing_level="Scopus",
            sec_reference_count=refs,
        )

    def test_the_boundary_is_two_not_one_and_not_three(self):
        self.assertEqual(MIN_SEC_REFERENCES, 2)
        self.assertEqual(self._paid(1).remuneration, 0.0)
        self.assertGreater(self._paid(2).remuneration, 0.0)
        self.assertEqual(self._paid(2).remuneration, self._paid(3).remuneration)

    def test_unchecked_references_still_show_an_estimate(self):
        self.assertGreater(self._paid(None).remuneration, 0.0)

    def test_a_zeroed_paper_keeps_its_author_point_and_a_reason(self):
        r = self._paid(0)
        self.assertEqual(r.remuneration, 0.0)
        self.assertEqual(r.point, 0.5)
        self.assertIn("SEC-affiliated reference", r.note)
        self.assertEqual(r.category, Category.NONE)

    def test_the_singular_is_used_for_one_reference(self):
        self.assertIn("1 SEC-affiliated reference cited", self._paid(1).note)
        self.assertIn("0 SEC-affiliated references cited", self._paid(0).note)

    @PROP
    @given(
        snip=st.one_of(st.none(), st.floats(min_value=0.1, max_value=30, allow_nan=False)),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
    )
    def test_more_references_never_pays_less(self, snip, quartile, total, pub, idx):
        last = None
        for refs in range(0, 6):
            r = price(
                snip=snip,
                quartile=quartile,
                total_authors=total,
                author_position=1,
                publication_type=pub,
                indexing_level=idx,
                sec_reference_count=refs,
            )
            if r.error:
                return
            if last is not None:
                self.assertGreaterEqual(
                    r.remuneration, last - 1e-9, f"{refs} references pays less than {refs - 1}"
                )
            last = r.remuneration

    def test_a_zero_minimum_disables_the_gate(self):
        cfg = FormulaConfigInput(min_sec_references=0)
        self.assertGreater(self._paid(0, cfg).remuneration, 0.0)


# ---------------------------------------------------------------------------
# 4. SNIP
# ---------------------------------------------------------------------------


class SnipTests(SimpleTestCase):
    def _paid(self, snip, **kw):
        kw.setdefault("publication_type", "Journal")
        kw.setdefault("indexing_level", "Scopus")
        kw.setdefault("total_authors", 1)
        kw.setdefault("author_position", 1)
        return price(snip=snip, **kw)

    @PROP
    @given(
        a=st.floats(min_value=0.1, max_value=30, allow_nan=False),
        b=st.floats(min_value=0.1, max_value=30, allow_nan=False),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        eng=st.sampled_from(ENG),
    )
    def test_a_higher_snip_never_pays_less_inside_category_one(
        self, a, b, quartile, total, pub, eng
    ):
        lo, hi = min(a, b), max(a, b)
        kw = dict(
            quartile=quartile,
            total_authors=total,
            author_position=1,
            publication_type=pub,
            indexing_level="Scopus",
            engineering_class=eng,
        )
        rl, rh = self._paid(lo, **kw), self._paid(hi, **kw)
        self.assertIsNone(rl.error)
        self.assertIsNone(rh.error)
        self.assertGreaterEqual(rh.remuneration, rl.remuneration - 1e-9)

    def test_the_cap_is_inclusive(self):
        cap = CFG.snip_cap
        self.assertEqual(cap, 30)
        self.assertIsNone(self._paid(cap).error)
        self.assertIsNotNone(self._paid(cap).remuneration)
        over = self._paid(math.nextafter(cap, math.inf))
        self.assertIsNone(over.remuneration)
        self.assertIn("looks invalid", over.error)

    def test_the_cap_moves_with_the_configured_cap(self):
        cfg = FormulaConfigInput(snip_cap=12)
        self.assertIsNone(self._paid(12, cfg=cfg).error)
        self.assertIn("max 12", self._paid(12.0001, cfg=cfg).error)

    def test_a_zero_cap_falls_back_to_thirty(self):
        cfg = FormulaConfigInput(snip_cap=0)
        self.assertIsNone(self._paid(30, cfg=cfg).error)
        self.assertIsNotNone(self._paid(31, cfg=cfg).error)

    def test_a_negative_snip_is_refused_rather_than_priced(self):
        r = self._paid(-0.001)
        self.assertIsNone(r.remuneration)
        self.assertEqual(r.error, "SNIP cannot be negative")

    def test_an_infinite_snip_is_refused(self):
        self.assertIsNotNone(self._paid(float("inf")).error)

    def test_a_snip_of_exactly_zero_is_treated_as_no_snip(self):
        """Zero is not "a SNIP of zero"; it is the fixed journal rate."""
        self.assertEqual(self._paid(0).category, Category.JOURNAL_NO_SNIP)
        self.assertEqual(self._paid(0).remuneration, self._paid(None).remuneration)

    # ------------------------------------------------------------------
    # DEFECT 1 — the SNIP curve is not monotonic across the zero boundary.
    #
    # A Scopus journal with NO SNIP is paid the Category II fixed rate of
    # 5,000. The same journal with a genuine, small SNIP is priced at
    # SNIP x 55,000, which is less than 5,000 for every SNIP below
    # 5000/55000 = 0.0909... So a journal that earns a real (if modest)
    # SNIP is paid LESS than one that has none at all — 0.001 pays 55,
    # against 5,000 for no SNIP. The same cliff exists for Category III at
    # 4000/55000 = 0.0727.
    #
    # Real SNIPs in that range exist (new and low-citation journals sit
    # around 0.02-0.08), so this is money, not a curiosity. The policy's own
    # wording gives Category II to a journal "without SNIP", which the code
    # implements as "SNIP is falsy" — it never considers that a valid low
    # SNIP should not be punished for existing.
    #
    # Reported, not fixed: the correction is a policy question (a floor of
    # 5,000 on Category I, or Category II as a minimum), not a typo.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_a_higher_snip_never_pays_less_including_across_zero(self):
        no_snip = self._paid(None).remuneration
        tiny = self._paid(0.001).remuneration
        self.assertGreaterEqual(
            tiny,
            no_snip,
            f"SNIP 0.001 pays {tiny} but no SNIP at all pays {no_snip}",
        )

    def test_the_crossover_point_of_defect_one_is_where_arithmetic_says(self):
        """Locks the size of DEFECT 1 so a fix cannot shrink it silently."""
        crossover = CFG.fixed_journal_no_snip / CFG.snip_multiplier
        self.assertAlmostEqual(crossover, 0.0909, places=4)
        self.assertLess(self._paid(crossover * 0.99).remuneration, self._paid(None).remuneration)
        self.assertGreater(self._paid(crossover * 1.01).remuneration, self._paid(None).remuneration)


# ---------------------------------------------------------------------------
# 5. Quartiles
# ---------------------------------------------------------------------------


class QuartileTests(SimpleTestCase):
    def _paid(self, quartile, **kw):
        kw.setdefault("publication_type", "Journal")
        kw.setdefault("indexing_level", "Scopus")
        kw.setdefault("engineering_class", "Engineering")
        kw.setdefault("total_authors", 1)
        kw.setdefault("author_position", 1)
        return price(snip=2.0, quartile=quartile, **kw)

    def test_q1_beats_q2_beats_q3_beats_q4_beats_nothing(self):
        amounts = [self._paid(q).remuneration for q in QUARTILES]
        for i in range(1, len(amounts)):
            self.assertGreaterEqual(amounts[i - 1], amounts[i], f"Q{i} < Q{i + 1}")
        self.assertGreaterEqual(amounts[-1], self._paid(None).remuneration)

    @PROP
    @given(
        snip=st.floats(min_value=0.1, max_value=30, allow_nan=False),
        total=st.integers(min_value=1, max_value=9),
        pos=st.integers(min_value=1, max_value=9),
        idx=st.sampled_from(["Scopus", "SCIE", "ESCI", "Scopus, SCIE"]),
    )
    def test_the_quartile_order_holds_for_every_paper(self, snip, total, pos, idx):
        assume(pos <= total)
        amounts = []
        for q in QUARTILES + [None, "", "Others"]:
            r = price(
                snip=snip,
                quartile=q,
                total_authors=total,
                author_position=pos,
                publication_type="Journal",
                indexing_level=idx,
                engineering_class="Engineering",
            )
            self.assertIsNone(r.error)
            amounts.append(r.remuneration)
        for i in range(1, 4):
            self.assertGreaterEqual(amounts[i - 1], amounts[i] - 1e-9)
        # Q4 is still worth at least as much as no quartile / an unranked one.
        for unranked in amounts[4:]:
            self.assertGreaterEqual(amounts[3], unranked - 1e-9)

    def test_an_unranked_quartile_earns_no_incentive(self):
        """`qf_others` was retired; the QFA table has four rows and no more."""
        for q in (None, "", "Others", "No Quartile", "q1 ", "junk"):
            self.assertEqual(qf_for(q or "", CFG), 0.0, repr(q))
        self.assertEqual(qf_for("Q1", CFG), 50000)

    def test_the_quartile_is_matched_after_stripping_but_not_case_folded(self):
        self.assertEqual(qf_for(" Q1 ", CFG), 50000)
        self.assertEqual(qf_for("q1", CFG), 0.0)

    def test_the_incentive_applies_to_journals_only(self):
        for pub in ("Conference Proceeding", "Book Chapter", "Book Series"):
            r = self._paid("Q1", publication_type=pub)
            self.assertEqual(r.qf, 0.0, pub)
            self.assertIn("journals only", r.note or "")
        self.assertEqual(self._paid("Q1", publication_type="Journal").qf, 50000)

    def test_a_journal_that_is_also_a_proceeding_is_not_a_journal_for_qfa(self):
        self.assertEqual(self._paid("Q1", publication_type="Journal, Conference").qf, 0.0)

    def test_non_engineering_earns_no_incentive(self):
        r = self._paid("Q1", engineering_class="Non-Engineering")
        self.assertEqual(r.qf, 0.0)
        self.assertIn("Non-Engineering", r.note)

    def test_an_untyped_publication_is_treated_as_a_journal_for_qfa(self):
        """Behaviour lock, not an endorsement: `_is_journal` answers True for a
        publication with no type at all, so a paper filed with the type left
        blank collects the full Q1 incentive."""
        self.assertEqual(self._paid("Q1", publication_type=None).qf, 50000)

    def test_category_four_pays_the_incentive_on_top_of_the_fixed_base(self):
        r = self._paid("Q1", indexing_level="SCIE")
        self.assertEqual(r.category, Category.WEB_OF_SCIENCE)
        self.assertEqual(r.base, CFG.fixed_web_of_science + CFG.qf_q1)


# ---------------------------------------------------------------------------
# 6. The four categories
# ---------------------------------------------------------------------------


class CategoryTests(SimpleTestCase):
    def test_the_four_categories_land_where_the_policy_says(self):
        cases = [
            (dict(snip=2.0, indexing_level="Scopus", publication_type="Journal"), Category.SNIP),
            (
                dict(snip=None, indexing_level="Scopus", publication_type="Journal"),
                Category.JOURNAL_NO_SNIP,
            ),
            (
                dict(snip=None, indexing_level="Scopus", publication_type="Conference Proceeding"),
                Category.OTHER_NO_SNIP,
            ),
            (
                dict(snip=None, indexing_level="SCIE", publication_type="Journal"),
                Category.WEB_OF_SCIENCE,
            ),
        ]
        for kw, expected in cases:
            r = price(total_authors=1, author_position=1, **kw)
            self.assertEqual(r.category, expected, kw)

    def test_scopus_wins_over_web_of_science_when_a_paper_is_in_both(self):
        r = price(
            snip=2.0,
            total_authors=1,
            author_position=1,
            indexing_level="Scopus, SCIE",
            publication_type="Journal",
        )
        self.assertEqual(r.category, Category.SNIP)

    def test_no_indexing_at_all_is_assumed_to_be_scopus(self):
        r = price(snip=2.0, total_authors=1, author_position=1, publication_type="Journal")
        self.assertEqual(r.category, Category.SNIP)

    @PROP
    @given(
        snip=st.one_of(st.none(), st.floats(min_value=0.1, max_value=30, allow_nan=False)),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
        eng=st.sampled_from(ENG),
    )
    def test_a_zero_amount_always_carries_an_explanation(
        self, snip, quartile, total, pub, idx, eng
    ):
        r = price(
            snip=snip,
            quartile=quartile,
            total_authors=total,
            author_position=1,
            publication_type=pub,
            indexing_level=idx,
            engineering_class=eng,
        )
        if r.error or r.remuneration is None:
            return
        if r.remuneration == 0.0:
            self.assertTrue(r.note, f"zero with no reason: {r}")

    def test_a_student_publication_is_always_zero_and_says_why(self):
        r = price(
            snip=30,
            quartile="Q1",
            total_authors=1,
            author_position=1,
            is_student_publication=True,
            indexing_level="Scopus",
            publication_type="Journal",
        )
        self.assertEqual((r.base, r.point, r.remuneration, r.qf), (0.0, 0.0, 0.0, 0.0))
        self.assertIn("no remuneration is payable", r.note)

    def test_a_student_publication_is_paid_when_the_policy_says_so(self):
        cfg = FormulaConfigInput(student_remuneration_zero=False)
        r = price(
            snip=2.0,
            total_authors=1,
            author_position=1,
            cfg=cfg,
            is_student_publication=True,
            indexing_level="Scopus",
            publication_type="Journal",
        )
        self.assertGreater(r.remuneration, 0)

    def test_an_uncovered_combination_pays_nothing_rather_than_guessing(self):
        r = price(
            snip=None,
            total_authors=1,
            author_position=1,
            indexing_level="Scopus",
            publication_type="Dataset",
        )
        self.assertEqual(r.remuneration, 0.0)
        self.assertEqual(r.category, Category.NONE)
        self.assertIn("not covered by the scheme", r.note)

    def test_the_best_qualifying_type_multiplier_applies(self):
        cfg = FormulaConfigInput(
            publication_type_multipliers={"Journal": 1.0, "Book Series": 0.5, "Other": 0.25}
        )
        one = price(
            snip=1.0,
            total_authors=1,
            author_position=1,
            cfg=cfg,
            indexing_level="Scopus",
            publication_type="Book Series",
        )
        both = price(
            snip=1.0,
            total_authors=1,
            author_position=1,
            cfg=cfg,
            indexing_level="Scopus",
            publication_type="Book Series, Journal",
        )
        self.assertEqual(one.base, 27500.0)
        self.assertEqual(both.base, 55000.0)


# ---------------------------------------------------------------------------
# 7. Rounding and money representation
# ---------------------------------------------------------------------------


class RoundingTests(SimpleTestCase):
    @WIDE
    @given(st.floats(min_value=-10**9, max_value=10**9, allow_nan=False))
    def test_round2_is_idempotent(self, x):
        self.assertEqual(round2(round2(x)), round2(x))

    @WIDE
    @given(st.floats(min_value=0, max_value=10**9, allow_nan=False))
    def test_round2_lands_on_a_whole_paisa(self, x):
        y = round2(x)
        self.assertLessEqual(-Decimal(repr(y)).as_tuple().exponent, 2, f"{x} -> {y!r}")

    @PROP
    @given(
        snip=st.one_of(st.none(), st.floats(min_value=0, max_value=30, allow_nan=False)),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pos=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
        eng=st.sampled_from(ENG),
    )
    def test_no_amount_is_ever_a_float_artefact(self, snip, quartile, total, pos, pub, idx, eng):
        """Nothing like 50874.999999 reaches a payment advice."""
        assume(pos <= total)
        r = price(
            snip=snip,
            quartile=quartile,
            total_authors=total,
            author_position=pos,
            publication_type=pub,
            indexing_level=idx,
            engineering_class=eng,
        )
        for name in ("base", "remuneration"):
            v = getattr(r, name)
            if v is None:
                continue
            self.assertLessEqual(
                -Decimal(repr(v)).as_tuple().exponent, 2, f"{name} is {v!r} for {snip!r}"
            )

    @PROP
    @given(st.floats(min_value=0, max_value=10**7, allow_nan=False))
    def test_format_inr_always_shows_two_decimals(self, x):
        s = format_inr(round2(x))
        self.assertTrue(re.fullmatch(r"₹[\d,]+\.\d{2}", s), s)

    def test_format_inr_has_a_dash_for_no_amount(self):
        self.assertEqual(format_inr(None), "—")

    def test_the_rounding_rule_is_the_same_everywhere(self):
        """round2 is round-half-to-even, consistently, in both directions."""
        self.assertEqual(round2(0.125), 0.12)
        self.assertEqual(round2(0.135), 0.14)
        self.assertEqual(round2(-0.125), -0.12)
        self.assertEqual(round2(1e-9), 0.0)

    def _share_sum(self, base_kwargs, total):
        shares = []
        for pos in range(1, total + 1):
            r = price(total_authors=total, author_position=pos, **base_kwargs)
            self.assertIsNone(r.error)
            shares.append(r.remuneration)
        return sum(shares), price(total_authors=total, author_position=1, **base_kwargs).base

    def test_the_shares_of_a_whole_rupee_paper_do_not_exceed_it(self):
        """Sanity case: the money-sized bases in real use divide cleanly."""
        kw = dict(
            snip=2.0, quartile="Q1", indexing_level="Scopus", publication_type="Journal",
            engineering_class="Engineering",
        )
        for total in range(1, MAX_ELIGIBLE_AUTHORS + 1):
            total_paid, base = self._share_sum(kw, total)
            self.assertLessEqual(total_paid, base + 1e-6, f"{total} authors overspend {base}")

    # ------------------------------------------------------------------
    # DEFECT 2 — per-author shares can sum to more than the paper is worth.
    #
    # `round2` is applied independently to each author's share, so up to nine
    # roundings each move up to half a paisa in the same direction. With a
    # SNIP of 0.001 and six authors the paper's base is 55.00 and the six
    # shares are 15.13 + 12.38 + 11.00 + 8.25 + 5.50 + 2.75 = 55.01 — the
    # institution pays one paisa it never priced.
    #
    # It is small but it is systematic, and it is the kind of thing a
    # reconciliation between the ledger and the per-claim rows will surface as
    # an unexplained difference. Larger bases hit it too: base 81,935.00 with
    # six authors also sums to 81,935.01.
    #
    # The fix is a largest-remainder allocation (round eight shares, give the
    # remainder to the last), not a change to `round2`. Reported, not fixed.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_per_author_shares_never_exceed_the_paper_total(self):
        kw = dict(
            snip=0.001, quartile=None, indexing_level="Scopus", publication_type="Journal",
            engineering_class="Engineering",
        )
        total_paid, base = self._share_sum(kw, 6)
        self.assertLessEqual(
            total_paid, base, f"six authors are paid {total_paid} for a paper worth {base}"
        )

    def test_the_size_of_defect_two_is_one_paisa_and_no_more(self):
        """Locks the blast radius: the overspend never exceeds half a paisa
        per author, so it cannot quietly become rupees."""
        worst = 0.0
        for total in range(1, MAX_ELIGIBLE_AUTHORS + 1):
            points = DEFAULT_AUTHOR_POINTS[str(total)]
            for cents in range(0, 400):
                base = 1000 + cents / 100
                over = sum(round2(base * p) for p in points) - base * sum(points)
                worst = max(worst, over)
        self.assertLessEqual(worst, 0.005 * MAX_ELIGIBLE_AUTHORS + 1e-9)


# ---------------------------------------------------------------------------
# 8. formula_from_model / snapshot_formula
# ---------------------------------------------------------------------------


class _FakeConfigRow:
    """Stands in for a `FormulaConfig` row without touching the database."""

    def __init__(self, **kw):
        defaults = dict(
            snip_multiplier=55000,
            snip_cap=30,
            qf_q1=50000,
            qf_q2=30000,
            qf_q3=15000,
            qf_q4=7000,
            qf_no_snip=0,
            qf_snip_only=0,
            qf_others=0,
            fixed_journal_no_snip=5000,
            fixed_other_no_snip=4000,
            fixed_web_of_science=5000,
            max_authors=9,
            min_sec_references=2,
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
            publication_type_multipliers_json=None,
            student_remuneration_zero=True,
            qf_only_for_no_snip=True,
            name="Policy v1",
            version=1,
        )
        defaults.update(kw)
        for k, v in defaults.items():
            setattr(self, k, v)


class FormulaFromModelTests(SimpleTestCase):
    def test_a_default_row_reproduces_the_default_config(self):
        cfg = formula_from_model(_FakeConfigRow())
        self.assertEqual(cfg.author_points, DEFAULT_AUTHOR_POINTS)
        self.assertEqual(cfg.max_authors, MAX_ELIGIBLE_AUTHORS)
        self.assertEqual(cfg.min_sec_references, MIN_SEC_REFERENCES)

    def test_unreadable_author_points_fall_back_rather_than_paying_nothing(self):
        for junk in ("", "not json", "{", None):
            cfg = formula_from_model(_FakeConfigRow(author_point_json=junk))
            self.assertEqual(cfg.author_points, DEFAULT_AUTHOR_POINTS, repr(junk))
            self.assertEqual(author_point(3, 1, cfg), (0.5, None))

    def test_null_json_falls_back_to_the_defaults(self):
        cfg = formula_from_model(_FakeConfigRow(author_point_json="null"))
        self.assertEqual(cfg.author_points, DEFAULT_AUTHOR_POINTS)
        cfg = formula_from_model(_FakeConfigRow(publication_type_multipliers_json="null"))
        self.assertTrue(cfg.publication_type_multipliers)

    def test_a_zero_or_missing_snip_cap_becomes_thirty(self):
        self.assertEqual(formula_from_model(_FakeConfigRow(snip_cap=0)).snip_cap, 30)
        self.assertEqual(formula_from_model(_FakeConfigRow(snip_cap=None)).snip_cap, 30)

    def test_a_zero_minimum_reference_count_is_kept_because_it_means_something(self):
        """0 disables the gate; it must not be confused with "unset"."""
        self.assertEqual(formula_from_model(_FakeConfigRow(min_sec_references=0)).min_sec_references, 0)
        self.assertEqual(
            formula_from_model(_FakeConfigRow(min_sec_references=None)).min_sec_references,
            MIN_SEC_REFERENCES,
        )

    @PROP
    @given(
        snip=st.one_of(st.none(), st.floats(min_value=0, max_value=30, allow_nan=False)),
        quartile=st.sampled_from([None] + QUARTILES),
        total=st.integers(min_value=1, max_value=9),
        pub=st.sampled_from(PUB_TYPES),
        idx=st.sampled_from(INDEXING),
    )
    def test_a_snapshot_round_trips_to_the_same_amount(self, snip, quartile, total, pub, idx):
        """A stored snapshot has to reprice the paper exactly, or an audit
        cannot reproduce what was paid."""
        cfg = formula_from_model(_FakeConfigRow())
        snap = snapshot_formula(cfg)
        restored = FormulaConfigInput(
            **{k: v for k, v in snap.items() if k in FormulaConfigInput.__dataclass_fields__}
        )
        kw = dict(
            snip=snip,
            quartile=quartile,
            total_authors=total,
            author_position=1,
            publication_type=pub,
            indexing_level=idx,
        )
        self.assertEqual(price(cfg=cfg, **kw), price(cfg=restored, **kw))

    def test_a_snapshot_is_json_serialisable(self):
        json.dumps(snapshot_formula(formula_from_model(_FakeConfigRow())))


# ---------------------------------------------------------------------------
# 9. normalize.py
# ---------------------------------------------------------------------------

ISSN_SHAPE = re.compile(r"\d{4}-\d{3}[\dX]")

# Real ISSNs, check digits included.
GENUINE_ISSNS = [
    "0272-8842", "0010-0161", "0001-2505", "1024-123X", "0975-3060",
    "1432-7643", "0390-6663", "0028-0836", "0036-8075", "1476-4687",
]

issn_junk = st.one_of(
    st.text(max_size=20),
    st.from_regex(r"\A[0-9]{1,12}\Z", fullmatch=True),
    st.from_regex(r"\A[0-9]{1,9}\.0+\Z", fullmatch=True),
    st.from_regex(r"\A[0-9]{4}-[0-9]{3}[0-9X]\Z", fullmatch=True),
    st.sampled_from(GENUINE_ISSNS + ["", " ", "not an issn", "0000-0000", "N/A", "-"]),
)


def _digit_core(raw: str) -> str:
    """The characters `normalize_issn` would keep, before any padding."""
    text = raw.strip()
    if re.fullmatch(r"\d+\.0+", text):
        text = text.split(".")[0]
    return re.sub(r"[^0-9Xx]", "", text).upper()


class NormalizeIssnTests(SimpleTestCase):
    @WIDE
    @given(issn_junk)
    def test_normalising_twice_is_the_same_as_once(self, raw):
        # Whitespace-only input is the one exception; it has its own test below.
        assume(raw == "" or raw.strip() != "")
        once = normalize_issn(raw)
        self.assertEqual(normalize_issn(once), once, f"{raw!r} -> {once!r}")

    # ------------------------------------------------------------------
    # DEFECT 8 (minor) — `normalize_issn` is not idempotent for a blank value.
    #
    # A whitespace-only ISSN falls through to `return issn.strip()`, which is
    # the empty string, while an empty ISSN returns None on the first line. So
    # normalising once gives "" and normalising that gives None — two
    # different answers, from a function annotated `-> str | None` whose every
    # other empty-ish input gives None.
    #
    # Harmless today only because every caller writes `normalize_issn(x) or ""`
    # or tests truthiness. Reported, not fixed.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_a_whitespace_only_issn_normalises_the_same_way_twice(self):
        once = normalize_issn("   ")
        self.assertEqual(normalize_issn(once), once, f"-> {once!r}")

    @WIDE
    @given(issn_junk)
    def test_it_only_ever_adds_leading_zeros(self, raw):
        """The anti-fabrication property. If the output looks like an ISSN,
        every character of it after the padding must have come from the input;
        the only thing the function may invent is leading zeros."""
        out = normalize_issn(raw)
        if not out or not ISSN_SHAPE.fullmatch(out):
            return
        digits = out.replace("-", "")
        core = _digit_core(raw)
        self.assertTrue(digits.endswith(core), f"{raw!r} -> {out!r} is not a padding of {core!r}")
        self.assertEqual(
            set(digits[: len(digits) - len(core)]) - {"0"},
            set(),
            f"{raw!r} -> {out!r} invented non-zero characters",
        )

    @WIDE
    @given(issn_junk)
    def test_junk_never_becomes_the_all_zero_issn(self, raw):
        if "0000-0000" in raw or _digit_core(raw) == "00000000":
            return
        self.assertNotEqual(normalize_issn(raw), "0000-0000", repr(raw))

    def test_a_value_with_nothing_to_pad_comes_back_unchanged(self):
        for junk in ("not an issn", "N/A", "-", "abc", " 0272 8842 "):
            self.assertEqual(normalize_issn(junk), normalize_issn(junk.strip()), repr(junk))
        for junk in ("not an issn", "N/A", "-", "abc"):
            self.assertEqual(normalize_issn(junk), junk)

    def test_nothing_in_gives_nothing_out(self):
        for empty in (None, "", "   "):
            self.assertIn(normalize_issn(empty), (None, ""))

    def test_the_excel_float_tail_is_stripped_only_when_the_whole_value_is_one(self):
        self.assertEqual(normalize_issn("2728842.0"), "0272-8842")
        # A genuine ISSN ending in zero must survive untouched.
        self.assertEqual(normalize_issn("1234-5670"), "1234-5670")
        self.assertEqual(normalize_issn("12345670"), "1234-5670")

    def test_multiple_lost_zeros_are_recovered_only_when_the_check_digit_agrees(self):
        self.assertEqual(normalize_issn("100161"), "0010-0161")
        self.assertEqual(normalize_issn("12505"), "0001-2505")
        # Six characters whose padding fails the checksum stays as it was.
        self.assertEqual(normalize_issn("100459"), "100459")

    def test_padding_needs_at_least_four_characters_to_work_from(self):
        for short in ("1", "12", "123"):
            self.assertEqual(normalize_issn(short), short)

    @WIDE
    @given(st.from_regex(r"\A[0-9]{4}-[0-9]{3}[0-9X]\Z", fullmatch=True))
    def test_a_well_formed_issn_is_returned_as_it_came(self, issn):
        self.assertEqual(normalize_issn(issn), issn)
        self.assertEqual(normalize_issn(issn.replace("-", "")), issn)

    def test_the_seven_character_path_is_unconditional_and_can_produce_a_bad_issn(self):
        """Behaviour lock. Seven characters are padded with one zero whether or
        not the checksum agrees, because that is the shape the claim table
        carries. The output is formatted like an ISSN but does not pass the
        check digit, so a downstream match against reference data still fails
        safe."""
        out = normalize_issn("1234567")
        self.assertEqual(out, "0123-4567")
        self.assertFalse(issn_check_digit_ok(out.replace("-", "")))


class IssnCheckDigitTests(SimpleTestCase):
    def test_it_accepts_genuine_issns(self):
        for issn in GENUINE_ISSNS:
            self.assertTrue(issn_check_digit_ok(issn.replace("-", "")), issn)

    def test_it_rejects_every_wrong_check_digit(self):
        for issn in GENUINE_ISSNS:
            plain = issn.replace("-", "")
            for c in "0123456789X":
                if c == plain[7]:
                    continue
                self.assertFalse(issn_check_digit_ok(plain[:7] + c), plain[:7] + c)

    @WIDE
    @given(st.integers(min_value=0, max_value=9999999))
    def test_exactly_one_check_digit_is_correct_for_any_seven_digits(self, n):
        prefix = f"{n:07d}"
        accepted = [c for c in "0123456789X" if issn_check_digit_ok(prefix + c)]
        self.assertEqual(len(accepted), 1, f"{prefix}: {accepted}")

    def test_it_rejects_the_wrong_length_and_the_wrong_shape(self):
        for bad in ("", "1234567", "123456789", "X2728842", "0272884 ", "0272-884"):
            self.assertFalse(issn_check_digit_ok(bad), repr(bad))

    def test_none_and_empty_are_rejected_without_complaint(self):
        self.assertFalse(issn_check_digit_ok(None))
        self.assertFalse(issn_check_digit_ok(""))

    def test_x_is_accepted_only_as_the_check_digit(self):
        self.assertTrue(issn_check_digit_ok("1024123X"))
        self.assertFalse(issn_check_digit_ok("1024X123"))

    def test_lower_case_x_is_accepted(self):
        self.assertTrue(issn_check_digit_ok("1024123x"))

    # ------------------------------------------------------------------
    # DEFECT 3 — `issn_check_digit_ok` raises instead of returning False.
    #
    # The guard is `cleaned[:7].isdigit()`, but `str.isdigit()` is true for
    # Unicode characters that `int()` cannot parse — superscripts and
    # subscripts, "²" among them. The next line does
    # `int(d) for d in cleaned[:7]` and throws ValueError.
    #
    # `normalize_issn` happens not to reach it, because its own `[^0-9Xx]`
    # strip is ASCII-only. But `issn_check_digit_ok` is a public predicate and
    # a predicate that raises is a predicate every caller has to wrap. Any
    # future caller feeding it a raw spreadsheet cell — where "10²" is a real
    # thing a person types — gets a 500 instead of a False.
    #
    # One-line fix: `.isascii() and .isdigit()`, or `.isdecimal()`.
    # Reported, not fixed.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_it_returns_false_for_unicode_digits_it_cannot_parse(self):
        self.assertFalse(issn_check_digit_ok("²²²²²²²X"))

    def test_unicode_digits_that_int_can_parse_are_handled(self):
        """Arabic-Indic digits do parse, so these are answered rather than
        thrown — which is what makes the superscript case a bug and not a
        deliberate policy."""
        self.assertFalse(issn_check_digit_ok("٠١٢٣٤٥٦٧"))


class NormalizeTitleTests(SimpleTestCase):
    @WIDE
    @given(st.text(max_size=60))
    def test_normalising_twice_is_the_same_as_once(self, title):
        once = normalize_title(title)
        self.assertEqual(normalize_title(once), once, repr(title))

    @WIDE
    @given(st.text(max_size=60))
    def test_the_output_is_only_lowercase_alphanumerics_and_single_spaces(self, title):
        out = normalize_title(title)
        self.assertTrue(re.fullmatch(r"[a-z0-9]*( [a-z0-9]+)*", out), repr(out))

    def test_none_and_empty_normalise_to_the_empty_string(self):
        self.assertEqual(normalize_title(None), "")
        self.assertEqual(normalize_title(""), "")
        self.assertEqual(normalize_title("!!!"), "")

    def test_punctuation_and_case_do_not_change_a_title(self):
        self.assertEqual(
            normalize_title("Deep-Learning: A Survey!"), normalize_title("deep learning a survey")
        )

    @WIDE
    @given(st.text(max_size=60))
    def test_tokens_are_a_subset_of_the_normalised_words(self, title):
        self.assertLessEqual(title_tokens(title), set(normalize_title(title).split()))


class TitlesRoughMatchTests(SimpleTestCase):
    @WIDE
    @given(st.text(max_size=40), st.text(max_size=40))
    def test_matching_is_symmetric(self, a, b):
        self.assertEqual(titles_rough_match(a, b), titles_rough_match(b, a), (a, b))

    @WIDE
    @given(st.text(max_size=40), st.text(max_size=40), st.floats(0.1, 1.0))
    def test_matching_is_symmetric_at_any_threshold(self, a, b, thresh):
        self.assertEqual(
            titles_rough_match(a, b, min_overlap=thresh),
            titles_rough_match(b, a, min_overlap=thresh),
        )

    @WIDE
    @given(st.text(max_size=40))
    def test_a_title_with_content_matches_itself(self, title):
        assume(normalize_title(title) != "")
        self.assertTrue(titles_rough_match(title, title), repr(title))

    def test_a_title_that_normalises_to_nothing_matches_nothing_including_itself(self):
        """Deliberate: an empty title is not evidence of a duplicate. Locked so
        a future "reflexivity" fix cannot start matching blank against blank."""
        for empty in ("", "   ", "!!!", None):
            self.assertFalse(titles_rough_match(empty, empty), repr(empty))

    @WIDE
    @given(st.text(max_size=40))
    def test_nothing_matches_an_empty_title(self, title):
        self.assertFalse(titles_rough_match(title, ""))
        self.assertFalse(titles_rough_match("", title))
        self.assertFalse(titles_rough_match(title, None))

    def test_a_lower_threshold_never_matches_less(self):
        a, b = "deep learning for retinal image analysis", "deep learning retinal images study"
        self.assertTrue(
            titles_rough_match(a, b, min_overlap=0.3) or not titles_rough_match(a, b, min_overlap=0.9)
        )

    @WIDE
    @given(st.text(max_size=40), st.text(max_size=40), st.floats(0.1, 0.5), st.floats(0.5, 1.0))
    def test_relaxing_the_threshold_never_loses_a_match(self, a, b, low, high):
        assume(low <= high)
        if titles_rough_match(a, b, min_overlap=high):
            self.assertTrue(titles_rough_match(a, b, min_overlap=low), (a, b, low, high))


class NormalizeDoiTests(SimpleTestCase):
    doi_junk = st.one_of(
        st.text(max_size=40),
        st.from_regex(r"\A10\.[0-9]{4}/[a-zA-Z0-9.\-]{1,12}\Z", fullmatch=True),
        st.sampled_from(
            [
                "10.1000/xyz123",
                "https://doi.org/10.1000/xyz123",
                "http://dx.doi.org/10.1000/xyz123",
                "HTTPS://DOI.ORG/10.1000/XYZ123",
                "  10.1000/xyz  ",
                "",
                None,
            ]
        ),
    )

    def test_a_single_resolver_prefix_is_stripped_and_the_case_folded(self):
        for raw in (
            "10.1000/xyz123",
            "https://doi.org/10.1000/xyz123",
            "http://doi.org/10.1000/xyz123",
            "http://dx.doi.org/10.1000/xyz123",
            "HTTPS://DOI.ORG/10.1000/XYZ123",
            "  10.1000/XYZ123 ",
        ):
            self.assertEqual(normalize_doi(raw), "10.1000/xyz123", repr(raw))

    def test_nothing_in_gives_none_out(self):
        for empty in (None, "", "   "):
            self.assertIsNone(normalize_doi(empty))

    @WIDE
    @given(doi_junk)
    def test_normalising_twice_is_the_same_as_once_for_ordinary_values(self, raw):
        assume(raw is None or raw.lower().count("doi.org/") < 2)
        once = normalize_doi(raw)
        self.assertEqual(normalize_doi(once), once, repr(raw))

    # ------------------------------------------------------------------
    # DEFECT 4 — `normalize_doi` is not idempotent.
    #
    # The prefix strip is `re.sub(r"^https?://(dx\.)?doi\.org/", "", s)`, which
    # is anchored and so removes exactly one prefix per call. A value that
    # carries the resolver twice — which is what a copy-paste out of a browser
    # into a field that already prefills the resolver produces, and it is
    # common — normalises to "https://doi.org/10.x/y" on the first pass and
    # "10.x/y" on the second.
    #
    # It matters because the DOI is a duplicate key: `check_already_paid` and
    # the ERP import compare normalised DOIs, so the same paper stored once
    # with a doubled prefix and once without will not be seen as the same
    # paper, and can be paid twice.
    #
    # Fix: loop the substitution, or use a non-anchored `re.sub(...)` with a
    # `(?:...)*` prefix group. Reported, not fixed.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_a_doubled_resolver_prefix_is_fully_stripped(self):
        self.assertEqual(
            normalize_doi("https://doi.org/https://doi.org/10.1000/xyz123"), "10.1000/xyz123"
        )

    def test_the_doubled_prefix_at_least_settles_after_a_second_pass(self):
        """Locks how far the defect goes: one extra pass is enough, so the
        value does not drift indefinitely."""
        raw = "https://doi.org/https://doi.org/10.1000/xyz123"
        self.assertEqual(normalize_doi(normalize_doi(raw)), "10.1000/xyz123")


# ---------------------------------------------------------------------------
# 10. The research quota
# ---------------------------------------------------------------------------

from core.api import _apply_calc, _assign_quota_position, _quota_state  # noqa: E402
from core.models import Claim, ClaimReason, FormulaConfig, Role  # noqa: E402


class ResearchQuotaPropertyTests(TestCase):
    """`quota_position` decides whether a paper is paid at all, so it is
    treated here as the money column it is."""

    def setUp(self):
        # The SEC-reference minimum would zero every claim here before the
        # quota ever got a look in; these tests are about the quota alone.
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
            min_sec_references=0,
            active=True,
        )
        self.researcher = User.objects.create_user(
            email="res@test.edu",
            password="pass",
            name="Res",
            role=Role.FACULTY,
            department="CSE",
            faculty_type="RESEARCH",
            research_quota=2,
        )
        self.regular = User.objects.create_user(
            email="reg@test.edu", password="pass", name="Reg", role=Role.FACULTY, department="CSE"
        )

    def _file(self, owner=None, year=2024, reason=ClaimReason.INCENTIVE, **kw):
        """Create a claim and hand it its quota slot, the way a submit does."""
        claim = Claim.objects.create(
            owner=owner or self.researcher,
            paper_title=kw.pop("title", "A paper"),
            publication_year=year,
            claim_reason=reason,
            snip=2.0,
            quartile="Q1",
            indexing_level="Scopus",
            publication_type="Journal",
            engineering_class="Engineering",
            total_authors=1,
            author_position=1,
            **kw,
        )
        _assign_quota_position(claim)
        claim.save()
        return claim

    # -- stability ------------------------------------------------------

    def test_a_position_is_handed_out_once_and_never_moves(self):
        first = self._file(title="one")
        self.assertEqual(first.quota_position, 1)
        for _ in range(5):
            self._file(title="filler")
            first.refresh_from_db()
            _assign_quota_position(first)
            self.assertEqual(first.quota_position, 1, "an existing position was reassigned")

    def test_refiling_a_rejected_paper_keeps_its_slot(self):
        claim = self._file(title="sent back")
        self._file(title="another")
        _assign_quota_position(claim)
        self.assertEqual(claim.quota_position, 1)

    def test_reading_the_quota_state_never_assigns_a_position(self):
        """`_quota_state` only reads. A draft must not consume an allowance."""
        draft = Claim.objects.create(
            owner=self.researcher, publication_year=2024, total_authors=1, author_position=1
        )
        for _ in range(3):
            inside, why = _quota_state(draft)
            self.assertTrue(inside)
            self.assertIsNone(draft.quota_position)
        draft.refresh_from_db()
        self.assertIsNone(draft.quota_position)

    # -- collisions -----------------------------------------------------

    def test_positions_never_collide_within_one_author_year(self):
        claims = [self._file(title=f"p{i}") for i in range(6)]
        positions = [c.quota_position for c in claims]
        self.assertEqual(positions, [1, 2, 3, 4, 5, 6])
        self.assertEqual(len(set(positions)), len(positions))

    def test_a_gap_in_the_sequence_does_not_reissue_a_taken_position(self):
        """The reason the code uses max+1 rather than count(): a paper whose
        year is corrected leaves a hole, and count() would hand the hole out
        again to a paper that is already there."""
        a = self._file(title="a")
        b = self._file(title="b")
        a.publication_year = 2025
        a.save()
        c = self._file(title="c")
        self.assertNotEqual(c.quota_position, b.quota_position)
        self.assertEqual(c.quota_position, 3)

    def test_positions_are_counted_per_year(self):
        y24 = [self._file(year=2024, title=f"a{i}") for i in range(3)]
        y25 = [self._file(year=2025, title=f"b{i}") for i in range(3)]
        self.assertEqual([c.quota_position for c in y24], [1, 2, 3])
        self.assertEqual([c.quota_position for c in y25], [1, 2, 3])

    def test_positions_are_counted_per_author(self):
        other = User.objects.create_user(
            email="res2@test.edu",
            password="pass",
            name="Res2",
            role=Role.FACULTY,
            faculty_type="RESEARCH",
            research_quota=2,
        )
        self._file(title="mine")
        theirs = self._file(owner=other, title="theirs")
        self.assertEqual(theirs.quota_position, 1)

    # -- exactly N ------------------------------------------------------

    def _inside_count(self, year=2024, owner=None):
        return sum(
            1
            for c in Claim.objects.filter(owner=owner or self.researcher, publication_year=year)
            if _quota_state(c)[0]
        )

    def test_a_quota_of_n_zeroes_exactly_n_papers(self):
        for quota in (1, 2, 3, 5):
            Claim.objects.all().delete()
            self.researcher.research_quota = quota
            self.researcher.save()
            for i in range(quota + 3):
                self._file(title=f"p{i}")
            self.assertEqual(self._inside_count(), quota, f"quota {quota}")

    def test_fewer_papers_than_the_quota_zeroes_all_of_them(self):
        self.researcher.research_quota = 5
        self.researcher.save()
        for i in range(3):
            self._file(title=f"p{i}")
        self.assertEqual(self._inside_count(), 3)

    def test_the_boundary_paper_is_inside_and_the_next_one_is_not(self):
        claims = [self._file(title=f"p{i}") for i in range(3)]
        self.assertTrue(_quota_state(claims[1])[0], "paper 2 of a 2-paper quota is not inside")
        self.assertFalse(_quota_state(claims[2])[0], "paper 3 of a 2-paper quota is inside")
        self.assertIn("beyond the 2-paper research quota", _quota_state(claims[2])[1])

    def test_a_count_only_paper_neither_takes_a_slot_nor_is_zeroed(self):
        count_only = self._file(reason=ClaimReason.COUNT_ONLY, title="count only")
        self.assertIsNone(count_only.quota_position)
        self.assertEqual(_quota_state(count_only), (False, None))
        paid = self._file(title="paid")
        self.assertEqual(paid.quota_position, 1, "a count-only paper consumed a slot")

    def test_a_paper_with_no_year_is_left_payable(self):
        claim = self._file(year=None, title="no year")
        self.assertIsNone(claim.quota_position)
        self.assertEqual(_quota_state(claim), (False, None))

    def test_regular_faculty_have_no_quota_at_all(self):
        claim = self._file(owner=self.regular, title="regular")
        self.assertIsNone(claim.quota_position)
        self.assertEqual(_quota_state(claim), (False, None))

    def test_a_quota_of_zero_or_none_zeroes_nothing(self):
        for quota in (0, None):
            Claim.objects.all().delete()
            self.researcher.research_quota = quota
            self.researcher.save()
            claim = self._file(title="p")
            self.assertIsNone(claim.quota_position, f"quota {quota!r} handed out a slot")
            self.assertEqual(_quota_state(claim), (False, None))

    # -- the amount -----------------------------------------------------

    def test_a_quota_paper_is_zeroed_but_keeps_what_it_was_worth(self):
        claim = self._file(title="inside")
        _apply_calc(claim)
        self.assertTrue(claim.quota_applied)
        self.assertEqual(claim.remuneration, 0.0)
        self.assertGreater(claim.base_amount, 0.0)
        self.assertEqual(claim.author_point, 1.0)
        self.assertIn("research quota", claim.quota_note)

    def test_the_paper_past_the_quota_is_paid_in_full(self):
        for i in range(3):
            claim = self._file(title=f"p{i}")
        _apply_calc(claim)
        self.assertFalse(claim.quota_applied)
        self.assertEqual(claim.remuneration, claim.base_amount)

    def test_pricing_a_quota_paper_twice_gives_the_same_answer(self):
        claim = self._file(title="stable")
        _apply_calc(claim)
        first = (claim.quota_position, claim.remuneration, claim.base_amount, claim.quota_applied)
        for _ in range(3):
            _apply_calc(claim)
            self.assertEqual(
                (claim.quota_position, claim.remuneration, claim.base_amount, claim.quota_applied),
                first,
            )

    # ------------------------------------------------------------------
    # DEFECT 5 — a gap in the position sequence shrinks the quota.
    #
    # Positions are handed out as max+1 and never renumbered, and
    # `_quota_state` decides on `position <= quota`. So the moment the sequence
    # has a hole, the quota stops meaning "the first N papers of the year" and
    # starts meaning "the papers numbered 1..N", which is fewer papers.
    #
    # Three papers are filed for 2024 and take positions 1, 2, 3. The first
    # one's year is corrected to 2025 — reachable through the ordinary edit
    # path, since a rejected claim can be edited and it already carries a
    # position. 2024 now holds two papers, numbered 2 and 3, against a quota of
    # 2. One of them is zeroed instead of both, and the author is paid for a
    # paper the quota was supposed to cover.
    #
    # The same hole opens whenever a claim is deleted or withdrawn.
    #
    # The trade-off is real — renumbering on read is what the docstring
    # rejects, because `created_at` and the uuid cannot order the papers. But
    # the fix is to renumber the *remaining* papers by their existing position
    # order when one leaves a year, which keeps the filing order and closes the
    # hole. Reported, not fixed.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_a_year_correction_does_not_shrink_the_quota(self):
        claims = [self._file(title=f"p{i}") for i in range(3)]
        claims[0].publication_year = 2025
        claims[0].save()
        remaining = Claim.objects.filter(owner=self.researcher, publication_year=2024).count()
        self.assertEqual(remaining, 2)
        self.assertEqual(
            self._inside_count(2024),
            2,
            "a 2-paper quota stopped covering both of the year's two papers",
        )

    # ------------------------------------------------------------------
    # DEFECT 6 — a corrected year carries the old year's position with it.
    #
    # `quota_position` is never cleared when `publication_year` changes, so the
    # paper arrives in its new year holding a number that year has already
    # issued. Two papers then share position 1, both are inside a quota of 2,
    # and the third paper of that year — which should have been paid — is not,
    # because it is numbered 3.
    #
    # There is no unique constraint on (owner, publication_year,
    # quota_position) to stop it, and `_assign_quota_position` is a no-op once
    # the field is set.
    #
    # Fix: clear `quota_position` when `publication_year` changes, and add the
    # constraint. Reported, not fixed.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_a_corrected_year_does_not_import_a_duplicate_position(self):
        moved = self._file(year=2024, title="moved")
        settled = self._file(year=2025, title="settled")
        self.assertEqual(moved.quota_position, 1)
        self.assertEqual(settled.quota_position, 1)
        moved.publication_year = 2025
        moved.save()
        positions = list(
            Claim.objects.filter(owner=self.researcher, publication_year=2025).values_list(
                "quota_position", flat=True
            )
        )
        self.assertEqual(len(set(positions)), len(positions), f"duplicate positions: {positions}")

    # ------------------------------------------------------------------
    # DEFECT 7 — two submits that interleave get the same position.
    #
    # `_assign_quota_position` reads MAX(quota_position) and writes MAX+1 with
    # no lock and no unique constraint, and the read and the write are in
    # different statements with the claim's `save()` between them. Two workers
    # handling two submits for the same author and year at the same moment both
    # read the same maximum and both write the same number.
    #
    # The test below stands in for the race by doing what the two workers do —
    # assigning both positions before either row is written. There is nothing
    # in the code or the schema that makes the interleaved order impossible;
    # the ticket-number path next to it takes a lock and retries on collision
    # precisely because the same thing happened there.
    #
    # Consequence: two papers share a slot, so a quota of N zeroes N-1 papers
    # and pays one it should not have.
    #
    # Fix: a UniqueConstraint on (owner, publication_year, quota_position) plus
    # the retry `assign_ticket_number` already uses. Reported, not fixed.
    # ------------------------------------------------------------------
    @expectedFailure
    def test_two_interleaved_submits_do_not_share_a_position(self):
        a = Claim.objects.create(
            owner=self.researcher, publication_year=2024, total_authors=1, author_position=1
        )
        b = Claim.objects.create(
            owner=self.researcher, publication_year=2024, total_authors=1, author_position=1
        )
        _assign_quota_position(a)
        _assign_quota_position(b)
        a.save()
        b.save()
        self.assertNotEqual(
            a.quota_position, b.quota_position, "two claims were given the same quota slot"
        )
