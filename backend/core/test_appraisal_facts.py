"""The appraisal list takes type, Scopus indexing, author order and the
corresponding author from the claim when the publication record lacks them."""
import json

from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, Publication, Role, User


class AppraisalFactsTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(email="me@x.edu", password="p", name="Me", role=Role.FACULTY)
        self.c = Client()
        self.c.force_login(self.me)

    def _claim(self, **over):
        data = dict(owner=self.me, status=ClaimStatus.PAID, paper_title="Graph study", journal_title="J Graphs",
                    publication_year=2024, doi="10.1/g", publication_type="Journal Article",
                    indexing_level="Scopus, UGC Care", author_position=3, total_authors=4,
                    authors_json=json.dumps([{"position": 3, "name": "Me", "corresponding": True}]))
        data.update(over)
        return Claim.objects.create(**data)

    def _papers(self):
        return self.c.get("/api/me/publications").json()["publications"]

    def test_doi_filed_record_paper_takes_claim_facts(self):
        pub = Publication.objects.create(title="Graph study", doi="10.1/g", year=2024, source="record")
        Authorship.objects.create(publication=pub, display_name="Me", user=self.me, author_key="n:me")
        self._claim()
        p = next(x for x in self._papers() if x["id"] == pub.id)
        self.assertEqual(p["type"], "Journal Article")
        self.assertTrue(p["scopus_indexed"])
        self.assertEqual((p["author_position"], p["total_authors"]), (3, 4))
        self.assertIs(p["corresponding_author"], True)

    def test_claims_only_paper_takes_claim_facts(self):
        self._claim()
        papers = self._papers()
        self.assertEqual(len(papers), 1)
        p = papers[0]
        self.assertEqual(p["source"], "claim")
        self.assertEqual(p["doi"], "10.1/g")
        self.assertTrue(p["scopus_indexed"])
        self.assertEqual((p["author_position"], p["total_authors"]), (3, 4))

    def test_openalex_corresponding_flag_is_stored_and_shown(self):
        pub = Publication.objects.create(title="Other", doi="10.1/o", year=2023)
        Authorship.objects.create(publication=pub, display_name="Me", user=self.me, author_key="n:me",
                                  position=1, is_corresponding=True)
        p = next(x for x in self._papers() if x["id"] == pub.id)
        self.assertIs(p["corresponding_author"], True)
        self.assertFalse(p["scopus_indexed"])

    def test_harvest_reads_is_corresponding(self):
        from core.services.publications import _authorship_rows
        rows = _authorship_rows({"authorships": [{"author": {"display_name": "A"}, "is_corresponding": True}]})
        self.assertTrue(rows[0]["is_corresponding"])
