"""The import's "Not Found" owner is data, not a colleague or a department.

Red team, 17 Nov 2026: the wall of fame congratulated a person named "Not
Found", and "Not Found" was offered as a department in the Top 5 filter, the
budget table, the flags and the data fixes. No list of people or departments
may carry it; the claims it owns stay, named for what they are.
"""
from __future__ import annotations

import json
from datetime import date

from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.services import placeholders


def _bodies(client: Client, *paths: str) -> dict[str, str]:
    out = {}
    for p in paths:
        r = client.get(p)
        assert r.status_code == 200, (p, r.status_code, r.content[:200])
        out[p] = r.content.decode()
    return out


class PlaceholderWordsTests(TestCase):
    def test_what_counts_as_nobody(self):
        for word in ("Not Found", "not found", " NOT  FOUND ", "N/A", "-", "Unknown", "None"):
            self.assertTrue(placeholders.is_placeholder_name(word), word)
            self.assertTrue(placeholders.is_not_a_department(word), word)
        for word in ("Anita Rao", "Found", "Notfoundland Rao"):
            self.assertFalse(placeholders.is_placeholder_name(word), word)
        self.assertEqual(placeholders.clean_department("Not Found"), "")
        self.assertEqual(placeholders.clean_department(" ECE "), "ECE")


class NoListCarriesThePlaceholderTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(email="adm@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN)
        self.real = User.objects.create_user(
            email="real@x.edu", password="p", name="Real Person", role=Role.FACULTY, department="ECE"
        )
        self.ghost = User.objects.create_user(
            email="erp.tssh242@imported.local", password="p", name="Not Found", role=Role.FACULTY,
            department="Not Found", active=False,
        )
        for owner, title in ((self.real, "A real paper"), (self.ghost, "An unclaimed paper")):
            Claim.objects.create(
                owner=owner, paper_title=title, status=ClaimStatus.PAID, remuneration=5000,
                payout_month=date(2026, 6, 1), publication_year=2026, ticket_number=f"ERP-{owner.name[:2]}-{title[:3]}",
            )
        PaidLedger.objects.create(
            payout_month=date(2026, 6, 1), department="Not Found", faculty_name="Not Found",
            amount=5000, paper_title="An unclaimed paper",
        )
        self.c = Client()
        self.c.force_login(self.admin)

    def test_no_people_or_department_list_names_it(self):
        bodies = _bodies(
            self.c, "/api/wall", "/api/meta/departments", "/api/budgets?financial_year=2025-26",
            "/api/budgets?financial_year=2026-27", "/api/admin/users", "/api/flags",
        )
        for path, body in bodies.items():
            self.assertNotIn('"Not Found"', body, path)

    def test_the_wall_leaves_it_out_and_keeps_real_people(self):
        wall = self.c.get("/api/wall").json()
        names = {a["name"] for card in wall["cards"] for a in card["authors"]}
        self.assertNotIn("Not Found", names)
        self.assertNotIn("Not Found", wall["departments"])

    def test_the_budget_keeps_its_money_without_a_department_row(self):
        body = self.c.get("/api/budgets?financial_year=2026-27").json()
        self.assertNotIn(None, [d["department"] for d in body["departments"]])
        # The ledger row and the unclaimed paper (10,000) have no department;
        # the real paper (5,000) is ECE's. All of it is in the college row.
        self.assertEqual([d["department"] for d in body["departments"]], ["ECE"])
        self.assertEqual(body["college"]["spent"], 15000)
        self.assertEqual(body["no_department"]["spent"], 10000)

    def test_a_claim_it_owns_says_claimant_not_identified(self):
        rows = self.c.get("/api/admin/data-fixes?kind=no_claimant").json()["rows"]
        self.assertTrue(rows)
        for r in rows:
            self.assertEqual(r["owner"]["name"], placeholders.UNIDENTIFIED)
            self.assertIsNone(r["department"])

    def test_the_directories_leave_it_out(self):
        users = self.c.get("/api/admin/users").json()
        flat = json.dumps(users)
        self.assertNotIn("Not Found", flat)
        self.assertIn("Real Person", flat)
