"""Faculty confirm or reject the papers that may be theirs, and say whether their Scopus profile is theirs.

Pinned here:

* a person sees, and may act on, only their own candidates; another person's
  id is a 404 and writes nothing;
* confirming links the candidate's own author row when it is free or already
  theirs, otherwise adds a row for them -- never another person's row -- and
  the matcher keeps the link afterwards;
* rejecting writes the same dispute row the record's "not mine" writes, so the
  matcher does not link the paper to them again;
* the Scopus profile answer: its figures are the directory's, a yes or no is
  recorded with its audit row, and a person with no Scopus id cannot answer;
* the cleanup seed is idempotent, and its dry run writes nothing.
"""

from __future__ import annotations

import csv
import json
import os
import tempfile
from io import StringIO

from django.core.cache import cache
from django.core.management import call_command
from django.test import Client, TestCase

from core.models import Authorship, AuditLog, PaperCandidate, Publication, Role, User
from core.services import publications as P

SEC_CSE = "Department of Computer Science and Engineering, Saveetha Engineering College, Chennai"
REASON = "Matched by name, but not on your Scopus profile"


def _person(email, name, **extra):
    return User.objects.create_user(email=email, password=None, name=name, **extra)


def _pub(title, year=2022, **extra):
    return Publication.objects.create(title=title, normalized_title=title.lower(), year=year, venue="Journal", **extra)


def _row(pub, user=None, **extra):
    """An author row on `pub`. Unlinked unless `user` is given, as the cleanup left it."""
    fields = {"position": 1, "display_name": "N. Priya", "author_key": "n:priya",
              "is_college": True, "raw_affiliation": SEC_CSE}
    fields.update(extra)
    return Authorship.objects.create(publication=pub, user=user, **fields)


def _candidate(user, pub, authorship=None, status=PaperCandidate.Status.PENDING):
    return PaperCandidate.objects.create(
        user=user, publication=pub, authorship=authorship, source="cleanup-2026-10-24", reason=REASON, status=status,
    )


class _Base(TestCase):
    def setUp(self):
        self.me = _person("pc-me@x.edu", "Dr. N. Priya", department="CSE", staff_id="TSCS001")
        self.other = _person("pc-other@x.edu", "Dr. A. Other", department="CSE", staff_id="TSCS002")
        self.c = Client()
        self.c.force_login(self.me)

    def post(self, path, body=None):
        return self.c.post(path, data=json.dumps(body or {}), content_type="application/json")


class ListTests(_Base):
    def test_lists_only_my_pending_candidates(self):
        mine = [_candidate(self.me, _pub(f"Mine {i}")) for i in range(2)]
        _candidate(self.me, _pub("Already confirmed"), status=PaperCandidate.Status.CONFIRMED)
        _candidate(self.other, _pub("Someone else's"))
        body = self.c.get("/api/me/paper-candidates").json()
        self.assertEqual(body["pending"], 2)
        self.assertEqual({r["id"] for r in body["results"]}, {c.id for c in mine})

    def test_the_shape_and_the_order_newest_year_first(self):
        _candidate(self.me, _pub("Older", year=2015))
        _candidate(self.me, _pub("Undated", year=None))
        newer = _candidate(self.me, _pub("Newer", year=2024))
        for position, name in ((2, "B"), (1, "A"), (3, "C"), (4, "D"), (5, "E")):
            _row(newer.publication, position=position, display_name=name)
        body = self.c.get("/api/me/paper-candidates").json()
        self.assertEqual([r["publication"]["title"] for r in body["results"]], ["Newer", "Older", "Undated"])
        first = body["results"][0]
        self.assertEqual(set(first), {"id", "reason", "source", "publication"})
        self.assertEqual(first["reason"], REASON)
        self.assertEqual(first["source"], "cleanup-2026-10-24")
        self.assertEqual(
            set(first["publication"]),
            {"id", "title", "year", "venue", "doi", "authors", "author_count"},
        )
        self.assertEqual(first["publication"]["authors"], ["A", "B", "C", "D"])
        self.assertEqual(first["publication"]["author_count"], 5)

    def test_at_most_200_are_listed_and_pending_counts_them_all(self):
        for i in range(205):
            _candidate(self.me, _pub(f"Paper {i}", year=2000 + i % 20))
        body = self.c.get("/api/me/paper-candidates").json()
        self.assertEqual(body["pending"], 205)
        self.assertEqual(len(body["results"]), 200)


class ConfirmTests(_Base):
    def test_confirm_links_the_free_row_and_the_matcher_keeps_it(self):
        pub = _pub("A paper with a free author row")
        row = _row(pub)
        cand = _candidate(self.me, pub, authorship=row)
        r = self.post(f"/api/me/paper-candidates/{cand.id}/confirm")
        self.assertEqual(r.status_code, 200, r.content)
        row.refresh_from_db()
        self.assertEqual((row.user_id, row.match_method, row.match_confidence, row.is_college),
                         (self.me.id, "confirmed", 1.0, True))
        cand.refresh_from_db()
        self.assertEqual(cand.status, PaperCandidate.Status.CONFIRMED)
        self.assertIsNotNone(cand.decided_at)
        self.assertTrue(AuditLog.objects.filter(action="PAPER_CONFIRMED", actor=self.me, entity_id=pub.id).exists())
        self.assertIn("confirmed", P.ANCHORED)
        P.match_authors()
        row.refresh_from_db()
        self.assertEqual((row.user_id, row.match_method), (self.me.id, "confirmed"))

    def test_confirm_on_a_row_already_mine_only_marks_it(self):
        pub = _pub("A paper the matcher already put on me by name")
        row = _row(pub, user=self.me, match_method="name", match_confidence=0.8)
        cand = _candidate(self.me, pub, authorship=row)
        self.assertEqual(self.post(f"/api/me/paper-candidates/{cand.id}/confirm").status_code, 200)
        row.refresh_from_db()
        self.assertEqual((row.user_id, row.match_method, row.match_confidence), (self.me.id, "confirmed", 1.0))
        self.assertEqual(Authorship.objects.filter(publication=pub).count(), 1)

    def test_confirm_never_takes_a_row_linked_to_someone_else(self):
        pub = _pub("A paper whose author row belongs to a colleague")
        theirs = _row(pub, user=self.other, display_name="A. Other", match_method="record", match_confidence=0.95)
        cand = _candidate(self.me, pub, authorship=theirs)
        self.assertEqual(self.post(f"/api/me/paper-candidates/{cand.id}/confirm").status_code, 200)
        theirs.refresh_from_db()
        self.assertEqual((theirs.user_id, theirs.match_method, theirs.match_confidence),
                         (self.other.id, "record", 0.95))
        mine = Authorship.objects.get(publication=pub, user=self.me)
        self.assertNotEqual(mine.id, theirs.id)
        self.assertEqual((mine.display_name, mine.match_method, mine.match_confidence, mine.is_college),
                         (self.me.name, "confirmed", 1.0, True))

    def test_confirm_with_no_row_adds_one_for_me(self):
        pub = _pub("A paper the cleanup left with no author row to point at")
        cand = _candidate(self.me, pub, authorship=None)
        self.assertEqual(self.post(f"/api/me/paper-candidates/{cand.id}/confirm").status_code, 200)
        mine = Authorship.objects.get(publication=pub, user=self.me)
        self.assertEqual((mine.match_method, mine.match_confidence, mine.is_college), ("confirmed", 1.0, True))
        P.match_authors()
        self.assertEqual(Authorship.objects.get(id=mine.id).user_id, self.me.id)

    def test_a_decided_candidate_cannot_be_decided_again(self):
        pub = _pub("A paper already rejected")
        cand = _candidate(self.me, pub, status=PaperCandidate.Status.REJECTED)
        self.assertEqual(self.post(f"/api/me/paper-candidates/{cand.id}/confirm").status_code, 409)
        self.assertEqual(self.post(f"/api/me/paper-candidates/{cand.id}/reject").status_code, 409)
        cand.refresh_from_db()
        self.assertEqual(cand.status, PaperCandidate.Status.REJECTED)
        self.assertFalse(Authorship.objects.filter(publication=pub, user=self.me).exists())
        self.assertFalse(AuditLog.objects.filter(action="PAPER_CONFIRMED").exists())


class RejectTests(_Base):
    def test_reject_writes_the_dispute_row_and_the_matcher_does_not_link_it_again(self):
        pub = _pub("A paper the matcher puts on me by name")
        row = _row(pub)
        cand = _candidate(self.me, pub, authorship=row)
        P.match_authors()
        self.assertEqual(Authorship.objects.get(id=row.id).user_id, self.me.id,
                         "the matcher would link this row by name")
        r = self.post(f"/api/me/paper-candidates/{cand.id}/reject")
        self.assertEqual(r.status_code, 200, r.content)
        dispute = AuditLog.objects.get(action="PUBLICATION_DISPUTED", actor=self.me, entity="Publication",
                                       entity_id=pub.id)
        self.assertEqual(json.loads(dispute.detail_json)["reason"], "not_mine")
        cand.refresh_from_db()
        self.assertEqual(cand.status, PaperCandidate.Status.REJECTED)
        self.assertIsNotNone(cand.decided_at)
        P.match_authors()
        self.assertIsNone(Authorship.objects.get(id=row.id).user)


class OwnershipTests(_Base):
    def test_a_colleagues_candidate_is_a_404_for_every_action_and_writes_nothing(self):
        pub = _pub("A colleague's candidate")
        theirs = _candidate(self.other, pub, authorship=_row(pub))
        for action in ("confirm", "reject"):
            self.assertEqual(self.post(f"/api/me/paper-candidates/{theirs.id}/{action}").status_code, 404, action)
        theirs.refresh_from_db()
        self.assertEqual(theirs.status, PaperCandidate.Status.PENDING)
        self.assertFalse(AuditLog.objects.filter(action__in=["PAPER_CONFIRMED", "PUBLICATION_DISPUTED"]).exists())
        self.assertEqual(self.c.get("/api/me/paper-candidates").json()["pending"], 0)

    def test_an_unknown_id_is_a_404(self):
        self.assertEqual(self.post("/api/me/paper-candidates/nope/confirm").status_code, 404)
        self.assertEqual(self.post("/api/me/paper-candidates/nope/reject").status_code, 404)


class ScopusProfileTests(_Base):
    def setUp(self):
        super().setUp()
        self.me.scopus_author_id = "59009649300"
        self.me.save(update_fields=["scopus_author_id"])

    def test_the_figures_are_the_directory_rows_figures(self):
        office = _person("pc-office@x.edu", "Office Admin", role=Role.SUPER_ADMIN)
        _row(_pub("Indexed paper", scopus_indexed=True), user=self.me)
        _row(_pub("EID paper", eid="2-s2.0-1"), user=self.me)
        _row(_pub("Plain paper"), user=self.me)
        cache.clear()
        office_client = Client()
        office_client.force_login(office)
        row = next(r for r in office_client.get("/api/directory/faculty?limit=100").json()["results"]
                   if r["id"] == self.me.id)
        profile = self.c.get("/api/me/scopus-profile").json()
        self.assertEqual((row["papers"], row["scopus_papers"]), (3, 2))
        self.assertEqual(
            {k: profile[k] for k in ("papers_on_record", "papers_in_scopus", "url", "scopus_author_id")},
            {"papers_on_record": 3, "papers_in_scopus": 2, "url": row["scopus_url"],
             "scopus_author_id": row["scopus_author_id"]},
        )
        self.assertEqual(profile["status"], "")
        self.assertIsNone(profile["checked_at"])

    def test_yes_confirms_the_profile_and_no_marks_it_wrong_each_with_its_audit_row(self):
        r = self.post("/api/me/scopus-profile", {"answer": "yes"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "confirmed")
        self.me.refresh_from_db()
        self.assertEqual(self.me.scopus_profile_status, "confirmed")
        self.assertIsNotNone(self.me.scopus_profile_checked_at)
        self.assertTrue(AuditLog.objects.filter(action="SCOPUS_PROFILE_CONFIRMED", actor=self.me).exists())

        r = self.post("/api/me/scopus-profile", {"answer": "no"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "wrong")
        self.me.refresh_from_db()
        self.assertEqual(self.me.scopus_profile_status, "wrong")
        self.assertTrue(AuditLog.objects.filter(action="SCOPUS_PROFILE_DISPUTED", actor=self.me).exists())
        self.assertEqual(self.c.get("/api/me/scopus-profile").json()["status"], "wrong")

    def test_an_answer_other_than_yes_or_no_is_a_400_and_changes_nothing(self):
        self.assertEqual(self.post("/api/me/scopus-profile", {"answer": "maybe"}).status_code, 400)
        self.me.refresh_from_db()
        self.assertEqual(self.me.scopus_profile_status, "")
        self.assertFalse(AuditLog.objects.filter(action__startswith="SCOPUS_PROFILE_").exists())

    def test_a_person_with_no_scopus_id_is_told_so_and_cannot_answer(self):
        stranger = _person("pc-noid@x.edu", "Dr. No Id", department="CSE")
        c = Client()
        c.force_login(stranger)
        body = c.get("/api/me/scopus-profile").json()
        self.assertEqual((body["status"], body["scopus_author_id"], body["url"]), ("no_id", None, None))
        r = c.post("/api/me/scopus-profile", data=json.dumps({"answer": "yes"}), content_type="application/json")
        self.assertEqual(r.status_code, 400, r.content)
        stranger.refresh_from_db()
        self.assertEqual(stranger.scopus_profile_status, "")
        self.assertFalse(AuditLog.objects.filter(action__startswith="SCOPUS_PROFILE_").exists())


class SeedCandidatesTests(_Base):
    HEADER = ["scope", "authorship_id", "publication_id", "staff_id", "user_id", "match_method",
              "match_confidence", "match_locked", "is_college", "position", "display_name", "author_key",
              "openalex_author_id", "orcid", "title", "year", "doi"]

    def setUp(self):
        super().setUp()
        self.pub1 = _pub("Log paper one")
        self.row1 = _row(self.pub1)
        self.pub2 = _pub("Log paper two")
        self.stray_pub = _pub("A paper with an author row of its own")
        self.stray = _row(self.stray_pub)
        self.log = self._log([
            ("A", str(self.row1.id), self.pub1.id, "tscs001"),        # created, staff id in lower case
            ("A", "99999", self.pub2.id, "TSCS002"),                  # created, the author row is gone
            ("A", str(self.row1.id), self.pub1.id, "NOBODY"),         # unresolved: no such person
            ("A", str(self.row1.id), "no-such-paper", "TSCS001"),     # unresolved: no such paper
            ("A", str(self.row1.id), self.pub1.id, "TSCS001"),        # skipped: the first row again
            ("A", str(self.stray.id), self.pub2.id, "TSCS001"),       # created, row is on another paper
        ])

    def _log(self, rows):
        fd, path = tempfile.mkstemp(suffix=".csv")
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(self.HEADER)
            for scope, authorship_id, publication_id, staff_id in rows:
                writer.writerow([scope, authorship_id, publication_id, staff_id] + [""] * (len(self.HEADER) - 4))
        self.addCleanup(os.remove, path)
        return path

    def _seed(self, **kw):
        out = StringIO()
        call_command("seed_paper_candidates", log=self.log, stdout=out, **kw)
        return json.loads(out.getvalue())

    def test_a_dry_run_counts_what_it_would_create_and_writes_nothing(self):
        result = self._seed(dry_run=True)
        self.assertEqual(result, {"created": 3, "skipped": 1, "unresolved": 2, "rows": 6, "dry_run": True})
        self.assertEqual(PaperCandidate.objects.count(), 0)

    def test_a_real_run_creates_the_candidates_with_their_author_rows_where_they_exist(self):
        result = self._seed()
        self.assertEqual(result, {"created": 3, "skipped": 1, "unresolved": 2, "rows": 6, "dry_run": False})
        mine = PaperCandidate.objects.get(user=self.me, publication=self.pub1)
        self.assertEqual((mine.authorship_id, mine.status, mine.source, mine.reason),
                         (self.row1.id, PaperCandidate.Status.PENDING, "cleanup-2026-10-24", REASON))
        self.assertIsNone(PaperCandidate.objects.get(user=self.other, publication=self.pub2).authorship_id)
        self.assertIsNone(PaperCandidate.objects.get(user=self.me, publication=self.pub2).authorship_id)

    def test_a_second_run_creates_nothing_and_leaves_a_decided_candidate_alone(self):
        self._seed()
        PaperCandidate.objects.filter(user=self.me, publication=self.pub1).update(status=PaperCandidate.Status.REJECTED)
        result = self._seed()
        self.assertEqual((result["created"], result["skipped"], result["unresolved"]), (0, 4, 2))
        self.assertEqual(PaperCandidate.objects.count(), 3)
        self.assertEqual(PaperCandidate.objects.get(user=self.me, publication=self.pub1).status,
                         PaperCandidate.Status.REJECTED)
