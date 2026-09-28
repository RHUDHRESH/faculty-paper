"""Who may make somebody research faculty and set their quota."""
import json

from django.test import Client, TestCase

from core.models import Role, User


class ResearchPostTests(TestCase):
    def setUp(self):
        self.person = User.objects.create_user(
            email="r@x.edu", password="p", name="Researcher", role=Role.FACULTY, department="EEE"
        )
        self.c = Client()

    def _as(self, role):
        u = User.objects.create_user(email=f"{role.lower()}@x.edu", password="p", name=role, role=role)
        self.c.force_login(u)

    def _patch(self, body):
        return self.c.patch(
            f"/api/admin/users/{self.person.id}", data=json.dumps(body), content_type="application/json"
        )

    def test_the_research_coordinator_ticks_research_faculty_and_sets_the_quota(self):
        self._as(Role.RESEARCH_COORDINATOR)
        r = self._patch({"faculty_type": "RESEARCH", "research_quota": 4, "research_quota_note": "2026-27 target"})
        self.assertEqual(r.status_code, 200, r.content)
        self.person.refresh_from_db()
        self.assertEqual((self.person.faculty_type, self.person.research_quota), ("RESEARCH", 4))

    def test_unticking_clears_the_quota(self):
        self._as(Role.RESEARCH_COORDINATOR)
        self._patch({"faculty_type": "RESEARCH", "research_quota": 4})
        self._patch({"faculty_type": "REGULAR"})
        self.person.refresh_from_db()
        self.assertIsNone(self.person.research_quota)

    def test_the_coordinator_still_cannot_touch_identity(self):
        self._as(Role.RESEARCH_COORDINATOR)
        self.assertEqual(self._patch({"staff_id": "X1"}).status_code, 403)

    def test_the_research_cell_cannot_set_it(self):
        # It clears the claims the quota decides.
        self._as(Role.RESEARCH_CELL)
        self.assertEqual(self._patch({"faculty_type": "RESEARCH", "research_quota": 4}).status_code, 403)
