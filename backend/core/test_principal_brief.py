from datetime import date

from django.test import TestCase

from core.models import Authorship, Budget, PaidLedger, Publication, Role, User
from core.services import principal_brief


class PrincipalBriefTests(TestCase):
    def setUp(self):
        self.principal = User.objects.create(email="p@x.test", name="P", role=Role.PRINCIPAL)
        self.hod = User.objects.create(email="h@x.test", name="H", role=Role.HOD, department="CSE")
        self.cse = [User.objects.create(email=f"c{i}@x.test", name=f"C{i}", role=Role.FACULTY, department="CSE")
                    for i in range(3)]
        self.mech = User.objects.create(email="m@x.test", name="M", role=Role.FACULTY, department="MECH")
        n = 0
        for year, dept_users, count, q in ((2024, self.cse, 2, "Q1"), (2025, self.cse, 4, "Q3"),
                                           (2025, [self.mech], 1, "Q2")):
            for k in range(count):
                n += 1
                pub = Publication.objects.create(title=f"Paper {n}", year=year, quartile=q, doi=f"10.1/{n}")
                Authorship.objects.create(publication=pub, display_name="x", author_key=f"k{n}",
                                          is_college=True, user=dept_users[k % len(dept_users)])
        # One paper shared by CSE and MECH: once for the college, once in each department.
        shared = Publication.objects.create(title="Shared", year=2025, quartile="Q1", doi="10.1/s")
        Authorship.objects.create(publication=shared, display_name="a", author_key="s1", is_college=True, user=self.cse[0])
        Authorship.objects.create(publication=shared, display_name="b", author_key="s2", is_college=True, user=self.mech)
        # FY 2025-26 = Apr 2025..Mar 2026; the March 2025 payment belongs to FY 2024-25.
        PaidLedger.objects.create(payout_month=date(2025, 5, 1), department="CSE", amount=30000)
        PaidLedger.objects.create(payout_month=date(2026, 3, 1), department="MECH", amount=10000)
        PaidLedger.objects.create(payout_month=date(2025, 3, 1), department="CSE", amount=99999)
        Budget.objects.create(financial_year="2025-26", amount=80000)

    def test_figures(self):
        b = principal_brief.brief(2025)
        t = b["totals"]
        self.assertEqual(t["papers"], 6)            # 4 CSE + 1 MECH + shared once
        self.assertEqual(t["papers_prev"], 2)
        self.assertEqual(t["teachers"], 5)          # faculty and heads; not the Principal
        self.assertEqual(t["per_teacher"], 1.2)
        self.assertEqual(t["paid"], 40000)          # FY 2025-26 only
        self.assertEqual(t["paid_prev"], 99999)
        self.assertEqual(t["budget_used"], 50)
        self.assertEqual(t["top_quartile_share"], 33)  # Q1 shared + Q2: 2 of 6
        depts = {d["department"]: d for d in b["departments"]}
        self.assertEqual(depts["CSE"]["papers"], 5)
        self.assertEqual(depts["MECH"]["papers"], 2)
        self.assertEqual(depts["MECH"]["per_teacher"], 2.0)
        self.assertEqual(b["departments"][0]["department"], "MECH")  # ranked per teacher, not size
        self.assertEqual(b["naac_331"]["papers"], 8)
        self.assertIn("up 200% on 2024", b["headline"])
        self.assertIn("₹40,000", b["headline"])

    def test_running_year_is_not_compared(self):
        b = principal_brief.brief(date.today().year)
        self.assertTrue(b["partial"])
        self.assertIn("not over", b["headline"])
        self.assertNotIn(" on ", b["headline"].split(".")[1])

    def test_naac_band(self):
        self.assertEqual([principal_brief.naac_331_band(v) for v in (None, 1, 3, 5, 10)], [0, 1, 2, 3, 4])

    def test_endpoints_and_downloads(self):
        self.client.force_login(self.principal)
        r = self.client.get("/api/reports/brief?year=2025")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["totals"]["papers"], 6)
        pdf = self.client.get("/api/reports/brief/export?year=2025&fmt=pdf")
        self.assertEqual(pdf["Content-Type"], "application/pdf")
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        x = self.client.get("/api/reports/brief/export?year=2025&fmt=xlsx")
        self.assertTrue(x.content.startswith(b"PK"))
        self.assertEqual(self.client.get("/api/reports/brief/export?fmt=doc").status_code, 400)

    def test_faculty_and_hod_refused(self):
        for u in (self.cse[0], self.hod):
            self.client.force_login(u)
            self.assertEqual(self.client.get("/api/reports/brief").status_code, 403)

    def test_papers_list_matches_the_brief(self):
        """Every figure opens a list that counts the same papers."""
        self.client.force_login(self.principal)
        b = self.client.get("/api/reports/brief?year=2025").json()
        every = self.client.get("/api/reports/papers?year=2025").json()
        self.assertEqual(every["total"], b["totals"]["papers"])
        for d in b["departments"]:
            r = self.client.get("/api/reports/papers", {"year": 2025, "department": d["department"]}).json()
            self.assertEqual(r["total"], d["papers"], d["department"])
        top = self.client.get("/api/reports/papers?year=2025&quartile=top").json()
        self.assertEqual(top["total"], 2)  # the shared Q1 paper and MECH's Q2
        none = self.client.get("/api/reports/papers?year=2025&quartile=none").json()
        self.assertEqual(none["total"], 0)
        row = every["results"][0]
        self.assertTrue(row["authors"] and row["authors"][0]["name"])
        found = self.client.get("/api/reports/papers?year=2025&q=Shared").json()
        self.assertEqual(found["total"], 1)

    def test_department_page(self):
        self.client.force_login(self.principal)
        r = self.client.get("/api/reports/department", {"name": "cse", "year": 2025})
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(d["department"], "CSE")
        self.assertEqual(d["row"]["papers"], 5)
        self.assertEqual(len(d["people"]), 4)  # three faculty and the head
        self.assertEqual(self.client.get("/api/reports/department", {"name": "nowhere"}).status_code, 404)

    def test_department_spellings_are_one_department(self):
        """The ledger's "cse" and "Not Found" are not departments of their own."""
        PaidLedger.objects.create(payout_month=date(2025, 6, 1), department="cse", amount=1000)
        PaidLedger.objects.create(payout_month=date(2025, 6, 1), department="Not Found", amount=500)
        b = principal_brief.brief(2025)
        names = [d["department"] for d in b["departments"]]
        self.assertNotIn("cse", names)
        self.assertNotIn("Not Found", names)
        cse = next(d for d in b["departments"] if d["department"] == "CSE")
        self.assertEqual(cse["paid"], 31000)  # 30000 already there, plus the 1000 filed as "cse"

    def test_accreditation_summary(self):
        retracted = Publication.objects.create(title="RETRACTED: A paper", year=2025, doi="10.1/r", scopus_indexed=True)
        Authorship.objects.create(publication=retracted, display_name="x", author_key="kr", is_college=True, user=self.cse[1])
        self.client.force_login(self.principal)
        a = self.client.get("/api/reports/accreditation?year=2025").json()
        self.assertEqual([r["year"] for r in a["table"]], [2021, 2022, 2023, 2024, 2025])
        row = a["table"][-1]
        self.assertEqual(row["record_papers"], 7)  # six from setUp and the retracted one
        self.assertEqual(row["scopus"], 1)
        self.assertEqual(row["retraction_signals"], 1)
        self.assertFalse(a["ugc_list_loaded"])
        self.assertEqual(a["naac_331"]["papers"], 9)
        self.client.force_login(self.cse[0])
        self.assertEqual(self.client.get("/api/reports/accreditation").status_code, 403)

    def test_push_and_pack(self):
        b = principal_brief.brief(2025)
        self.assertIsInstance(b["push"], list)
        keys = {c["key"]: c for c in b["pack"]}
        self.assertTrue(keys["budget"]["ok"])
        self.assertFalse(keys["ugc"]["ok"])

    def test_lists_refuse_faculty(self):
        self.client.force_login(self.cse[0])
        self.assertEqual(self.client.get("/api/reports/papers").status_code, 403)
        self.assertEqual(self.client.get("/api/reports/department?name=CSE").status_code, 403)
