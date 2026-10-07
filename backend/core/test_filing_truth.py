"""Home, My papers and the filing page give one answer about a paper:
retracted papers are not offered, my own old-ERP payments count as paid, and a
colleague's merely similar title is a note, not a block."""
import json
from datetime import date, datetime, timezone

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Authorship, PriorPayment, Publication, Role, User
from core.services.normalize import normalize_title
from core.services.verify import check_already_paid, erp_reference


class FilingTruthTests(TestCase):
    def setUp(self):
        cache.clear()
        self.me = User.objects.create_user(
            email="truth@x.edu", password="p", name="Asha Rao", role=Role.FACULTY,
            staff_id="S77", department="Physics",
        )
        self.c = Client()
        self.c.force_login(self.me)

    def _pub(self, title, year=2024, **kw):
        p = Publication.objects.create(title=title, normalized_title=normalize_title(title), year=year,
                                       date=date(year, 3, 1), **kw)
        Authorship.objects.create(publication=p, user=self.me, position=1, display_name=self.me.name,
                                  author_key=f"u:{self.me.id}", is_college=True)
        return p

    def _prior(self, title, **kw):
        kw.setdefault("normalized_title", normalize_title(title))
        return PriorPayment.objects.create(paper_title=title, raw_json="{}", amount_paid=4000, **kw)

    def _mine(self, title):
        pubs = self.c.get("/api/me/publications").json()["publications"]
        return next(p for p in pubs if p["title"] == title)

    def test_a_retracted_paper_is_not_offered(self):
        self._pub("RETRACTED: Graphene sensors for everything")
        self._pub("Graphene sensors that work")
        home = self.c.get("/api/me/home").json()
        self.assertEqual([i["title"] for i in home["unfiled"]["items"]], ["Graphene sensors that work"])
        row = self._mine("RETRACTED: Graphene sensors for everything")
        self.assertFalse(row["eligible"])
        self.assertEqual(row["ineligible_reason"], "Retracted")

    def test_my_own_erp_payment_counts_as_paid(self):
        self._pub("Optical fibres in rural clinics", doi="10.5/fibre")
        self._pub("Still to file")
        self._prior("Optical Fibres in Rural Clinics", employee_id="s77",
                    paid_at=datetime(2023, 4, 1, tzinfo=timezone.utc), claim_ref="2467.0")
        home = self.c.get("/api/me/home").json()
        self.assertEqual([i["title"] for i in home["unfiled"]["items"]], ["Still to file"])
        row = self._mine("Optical fibres in rural clinics")
        self.assertEqual(row["claim"]["stage"], "Paid")
        self.assertEqual(row["claim"]["paid_month"], "2023-04")

    def test_a_colleagues_erp_payment_does_not_mark_mine_paid(self):
        self._pub("Optical fibres in rural clinics")
        self._prior("Optical Fibres in Rural Clinics", employee_id="S99")
        self.assertIsNone(self._mine("Optical fibres in rural clinics")["claim"])

    def test_a_colleagues_similar_title_warns_without_blocking(self):
        self._prior("Deep Learning for Rice Disease Detection in Tamil Nadu",
                    employee_id="S99", faculty_name="Dr Other", claim_ref="1067.0")
        out = check_already_paid(
            title="Deep learning for rice disease detection in Tamil Nadu region", staff_id="S77")
        self.assertTrue(out["warning"])
        self.assertFalse(out["block"])
        self.assertFalse(out["matches"][0]["blocks"])

    def test_an_exact_title_by_anyone_still_blocks(self):
        self._prior("Deep Learning for Rice Disease Detection", employee_id="S99")
        out = check_already_paid(title="Deep learning for rice disease detection", staff_id="S77")
        self.assertTrue(out["block"])

    def test_the_endpoint_knows_who_is_asking(self):
        self._prior("Deep Learning for Rice Disease Detection in Tamil Nadu", employee_id="S77",
                    claim_ref="1067.0")
        out = self.c.post("/api/prior/check", data=json.dumps(
            {"title": "Deep learning for rice disease detection in Tamil Nadu region"}),
            content_type="application/json").json()
        self.assertTrue(out["block"], "my own earlier payment for a similar title stops me")
        self.assertEqual(out["matches"][0]["reference"], "ERP #1067")

    def test_the_reference_has_no_float_tail(self):
        self.assertEqual(erp_reference("2467.0"), "ERP #2467")
        self.assertEqual(erp_reference("A-12"), "ERP #A-12")
        self.assertIsNone(erp_reference(None))
