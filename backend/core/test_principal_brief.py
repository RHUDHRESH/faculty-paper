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
