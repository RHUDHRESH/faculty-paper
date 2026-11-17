"""Personal API tokens and the read-only /api/v1 they open."""
from __future__ import annotations

import csv
import io
import json
from datetime import timedelta

from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from core.models import (
    ApiToken,
    ApiTokenUsage,
    Authorship,
    Claim,
    ClaimStatus,
    PaidLedger,
    Publication,
    Role,
    Team,
    TeamMember,
    User,
)
from core.services import api_tokens

ALL = list(api_tokens.SCOPES)


def _user(email, role, dept="CSE", **extra):
    return User.objects.create_user(email=email, password="pw-long-enough-1", name=email.split("@")[0].title(),
                                    role=role, department=dept, **extra)


def _json(response):
    return json.loads(response.content)


class Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.fac = _user("fac@t.edu", Role.FACULTY, staff_id="S1")
        cls.fac2 = _user("fac2@t.edu", Role.FACULTY, staff_id="S2")
        cls.other_dept = _user("mech@t.edu", Role.FACULTY, dept="MECH", staff_id="S3")
        cls.head = _user("head@t.edu", Role.HOD)
        cls.office = _user("office@t.edu", Role.RESEARCH_COORDINATOR, dept="Admin")
        cls.admin = _user("admin@t.edu", Role.SUPER_ADMIN, dept="Admin")
        cls.fin = _user("fin@t.edu", Role.FINANCE, dept="Accounts")

        cls.c_fac = Claim.objects.create(owner=cls.fac, status=ClaimStatus.PAID, paper_title="Own paper",
                                         journal_title="J1", ticket_number="FP-1", remuneration=5000,
                                         publication_year=2025, doi="10.1/a")
        cls.c_fac_draft = Claim.objects.create(owner=cls.fac, status=ClaimStatus.DRAFT, paper_title="Own draft",
                                               ticket_number=None, remuneration=111)
        cls.c_fac2 = Claim.objects.create(owner=cls.fac2, status=ClaimStatus.SUBMITTED, paper_title="Colleague paper",
                                          ticket_number="FP-2", remuneration=7000, publication_year=2025)
        cls.c_fac2_draft = Claim.objects.create(owner=cls.fac2, status=ClaimStatus.DRAFT,
                                                paper_title="Colleague secret draft", remuneration=222)
        cls.c_mech = Claim.objects.create(owner=cls.other_dept, status=ClaimStatus.SUBMITTED,
                                          paper_title="Mech paper", ticket_number="FP-3", remuneration=9000)
        cls.c_head = Claim.objects.create(owner=cls.head, status=ClaimStatus.SUBMITTED, paper_title="Head paper",
                                          ticket_number="FP-4", remuneration=1234)
        PaidLedger.objects.create(claim=cls.c_fac, payout_month=timezone.localdate().replace(day=1),
                                  department="CSE", faculty_name="Fac", staff_id="S1", paper_title="Own paper",
                                  amount=5000, voucher_number="V1")
        PaidLedger.objects.create(claim=None, payout_month=timezone.localdate().replace(day=1),
                                  department="MECH", faculty_name="Mech", staff_id="S3", paper_title="Mech old",
                                  amount=3000, voucher_number="V2")

        for owner, title in ((cls.fac, "Pub one"), (cls.fac2, "Pub two"), (cls.other_dept, "Pub mech")):
            pub = Publication.objects.create(title=title, year=2025, venue="J", doi=f"10.9/{title[-3:]}",
                                             quartile="Q1", citations=4)
            Authorship.objects.create(publication=pub, position=1, display_name=owner.name, author_key=owner.id,
                                      user=owner, is_college=True)
            Authorship.objects.create(publication=pub, position=2, display_name="External Person",
                                      author_key="n:external")

        team = Team.objects.create(code="T1", title="Robot", department="CSE", academic_year="2025-26",
                                   mentor=cls.fac)
        TeamMember.objects.create(team=team, name="Student A", register_number="R1")
        Team.objects.create(code="T2", title="Other", department="MECH", academic_year="2025-26",
                            mentor=cls.other_dept)

    def setUp(self):
        cache.clear()
        self.client = Client()

    def token(self, user, scopes=None, days=None):
        token, secret = api_tokens.create(user, "test", scopes or api_tokens.scopes_for_role(user.role), days)
        return token, secret

    def get(self, path, secret, **extra):
        return self.client.get(path, HTTP_AUTHORIZATION=f"Bearer {secret}", **extra)


class TokenStorageTests(Base):
    def test_only_a_hash_is_stored_and_the_secret_has_the_format(self):
        token, secret = self.token(self.fac)
        self.assertTrue(secret.startswith("sec_"))
        self.assertEqual(len(secret), 4 + 40)
        self.assertEqual(token.prefix, secret[:8])
        self.assertEqual(token.secret_hash, api_tokens.hash_secret(secret))
        for value in ApiToken.objects.filter(pk=token.pk).values()[0].values():
            self.assertNotIn(secret, str(value))
        # Expires in a year unless told otherwise.
        self.assertAlmostEqual((token.expires_at - timezone.now()).days, 365, delta=1)

    def test_the_secret_is_shown_once(self):
        c = Client()
        c.force_login(self.fac)
        r = c.post("/api/me/api-tokens", data=json.dumps({"name": "Excel", "scopes": ["read:papers"]}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        body = _json(r)
        self.assertTrue(body["secret"].startswith("sec_"))
        listing = c.get("/api/me/api-tokens")
        self.assertNotIn(body["secret"], listing.content.decode())
        self.assertNotIn("secret", json.dumps(_json(listing)["tokens"]))
        self.assertNotIn("secret_hash", listing.content.decode())

    def test_own_tokens_only_and_revoke(self):
        token, secret = self.token(self.fac)
        c = Client()
        c.force_login(self.fac2)
        self.assertEqual(c.delete(f"/api/me/api-tokens/{token.id}").status_code, 404)
        c.force_login(self.fac)
        self.assertEqual(c.delete(f"/api/me/api-tokens/{token.id}").status_code, 200)
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 401)

    def test_scopes_are_limited_to_what_the_role_can_read(self):
        c = Client()
        c.force_login(self.head)
        r = c.post("/api/me/api-tokens", data=json.dumps({"name": "x", "scopes": ["read:payments"]}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("read:payments", [o["scope"] for o in _json(c.get("/api/me/api-tokens"))["scope_options"]])

    def test_admin_lists_every_token_without_secrets_and_revokes_any(self):
        token, secret = self.token(self.fac)
        c = Client()
        c.force_login(self.fac)
        self.assertEqual(c.get("/api/admin/api-tokens").status_code, 403)
        c.force_login(self.admin)
        r = c.get("/api/admin/api-tokens")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(secret, r.content.decode())
        self.assertNotIn("secret_hash", r.content.decode())
        self.assertEqual(_json(r)["tokens"][0]["owner"]["email"], "fac@t.edu")
        self.assertEqual(c.delete(f"/api/admin/api-tokens/{token.id}").status_code, 200)
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 401)


class AuthTests(Base):
    def test_missing_or_bad_tokens_get_401(self):
        self.assertEqual(self.client.get("/api/v1/papers").status_code, 401)
        self.assertEqual(self.get("/api/v1/papers", "sec_" + "x" * 40).status_code, 401)
        self.assertEqual(self.get("/api/v1/papers", "garbage").status_code, 401)

    def test_revoked_expired_and_inactive_get_401(self):
        token, secret = self.token(self.fac)
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 200)
        ApiToken.objects.filter(pk=token.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 401)
        ApiToken.objects.filter(pk=token.pk).update(expires_at=None, revoked_at=timezone.now())
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 401)
        ApiToken.objects.filter(pk=token.pk).update(revoked_at=None)
        User.objects.filter(pk=self.fac.pk).update(active=False)
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 401)

    def test_scope_is_enforced(self):
        _t, secret = self.token(self.fac, ["read:papers"])
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 200)
        for kind in ("claims", "payments", "faculty", "teams"):
            self.assertEqual(self.get(f"/api/v1/{kind}", secret).status_code, 403, kind)

    def test_a_token_cannot_reach_session_endpoints_or_write(self):
        _t, secret = self.token(self.office)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {secret}"}
        for path in ("/api/me/api-tokens", "/api/claims", "/api/me/payments", "/api/directory/faculty"):
            self.assertEqual(self.client.get(path, **auth).status_code, 401, path)
        before = Claim.objects.count()
        r = self.client.post("/api/claims", data=json.dumps({"paper_title": "x"}),
                             content_type="application/json", **auth)
        self.assertIn(r.status_code, (401, 403))
        self.assertEqual(Claim.objects.count(), before)
        for method in ("post", "put", "patch", "delete"):
            r = getattr(self.client, method)("/api/v1/claims", data="{}", content_type="application/json", **auth)
            self.assertEqual(r.status_code, 405, method)
        self.assertEqual(Claim.objects.count(), before)

    def test_a_browser_session_does_not_open_the_data_endpoints(self):
        c = Client()
        c.force_login(self.office)
        self.assertEqual(c.get("/api/v1/claims").status_code, 401)

    def test_role_switch_off_gives_403_and_blocks_creation(self):
        _t, secret = self.token(self.fac)
        admin = Client()
        admin.force_login(self.admin)
        r = admin.put("/api/admin/api-access", data=json.dumps({"role": "FACULTY", "enabled": False}),
                      content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(_json(r)["access"]["FACULTY"])
        self.assertTrue(_json(r)["access"]["HOD"])
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 403)
        c = Client()
        c.force_login(self.fac)
        r = c.post("/api/me/api-tokens", data=json.dumps({"name": "n", "scopes": ["read:papers"]}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 403)
        admin.put("/api/admin/api-access", data=json.dumps({"role": "FACULTY", "enabled": True}),
                  content_type="application/json")
        self.assertEqual(self.get("/api/v1/papers", secret).status_code, 200)

    def test_rate_limit_is_60_a_minute_with_retry_after(self):
        _t, secret = self.token(self.fac, ["read:papers"])
        for _ in range(60):
            self.assertEqual(self.get("/api/v1/papers", secret).status_code, 200)
        r = self.get("/api/v1/papers", secret)
        self.assertEqual(r.status_code, 429)
        self.assertGreaterEqual(int(r["Retry-After"]), 1)

    def test_usage_is_counted_per_token_and_day(self):
        token, secret = self.token(self.fac, ["read:papers"])
        for _ in range(3):
            self.get("/api/v1/papers", secret, REMOTE_ADDR="10.1.2.3")
        token.refresh_from_db()
        self.assertEqual(token.use_count, 3)
        self.assertEqual(token.last_used_ip, "10.1.2.3")
        self.assertIsNotNone(token.last_used_at)
        self.assertEqual(ApiTokenUsage.objects.get(token=token).count, 3)


class VisibilityTests(Base):
    def titles(self, user, kind, key="title"):
        _t, secret = self.token(user)
        r = self.get(f"/api/v1/{kind}", secret)
        self.assertEqual(r.status_code, 200, r.content)
        return _json(r)["data"]

    def test_faculty_see_only_their_own_claims_and_drafts(self):
        rows = self.titles(self.fac, "claims")
        self.assertEqual({r["title"] for r in rows}, {"Own paper", "Own draft"})
        self.assertEqual(rows[0]["owner_id"], self.fac.id)

    def test_head_sees_department_filed_claims_and_no_money(self):
        _t, secret = self.token(self.head)
        r = self.get("/api/v1/claims", secret)
        body = r.content.decode()
        rows = _json(r)["data"]
        self.assertEqual({x["title"] for x in rows}, {"Own paper", "Colleague paper", "Head paper"})
        self.assertNotIn("Colleague secret draft", body)
        self.assertNotIn("Mech paper", body)
        for row in rows:
            self.assertNotIn("amount", row)
            self.assertNotIn("paid_on", row)
        self.assertNotIn("5000", body)
        # Not even through the spreadsheet.
        csv_body = self.get("/api/v1/claims?format=csv", secret).content.decode("utf-8-sig")
        self.assertNotIn("amount", csv_body.splitlines()[0])

    def test_head_is_refused_payments(self):
        _t, secret = self.token(self.head, ["read:claims"])
        self.assertEqual(self.get("/api/v1/payments", secret).status_code, 403)

    def test_office_sees_the_college_but_no_other_drafts(self):
        rows = self.titles(self.office, "claims")
        titles = {r["title"] for r in rows}
        self.assertTrue({"Own paper", "Colleague paper", "Mech paper"} <= titles)
        self.assertNotIn("Own draft", titles)
        self.assertNotIn("Colleague secret draft", titles)
        self.assertTrue(all("amount" in r for r in rows))

    def test_payments_faculty_own_and_office_all(self):
        mine = self.titles(self.fac, "payments")
        self.assertEqual([r["voucher"] for r in mine], ["V1"])
        self.assertEqual(mine[0]["amount"], 5000)
        everyone = self.titles(self.fin, "payments")
        self.assertEqual({r["voucher"] for r in everyone}, {"V1", "V2"})

    def test_papers_faculty_own_head_department_office_college(self):
        self.assertEqual([r["title"] for r in self.titles(self.fac, "papers")], ["Pub one"])
        self.assertEqual({r["title"] for r in self.titles(self.head, "papers")}, {"Pub one", "Pub two"})
        self.assertEqual(len(self.titles(self.office, "papers")), 3)
        row = self.titles(self.fac, "papers")[0]
        self.assertEqual(row["authors"], [self.fac.name, "External Person"])
        self.assertEqual(row["college_authors"], [self.fac.name])

    def test_faculty_directory_scoping_and_money(self):
        own = self.titles(self.fac, "faculty")
        self.assertEqual([r["id"] for r in own], [self.fac.id])
        head = self.titles(self.head, "faculty")
        self.assertEqual({r["department"] for r in head}, {"CSE"})
        self.assertTrue(all("incentive_total" not in r for r in head))
        office = self.titles(self.office, "faculty")
        self.assertIn(self.other_dept.id, {r["id"] for r in office})
        self.assertTrue(all("incentive_total" in r for r in office))

    def test_teams_scoping(self):
        self.assertEqual([r["code"] for r in self.titles(self.fac, "teams")], ["T1"])
        self.assertEqual([r["code"] for r in self.titles(self.head, "teams")], ["T1"])
        self.assertEqual({r["code"] for r in self.titles(self.office, "teams")}, {"T1", "T2"})
        self.assertEqual(self.titles(self.fac, "teams")[0]["members"][0]["register_number"], "R1")

    def test_department_filter_for_office(self):
        _t, secret = self.token(self.office)
        rows = _json(self.get("/api/v1/claims?department=MECH", secret))["data"]
        self.assertEqual([r["title"] for r in rows], ["Mech paper"])


class FormatTests(Base):
    def test_json_envelope_and_pagination(self):
        _t, secret = self.token(self.office, ["read:claims"])
        r = _json(self.get("/api/v1/claims?page_size=2", secret))
        self.assertEqual(set(r), {"data", "page", "page_size", "total", "next"})
        self.assertEqual((r["page"], r["page_size"], len(r["data"])), (1, 2, 2))
        self.assertEqual(r["total"], 4)
        self.assertIn("page=2", r["next"])
        second = _json(self.get("/api/v1/claims?page_size=2&page=2", secret))
        self.assertIsNone(second["next"])
        ids = [x["id"] for x in r["data"]] + [x["id"] for x in second["data"]]
        self.assertEqual(len(set(ids)), 4)

    def test_page_size_is_capped_and_bad_values_refused(self):
        _t, secret = self.token(self.office, ["read:claims"])
        self.assertEqual(_json(self.get("/api/v1/claims?page_size=5000", secret))["page_size"], 1000)
        for bad in ("page=0", "page_size=0", "page=x", "year=abc", "from=nope", "format=pdf",
                    "from=2026-05-01&to=2026-04-01"):
            self.assertEqual(self.get(f"/api/v1/claims?{bad}", secret).status_code, 400, bad)

    def test_updated_since_year_and_q(self):
        _t, secret = self.token(self.office, ["read:claims"])
        future = (timezone.now() + timedelta(days=1)).isoformat().replace("+", "%2B")
        self.assertEqual(_json(self.get(f"/api/v1/claims?updated_since={future}", secret))["total"], 0)
        self.assertEqual(_json(self.get("/api/v1/claims?year=2025", secret))["total"], 2)
        self.assertEqual(_json(self.get("/api/v1/claims?q=head", secret))["total"], 1)

    def test_csv_is_formula_safe(self):
        Claim.objects.filter(pk=self.c_fac.pk).update(paper_title='=HYPERLINK("http://evil","x")',
                                                       journal_title="@SUM(A1)")
        _t, secret = self.token(self.fac, ["read:claims"])
        r = self.get("/api/v1/claims?format=csv", secret)
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r["Content-Type"])
        rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
        titles = {row["title"] for row in rows}
        self.assertIn("'=HYPERLINK(\"http://evil\",\"x\")", titles)
        self.assertIn("'@SUM(A1)", {row["journal"] for row in rows})
        self.assertEqual(r["X-Total-Count"], "2")

    def test_xlsx_is_formula_safe(self):
        from openpyxl import load_workbook

        Claim.objects.filter(pk=self.c_fac.pk).update(paper_title="=1+1")
        _t, secret = self.token(self.fac, ["read:claims"])
        r = self.get("/api/v1/claims?format=xlsx", secret)
        self.assertEqual(r.status_code, 200)
        ws = load_workbook(io.BytesIO(r.content)).active
        header = [c.value for c in ws[1]]
        col = header.index("title") + 1
        values = [ws.cell(row=i, column=col) for i in range(2, ws.max_row + 1)]
        self.assertIn("'=1+1", [c.value for c in values])
        for cell in values:
            self.assertNotEqual(cell.data_type, "f")

    def test_meta_serves_tokens_and_browsers(self):
        _t, secret = self.token(self.head, ["read:papers"])
        r = _json(self.get("/api/v1/meta", secret))
        names = {e["name"]: e for e in r["endpoints"]}
        self.assertEqual(set(names), {"papers", "claims", "payments", "faculty", "teams"})
        self.assertFalse(names["payments"]["available"])
        self.assertNotIn("amount", [f["name"] for f in names["claims"]["fields"]])
        c = Client()
        c.force_login(self.office)
        office = _json(c.get("/api/v1/meta"))
        self.assertIn("amount", [f["name"] for e in office["endpoints"] if e["name"] == "claims" for f in e["fields"]])
        self.assertEqual(Client().get("/api/v1/meta").status_code, 401)
