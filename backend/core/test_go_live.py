"""Get the college running: the ordered checklist for a fresh install or a host move."""
import shutil
import tempfile

from django.conf import settings
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from core.models import Claim, ClaimAttachment, ClaimStatus, FormulaConfig, Publication, Role, User
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
                         ["record", "desks", "passwords", "policy", "backup", "files", "email", "scopus"])
        self.assertEqual(body["next"], "record")
        self.assertFalse(body["complete"])
        self.assertEqual(body["total"], 5)
        self.assertEqual(by["record"]["state"], "todo")
        self.assertEqual(by["record"]["to"], "/imports")
        self.assertFalse(by["email"]["required"])
        self.assertFalse(by["files"]["required"])

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


class PhotosAndFiles(TestCase):
    """After a restore the rows name photos and claim files that are not on the new host yet."""

    def setUp(self):
        cache.clear()
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        override = override_settings(MEDIA_ROOT=tmp)
        override.enable()
        self.addCleanup(override.disable)
        self.c = Client()
        self.c.force_login(make(Role.SUPER_ADMIN, 1))

    def step(self):
        body = self.c.get("/api/admin/start").json()
        return body, next(s for s in body["steps"] if s["key"] == "files")

    def test_nothing_recorded_means_nothing_to_load(self):
        _, step = self.step()
        self.assertEqual(step["state"], "done")
        self.assertIn("No photos or files are recorded", step["fact"])

    def test_a_photo_on_record_with_no_file_asks_for_the_zip_without_holding_the_college_back(self):
        name = f"avatars/{'a' * 32}.jpg"
        make(Role.FACULTY, 2, photo=name)
        missing, step = self.step()
        self.assertEqual(step["state"], "todo")
        self.assertIn("1 of 1", step["fact"])
        self.assertIn("media zip", step["fact"])
        self.assertFalse(step["required"])
        # It is an extra: with the file in place, the count and the next step are exactly the same.
        default_storage.save(name, ContentFile(b"\xff\xd8\xff"))
        present, _ = self.step()
        self.assertEqual(
            (missing["total"], missing["done"], missing["next"], missing["complete"]),
            (present["total"], present["done"], present["next"], present["complete"]),
        )

    def test_it_turns_done_once_the_files_are_there(self):
        name = f"avatars/{'a' * 32}.jpg"
        make(Role.FACULTY, 2, photo=name)
        default_storage.save(name, ContentFile(b"\xff\xd8\xff"))
        _, step = self.step()
        self.assertEqual(step["state"], "done")
        self.assertIn("all here", step["fact"])

    def test_a_claim_file_that_is_missing_counts_too(self):
        owner = make(Role.FACULTY, 2)
        claim = Claim.objects.create(owner=owner, status=ClaimStatus.SUBMITTED, paper_title="A paper")
        ClaimAttachment.objects.create(
            claim=claim, kind="PUBLISHED_PAPER", url=f"{settings.MEDIA_URL}claims/{'b' * 32}.pdf"
        )
        _, step = self.step()
        self.assertEqual(step["state"], "todo")

    def test_only_a_handful_is_checked_however_many_photos_there_are(self):
        for n in range(30):
            make(Role.FACULTY, 100 + n, photo=f"avatars/{n:032x}.jpg")
        _, step = self.step()
        self.assertEqual(step["state"], "todo")
        self.assertIn("of 12 photos", step["fact"])


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
