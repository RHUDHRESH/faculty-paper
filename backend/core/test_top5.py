"""The Top 5 dashboard: what each list counts, who may see it, which period.

Synthetic people and papers only. The definitions pinned here:

- count: distinct papers (normalised title) on PAYMENT rows, a zero-amount row
  included, plus PAID claims the ledger does not already hold;
- remuneration: the sum of the amounts paid, a voided payment excluded;
- SNIP: the sum over those distinct papers; a non-numeric SNIP adds nothing.
"""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.test_search import money_keys_in

TODAY = date(2026, 9, 24)  # academic year 2026-27 began on 1 June 2026


class _Top5(TestCase):
    def setUp(self):
        cache.clear()
        patcher = patch("core.services.top5.today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.asha = self._user("asha", "ECE", "TSEC001")
        self.ravi = self._user("ravi", "ECE", "TSEC002")
        self.mina = self._user("mina", "CSE", "TSCS001")
        self.head = self._user("head", "CSE", "TSCS900", role=Role.HOD)
        self.client = Client()

    def _user(self, name, dept, staff_id=None, role=Role.FACULTY):
        return User.objects.create_user(
            email=f"{name}@x.edu", password=None, name=name.title(), role=role,
            department=dept, staff_id=staff_id,
        )

    def _office(self, role):
        return User.objects.create_user(email=f"{role.lower()}@x.edu", password=None, name=role.title(), role=role)

    def _row(self, staff, title, amount, *, snip="1.5", month=date(2026, 8, 1),
             kind=PaidLedger.Kind.PAYMENT, claim=None, cycle=1, **extra):
        raw = {"SNIP Value": snip} if snip is not None else {}
        return PaidLedger.objects.create(
            staff_id=staff, paper_title=title, amount=amount, payout_month=month, kind=kind,
            claim=claim, cycle=cycle, raw_json=json.dumps(raw), **extra,
        )

    def _get(self, viewer, expect=200, **params):
        self.client.force_login(viewer)
        res = self.client.get("/api/dashboard/top5", params)
        self.assertEqual(res.status_code, expect, res.content[:300])
        return res.json()

    def _by_name(self, body, key):
        return {r["name"]: r["value"] for r in body[key]}


class TheDefinitions(_Top5):
    def test_count_dedupes_titles_and_zero_rows_count_but_add_nothing(self):
        self._row("TSEC001", "Deep Nets: A Study", 1000, snip="2")
        self._row("TSEC001", "deep nets a study", 500, snip="2")  # the same paper again
        self._row("TSEC001", "A count only paper", 0, snip="1.25")
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(self._by_name(board, "count")["Asha"], 2)
        self.assertEqual(self._by_name(board, "remuneration")["Asha"], 1500)
        self.assertEqual(self._by_name(board, "snip")["Asha"], 3.25)

    def test_zero_amount_row_counts_and_adds_no_money(self):
        self._row("TSEC002", "Free paper", 0, snip="0.8")
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(self._by_name(board, "count")["Ravi"], 1)
        self.assertNotIn("Ravi", self._by_name(board, "remuneration"))

    def test_non_numeric_snip_is_skipped(self):
        self._row("TSEC001", "One", 100, snip="N/A")
        self._row("TSEC001", "Two", 100, snip="-")
        self._row("TSEC001", "Three", 100, snip="1,234.5")
        self._row("TSEC001", "Four", 100, snip=None)
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(self._by_name(board, "snip")["Asha"], 1234.5)
        self.assertEqual(self._by_name(board, "count")["Asha"], 4)

    def test_staff_id_matches_in_any_case_and_spacing(self):
        self._row(" tsec001 ", "One", 100)
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(self._by_name(board, "count"), {"Asha": 1})

    def test_paid_claims_not_in_the_ledger_are_added_once(self):
        Claim.objects.create(
            owner=self.mina, status=ClaimStatus.PAID, paper_title="Paid in app", remuneration=7000,
            snip=2.5, payout_month=date(2026, 9, 1),
        )
        in_ledger = Claim.objects.create(
            owner=self.mina, status=ClaimStatus.PAID, paper_title="On the ledger", remuneration=3000,
            snip=1.0, payout_month=date(2026, 9, 1),
        )
        self._row("TSCS001", "On the ledger", 3000, snip="1.0", month=date(2026, 9, 1), claim=in_ledger)
        Claim.objects.create(owner=self.mina, status=ClaimStatus.CLEARED, paper_title="Not paid", remuneration=9999, snip=9)
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(self._by_name(board, "count")["Mina"], 2)
        self.assertEqual(self._by_name(board, "remuneration")["Mina"], 10000)
        self.assertEqual(self._by_name(board, "snip")["Mina"], 3.5)

    def test_a_claim_already_on_the_ledger_by_title_is_not_counted_twice(self):
        self._row("TSCS001", "Same Paper", 4000, snip="1")
        Claim.objects.create(owner=self.mina, status=ClaimStatus.PAID, paper_title="same paper", remuneration=4000, snip=1)
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(self._by_name(board, "count")["Mina"], 1)
        self.assertEqual(self._by_name(board, "remuneration")["Mina"], 4000)

    def test_a_voided_payment_is_not_a_settled_paper(self):
        claim = Claim.objects.create(owner=self.asha, status=ClaimStatus.CLEARED, paper_title="Voided", snip=3)
        self._row("TSEC001", "Voided", 5000, claim=claim)
        self._row("TSEC001", "Voided", -5000, claim=claim, kind=PaidLedger.Kind.REVERSAL)
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(board["count"], [])
        self.assertEqual(board["remuneration"], [])

    def test_unmatched_staff_ids_are_kept_by_name(self):
        self._row("TSXX777", "Outside paper", 800, faculty_name="Retired Person", department="ECE")
        self._row("TSXX777", "Another", 200, faculty_name="Retired Person", department="ECE")
        board = self._get(self._office(Role.PRINCIPAL))
        row = board["remuneration"][0]
        self.assertEqual((row["name"], row["value"], row["user_id"], row["staff_id"]), ("Retired Person", 1000, None, "TSXX777"))

    def test_five_each_ranked_with_ties_broken_by_name(self):
        for i, name in enumerate(["zed", "amy", "bob", "cat", "dan", "eve", "fay"]):
            u = self._user(name, "ECE", f"TS{i:03d}")
            for k in range(2):
                self._row(u.staff_id, f"{name} paper {k}", 100, snip="1")
        board = self._get(self._office(Role.PRINCIPAL))
        self.assertEqual(len(board["count"]), 5)
        self.assertEqual([r["name"] for r in board["count"]], ["Amy", "Bob", "Cat", "Dan", "Eve"])
        self.assertEqual([r["rank"] for r in board["count"]], [1, 2, 3, 4, 5])
        self.assertLessEqual(
            {"rank", "user_id", "staff_id", "name", "department", "photo", "value"}, set(board["count"][0])
        )


class Permissions(_Top5):
    def setUp(self):
        super().setUp()
        self._row("TSEC001", "ECE paper", 1000, snip="2")
        self._row("TSCS001", "CSE paper", 2000, snip="3")

    def test_college_wide_roles_see_everything_with_money(self):
        for role in (Role.PRINCIPAL, Role.DIRECTOR, Role.SUPER_ADMIN, Role.RESEARCH_COORDINATOR, Role.FINANCE):
            body = self._get(self._office(role))
            self.assertEqual({r["name"] for r in body["count"]}, {"Asha", "Mina"}, role)
            self.assertEqual(self._by_name(body, "remuneration"), {"Mina": 2000, "Asha": 1000}, role)

    def test_faculty_and_others_are_refused(self):
        self._get(self.asha, expect=403)
        self._get(self._office(Role.RESEARCH_CELL), expect=403)
        self.client.logout()
        self.assertEqual(self.client.get("/api/dashboard/top5").status_code, 401)

    def test_head_sees_own_department_and_no_money(self):
        body = self._get(self.head)
        self.assertEqual([r["name"] for r in body["snip"]], ["Mina"])
        self.assertEqual([r["name"] for r in body["count"]], ["Mina"])
        self.assertIn("remuneration", body)
        self.assertIsNone(body["remuneration"])
        self.assertNotIn("2000", json.dumps(body))
        self.assertEqual(money_keys_in({k: v for k, v in body.items() if k != "remuneration"}), [])

    def test_head_cannot_ask_for_another_department(self):
        self._get(self.head, expect=403, department="ECE")
        body = self._get(self.head, department="cse")
        self.assertEqual(body["department"], "CSE")

    def test_department_filter_for_the_college(self):
        body = self._get(self._office(Role.PRINCIPAL), department="ece")
        self.assertEqual([r["name"] for r in body["count"]], ["Asha"])
        self.assertEqual(self._by_name(body, "remuneration"), {"Asha": 1000})

    def test_bad_period_is_refused(self):
        self._get(self._office(Role.PRINCIPAL), expect=400, period="week")


class Periods(_Top5):
    def setUp(self):
        super().setUp()
        self._row("TSEC001", "Old paper", 1000, snip="1", month=date(2025, 7, 1))     # 2025-26
        self._row("TSEC001", "Earlier this year", 500, snip="1", month=date(2026, 6, 1))  # 2026-27
        self._row("TSEC002", "This month", 700, snip="2", month=date(2026, 9, 1))
        self.viewer = self._office(Role.PRINCIPAL)

    def test_all_time(self):
        body = self._get(self.viewer)
        self.assertEqual(self._by_name(body, "remuneration"), {"Asha": 1500, "Ravi": 700})

    def test_academic_year_defaults_to_the_current_one(self):
        body = self._get(self.viewer, period="year")
        self.assertEqual(self._by_name(body, "remuneration"), {"Ravi": 700, "Asha": 500})
        self.assertEqual(body["label"], "Academic year 2026-27")

    def test_academic_year_can_be_named(self):
        body = self._get(self.viewer, period="year", year=2025)
        self.assertEqual(self._by_name(body, "remuneration"), {"Asha": 1000})
        self.assertEqual(self._by_name(body, "count"), {"Asha": 1})

    def test_this_month(self):
        body = self._get(self.viewer, period="month")
        self.assertEqual(self._by_name(body, "remuneration"), {"Ravi": 700})
        self.assertEqual(body["period"], "month")

    def test_empty_period_gives_empty_lists(self):
        body = self._get(self.viewer, period="year", year=2030)
        self.assertEqual((body["snip"], body["remuneration"], body["count"]), ([], [], []))
