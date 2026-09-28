"""`/api/feed/college`: recent college papers and people to follow, no money."""
from __future__ import annotations

from core.models import ClaimStatus, Follow
from core.test_social_plus import Base


class CollegeStreamTests(Base):
    def test_recent_papers_by_colleagues_without_money(self):
        self._paper(self.ravi, "T1", title="Graphene sheets", year=2026)
        self._paper(self.meera, "T2", title="Graphene sheets", year=2026)  # same paper, one card
        self._paper(self.asha, "T3", title="My own", year=2026)
        self._paper(self.meera, "T4", title="A draft", status=ClaimStatus.DRAFT, year=2026)
        data = self._json("get", self.asha, "/api/feed/college")
        titles = [p["paper"]["title"] for p in data["papers"]]
        self.assertEqual(titles, ["Graphene sheets"])
        self.assertIn("photo_url", data["papers"][0]["owner"])
        self.assertNoMoney(data)

    def test_people_skip_me_and_whom_i_follow(self):
        self._paper(self.ravi, "T1", year=2026)
        self._paper(self.meera, "T2", year=2026)
        self._paper(self.asha, "T3", year=2026)
        Follow.objects.create(follower=self.asha, person=self.ravi)
        data = self._json("get", self.asha, "/api/feed/college")
        self.assertEqual([p["id"] for p in data["people"]], [self.meera.id])
        self.assertIn("initials", data["people"][0])

    def test_needs_sign_in(self):
        self.assertIn(self.c.get("/api/feed/college").status_code, (401, 403))
