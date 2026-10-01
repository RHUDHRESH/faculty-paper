"""Publication-record quality: duplicates and their reversible merge, roster
name suggestions, record anomalies in data health, and a head opening a
colleague's paper without seeing money."""
import json
from io import StringIO

from django.core.management import call_command
from django.test import Client, TestCase

from core.models import (
    AuditLog, Authorship, Claim, ClaimStatus, FeedPost, PaidLedger, Publication, PublicationMerge,
    PublicationMetrics, Role, User,
)
from core.services import integrity
from core.services import record_quality as rq

LONG = "Demarcation of non-carcinogenic risk zones based on the intake of contaminated groundwater"


def _pub(title, year, users=(), doi=None, **kw):
    p = Publication.objects.create(title=title, year=year, doi=doi, **kw)
    for i, u in enumerate(users, 1):
        Authorship.objects.create(publication=p, position=i, display_name=u.name, author_key=f"u:{u.pk}", user=u,
                                  is_college=True)
    return p


class DuplicateTests(TestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.edu", password="p", name="Dr. A. Kumar")
        self.b = User.objects.create_user(email="b@x.edu", password="p", name="Dr. B. Rani")

    def test_same_doi_title_year_with_plural_and_preprint_are_found(self):
        p1 = _pub(LONG + " technique", 2022, [self.a], doi="10.5004/dwt.2022.28901", citations=6)
        _pub(LONG + " techniques", 2022, [self.a], doi="10.5004/dwt.2022.29203")
        _pub("Deep learning for crop disease detection in the field", 2023, [self.b], doi="10.1/x")
        _pub("Deep learning for crop disease detection in the field", 2022, [self.b], venue="Research Square")
        _pub("Same doi one", 2020, doi="10.9/same")
        _pub("Same doi two", 2020, doi="10.9/same")
        pairs = rq.find_duplicates()
        reasons = sorted(p["reason"] for p in pairs)
        self.assertEqual(reasons, ["preprint", "same_doi", "same_title_year"])
        tp = next(p for p in pairs if p["reason"] == "same_title_year")
        self.assertEqual(tp["keep"]["id"], p1.pk)  # more citations wins the tie
        pre = next(p for p in pairs if p["reason"] == "preprint")
        self.assertFalse(pre["keep"]["preprint"])

    def test_same_title_on_different_peoples_records_is_not_a_duplicate(self):
        _pub(LONG, 2022, [self.a])
        _pub(LONG, 2022, [self.b])
        self.assertEqual(rq.find_duplicates(), [])

    def test_short_titles_never_match(self):
        _pub("Editorial", 2022, [self.a])
        _pub("Editorial", 2022, [self.a])
        self.assertEqual(rq.find_duplicates(), [])

    def test_command_is_a_dry_run_unless_told(self):
        _pub(LONG, 2022, [self.a], doi="10.1/a")
        _pub(LONG, 2022, [self.a], doi="10.1/a")
        out = StringIO()
        call_command("find_duplicate_publications", stdout=out)
        self.assertIn("1 duplicate pairs", out.getvalue())
        self.assertEqual(Publication.objects.count(), 2)
        call_command("find_duplicate_publications", "--apply", stdout=StringIO())
        self.assertEqual(Publication.objects.count(), 1)
        self.assertEqual(PublicationMerge.objects.count(), 1)


class MergeTests(TestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.edu", password="p", name="Dr. A. Kumar")
        self.b = User.objects.create_user(email="b@x.edu", password="p", name="Dr. B. Rani")
        self.sa = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        self.keep = _pub(LONG, 2022, [self.a], doi="10.1/keep", openalex_id="W1", citations=3)
        self.drop = _pub(LONG, 2022, [self.a, self.b], citations=9, issn="1234-5678", openalex_id="W2")
        self.claim = Claim.objects.create(owner=self.a, status=ClaimStatus.PAID, paper_title=LONG)
        self.drop.claims.add(self.claim)
        self.row = PaidLedger.objects.create(amount=100, staff_id="S", payout_month="2025-01-01")
        self.drop.ledger_rows.add(self.row)
        self.post = FeedPost.objects.create(author=self.a, body="x", publication=self.drop)
        PublicationMetrics.objects.create(user=self.a, total_publications=2)

    def test_merge_moves_everything_and_undo_puts_it_back(self):
        m = rq.merge(self.keep.pk, self.drop.pk, self.sa)
        self.assertFalse(Publication.objects.filter(pk=self.drop.pk).exists())
        self.keep.refresh_from_db()
        self.assertEqual(self.keep.citations, 9)
        self.assertEqual(self.keep.issn, "1234-5678")
        self.assertEqual(self.keep.openalex_id, "W1")
        users = sorted(self.keep.authorships.values_list("user_id", flat=True))
        self.assertEqual(users, sorted([self.a.pk, self.b.pk]))  # A not repeated, B moved
        self.assertIn(self.claim, self.keep.claims.all())
        self.assertIn(self.row, self.keep.ledger_rows.all())
        self.post.refresh_from_db()
        self.assertEqual(self.post.publication_id, self.keep.pk)
        self.assertEqual(PublicationMetrics.objects.get(user=self.a).total_publications, 1)
        self.assertTrue(AuditLog.objects.filter(action="PUBLICATION_MERGED", entity_id=self.keep.pk).exists())

        rq.undo_merge(m.pk, self.sa)
        drop = Publication.objects.get(pk=self.drop.pk)
        self.keep.refresh_from_db()
        self.assertEqual((self.keep.citations, self.keep.issn), (3, ""))
        self.assertEqual((drop.citations, drop.issn, drop.openalex_id), (9, "1234-5678", "W2"))
        self.assertEqual(sorted(drop.authorships.values_list("user_id", flat=True)), sorted([self.a.pk, self.b.pk]))
        self.assertEqual(list(self.keep.authorships.values_list("user_id", flat=True)), [self.a.pk])
        self.assertEqual(list(self.keep.claims.all()), [])
        self.assertEqual(list(drop.claims.all()), [self.claim])
        self.assertEqual(list(drop.ledger_rows.all()), [self.row])
        self.post.refresh_from_db()
        self.assertEqual(self.post.publication_id, drop.pk)
        self.assertEqual(PublicationMetrics.objects.get(user=self.a).total_publications, 2)
        with self.assertRaises(rq.MergeError):
            rq.undo_merge(m.pk, self.sa)

    def test_api_is_super_admin_only_and_merges(self):
        c = Client()
        c.force_login(self.a)
        self.assertEqual(c.get("/api/admin/record/duplicates").status_code, 403)
        c.force_login(self.sa)
        body = c.get("/api/admin/record/duplicates").json()
        self.assertEqual(body["summary"]["pairs"], 1)
        pair = body["pairs"][0]
        self.assertEqual(pair["people"][0]["name"], "Dr. A. Kumar")
        r = c.post("/api/admin/record/duplicates/merge", json.dumps({"keep_id": pair["keep"]["id"], "drop_id": pair["drop"]["id"]}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        merges = c.get("/api/admin/record/merges").json()["merges"]
        self.assertEqual(len(merges), 1)
        self.assertEqual(c.post(f"/api/admin/record/merges/{merges[0]['id']}/undo").status_code, 200)
        self.assertEqual(Publication.objects.count(), 2)

    def test_dismissed_pairs_stay_dismissed(self):
        c = Client()
        c.force_login(self.sa)
        c.post("/api/admin/record/duplicates/dismiss", json.dumps({"a": self.drop.pk, "b": self.keep.pk}),
               content_type="application/json")
        self.assertEqual(rq.find_duplicates(), [])


class RosterNameTests(TestCase):
    def setUp(self):
        self.u = User.objects.create_user(email="g@x.edu", password="p", name="Dr. G. Bhuaneswari", department="CSE")
        self.other = User.objects.create_user(email="c@x.edu", password="p", name="Mr. C. Rajesh")
        for i, name in enumerate(["G. Bhuvaneswari", "G Bhuvaneswari", "G. Bhuvaneswari"]):
            p = Publication.objects.create(title=f"Paper {i}", year=2020)
            Authorship.objects.create(publication=p, display_name=name, author_key=f"n:{i}", is_college=True)
        # Her own claim copied the roster spelling: not evidence either way.
        p = Publication.objects.create(title="Claimed", year=2021)
        Authorship.objects.create(publication=p, display_name="Dr. G. Bhuaneswari", author_key="x", user=self.u,
                                  is_college=True)
        for i in range(3):  # a different person, different initial
            p = Publication.objects.create(title=f"R {i}", year=2020)
            Authorship.objects.create(publication=p, display_name="R. Ramesh", author_key=f"r:{i}", is_college=True)

    def test_suggests_the_papers_spelling_and_never_renames(self):
        rows = rq.roster_name_suggestions()
        self.assertEqual([(r["name"], r["suggested"], r["papers"]) for r in rows],
                         [("Dr. G. Bhuaneswari", "Dr. G. Bhuvaneswari", 3)])
        self.u.refresh_from_db()
        self.assertEqual(self.u.name, "Dr. G. Bhuaneswari")

    def test_super_admin_applies_or_dismisses(self):
        sa = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        c = Client()
        c.force_login(sa)
        rows = c.get("/api/admin/record/roster-names").json()["suggestions"]
        r = c.post("/api/admin/record/roster-names/apply", json.dumps({"user_id": self.u.pk, "name": rows[0]["suggested"]}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 200)
        self.u.refresh_from_db()
        self.assertEqual(self.u.name, "Dr. G. Bhuvaneswari")
        self.assertTrue(AuditLog.objects.filter(action="ROSTER_NAME_CORRECTED").exists())

        rq.dismiss_roster_suggestion(self.u.pk, "whatever", sa)
        self.assertEqual(rq.roster_name_suggestions(), [])


class AnomalyTests(TestCase):
    def test_anomalies_counted_in_data_health_with_a_fix_for_url_venues(self):
        a = User.objects.create_user(email="a@x.edu", password="p", name="A")
        _pub("-", 2020, [a])
        _pub("Real title of a paper", 1860, [a])
        _pub("Nobody wrote this one", 2020)
        url = _pub("A paper in a web address", 2019, [a], venue="decision.csl.uiuc.edu")
        http = _pub("Another in a pdf", 2014, [a], venue="http://www.ijcst.com/vol23/1/sasi.pdf")
        _pub("Fine paper", 2020, [a], venue="Preprints.org")
        _pub("Fine paper two", 2020, [a], venue="Procedia Comput. Sci.")
        report = integrity.run_audit()
        f = {x["key"]: x for x in report["findings"]}
        self.assertEqual(f["pub_placeholder_title"]["count"], 1)
        self.assertEqual(f["pub_impossible_year"]["count"], 1)
        self.assertEqual(f["pub_no_authors"]["count"], 1)
        self.assertEqual(f["pub_venue_is_url"]["count"], 2)
        self.assertEqual(f["pub_venue_is_url"]["fix"], "clear_url_venues")
        self.assertEqual(integrity.apply_fix("clear_url_venues", None), 2)
        url.refresh_from_db()
        http.refresh_from_db()
        self.assertEqual((url.venue, url.oa_url), ("", ""))
        self.assertEqual((http.venue, http.oa_url), ("", "http://www.ijcst.com/vol23/1/sasi.pdf"))

    def test_duplicates_on_a_record_show_in_data_health(self):
        a = User.objects.create_user(email="a@x.edu", password="p", name="A")
        _pub(LONG, 2022, [a])
        _pub(LONG, 2022, [a])
        f = next(x for x in integrity.run_audit()["findings"] if x["key"] == "pub_duplicate_on_record")
        self.assertEqual(f["count"], 1)
        self.assertEqual(f["rows"][0]["href"], "/data/record")


class HodPaperTests(TestCase):
    def setUp(self):
        self.hod = User.objects.create_user(email="h@x.edu", password="p", name="Dr. Head", role=Role.HOD, department="CSE")
        self.col = User.objects.create_user(email="c@x.edu", password="p", name="Dr. Colleague", department="CSE")
        self.far = User.objects.create_user(email="f@x.edu", password="p", name="Dr. Far", department="MECH")
        self.claim = Claim.objects.create(owner=self.col, status=ClaimStatus.PAID, paper_title="Colleague paper",
                                          journal_title="J", remuneration=12345, ticket_number="T-1",
                                          publication_year=2024)
        pub = _pub("Colleague paper", 2024, [self.col], citations=4)
        pub.claims.add(self.claim)
        self.other = Claim.objects.create(owner=self.far, status=ClaimStatus.SUBMITTED, paper_title="Far", remuneration=5)
        self.c = Client()
        self.c.force_login(self.hod)

    def test_head_opens_a_colleague_paper_without_money(self):
        r = self.c.get(f"/api/hod/papers/{self.claim.pk}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["paper_title"], "Colleague paper")
        self.assertEqual(body["progress"], "Completed" if body["progress"] == "Completed" else body["progress"])
        self.assertEqual(body["citations"], 4)
        self.assertEqual(body["authors"][0]["name"], "Dr. Colleague")
        text = r.content.decode()
        self.assertNotIn("12345", text)
        self.assertNotIn("remuneration", text)
        self.assertNotIn("PAID", text)
        # The claim page itself still refuses the head.
        self.assertEqual(self.c.get(f"/api/claims/{self.claim.pk}").status_code, 403)

    def test_head_cannot_open_another_department_or_be_a_non_head(self):
        self.assertEqual(self.c.get(f"/api/hod/papers/{self.other.pk}").status_code, 404)
        c = Client()
        c.force_login(self.col)
        self.assertEqual(c.get(f"/api/hod/papers/{self.claim.pk}").status_code, 403)
