"""Get the college running: the ordered checklist for a fresh install or a host move."""
from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from core.models import FormulaConfig, Publication, Role, User
from core.services.issue_passwords import HASHER


def make(role, n, **kw):
    return User.objects.create_user(
        email=f"g{n}@x.edu", password="p", name=f"Person {n}", role=role, department="CSE", **kw
    )


class GoLive(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = make(Role.SUPER_ADMIN, 1)
        self.c = Client()
        self.c.force_login(self.admin)

    def steps(self):
        body = self.c.get("/api/admin/start").json()
        return body, {s["key"]: s for s in body["steps"]}

    def test_a_fresh_install_starts_with_the_record(self):
        body, by = self.steps()
        self.assertEqual([s["key"] for s in body["steps"]],
                         ["record", "desks", "passwords", "policy", "backup", "email", "scopus"])
        self.assertEqual(body["next"], "record")
        self.assertFalse(body["complete"])
        self.assertEqual(body["total"], 5)
        self.assertEqual(by["record"]["state"], "todo")
        self.assertEqual(by["record"]["to"], "/imports")
        self.assertFalse(by["email"]["required"])

    def test_loading_people_moves_the_next_step_on(self):
        make(Role.FACULTY, 2)
        make(Role.FACULTY, 3)
        Publication.objects.create(title="A paper")
        body, by = self.steps()
        self.assertEqual(by["record"]["state"], "done")
        self.assertIn("2 people", by["record"]["fact"])
        self.assertEqual(body["next"], "desks")
        self.assertIn("Principal", by["desks"]["fact"])
        # The empty desks come with the role to give, for the page's person-picker.
        self.assertEqual(
            [(d["role"], d["label"]) for d in by["desks"]["desks"]],
            [("PRINCIPAL", "Principal"), ("DIRECTOR", "Director"), ("FINANCE", "Finance")],
        )

    def test_passwords_wait_until_everyone_has_one(self):
        u = make(Role.FACULTY, 2)
        _, by = self.steps()
        self.assertEqual(by["passwords"]["state"], "todo")
        self.assertIn("1 person has", by["passwords"]["fact"])
        User.objects.filter(pk=u.pk).update(password=HASHER + "$1$salt$hash")
        _, by = self.steps()
        self.assertEqual(by["passwords"]["state"], "done")
        User.objects.filter(pk=u.pk).update(last_login=timezone.now())
        _, by = self.steps()
        self.assertIn("signed in at least once", by["passwords"]["fact"])

    def test_the_admin_is_never_counted_as_someone_to_issue_to(self):
        _, by = self.steps()
        self.assertIn("nobody", by["passwords"]["fact"])

    def test_a_policy_turns_its_step_done(self):
        FormulaConfig.objects.create(name="Policy v1", active=True, author_point_json="{}")
        _, by = self.steps()
        self.assertEqual(by["policy"]["state"], "done")

    def test_only_the_super_admin_may_ask(self):
        other = Client()
        other.force_login(make(Role.RESEARCH_COORDINATOR, 9))
        self.assertEqual(other.get("/api/admin/start").status_code, 403)
        self.assertEqual(Client().get("/api/admin/start").status_code, 401)


class FindAnything(TestCase):
    """The office finds a person by staff ID and a claim by voucher, in one search."""

    def setUp(self):
        cache.clear()
        from core.models import Claim, ClaimStatus

        self.admin = make(Role.SUPER_ADMIN, 1)
        self.person = make(Role.FACULTY, 2, staff_id="TSSH777")
        Claim.objects.create(owner=self.person, status=ClaimStatus.PAID, paper_title="Paid paper",
                             ticket_number="FP-2026-000009", voucher_number="V-0042")
        self.c = Client()
        self.c.force_login(self.admin)

    def kinds(self, q):
        body = self.c.get("/api/search/all", {"q": q}).json()
        return {g["kind"]: g["items"] for g in body["groups"] if g.get("items")}

    def test_a_staff_id_finds_the_person(self):
        self.assertEqual([i["title"] for i in self.kinds("TSSH777")["person"]], ["Person 2"])

    def test_a_voucher_finds_the_claim(self):
        self.assertEqual(self.kinds("V-0042")["claim"][0]["title"], "Paid paper")
