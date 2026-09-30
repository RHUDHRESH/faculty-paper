"""Super admin tools: a searchable audit log with CSV, and a policy preview
that says which open claims a new version would reprice."""
from __future__ import annotations

import json

from django.test import Client, TestCase

from core.models import AuditLog, Claim, ClaimStatus, FormulaConfig, Role, User


class AuditSearchTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            email="sa@x.edu", password="p", name="Sys Admin", role=Role.SUPER_ADMIN
        )
        self.fin = User.objects.create_user(
            email="fin@x.edu", password=None, name="Meena Finance", role=Role.FINANCE
        )
        self.fac = User.objects.create_user(
            email="fac@x.edu", password=None, name="F", role=Role.FACULTY
        )
        self.claim = Claim.objects.create(
            owner=self.fac, status=ClaimStatus.PAID, ticket_number="T-42", paper_title="P"
        )
        AuditLog.objects.create(actor=self.fin, action="MARK_PAID", entity="Claim", entity_id=self.claim.id)
        AuditLog.objects.create(actor=self.admin, action="USER_UPDATE", entity="User", entity_id=self.fac.id)
        self.c = Client()
        self.c.force_login(self.admin)

    def test_filter_by_person(self):
        r = self.c.get("/api/admin/audit?person=Meena").json()
        self.assertEqual([x["action"] for x in r["results"]], ["MARK_PAID"])

    def test_filter_by_claim_ticket(self):
        r = self.c.get("/api/admin/audit?claim=T-42").json()
        self.assertEqual(r["total"], 1)
        self.assertEqual(r["results"][0]["entity_id"], self.claim.id)

    def test_filter_by_dates(self):
        self.assertEqual(self.c.get("/api/admin/audit?date_from=2999-01-01").json()["total"], 0)
        self.assertEqual(self.c.get("/api/admin/audit?date_to=2999-01-01").json()["total"], 2)
        self.assertEqual(self.c.get("/api/admin/audit?date_from=nope").status_code, 400)

    def test_csv_matches_filters(self):
        r = self.c.get("/api/admin/audit.csv?person=Meena")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r["Content-Type"])
        lines = r.content.decode().strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("MARK_PAID", lines[1])

    def test_csv_says_when_truncated(self):
        from unittest import mock

        with mock.patch("core.api.admin.AUDIT_CSV_CAP", 1):
            r = self.c.get("/api/admin/audit.csv")
        self.assertEqual(r["X-Truncated"], "true")
        self.assertEqual(r["X-Total-Rows"], "2")
        first = r.content.decode().splitlines()[0]
        self.assertIn("Truncated", first)
        self.assertIn("1 of 2", first)
        r = self.c.get("/api/admin/audit.csv")
        self.assertEqual(r["X-Truncated"], "false")
        self.assertTrue(r.content.decode("utf-8-sig").startswith("When (IST),"))

    def test_csv_refused_to_faculty(self):
        c = Client()
        c.force_login(self.fac)
        self.assertEqual(c.get("/api/admin/audit.csv").status_code, 403)


class PolicyPreviewTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            email="sa2@x.edu", password="p", name="Sys Admin", role=Role.SUPER_ADMIN
        )
        fac = User.objects.create_user(email="f2@x.edu", password=None, name="Dr F", role=Role.FACULTY)
        FormulaConfig.objects.create(
            name="Policy v1", version=1, active=True, snip_multiplier=55000, qf_q1=50000,
            qf_q2=30000, qf_q3=15000, qf_q4=7000, qf_no_snip=0, qf_snip_only=0,
            author_point_json=json.dumps({"1": [1.0]}), min_sec_references=0,
        )
        common = dict(
            owner=fac, paper_title="Open", snip=1.0, quartile="Q1", total_authors=1,
            author_position=1, publication_type="Journal", indexing_level="Scopus",
        )
        self.open = Claim.objects.create(status=ClaimStatus.CLEARED, ticket_number="O-1", **common)
        Claim.objects.create(status=ClaimStatus.PAID, ticket_number="P-1", **common)
        self.c = Client()
        self.c.force_login(self.admin)
        self.body = {
            "snip_multiplier": 80000, "qf_q1": 50000, "qf_q2": 30000, "qf_q3": 15000,
            "qf_q4": 7000, "author_point_json": json.dumps({"1": [1.0]}), "min_sec_references": 0,
        }

    def test_preview_lists_open_claims_that_change_and_saves_nothing(self):
        r = self.c.post("/api/admin/formula/preview", self.body, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual(d["open_claims"], 1)
        self.assertEqual(d["live_version"], 1)
        tickets = [x["ticket_number"] for x in d["changed"]]
        self.assertEqual(tickets, ["O-1"])
        self.assertGreater(d["after_total"], d["before_total"])
        self.assertEqual(FormulaConfig.objects.count(), 1)

    def test_same_rates_change_nothing(self):
        body = dict(self.body, snip_multiplier=55000)
        d = self.c.post("/api/admin/formula/preview", body, content_type="application/json").json()
        self.assertEqual(d["changed_count"], 0)

    def test_quota_papers_pay_nothing_and_are_reported_per_person(self):
        res = User.objects.create_user(
            email="r@x.edu", password=None, name="Dr Research", role=Role.FACULTY,
            faculty_type="RESEARCH", research_quota=1,
        )
        c = Claim.objects.create(
            owner=res, status=ClaimStatus.CLEARED, ticket_number="Q-1", paper_title="In quota",
            snip=1.0, quartile="Q1", total_authors=1, author_position=1,
            publication_type="Journal", indexing_level="Scopus", publication_year=2025,
        )
        Claim.objects.filter(pk=c.pk).update(quota_position=1)
        d = self.c.post("/api/admin/formula/preview", self.body, content_type="application/json").json()
        self.assertNotIn("Q-1", [x["ticket_number"] for x in d["changed"]])
        self.assertEqual(d["quota_papers"], 1)
        [row] = d["quota"]
        self.assertEqual(row["name"], "Dr Research")
        self.assertEqual(row["quota"], 1)
        self.assertEqual(row["tickets"], ["Q-1"])
        self.assertGreater(row["absorbed_after"], row["absorbed_before"])

    def test_faculty_refused(self):
        c = Client()
        c.force_login(Claim.objects.first().owner)
        r = c.post("/api/admin/formula/preview", self.body, content_type="application/json")
        self.assertEqual(r.status_code, 403)


class AttentionTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            email="sa3@x.edu", password="p", name="Sys Admin", role=Role.SUPER_ADMIN
        )
        self.c = Client()
        self.c.force_login(self.admin)

    def test_empty_system_says_why_each_item_matters(self):
        r = self.c.get("/api/admin/attention")
        self.assertEqual(r.status_code, 200, r.content)
        keys = {i["key"]: i for i in r.json()["items"]}
        self.assertIn("no_policy", keys)
        self.assertIn("backup_none", keys)
        self.assertEqual(keys["no_policy"]["severity"], "critical")
        self.assertTrue(all(i["why"] and i["to"] for i in keys.values()))
        self.assertEqual(r.json()["items"][0]["severity"], "critical")

    def test_only_super_admin(self):
        fin = User.objects.create_user(email="f3@x.edu", password=None, name="F", role=Role.FINANCE)
        c = Client()
        c.force_login(fin)
        self.assertEqual(c.get("/api/admin/attention").status_code, 403)
