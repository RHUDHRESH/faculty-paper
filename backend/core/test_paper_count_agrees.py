"""Home and My research report the same paper count.

The UX walk found the card saying 20 while Home and My research said 10
(docs/ux/15). All three now read `core.services.person_record`: the
publication record plus claims-only papers.
"""
from datetime import date

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, PaidLedger, Publication, Role, User


class PaperCountAgreesTests(TestCase):
    def setUp(self):
        cache.clear()
        self.me = User.objects.create_user(
            email="me@x.edu", password="p", name="Asha Rao", role=Role.FACULTY,
            staff_id="S1", department="Physics",
        )
        self.c = Client()
        self.c.force_login(self.me)

    def _pub(self, title, year, **kw):
        p = Publication.objects.create(title=title, normalized_title=title.lower(), year=year,
                                       date=date(year, 3, 1), **kw)
        Authorship.objects.create(publication=p, user=self.me, position=1, display_name=self.me.name,
                                  author_key=f"u:{self.me.id}", is_college=True)
        return p

    def _three(self):
        home = self.c.get("/api/me/summary").json()["papers"]
        research = self.c.get("/api/me/research").json()["metrics"]["papers"]
        return home, research

    def test_record_plus_claims_only_is_one_count_everywhere(self):
        # On the record only (OpenAlex found it, no claim).
        self._pub("Record only paper", 2023, quartile="Q1", citations=5)
        # On the record AND claimed: one paper, not two.
        linked = self._pub("Claimed and recorded", 2024, doi="10.1/abc")
        claim = Claim.objects.create(owner=self.me, status=ClaimStatus.PAID, paper_title="Claimed and recorded",
                                     doi="10.1/abc", publication_year=2024)
        linked.claims.add(claim)
        # Same paper by DOI, not linked: still one.
        self._pub("Doi twin on record", 2022, doi="10.1/twin")
        Claim.objects.create(owner=self.me, status=ClaimStatus.PAID, paper_title="Doi twin, differently titled",
                             doi="10.1/twin", publication_year=2022)
        # Claims-only: recognised by the college, not on the record yet.
        Claim.objects.create(owner=self.me, status=ClaimStatus.DIRECTOR_APPROVED, paper_title="Only a claim",
                             publication_year=2025, quartile="Q2")
        PaidLedger.objects.create(staff_id="s1", paper_title="Only a ledger row",
                                  payout_month=date(2024, 5, 1), amount=0)
        # Not recognised yet: counts nowhere.
        Claim.objects.create(owner=self.me, status=ClaimStatus.SUBMITTED, paper_title="Under review")

        home, research = self._three()
        self.assertEqual((home, research), (5, 5))

    def test_empty_record_is_zero_everywhere(self):
        self.assertEqual(self._three(), (0, 0))
