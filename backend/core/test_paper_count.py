"""One paper count everywhere (docs/audit/faculty).

Home (`/me/summary`), My papers (`/me/publications`), My research
(`/me/research`), the person's own record (`/directory/faculty/me`) and the
public profile's figures (`/people/{id}/publication-metrics`) count the same
thing. The last of them used to read a stored snapshot that lagged the record
by a paper or more, so a colleague opening the profile saw 144 where the owner
saw 145.
"""
from datetime import date

from django.test import Client, TestCase

from core.models import Authorship, PaidLedger, Publication, PublicationMetrics, Role, User


class OnePaperCount(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="me@x.edu", password="p", name="Dr Me", role=Role.FACULTY, staff_id="S1", department="ECE"
        )
        for i in range(3):
            pub = Publication.objects.create(title=f"Paper {i}", year=2024, doi=f"10.1/{i}", citations=i)
            Authorship.objects.create(publication=pub, position=1, display_name="Dr Me", user=self.me,
                                      author_key=f"u:{self.me.id}", is_college=True)
        # A paper known only from the accounts ledger still counts on the record.
        PaidLedger.objects.create(staff_id="S1", paper_title="Ledger only", payout_month=date(2024, 3, 1), amount=1000)
        # A snapshot taken before the ledger paper was recognised.
        PublicationMetrics.objects.create(user=self.me, total_publications=3, total_citations=3, h_index=1)
        self.c = Client()
        self.c.force_login(self.me)

    def counts(self):
        get = lambda p: self.c.get(p).json()  # noqa: E731
        return {
            "home": get("/api/me/summary")["papers"],
            "my_papers": get("/api/me/publications")["count"],
            "my_papers_metrics": get("/api/me/publications")["metrics"]["total_publications"],
            "my_research": get("/api/me/research")["metrics"]["papers"],
            "record_figure": get("/api/directory/faculty/me")["metrics"]["total_publications"],
            "record_list": len(get("/api/directory/faculty/me")["papers"]),
            "profile_figure": get(f"/api/people/{self.me.id}/publication-metrics")["total_publications"],
        }

    def test_every_view_counts_the_same_papers(self):
        counts = self.counts()
        self.assertEqual(len(set(counts.values())), 1, counts)
        self.assertEqual(counts["home"], 4)
