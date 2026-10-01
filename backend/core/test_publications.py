"""The publication record: harvest, matching, co-authors -- OpenAlex mocked.

Pinned here:
- the harvest recognises the college by raw affiliation, author by author,
  so a SIMATS co-author on the same paper stays outside;
- paging follows the cursor, and a second run changes nothing;
- matching: records anchor a member to a paper, the OpenAlex author id
  carries it to their other papers, names match initials-first Indian names,
  and a tie is left unmatched rather than guessed;
- the API: records, filters, co-authors inside and outside, connection
  paths, external search, Scopus pull, the super-admin queue -- no money.
"""

from __future__ import annotations

import json
import tempfile
from unittest.mock import patch

from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, PaidLedger, Publication, Role, User
from core.services import publications as P
from core.services.author_names import departments_in, name_score
from core.test_search import money_keys_in

SEC = "Department of Electrical and Electronics Engineering, Saveetha Engineering College, Chennai, India"
SEC_ECE = "Department of Electronics and Communication Engineering, Saveetha Engineering College, Chennai"
SIMATS = "Saveetha School of Engineering, Saveetha University, Chennai"
IIT = "Indian Institute of Technology Madras, Chennai"


def author(aid, name, aff, orcid=None, inst="Saveetha University", country="IN"):
    return {
        "author": {"id": f"https://openalex.org/{aid}", "display_name": name,
                   "orcid": f"https://orcid.org/{orcid}" if orcid else None},
        "raw_author_name": name,
        "raw_affiliation_strings": [aff],
        "institutions": [{"display_name": inst, "country_code": country}],
        "countries": [country],
    }


def work(wid, title, year, authors, *, doi=None, cites=0):
    return {
        "id": f"https://openalex.org/{wid}",
        "doi": f"https://doi.org/{doi}" if doi else None,
        "title": title,
        "publication_year": year,
        "publication_date": f"{year}-03-01",
        "type": "article",
        "cited_by_count": cites,
        "open_access": {"oa_url": None},
        "primary_location": {"source": {"display_name": "Journal of Things", "issn_l": "1234-5678"}},
        "authorships": authors,
        "topics": [{"display_name": "Power systems"}],
    }


W1 = work("W1", "Fuzzy control of a grid connected inverter for rural feeders", 2022, [
    author("A1", "S. Joyal Isac", SEC),
    author("A9", "V. Subathra Devi", SIMATS),
    author("A7", "K. Outsider", IIT, inst="IIT Madras"),
], doi="10.1/w1", cites=12)
W2 = work("W2", "Solar harvester design for smart homes in coastal towns", 2023, [
    author("A2", "Subhashini R", SEC_ECE),
    author("A1", "Joyal Isac S", SEC),
], doi="10.1/w2", cites=3)
W3 = work("W3", "A third paper written with an outside collaborator from IIT", 2024, [
    author("A7", "K. Outsider", IIT, inst="IIT Madras"),
    author("A3", "M. Other", IIT, inst="IIT Madras"),
], cites=40)
W4 = work("W4", "An ambiguous author appears on this long paper title", 2024, [
    author("A5", "P. Kumar", "Saveetha Engineering College, Chennai"),
])
# Joyal's pre-college paper: not SEC, found through his OpenAlex id.
W5 = work("W5", "Capacitor placement in radial distribution systems using fuzzy logic", 2013, [
    author("A1", "S. Joyal Isac", "Velammal Engineering College, Chennai", inst="Velammal"),
], doi="10.1/w5", cites=11)


class FakeOpenAlex:
    """Answers the few filters the harvest sends, in pages of two."""

    def __init__(self, works):
        self.works = {w["id"].rsplit("/", 1)[-1]: w for w in works}
        self.calls = []

    def __call__(self, path, params):
        self.calls.append((path, dict(params)))
        f = params.get("filter", "")
        if path == "authors":
            ids = f.split(":", 1)[1].split("|")
            return {"results": [{"id": f"https://openalex.org/{a}", "works_count": 5} for a in ids]}
        if f.startswith("raw_affiliation_strings.search"):
            hits = [w for w in self.works.values()
                    if any(P.is_college_affiliation(";".join(a["raw_affiliation_strings"])) for a in w["authorships"])]
        elif f.startswith("doi:"):
            want = set(f[4:].split("|"))
            hits = [w for w in self.works.values() if w["doi"] and w["doi"].split("doi.org/")[1] in want]
        elif f.startswith("authorships.author.id:"):
            want = set(f.split(":", 1)[1].split("|"))
            hits = [w for w in self.works.values()
                    if any(a["author"]["id"].rsplit("/", 1)[-1] in want for a in w["authorships"])]
        elif f.startswith("authorships.author.orcid:"):
            want = set(f.split(":", 1)[1].split("|"))
            hits = [w for w in self.works.values()
                    if any((a["author"]["orcid"] or "").rsplit("/", 1)[-1] in want for a in w["authorships"])]
        elif f.startswith("openalex:"):
            want = set(f[9:].split("|"))
            return {"results": [{"id": w["id"], "cited_by_count": w["cited_by_count"] + 1}
                                for k, w in self.works.items() if k in want]}
        else:
            hits = []
        start = 0 if params.get("cursor") in (None, "*") else int(params["cursor"])
        page = hits[start:start + 2]
        nxt = str(start + 2) if start + 2 < len(hits) else None
        return {"meta": {"next_cursor": nxt}, "results": page}


class NameTests(TestCase):
    def test_initials_first_indian_names(self):
        self.assertEqual(name_score("R. Subhashini", "Subhashini R"), 1.0)
        self.assertGreaterEqual(name_score("Subhashini R", "Subhashini Ramesh"), 0.9)
        self.assertGreaterEqual(name_score("R. Subhashini", "Subhashini Ramesh"), 0.9)
        self.assertGreaterEqual(name_score("Mr. S. Joyal Isac", "Joyal Isac S"), 0.99)
        # "Selvi" is an honorific and a name: kept when it is the only name.
        self.assertGreaterEqual(name_score("M. Selvi", "Dr. M. Selvi"), 0.9)
        self.assertEqual(name_score("M. Selvi", "Dr. K. Selvi"), 0.0)
        self.assertGreaterEqual(name_score("Selvi R. Kavitha", "Kavitha R"), 0.9)
        self.assertGreaterEqual(name_score("Dr. Gowri Ganesh N S", "N. S. Gowri Ganesh"), 0.99)
        self.assertGreaterEqual(name_score("S. Joyal Isac", "Joyal Isac"), 0.85)

    def test_contradictions_score_zero(self):
        self.assertEqual(name_score("R. Subhashini", "K. Subhashini"), 0)
        self.assertEqual(name_score("Subhashini Ramesh", "Subhashini Kumar"), 0)
        self.assertEqual(name_score("Joyal Isac", "Priya Devi"), 0)
        # Only the surname shared, each given name "explained" by the other's
        # initial: below the bar the name matcher acts on.
        self.assertLess(name_score("R. Monish Kumar", "Rakesh Kumar M"), 0.85)

    def test_departments_from_affiliation(self):
        self.assertEqual(departments_in(SEC), {"EEE"})
        self.assertIn("ECE", departments_in(SEC_ECE))


class _Base(TestCase):
    def setUp(self):
        self.joyal = User.objects.create_user(email="joyal@x.edu", password=None, name="Mr. S. Joyal Isac",
                                              department="EEE", staff_id="TSEE023",
                                              scopus_author_id="57983494200")
        self.subha = User.objects.create_user(email="subha@x.edu", password=None, name="Dr. R. Subhashini",
                                              department="ECE", staff_id="TSEC010")
        self.kumar1 = User.objects.create_user(email="pk1@x.edu", password=None, name="P. Kumar", department="CSE")
        self.kumar2 = User.objects.create_user(email="pk2@x.edu", password=None, name="Kumar P", department="MECH")
        self.admin = User.objects.create_user(email="sa@x.edu", password=None, name="Super Admin",
                                              role=Role.SUPER_ADMIN)
        # The ledger says Joyal was paid for W1 (by DOI) -- the record anchor.
        PaidLedger.objects.create(
            payout_month="2023-01-01", staff_id="tsee023", faculty_name="Joyal", amount=5000,
            paper_title="Fuzzy control", raw_json=json.dumps({"DOI": "10.1/W1", "Scopus EID": "2-s2.0-111",
                                                              "SJR Quartile": "Q2", "Scopus Article Title": "Fuzzy control"}),
        )
        # A paper only the ledger knows.
        PaidLedger.objects.create(
            payout_month="2023-02-01", staff_id="TSEE023", faculty_name="Joyal", amount=4000,
            raw_json=json.dumps({"DOI": "10.9/unknown", "Scopus Article Title": "A paper OpenAlex never saw at all",
                                 "Publication Date": "2021-05-01", "SJR Quartile": "Q4", "Source Title": "J"}),
        )
        self.fake = FakeOpenAlex([W1, W2, W3, W4, W5])

    def harvest(self):
        return P.run_harvest(fetch=self.fake, log=lambda m: None)


class HarvestTests(_Base):
    def test_college_by_raw_affiliation_and_idempotent(self):
        out = self.harvest()
        self.assertEqual(out["college"]["works"], 3)  # W1, W2, W4 name SEC
        pages = [c for c in self.fake.calls if c[1].get("filter", "").startswith("raw_aff")]
        self.assertEqual(len(pages), 2)  # cursor followed
        self.assertIn("select", pages[0][1])
        w1 = Publication.objects.get(openalex_id="W1")
        college = {a.display_name: a.is_college for a in w1.authorships.all()}
        self.assertEqual(college, {"S. Joyal Isac": True, "V. Subathra Devi": False, "K. Outsider": False})
        self.assertEqual(w1.quartile, "Q2")
        self.assertEqual(w1.eid, "2-s2.0-111")
        self.assertEqual(w1.ledger_rows.count(), 1)
        counts = (Publication.objects.count(), Authorship.objects.count(),
                  Authorship.objects.filter(user__isnull=False).count())
        self.harvest()
        self.assertEqual(counts, (Publication.objects.count(), Authorship.objects.count(),
                                  Authorship.objects.filter(user__isnull=False).count()))

    def test_a_refusal_midway_keeps_what_was_fetched_and_still_matches(self):
        # OpenAlex answers a long run with 429s; what came in must still be
        # attributed, and the run must say it stopped early.
        calls = []

        def refusing(path, params):
            calls.append(params)
            if len(calls) > 1:
                raise RuntimeError("Client error '429 Too Many Requests'")
            return self.fake(path, params)

        out = P.run_harvest(fetch=refusing, log=lambda m: None)
        self.assertTrue(out["partial"])
        self.assertIn("429", out["errors"]["college"])
        self.assertTrue(Publication.objects.filter(openalex_id="W1").exists())
        self.assertTrue(Authorship.objects.filter(user=self.joyal).exists())
        self.assertIn("match", out)


    def test_matching(self):
        out = self.harvest()
        mine = Authorship.objects.filter(user=self.joyal)
        methods = {a.publication.openalex_id or a.publication.source: a.match_method for a in mine}
        self.assertEqual(methods["W1"], "record")
        self.assertEqual(methods["W2"], "author_id")
        self.assertEqual(methods["W5"], "author_id")  # pre-college, via his OpenAlex id
        self.assertEqual(methods["record"], "record")  # ledger-only paper
        subha = Authorship.objects.get(publication__openalex_id="W2", position=1)
        self.assertEqual(subha.user, self.subha)
        self.assertEqual(subha.match_method, "name")
        ambiguous = Authorship.objects.get(publication__openalex_id="W4")
        self.assertIsNone(ambiguous.user)  # P. Kumar / Kumar P: two people, not guessed
        self.assertEqual(out["ambiguous"], 1)
        self.assertEqual(P.metrics_for(self.joyal.id)["total_publications"], 4)
        self.assertEqual(P.metrics_for(self.joyal.id)["h_index"], 3)  # 12, 11, 3, 0

    def test_locked_match_survives(self):
        self.harvest()
        row = Authorship.objects.get(publication__openalex_id="W4")
        row.user, row.match_locked, row.match_method = self.kumar1, True, "manual"
        row.save()
        P.match_authors()
        row.refresh_from_db()
        self.assertEqual(row.user, self.kumar1)

    def test_citation_refresh(self):
        self.harvest()
        out = P.refresh_citations(fetch=self.fake)
        self.assertEqual(Publication.objects.get(openalex_id="W1").citations, 13)
        self.assertGreater(out["changed"], 0)

    def test_scopus_profile_sheet(self):
        import openpyxl

        self.harvest()
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Mr. S. Joyal Isac"
        ws.append(["Scopus ID", 57983494200])
        ws.append([])
        ws.append(["Author Name", "N/A", "Total Publications", 2])
        ws.append(["Year", "Title", "Journal", "Document Type", "Citations", "DOI", "EID"])
        ws.append([2022, "Fuzzy control", "J", "Article", 12, "10.1/w1", "2-s2.0-111"])
        ws.append([2019, "Only in Scopus: a book chapter on wind turbines", "B", "Book Chapter", 6, None, "2-s2.0-222"])
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as fh:
            wb.save(fh.name)
        from core.services.scopus_profile import import_workbook

        report = import_workbook(fh.name)
        sheet = report["sheets"][0]
        self.assertEqual((sheet["matched_existing"], sheet["created"]), (1, 1))
        self.assertTrue(Authorship.objects.filter(user=self.joyal, publication__eid="2-s2.0-222").exists())


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.harvest()
        self.client = Client()
        self.client.force_login(self.subha)

    def get(self, url, own_money=False):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        if not own_money:
            self.assertEqual(money_keys_in(body), [])
        return body

    def test_records_and_filters(self):
        body = self.get(f"/api/people/{self.joyal.id}/publications")
        self.assertEqual(body["count"], 4)
        self.assertEqual(body["metrics"]["total_publications"], 4)
        self.assertEqual([p["year"] for p in body["publications"]], sorted([p["year"] for p in body["publications"]], reverse=True))
        self.assertEqual(self.get(f"/api/people/{self.joyal.id}/publications?quartile=Q2")["count"], 1)
        self.assertEqual(self.get(f"/api/people/{self.joyal.id}/publications?year=2013")["count"], 1)
        top = self.get(f"/api/people/{self.joyal.id}/publications?sort=citations")["publications"][0]
        self.assertEqual(top["citations"], 12)
        self.assertEqual(self.get("/api/me/publications")["count"], 1)
        self.assertEqual(self.client.get(f"/api/people/{self.joyal.id}/publications?sort=x").status_code, 400)

    def test_coauthors(self):
        body = self.get(f"/api/people/{self.joyal.id}/coauthors")
        inside = {p["name"] for p in body["inside"]}
        outside = {p["name"] for p in body["outside"]}
        self.assertEqual(inside, {"Dr. R. Subhashini"})
        self.assertEqual(outside, {"V. Subathra Devi", "K. Outsider"})
        outsider = next(p for p in body["outside"] if p["name"] == "K. Outsider")
        self.assertEqual(outsider["institutions"], ["IIT Madras"])
        self.assertEqual(outsider["last_year_together"], 2022)

    def test_connection(self):
        # Subhashini -> Joyal (W2) -> K. Outsider (W1) -> M. Other (W3, no SEC author:
        # stored as another harvest would bring it in).
        P.upsert_work(W3)
        body = self.get(f"/api/people/{self.subha.id}/connection?to=A3")
        self.assertEqual(body["hops"], 3)
        names = [s["name"] for s in body["paths"][0]["people"]]
        self.assertEqual(names, ["Dr. R. Subhashini", "Mr. S. Joyal Isac", "K. Outsider", "M. Other"])
        self.assertEqual(body["paths"][0]["people"][1]["via"][0]["year"], 2023)
        self.assertEqual(self.get(f"/api/people/{self.subha.id}/connection?to={self.joyal.id}")["hops"], 1)
        self.assertEqual(self.client.get(f"/api/people/{self.subha.id}/connection?to=nobody").status_code, 404)

    def test_why(self):
        body = self.get(f"/api/people/{self.joyal.id}/why?for=me")
        self.assertEqual(body["for"], f"u:{self.subha.id}")
        together = [r for r in body["reasons"] if r["kind"] == "together"]
        self.assertEqual(len(together), 1)
        self.assertTrue(together[0]["text"].startswith("1 paper together"))
        self.assertTrue(self.get(f"/api/people/{self.subha.id}/why?of=A7")["about"])
        self.assertEqual(self.client.get(f"/api/people/{self.subha.id}/why?of=nobody").status_code, 404)

    def test_why_for_someone_else(self):
        # Faculty cannot ask on another's behalf; the office can.
        url = f"/api/people/{self.joyal.id}/why?for={self.kumar1.id}"
        self.assertEqual(self.client.get(url).status_code, 403)
        self.assertEqual(self.get(f"/api/people/{self.joyal.id}/why?for={self.subha.id}")["for"], f"u:{self.subha.id}")
        self.client.force_login(self.admin)
        self.assertEqual(self.get(url)["for"], f"u:{self.kumar1.id}")

    def test_discover_dismiss(self):
        from core.models import DiscoverDismissal
        post = lambda body: self.client.post("/api/discover/dismiss", json.dumps(body),
                                             content_type="application/json")
        self.assertEqual(post({"kind": "venue", "id": "venue:x"}).json()["dismissed"], True)
        post({"kind": "venue", "id": "venue:x"})
        self.assertEqual(DiscoverDismissal.objects.filter(user=self.subha).count(), 1)
        self.assertEqual(post({"kind": "venue", "id": "venue:x", "undo": True}).json()["dismissed"], False)
        self.assertFalse(DiscoverDismissal.objects.exists())
        self.assertEqual(post({"kind": "venue", "id": " "}).status_code, 400)

    def test_dismissed_items_leave_suggestions(self):
        from core.services.dismissals import without_dismissed
        things = {"people": [{"id": "p1"}, {"id": "p2"}], "journals": [{"title": "IEEE  Access"}],
                  "topics": [{"area": "Machine Learning"}]}
        out = without_dismissed(things, {"person:p1", "venue:ieee access", "topic:machine learning"})
        self.assertEqual(out["people"], [{"id": "p2"}])
        self.assertEqual(out["journals"], [])
        self.assertEqual(out["topics"], [])
        self.client.post("/api/discover/dismiss", json.dumps({"kind": "paper", "id": "paper:zzz"}),
                         content_type="application/json")
        ids = [i["id"] for i in self.get("/api/discover/for-you")["items"]]
        self.assertNotIn("paper:zzz", ids)

    def test_external_search(self):
        body = self.get("/api/search/people-external?q=outsider")
        hit = body["results"][0]
        self.assertEqual(hit["key"], "A7")
        self.assertEqual([c["name"] for c in hit["college_coauthors"]], ["Mr. S. Joyal Isac"])

    def test_external_person(self):
        body = self.get("/api/external-person?key=A7")
        self.assertEqual(body["name"], "K. Outsider")
        self.assertEqual(body["institutions"], ["IIT Madras"])
        self.assertEqual(body["openalex_id"], "A7")
        self.assertEqual([c["name"] for c in body["college_coauthors"]], ["Mr. S. Joyal Isac"])
        self.assertEqual(body["papers"][0]["college_authors"][0]["name"], "Mr. S. Joyal Isac")
        self.assertEqual(self.client.get("/api/external-person?key=nobody").status_code, 404)

    def test_ego(self):
        P.upsert_work(W3)
        body = self.get("/api/people/me/ego")
        hops = {n["name"]: n["hop"] for n in body["nodes"]}
        self.assertEqual(hops["Dr. R. Subhashini"], 0)
        self.assertEqual(hops["Mr. S. Joyal Isac"], 1)
        self.assertEqual(hops["K. Outsider"], 2)
        self.assertNotIn("M. Other", hops)  # three hops away
        self.assertEqual(body["coauthors"], 1)
        self.assertLessEqual(len(self.get(f"/api/people/{self.joyal.id}/ego?limit=500")["nodes"]), 60)
        keys = {n["key"] for n in body["nodes"]}
        for link in body["links"]:
            self.assertIn(link["source"], keys)
            self.assertIn(link["target"], keys)

    def test_why(self):
        body = self.get(f"/api/people/me/why?of={self.joyal.id}")
        kinds = [r["kind"] for r in body["reasons"]]
        self.assertEqual(kinds[0], "together")
        self.assertIn("shared_venue", kinds)
        self.assertIn("topic", kinds)
        self.assertIn("complement", kinds)  # EEE vs ECE, same venue
        outsider = self.get("/api/people/me/why?of=A7")
        self.assertIn("shared_venue", [r["kind"] for r in outsider["reasons"]])
        self.assertIn("common_coauthors", [r["kind"] for r in outsider["reasons"]])
        self.assertEqual(self.client.get("/api/people/me/why?of=nobody").status_code, 404)

    def test_scopus_pull(self):
        claim = Claim.objects.create(owner=self.joyal, status=ClaimStatus.SUBMITTED, paper_title="x", doi="10.1/w2")
        self.client.force_login(self.joyal)
        body = self.get("/api/me/scopus-pull")
        by_doi = {p["doi"]: p for p in body["papers"]}
        self.assertTrue(by_doi["10.1/w2"]["already_claimed"])
        self.assertEqual(by_doi["10.1/w2"]["claim_id"], claim.id)
        self.assertFalse(by_doi["10.1/w5"]["already_claimed"])
        # W1 has no claim, but the paid ledger shows it paid: already filed.
        w1 = next(p for p in body["papers"] if (p["doi"] or "").lower() == "10.1/w1")
        self.assertTrue(w1["already_claimed"])
        self.assertTrue(w1["on_paid_ledger"])
        self.assertEqual(w1["paid_month"], "2023-01")
        # ...and so is the paper only the ledger knows. W2 is claimed; the rest are open.
        self.assertEqual(sum(p["on_paid_ledger"] for p in body["papers"]), 2)
        self.assertEqual(body["unclaimed"], body["count"] - 3)

    def test_publication_evidence(self):
        self.client.force_login(self.joyal)
        body = self.get("/api/me/scopus-pull")
        w2 = next(p for p in body["papers"] if p["doi"] == "10.1/w2")
        w1 = next(p for p in body["papers"] if (p["doi"] or "").lower() == "10.1/w1")
        ev = self.get(f"/api/me/publications/{w2['publication_id']}/evidence")
        self.assertTrue(ev["lists_me"])
        self.assertEqual(ev["my_position"], w2["author_position"])
        self.assertIsNone(ev["existing_claim"])
        self.assertIsNone(ev["paid_ledger"])
        self.assertIn("affiliation_found", ev)
        # A co-author's filed claim for the same DOI shows as the existing claim.
        other = Claim.objects.create(owner=self.subha, status=ClaimStatus.SUBMITTED, paper_title="x", doi="10.1/W2")
        ev = self.get(f"/api/me/publications/{w2['publication_id']}/evidence")
        self.assertEqual(ev["existing_claim"]["id"], other.id)
        self.assertFalse(ev["existing_claim"]["is_mine"])
        self.assertEqual(self.get(f"/api/me/publications/{w1['publication_id']}/evidence")["paid_ledger"]["paid_month"],
                         "2023-01")
        # Not my paper: 404.
        self.client.force_login(self.kumar2)
        self.assertEqual(self.client.get(f"/api/me/publications/{w2['publication_id']}/evidence").status_code, 404)

    DESK_WORDS = ("CLEARED", "PRINCIPAL_APPROVED", "DIRECTOR_APPROVED", "SUBMITTED", "HOD_APPROVED",
                  "RESEARCH_APPROVED", "FINANCE_APPROVED")

    def test_faculty_are_told_the_stage_never_the_desk_status(self):
        """Pull list and evidence card carry the stage words; no desk status leaks."""
        for status, stage in ((ClaimStatus.CLEARED, "Under review"),
                              (ClaimStatus.PRINCIPAL_APPROVED, "Under review"),
                              (ClaimStatus.DIRECTOR_APPROVED, "Approved for payment")):
            Claim.objects.all().delete()
            Claim.objects.create(owner=self.joyal, status=status, paper_title="x", doi="10.1/w2")
            self.client.force_login(self.joyal)
            raw = self.client.get("/api/me/scopus-pull")
            self.assertEqual(raw.status_code, 200, raw.content)
            for word in self.DESK_WORDS:
                self.assertNotIn(f'"{word}"', raw.content.decode())
            by_doi = {p["doi"]: p for p in raw.json()["papers"]}
            self.assertEqual(by_doi["10.1/w2"]["claim_status"], stage)
            # Paid through the ledger only: the stage, not PAID.
            w1 = next(p for p in raw.json()["papers"] if (p["doi"] or "").lower() == "10.1/w1")
            self.assertEqual(w1["claim_status"], "Paid")
            ev = self.client.get(f"/api/me/publications/{by_doi['10.1/w2']['publication_id']}/evidence")
            for word in self.DESK_WORDS:
                self.assertNotIn(f'"{word}"', ev.content.decode())
            self.assertEqual(ev.json()["existing_claim"]["status"], stage)

    def test_evidence_does_not_name_a_colleague_who_filed(self):
        self.client.force_login(self.joyal)
        pub_id = next(p for p in self.get("/api/me/scopus-pull")["papers"] if p["doi"] == "10.1/w2")["publication_id"]
        Claim.objects.create(owner=self.subha, status=ClaimStatus.CLEARED, paper_title="x", doi="10.1/w2")
        ev = self.client.get(f"/api/me/publications/{pub_id}/evidence")
        existing = ev.json()["existing_claim"]
        self.assertFalse(existing["is_mine"])
        self.assertIsNone(existing["owner"])
        self.assertNotIn(self.subha.name, ev.content.decode())
        # On my own claim my own name is fine.
        Claim.objects.all().delete()
        Claim.objects.create(owner=self.joyal, status=ClaimStatus.SUBMITTED, paper_title="x", doi="10.1/w2")
        mine = self.client.get(f"/api/me/publications/{pub_id}/evidence").json()["existing_claim"]
        self.assertEqual(mine["owner"], self.joyal.name)

    def test_my_publications_merge_claims(self):
        claim = Claim.objects.create(owner=self.joyal, status=ClaimStatus.SUBMITTED, paper_title="x", doi="10.1/w2")
        self.client.force_login(self.joyal)
        body = self.get("/api/me/publications", own_money=True)
        # The ledger paid Joyal for W1: filed and paid, his own amount shown.
        w1 = next(p for p in body["publications"] if (p["doi"] or "").lower() == "10.1/w1")
        self.assertEqual((w1["claim"]["stage"], w1["claim"]["amount"]), ("Paid", 5000))
        by_doi = {p["doi"]: p for p in body["publications"]}
        self.assertEqual(by_doi["10.1/w2"]["claim"]["id"], claim.id)
        self.assertEqual(by_doi["10.1/w2"]["claim"]["stage"], "Under review")
        self.assertIsNone(by_doi["10.1/w5"]["claim"])
        self.assertTrue(by_doi["10.1/w5"]["eligible"])
        # W2 (my claim), W1 and the ledger-only paper (paid through the ledger) are filed.
        self.assertEqual(body["unclaimed"], body["count"] - 3)
        self.assertEqual(self.client.get("/api/me/scopus-pull").json()["unclaimed"], body["unclaimed"])
        # Home's unclaimed reads the same rule.
        self.assertEqual(self.client.get("/api/me/summary").json()["unclaimed"], body["unclaimed"])
        # Own money appears once paid, and only on my own claim.
        Claim.objects.filter(id=claim.id).update(status=ClaimStatus.PAID, remuneration=5000)
        paid = {p["doi"]: p for p in self.client.get("/api/me/publications").json()["publications"]}["10.1/w2"]
        self.assertEqual(paid["claim"]["amount"], 5000)

    def test_dispute_only_own_paper(self):
        self.client.force_login(self.joyal)
        pid = self.get("/api/me/publications", own_money=True)["publications"][0]["id"]
        url = f"/api/me/publications/{pid}/dispute"
        r = self.client.post(url, data=json.dumps({"reason": "not_mine"}), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        bad = self.client.post(url, data=json.dumps({"reason": "x"}), content_type="application/json")
        self.assertEqual(bad.status_code, 400)
        other = Publication.objects.exclude(authorships__user=self.joyal).first()
        if other:
            r = self.client.post(f"/api/me/publications/{other.id}/dispute", data=json.dumps({"reason": "not_mine"}),
                                 content_type="application/json")
            self.assertEqual(r.status_code, 404)

    def test_admin_harvest_is_super_admin_only(self):
        r = self.client.post("/api/admin/publications/harvest", data="{}", content_type="application/json")
        self.assertEqual(r.status_code, 403)
        self.client.force_login(self.admin)
        with patch("django_q.tasks.async_task", return_value="job-1") as queued:
            r = self.client.post("/api/admin/publications/harvest", data=json.dumps({"since": 2024}),
                                 content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["job_id"], "job-1")
        self.assertEqual(queued.call_args[0][:2], ("core.tasks.harvest_publications", 2024))
        status = self.client.get("/api/admin/publications/status").json()
        self.assertIn("P. Kumar", status["unmatched_college_names"])
