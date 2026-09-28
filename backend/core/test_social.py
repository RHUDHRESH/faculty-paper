"""Profiles, the feed, following and moderation: the college's own small social network.

The invariants that matter more than any feature here:

- Anybody signed in can open anybody's profile, and a profile carries no money
  and no workflow internals -- not for a colleague, not for a head, not for the
  Finance desk that sees amounts everywhere else. A profile is a social page.
- A department-only post is invisible to every other department: not in the
  feed, not by its link, not through its comments, likes or attachment.
- A mention notifies the person named, and only if they can read the post.
"""
from __future__ import annotations

import importlib
import io
import json

from django.apps import apps as live_apps
from django.test import Client, TestCase
from PIL import Image

from core.hod import MONEY_KEYS
from core.models import (
    Claim,
    ClaimStatus,
    FeedPost,
    Notification,
    Post,
    ResearchInterest,
    Role,
    Thread,
    User,
)


def _png(size=(8, 8), colour=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_with_exif() -> bytes:
    """A photo that says which camera took it -- the metadata a re-encode must drop."""
    img = Image.new("RGB", (40, 30), (10, 120, 200))
    exif = Image.Exif()
    exif[0x010F] = "TellTaleCamera"  # Make
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif.tobytes())
    return buf.getvalue()


def _upload(name: str, content: bytes):
    from django.core.files.uploadedfile import SimpleUploadedFile

    return SimpleUploadedFile(name, content)


def _keys(value) -> set[str]:
    """Every key anywhere in a JSON payload."""
    found: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            found.add(k)
            found |= _keys(v)
    elif isinstance(value, list):
        for v in value:
            found |= _keys(v)
    return found


class SocialCase(TestCase):
    def setUp(self):
        self.asha = self._user("asha@x.edu", "Asha Menon", department="Physics",
                               designation="Assistant Professor")
        self.ravi = self._user("ravi@x.edu", "Ravi Kumar", department="Physics")
        self.meera = self._user("meera@x.edu", "Meera Pillai", department="Chemistry")
        self.admin = self._user("admin@x.edu", "The Admin", role=Role.SUPER_ADMIN, department=None)
        self.c = Client()

    def _user(self, email, name, *, role=Role.FACULTY, department="Physics", **extra):
        # No usable password: every test signs in with force_login, and hashing
        # one costs a third of a second -- per person, per test.
        return User.objects.create_user(
            email=email, password=None, name=name, role=role, department=department, **extra
        )

    def _as(self, user):
        self.c.force_login(user)
        return self.c

    def _paper(self, owner, ticket, *, status=ClaimStatus.PAID, quartile="Q2", position=2,
               doi=None, title=None, year=2025, amount=48000.0, subjects="Physics"):
        return Claim.objects.create(
            owner=owner, status=status, ticket_number=ticket,
            paper_title=title or f"Paper {ticket}", journal_title="Journal of Tests",
            quartile=quartile, author_position=position, total_authors=4,
            publication_year=year, remuneration=amount, qf_amount=amount / 2,
            base_amount=amount / 4, doi=doi, subjects_json=subjects,
        )

    def _post(self, author, body="Hello, college", **fields):
        data = {"body": body, "visibility": "EVERYONE", **fields}
        r = self._as(author).post("/api/feed/posts", data=data)
        return r

    def _feed(self, viewer, tab="everyone", **params):
        query = "&".join(f"{k}={v}" for k, v in {"tab": tab, **params}.items())
        r = self._as(viewer).get(f"/api/feed?{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


# ---------------------------------------------------------------- profiles --


class PublicProfileTests(SocialCase):
    def test_any_signed_in_person_can_open_anybodys_profile(self):
        r = self._as(self.meera).get(f"/api/people/{self.asha.id}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["person"]["name"], "Asha Menon")
        self.assertEqual(body["person"]["initials"], "AM")
        self.assertEqual(body["person"]["designation"], "Assistant Professor")
        self.assertEqual(body["person"]["department"], "Physics")
        self.assertFalse(body["is_me"])

    def test_me_is_an_alias_for_your_own_profile(self):
        body = self._as(self.asha).get("/api/people/me").json()
        self.assertEqual(body["person"]["id"], self.asha.id)
        self.assertTrue(body["is_me"])

    def test_signed_out_is_refused(self):
        self.assertEqual(Client().get(f"/api/people/{self.asha.id}").status_code, 401)

    def test_nobody_by_that_id_is_a_404(self):
        self.assertEqual(self._as(self.asha).get("/api/people/nobody").status_code, 404)

    def test_a_deactivated_account_has_no_public_profile(self):
        self.ravi.active = False
        self.ravi.save(update_fields=["active"])
        self.assertEqual(self._as(self.asha).get(f"/api/people/{self.ravi.id}").status_code, 404)

    def test_papers_are_only_their_own_published_or_filed_work(self):
        self._paper(self.asha, "A-PAID", title="Paid paper")
        self._paper(self.asha, "A-SUB", status=ClaimStatus.SUBMITTED, title="Filed paper")
        self._paper(self.asha, "A-DRAFT", status=ClaimStatus.DRAFT, title="Draft paper")
        self._paper(self.asha, "A-REJ", status=ClaimStatus.REJECTED, title="Refused paper")
        self._paper(self.ravi, "R-PAID", title="Somebody else's paper")

        body = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()
        titles = {p["title"] for p in body["papers"]}
        self.assertEqual(titles, {"Paid paper", "Filed paper"})

    def test_counts_are_papers_q1s_and_first_author(self):
        self._paper(self.asha, "C1", quartile="Q1", position=1)
        self._paper(self.asha, "C2", quartile="Q1", position=3)
        self._paper(self.asha, "C3", quartile="Q3", position=1)
        counts = self._as(self.ravi).get(f"/api/people/{self.asha.id}").json()["counts"]
        self.assertEqual((counts["papers"], counts["q1"], counts["first_author"]), (3, 2, 2))

    def test_coauthors_are_colleagues_who_filed_the_same_paper(self):
        self._paper(self.asha, "S1", doi="10.1/shared", title="Shared work")
        self._paper(self.ravi, "S2", doi="10.1/shared", title="Shared work")
        self._paper(self.meera, "S3", doi="10.1/other")

        body = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()
        self.assertEqual([c["name"] for c in body["coauthors"]], ["Ravi Kumar"])
        self.assertEqual(body["coauthors"][0]["together"], 1)
        shared = next(p for p in body["papers"] if p["title"] == "Shared work")
        self.assertEqual([c["name"] for c in shared["coauthors"]], ["Ravi Kumar"])

    def test_no_money_on_another_persons_profile_whoever_is_looking(self):
        """Finance and the Principal see amounts on their desks -- not on a profile."""
        self._paper(self.asha, "M1", amount=48000.0)
        head = self._user("head@x.edu", "Physics Head", role=Role.HOD, department="Physics")
        finance = self._user("fin@x.edu", "Finance Desk", role=Role.FINANCE, department=None)
        principal = self._user("pri@x.edu", "The Principal", role=Role.PRINCIPAL, department=None)

        for viewer in (self.ravi, self.meera, head, finance, principal, self.admin):
            r = self._as(viewer).get(f"/api/people/{self.asha.id}")
            self.assertEqual(r.status_code, 200, (viewer.role, r.content))
            leaked = _keys(r.json()) & (MONEY_KEYS | {"remuneration", "qf_amount", "base_amount"})
            self.assertFalse(leaked, f"{viewer.role} was shown {sorted(leaked)} on a profile")
            raw = r.content.decode()
            for figure in ("48000", "24000", "12000"):
                self.assertNotIn(figure, raw, f"{viewer.role} saw an amount on a profile")

    def test_no_money_on_your_own_public_profile_either(self):
        """The same page others see -- your own pay lives on your own desk."""
        self._paper(self.asha, "M2", amount=48000.0)
        raw = self._as(self.asha).get("/api/people/me").content.decode()
        self.assertNotIn("48000", raw)

    def test_no_workflow_internals_on_a_profile(self):
        self._paper(self.asha, "INT-7", status=ClaimStatus.SUBMITTED, title="Under review somewhere")
        body = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()
        leaked = _keys(body) & {"status", "ticket_number", "faculty_stage", "status_note",
                                "cleared_by_name", "hold_reason", "on_hold"}
        self.assertFalse(leaked, sorted(leaked))
        self.assertNotIn("INT-7", json.dumps(body))

    def test_interests_and_bio_are_on_the_profile(self):
        ResearchInterest.objects.create(user=self.asha, domain="Condensed Matter Physics")
        self.asha.bio = "Thin films, mostly."
        self.asha.save(update_fields=["bio"])
        person = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()["person"]
        self.assertEqual(person["interests"], ["Condensed Matter Physics"])
        self.assertEqual(person["bio"], "Thin films, mostly.")

    def test_contact_details_stay_private(self):
        self.asha.phone = "+91 98400 12345"
        self.asha.save(update_fields=["phone"])
        raw = self._as(self.meera).get(f"/api/people/{self.asha.id}").content.decode()
        self.assertNotIn("98400", raw)
        self.assertNotIn("asha@x.edu", raw)


class ResearchPostOnProfileTests(SocialCase):
    """Research faculty: a tick box for the coordinator, progress for the person, a badge for the rest."""

    def setUp(self):
        super().setUp()
        self.asha.faculty_type = "RESEARCH"
        self.asha.research_quota = 4
        self.asha.research_quota_note = "2026-27 target"
        self.asha.save()
        self.coordinator = self._user("rc@x.edu", "Coordinator", role=Role.RESEARCH_COORDINATOR,
                                      department=None)

    def test_everybody_else_sees_only_a_badge(self):
        body = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()
        self.assertTrue(body["person"]["research_faculty"])
        self.assertIsNone(body["research_post"])
        self.assertNotIn("2026-27 target", json.dumps(body))

    def test_the_person_sees_their_own_quota_progress(self):
        from django.utils import timezone

        year = timezone.now().year
        c = self._paper(self.asha, "Q-1", status=ClaimStatus.SUBMITTED, year=year)
        Claim.objects.filter(pk=c.pk).update(quota_position=1)
        post = self._as(self.asha).get("/api/people/me").json()["research_post"]
        self.assertEqual((post["quota"], post["year"], post["used"]), (4, year, 1))
        self.assertFalse(post["may_edit"])

    def test_the_coordinator_sees_the_settings_and_may_edit_them(self):
        post = self._as(self.coordinator).get(f"/api/people/{self.asha.id}").json()["research_post"]
        self.assertEqual((post["quota"], post["quota_note"]), (4, "2026-27 target"))
        self.assertTrue(post["may_edit"])

    def test_the_research_cell_is_not_offered_the_setting(self):
        cell = self._user("cell@x.edu", "Cell", role=Role.RESEARCH_CELL, department=None)
        self.assertIsNone(self._as(cell).get(f"/api/people/{self.asha.id}").json()["research_post"])


class SelfServiceProfileTests(SocialCase):
    def _patch(self, body):
        return self._as(self.asha).patch(
            "/api/auth/profile/self", data=json.dumps(body), content_type="application/json"
        )

    def test_a_person_writes_their_own_bio(self):
        r = self._patch({"bio": "  Thin films and the people who grow them.  "})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["bio"], "Thin films and the people who grow them.")
        person = self._as(self.ravi).get(f"/api/people/{self.asha.id}").json()["person"]
        self.assertEqual(person["bio"], "Thin films and the people who grow them.")

    def test_a_bio_is_short(self):
        self.assertEqual(self._patch({"bio": "x" * 601}).status_code, 400)

    def test_an_orcid_is_checked_before_it_is_kept(self):
        self.assertEqual(self._patch({"orcid_id": "0000-0002-1825-0098"}).status_code, 400)
        r = self._patch({"orcid_id": "https://orcid.org/0000-0002-1825-0097"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["orcid_id"], "0000-0002-1825-0097")
        person = self._as(self.ravi).get(f"/api/people/{self.asha.id}").json()["person"]
        self.assertEqual(person["orcid_url"], "https://orcid.org/0000-0002-1825-0097")

    def test_the_allow_list_still_refuses_identity(self):
        self.assertEqual(self._patch({"name": "Somebody Else"}).status_code, 422)


class ProfilePhotoTests(SocialCase):
    def _send(self, user, name, content):
        return self._as(user).post("/api/people/me/photo", data={"file": _upload(name, content)})

    def test_a_person_sets_a_photo_that_colleagues_can_see(self):
        r = self._send(self.asha, "me.png", _png((600, 400)))
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()["photo_url"]
        self.assertTrue(url.startswith("/media/avatars/"), url)

        person = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()["person"]
        self.assertEqual(person["photo_url"], url)
        served = self._as(self.meera).get(url)
        self.assertEqual(served.status_code, 200)
        self.assertTrue(served["Content-Type"].startswith("image/"))
        img = Image.open(io.BytesIO(b"".join(served.streaming_content)))
        self.assertLessEqual(max(img.size), 320, "a profile photo is stored small")

    def test_a_photo_is_not_served_to_the_signed_out(self):
        url = self._send(self.asha, "me.png", _png()).json()["photo_url"]
        self.assertEqual(Client().get(url).status_code, 401)

    def test_camera_metadata_is_dropped(self):
        url = self._send(self.asha, "me.jpg", _jpeg_with_exif()).json()["photo_url"]
        data = b"".join(self._as(self.ravi).get(url).streaming_content)
        self.assertNotIn(b"TellTaleCamera", data)

    def test_only_an_image_is_a_photo(self):
        r = self._send(self.asha, "me.png", b"%PDF-1.4 not a photo")
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_photo_can_be_removed(self):
        self._send(self.asha, "me.png", _png())
        r = self._as(self.asha).delete("/api/people/me/photo")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["photo_url"])
        self.assertIsNone(self._as(self.ravi).get(f"/api/people/{self.asha.id}").json()["person"]["photo_url"])


class PeopleSearchTests(SocialCase):
    def test_by_name_department_and_interest(self):
        ResearchInterest.objects.create(user=self.meera, domain="Organic Chemistry")

        by_name = self._as(self.asha).get("/api/people?q=ravi").json()["results"]
        self.assertEqual([p["name"] for p in by_name], ["Ravi Kumar"])

        by_dept = self._as(self.asha).get("/api/people?department=Chemistry").json()["results"]
        self.assertEqual([p["name"] for p in by_dept], ["Meera Pillai"])

        by_interest = self._as(self.asha).get("/api/people?q=organic").json()["results"]
        self.assertEqual([p["name"] for p in by_interest], ["Meera Pillai"])

    def test_deactivated_accounts_are_not_offered(self):
        self.ravi.active = False
        self.ravi.save(update_fields=["active"])
        names = [p["name"] for p in self._as(self.asha).get("/api/people?q=kumar").json()["results"]]
        self.assertEqual(names, [])


# ------------------------------------------------------------------- feed ---


class FeedVisibilityTests(SocialCase):
    def test_a_post_for_everyone_reaches_everyone(self):
        pid = self._post(self.asha, "Seminar on Friday").json()["id"]
        for viewer in (self.ravi, self.meera, self.admin):
            ids = [p["id"] for p in self._feed(viewer)["results"]]
            self.assertIn(pid, ids, viewer.name)

    def test_a_department_post_is_hidden_from_other_departments(self):
        r = self._post(self.asha, "Physics only: lab keys", visibility="DEPARTMENT")
        self.assertEqual(r.status_code, 200, r.content)
        pid = r.json()["id"]
        self.assertEqual(r.json()["department"], "Physics")

        self.assertIn(pid, [p["id"] for p in self._feed(self.ravi)["results"]])
        self.assertNotIn(pid, [p["id"] for p in self._feed(self.meera)["results"]])
        self.assertNotIn(pid, [p["id"] for p in self._feed(self.meera, tab="department")["results"]])

        c = self._as(self.meera)
        self.assertEqual(c.get(f"/api/feed/posts/{pid}").status_code, 404)
        self.assertEqual(c.post(f"/api/feed/posts/{pid}/like").status_code, 404)
        self.assertEqual(
            c.post(f"/api/feed/posts/{pid}/comments", data=json.dumps({"body": "hi"}),
                   content_type="application/json").status_code,
            404,
        )
        self.assertEqual(c.get(f"/api/feed/posts/{pid}/comments").status_code, 404)
        self.assertEqual(
            c.post(f"/api/feed/posts/{pid}/report", data=json.dumps({"reason": "x"}),
                   content_type="application/json").status_code,
            404,
        )
        # Nor on the author's profile, when somebody from outside looks.
        profile = c.get(f"/api/people/{self.asha.id}").json()
        self.assertNotIn(pid, [p["id"] for p in profile["posts"]])

    def test_the_super_admin_reads_department_posts_to_moderate_them(self):
        pid = self._post(self.asha, "Physics only", visibility="DEPARTMENT").json()["id"]
        self.assertEqual(self._as(self.admin).get(f"/api/feed/posts/{pid}").status_code, 200)

    def test_nobody_without_a_department_can_post_to_one(self):
        r = self._post(self.admin, "To whom?", visibility="DEPARTMENT")
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_department_attachment_is_not_served_outside_it(self):
        r = self._post(self.asha, "Our poster", visibility="DEPARTMENT",
                       file=_upload("poster.png", _png((50, 50))))
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()["attachment"]["url"]
        self.assertEqual(self._as(self.ravi).get(url).status_code, 200)
        self.assertEqual(self._as(self.meera).get(url).status_code, 404)

    def test_mentioning_somebody_who_cannot_read_the_post_does_not_notify_them(self):
        self._post(self.asha, 'Physics only, @user:"Meera Pillai"', visibility="DEPARTMENT")
        self.assertFalse(Notification.objects.filter(user=self.meera).exists())


class FeedInteractionTests(SocialCase):
    def test_a_post_arrives_at_the_top_of_a_colleagues_feed(self):
        self._post(self.ravi, "Older")
        r = self._post(self.asha, "Newest news")
        self.assertEqual(r.status_code, 200, r.content)
        first = self._feed(self.meera)["results"][0]
        self.assertEqual(first["body"], "Newest news")
        self.assertEqual(first["author"]["name"], "Asha Menon")
        self.assertEqual(first["author"]["initials"], "AM")

    def test_an_empty_post_is_refused(self):
        self.assertEqual(self._post(self.asha, "   ").status_code, 400)

    def test_a_link_must_be_a_web_address(self):
        self.assertEqual(self._post(self.asha, "look", link_url="javascript:alert(1)").status_code, 400)
        ok = self._post(self.asha, "look", link_url="https://doi.org/10.1/abc")
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()["link_url"], "https://doi.org/10.1/abc")

    def test_a_post_may_point_at_your_own_paper_without_its_money(self):
        mine = self._paper(self.asha, "P-1", title="My new paper", amount=48000.0)
        theirs = self._paper(self.ravi, "P-2", title="Not mine")
        draft = self._paper(self.asha, "P-3", status=ClaimStatus.DRAFT)

        self.assertEqual(self._post(self.asha, "x", paper_id=theirs.id).status_code, 400)
        self.assertEqual(self._post(self.asha, "x", paper_id=draft.id).status_code, 400)
        r = self._post(self.asha, "Out now", paper_id=mine.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["paper"]["title"], "My new paper")

        raw = self._as(self.meera).get("/api/feed?tab=everyone").content.decode()
        self.assertIn("My new paper", raw)
        self.assertNotIn("48000", raw)
        self.assertNotIn("P-1", raw, "a ticket number is the office's, not the feed's")

    def test_the_papers_you_can_point_at_are_your_own(self):
        self._paper(self.asha, "O-1", title="Mine to share")
        self._paper(self.ravi, "O-2", title="Somebody else's")
        titles = [p["title"] for p in self._as(self.asha).get("/api/feed/my-papers").json()["results"]]
        self.assertEqual(titles, ["Mine to share"])

    def test_commenting_notifies_the_author_and_counts(self):
        pid = self._post(self.asha, "Thoughts?").json()["id"]
        r = self._as(self.ravi).post(
            f"/api/feed/posts/{pid}/comments", data=json.dumps({"body": "Yes, lots"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["author"]["name"], "Ravi Kumar")

        post = self._as(self.meera).get(f"/api/feed/posts/{pid}").json()
        self.assertEqual(post["comment_count"], 1)
        self.assertEqual([c["body"] for c in post["comments"]], ["Yes, lots"])

        note = Notification.objects.get(user=self.asha)
        self.assertIn("Ravi Kumar", note.title)
        self.assertEqual(note.href, f"/discussions/p/{pid}")
        self.assertFalse(Notification.objects.filter(user=self.ravi).exists())

    def test_the_feed_shows_the_latest_comments_under_each_post(self):
        pid = self._post(self.asha, "Thoughts?").json()["id"]
        for i in range(4):
            self._as(self.ravi).post(
                f"/api/feed/posts/{pid}/comments", data=json.dumps({"body": f"c{i}"}),
                content_type="application/json",
            )
        row = self._feed(self.meera)["results"][0]
        self.assertEqual(row["comment_count"], 4)
        self.assertEqual([c["body"] for c in row["comments_preview"]], ["c2", "c3"])

    def test_a_like_is_once_per_person_and_can_be_taken_back(self):
        pid = self._post(self.asha, "Like me").json()["id"]
        c = self._as(self.ravi)
        c.post(f"/api/feed/posts/{pid}/like")
        r = c.post(f"/api/feed/posts/{pid}/like")
        self.assertEqual(r.json(), {"liked": True, "like_count": 1})

        mine = self._feed(self.ravi)["results"][0]
        theirs = self._feed(self.meera)["results"][0]
        self.assertTrue(mine["liked"])
        self.assertFalse(theirs["liked"])
        self.assertEqual(theirs["like_count"], 1)

        r = self._as(self.ravi).delete(f"/api/feed/posts/{pid}/like")
        self.assertEqual(r.json(), {"liked": False, "like_count": 0})

    def test_a_mention_notifies_the_person_named(self):
        r = self._post(self.asha, 'Great talk by @user:"Meera Pillai" today')
        pid = r.json()["id"]
        note = Notification.objects.get(user=self.meera)
        self.assertIn("Asha Menon", note.title)
        self.assertEqual(note.href, f"/discussions/p/{pid}")
        mention = r.json()["mentions"][0]
        self.assertEqual((mention["kind"], mention["user_id"]), ("USER", self.meera.id))

    def test_a_mention_by_id_reaches_the_right_one_of_two_namesakes(self):
        twin = self._user("ravi2@x.edu", "Ravi Kumar", department="Chemistry")
        self._post(self.asha, 'Thanks @user:"Ravi Kumar"', mention_ids=[twin.id])
        self.assertTrue(Notification.objects.filter(user=twin).exists())
        self.assertFalse(Notification.objects.filter(user=self.ravi).exists())

    def test_a_mention_in_a_comment_notifies_too(self):
        pid = self._post(self.asha, "Question").json()["id"]
        self._as(self.ravi).post(
            f"/api/feed/posts/{pid}/comments",
            data=json.dumps({"body": 'Ask @user:"Meera Pillai"'}),
            content_type="application/json",
        )
        self.assertTrue(Notification.objects.filter(user=self.meera, href=f"/discussions/p/{pid}").exists())

    def test_only_the_author_edits_or_deletes_a_post(self):
        pid = self._post(self.asha, "First draft").json()["id"]
        edit = {"data": json.dumps({"body": "Second draft"}), "content_type": "application/json"}

        self.assertEqual(self._as(self.ravi).patch(f"/api/feed/posts/{pid}", **edit).status_code, 403)
        r = self._as(self.asha).patch(f"/api/feed/posts/{pid}", **edit)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["body"], "Second draft")
        self.assertIsNotNone(r.json()["edited_at"])

        self.assertEqual(self._as(self.ravi).delete(f"/api/feed/posts/{pid}").status_code, 403)
        self.assertEqual(self._as(self.asha).delete(f"/api/feed/posts/{pid}").status_code, 200)
        self.assertEqual(self._as(self.ravi).get(f"/api/feed/posts/{pid}").status_code, 404)

    def test_comments_are_edited_by_their_author_and_removable_by_the_posts(self):
        pid = self._post(self.asha, "Mine").json()["id"]
        cid = self._as(self.ravi).post(
            f"/api/feed/posts/{pid}/comments", data=json.dumps({"body": "typo"}),
            content_type="application/json",
        ).json()["id"]
        edit = {"data": json.dumps({"body": "fixed"}), "content_type": "application/json"}
        self.assertEqual(self._as(self.meera).patch(f"/api/feed/comments/{cid}", **edit).status_code, 403)
        self.assertEqual(self._as(self.ravi).patch(f"/api/feed/comments/{cid}", **edit).json()["body"], "fixed")
        self.assertEqual(self._as(self.meera).delete(f"/api/feed/comments/{cid}").status_code, 403)
        self.assertEqual(self._as(self.asha).delete(f"/api/feed/comments/{cid}").status_code, 200)
        self.assertEqual(self._as(self.asha).get(f"/api/feed/posts/{pid}").json()["comment_count"], 0)

    def test_an_image_travels_with_a_post(self):
        r = self._post(self.asha, "Our poster", file=_upload("poster.png", _png((2400, 1200))))
        self.assertEqual(r.status_code, 200, r.content)
        att = r.json()["attachment"]
        self.assertEqual(att["kind"], "image")
        served = self._as(self.meera).get(att["url"])
        self.assertEqual(served.status_code, 200)
        img = Image.open(io.BytesIO(b"".join(served.streaming_content)))
        self.assertLessEqual(max(img.size), 1600, "an image is stored no larger than it is shown")

    def test_a_file_that_is_not_an_image_or_pdf_is_refused(self):
        r = self._post(self.asha, "x", file=_upload("a.exe", b"MZ\x90\x00 executable"))
        self.assertEqual(r.status_code, 400, r.content)

    def test_the_feed_pages_without_repeating_itself(self):
        for i in range(25):
            self._post(self.asha, f"post {i}")
        first = self._feed(self.ravi, limit=10)
        self.assertEqual(len(first["results"]), 10)
        self.assertTrue(first["next"])
        second = self._feed(self.ravi, limit=10, cursor=first["next"])
        third = self._feed(self.ravi, limit=10, cursor=second["next"])
        ids = [p["id"] for page in (first, second, third) for p in page["results"]]
        self.assertEqual(len(ids), 25)
        self.assertEqual(len(set(ids)), 25)
        self.assertIsNone(third["next"])

    def test_a_profile_lists_the_persons_recent_posts(self):
        pid = self._post(self.asha, "On my profile").json()["id"]
        self._post(self.ravi, "Not on hers")
        posts = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()["posts"]
        self.assertEqual([p["id"] for p in posts], [pid])


class FollowTests(SocialCase):
    def test_following_a_person_fills_the_following_tab(self):
        r = self._as(self.meera).post(f"/api/follows/people/{self.asha.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"following": True, "followers": 1})

        from_asha = self._post(self.asha, "From someone Meera follows").json()["id"]
        from_ravi = self._post(self.ravi, "From someone she does not").json()["id"]
        ids = [p["id"] for p in self._feed(self.meera, tab="following")["results"]]
        self.assertIn(from_asha, ids)
        self.assertNotIn(from_ravi, ids)

        profile = self._as(self.meera).get(f"/api/people/{self.asha.id}").json()
        self.assertEqual(profile["follow"], {"following": True, "followers": 1, "following_count": 0})

    def test_being_followed_is_a_notification(self):
        self._as(self.meera).post(f"/api/follows/people/{self.asha.id}")
        note = Notification.objects.get(user=self.asha)
        self.assertIn("Meera Pillai", note.title)
        self.assertEqual(note.href, f"/u/{self.meera.id}")

    def test_following_twice_is_still_following_once_and_can_be_undone(self):
        c = self._as(self.meera)
        c.post(f"/api/follows/people/{self.asha.id}")
        c.post(f"/api/follows/people/{self.asha.id}")
        self.assertEqual(Notification.objects.filter(user=self.asha).count(), 1)
        r = c.delete(f"/api/follows/people/{self.asha.id}")
        self.assertEqual(r.json(), {"following": False, "followers": 0})

    def test_you_cannot_follow_yourself(self):
        self.assertEqual(self._as(self.asha).post(f"/api/follows/people/{self.asha.id}").status_code, 400)

    def test_following_a_department_brings_its_posts(self):
        c = self._as(self.meera)
        r = c.post("/api/follows/departments", data=json.dumps({"department": "physics"}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(c.get("/api/follows").json()["departments"], ["Physics"])

        pid = self._post(self.ravi, "From Physics").json()["id"]
        self.assertIn(pid, [p["id"] for p in self._feed(self.meera, tab="following")["results"]])

        self.assertEqual(
            c.post("/api/follows/departments", data=json.dumps({"department": "Astrology"}),
                   content_type="application/json").status_code,
            404,
        )
        r = self._as(self.meera).delete("/api/follows/departments?department=Physics")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._as(self.meera).get("/api/follows").json()["departments"], [])

    def test_the_department_tab_is_your_departments_posts(self):
        physics = self._post(self.ravi, "Physics news").json()["id"]
        chemistry = self._post(self.meera, "Chemistry news").json()["id"]
        ids = [p["id"] for p in self._feed(self.asha, tab="department")["results"]]
        self.assertIn(physics, ids)
        self.assertNotIn(chemistry, ids)


class ModerationTests(SocialCase):
    def test_a_report_reaches_the_super_admin(self):
        pid = self._post(self.asha, "Something questionable").json()["id"]
        r = self._as(self.meera).post(f"/api/feed/posts/{pid}/report",
                                      data=json.dumps({"reason": "Not appropriate"}),
                                      content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(Notification.objects.filter(user=self.admin).exists())

        reports = self._as(self.admin).get("/api/feed/reports").json()["results"]
        self.assertEqual([(x["post"]["id"], x["reason"]) for x in reports], [(pid, "Not appropriate")])
        self.assertEqual(self._as(self.meera).get("/api/feed/reports").status_code, 403)

    def test_the_super_admin_hides_a_post_from_everybody_but_its_author(self):
        pid = self._post(self.asha, "Something questionable").json()["id"]
        self._as(self.meera).post(f"/api/feed/posts/{pid}/report",
                                  data=json.dumps({"reason": "Spam"}), content_type="application/json")

        self.assertEqual(self._as(self.ravi).post(f"/api/feed/posts/{pid}/hide",
                                                  data=json.dumps({"reason": "no"}),
                                                  content_type="application/json").status_code, 403)
        r = self._as(self.admin).post(f"/api/feed/posts/{pid}/hide",
                                      data=json.dumps({"reason": "Off topic"}),
                                      content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)

        self.assertNotIn(pid, [p["id"] for p in self._feed(self.ravi)["results"]])
        self.assertEqual(self._as(self.ravi).get(f"/api/feed/posts/{pid}").status_code, 404)
        own = self._as(self.asha).get(f"/api/feed/posts/{pid}").json()
        self.assertTrue(own["hidden"])
        self.assertEqual(own["hidden_reason"], "Off topic")
        self.assertEqual(self._as(self.admin).get("/api/feed/reports").json()["results"], [])

        self._as(self.admin).post(f"/api/feed/posts/{pid}/unhide")
        self.assertIn(pid, [p["id"] for p in self._feed(self.ravi)["results"]])

    def test_a_report_can_be_dismissed(self):
        pid = self._post(self.asha, "Fine really").json()["id"]
        self._as(self.meera).post(f"/api/feed/posts/{pid}/report",
                                  data=json.dumps({"reason": "hmm"}), content_type="application/json")
        rid = self._as(self.admin).get("/api/feed/reports").json()["results"][0]["id"]
        r = self._as(self.admin).post(f"/api/feed/reports/{rid}/dismiss")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._as(self.admin).get("/api/feed/reports").json()["results"], [])
        self.assertIn(pid, [p["id"] for p in self._feed(self.ravi)["results"]])


class LegacyThreadTests(SocialCase):
    """Threads opened before the feed existed are carried into it, not lost."""

    def _thread(self, visibility, title, department=None):
        from datetime import timedelta

        thread = Thread.objects.create(title=title, visibility=visibility, department=department,
                                       created_by=self.asha, post_count=2)
        opening = Post.objects.create(thread=thread, author=self.asha, body="the opening post")
        reply = Post.objects.create(thread=thread, author=self.ravi, body="a reply")
        # `auto_now_add` on a millisecond clock can give both the same instant;
        # a real reply comes after the post it answers.
        Post.objects.filter(pk=reply.pk).update(created_at=opening.created_at + timedelta(minutes=1))
        return thread

    def _migrate(self):
        module = importlib.import_module("core.migrations.0045_social_feed")
        module.threads_to_posts(live_apps, None)

    def test_open_threads_become_posts_with_their_replies_as_comments(self):
        public = self._thread(Thread.Visibility.PUBLIC, "Where to publish?")
        dept = self._thread(Thread.Visibility.DEPARTMENT, "Lab rota", department="Physics")
        direct = self._thread(Thread.Visibility.DIRECT, "Just us")
        office = self._thread(Thread.Visibility.OFFICE, "Ask the office")

        self._migrate()
        self._migrate()  # twice is the same as once

        self.assertEqual(FeedPost.objects.count(), 2)
        post = FeedPost.objects.get(legacy_thread=public)
        self.assertEqual(post.author, self.asha)
        self.assertIn("Where to publish?", post.body)
        self.assertIn("the opening post", post.body)
        self.assertEqual([c.body for c in post.comments.order_by("created_at")], ["a reply"])
        self.assertEqual(FeedPost.objects.get(legacy_thread=dept).visibility, "DEPARTMENT")
        self.assertFalse(FeedPost.objects.filter(legacy_thread__in=[direct, office]).exists())

        # The old link still leads somewhere: the thread says where it went.
        thread = self._as(self.ravi).get(f"/api/threads/{public.id}").json()
        self.assertEqual(thread["feed_post_id"], post.id)

    def test_a_migrated_department_thread_stays_in_its_department(self):
        dept = self._thread(Thread.Visibility.DEPARTMENT, "Lab rota", department="Physics")
        self._migrate()
        pid = FeedPost.objects.get(legacy_thread=dept).id
        self.assertEqual(self._as(self.meera).get(f"/api/feed/posts/{pid}").status_code, 404)
        self.assertEqual(self._as(self.ravi).get(f"/api/feed/posts/{pid}").status_code, 200)
