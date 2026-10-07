"""The journal safety check: GET /api/journals/check and load_journal_flags."""

from __future__ import annotations

import json
import tempfile
from io import StringIO
from pathlib import Path

from django.core.cache import cache
from django.core.management import call_command
from django.test import Client, TestCase

from core.models import (
    Authorship,
    Claim,
    ClaimStatus,
    FormulaConfig,
    JournalFlagList,
    JournalWatch,
    Publication,
    Role,
    ScimagoJournal,
    SnipSource,
    User,
)
from core.services import journal_check
from core.test_search import money_keys_in


def _j(title, issn, year, quartile="Q1", sjr=1.5):
    return ScimagoJournal.objects.create(
        title=title, issn=issn, year=year, sjr=sjr,
        categories_json=json.dumps([{"category": "Renewable Energy", "quartile": quartile}]),
    )


class JournalCheckTests(TestCase):
    def setUp(self):
        cache.clear()
        mk = lambda e, n, role=Role.FACULTY: User.objects.create_user(  # noqa: E731
            email=e, password=None, name=n, role=role, staff_id=e[:4], department="EEE")
        self.me = mk("me@x.edu", "Dr Me")
        self.col = mk("col@x.edu", "Dr Colleague")
        self.head = mk("head@x.edu", "Dr Head", Role.HOD)
        _j("Solar Energy Materials", "11112222", 2025)
        _j("Solar Energy Materials", "11112222", 2024)
        _j("Lapsed Photonics Letters", "33334444", 2022, "Q2")
        _j("Watched Energy Letters", "55556666", 2025, "Q2")
        SnipSource.objects.create(title="Solar Energy Materials", print_issn="11112222", snip=1.6, year=2025)
        JournalWatch.objects.create(issn="5555-6666", title="Watched Energy Letters", reason="Cloned title")
        p = Publication.objects.create(title="A paper", venue="Solar Energy Materials", issn="1111-2222",
                                       year=2024, type="article")
        for pos, u in enumerate([self.me, self.col], 1):
            Authorship.objects.create(publication=p, user=u, position=pos, display_name=u.name,
                                      author_key=f"u:{u.id}", is_college=True)
        Claim.objects.create(owner=self.col, paper_title="A paper", normalized_title="a paper",
                             journal_title="Solar Energy Materials", issn="1111-2222", publication_year=2024,
                             quartile="Q1", status=ClaimStatus.PAID, remuneration=50000.0)
        self.client = Client()
        self.client.force_login(self.me)

    def get(self, q, client=None, **extra):
        return (client or self.client).get("/api/journals/check", {"q": q, **extra})

    def status(self, body, key):
        return next(c for c in body["checks"] if c["key"] == key)["status"]

    def test_issn_resolves(self):
        body = self.get("1111-2222").json()
        self.assertEqual(body["kind"], "issn")
        self.assertEqual(body["journal"]["name"], "Solar Energy Materials")
        self.assertEqual(body["journal"]["latest_year_in_data"], 2025)
        self.assertEqual(body["journal"]["snip"], 1.6)
        self.assertEqual(self.status(body, "listed"), "ok")
        self.assertEqual(self.status(body, "covered"), "ok")

    def test_name_resolves_with_close_matches(self):
        body = self.get("solar energy materials").json()
        self.assertEqual(body["journal"]["name"], "Solar Energy Materials")
        self.assertEqual(len(body["matches"]), 1)
        self.assertEqual(body["college"]["papers"], 1)
        self.assertEqual(body["college"]["colleagues"][0]["name"], "Dr Colleague")
        self.assertEqual(body["college"]["claims"]["paid"], 1)
        self.assertEqual(len(body["college"]["mine"]), 1)
        two = self.get("energy letters").json()
        self.assertGreaterEqual(len(two["matches"]), 1)

    def test_not_in_list_warns(self):
        body = self.get("Journal Of Nowhere Things").json()
        self.assertIsNone(body["journal"])
        self.assertEqual(self.status(body, "listed"), "warn")
        self.assertIn("check Scopus before you submit", body["checks"][0]["detail"])
        self.assertEqual(body["verdict"]["level"], "caution")
        self.assertIn("needs", body["estimate"])

    def test_lapsed_coverage_warns(self):
        body = self.get("3333-4444").json()
        c = next(c for c in body["checks"] if c["key"] == "covered")
        self.assertEqual(c["status"], "warn")
        self.assertIn("stopped listing it after 2022", c["detail"])

    def test_a_q3_journal_is_sound_and_only_pays_less(self):
        _j("Quiet Q3 Journal", "77778888", 2025, "Q3")
        body = self.get("7777-8888").json()
        q = next(c for c in body["checks"] if c["key"] == "quartile")
        self.assertEqual(q["status"], "ok")
        self.assertIn("pay less", q["detail"])
        self.assertEqual(body["verdict"]["level"], "safe")
        self.assertIn("Q3", body["verdict"]["text"])

    def test_watch_list_is_bad(self):
        body = self.get("5555-6666").json()
        self.assertEqual(self.status(body, "watch"), "bad")
        self.assertEqual(body["verdict"]["level"], "avoid")

    def test_no_list_loaded_is_unknown(self):
        body = self.get("1111-2222").json()
        self.assertEqual(self.status(body, "discontinued"), "unknown")
        self.assertEqual(self.status(body, "hijacked"), "unknown")
        d = next(c for c in body["checks"] if c["key"] == "discontinued")
        self.assertIn("has not been loaded yet", d["detail"])

    def test_discontinued_list_is_bad_and_says_when(self):
        journal_check.load_flags("Title,ISSN\nSolar Energy Materials,1111-2222\n", "SCOPUS_DISCONTINUED")
        body = self.get("1111-2222").json()
        d = next(c for c in body["checks"] if c["key"] == "discontinued")
        self.assertEqual(d["status"], "bad")
        self.assertIn("loaded", d["detail"])

    def test_hijacked_domain_is_bad(self):
        journal_check.load_flags("Journal,URL\nSolar Energy Materials,https://www.solar-energy-mat.com/submit\n",
                                 "HIJACKED")
        body = self.get("http://solar-energy-mat.com/paper").json()
        self.assertEqual(body["kind"], "url")
        self.assertEqual(self.status(body, "domain"), "bad")
        self.assertEqual(body["verdict"]["level"], "avoid")
        other = self.get("https://example.org").json()
        self.assertEqual(self.status(other, "domain"), "unknown")

    def test_estimate_for_three_positions(self):
        FormulaConfig.objects.create(active=True) if not FormulaConfig.objects.exists() else None
        body = self.get("1111-2222").json()
        est = body["estimate"]
        self.assertEqual([p["position"] for p in est["positions"]], [1, 2, 3])

    def test_hod_gets_no_money(self):
        c = Client()
        c.force_login(self.head)
        body = self.get("1111-2222", client=c).json()
        self.assertEqual(money_keys_in(body), [])
        self.assertTrue(body["estimate_hidden"])
        self.assertNotIn("paid", body["college"]["claims"])

    def test_needs_sign_in(self):
        self.assertEqual(Client().get("/api/journals/check", {"q": "x"}).status_code, 401)

    def test_load_command_parses_csv(self):
        csv_text = ("﻿Journal Name,E-ISSN,Website,Remarks\n"
                    "Fake Journal Of Things,1234-5679,http://www.fakejot.com/,clone\n"
                    ",,,\n"
                    "Only A Title,,,\n")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "h.csv"
            path.write_text(csv_text, encoding="utf-8")
            out = StringIO()
            call_command("load_journal_flags", str(path), "--source", "HIJACKED", stdout=out)
        self.assertIn("Loaded 2", out.getvalue())
        f = JournalFlagList.objects.get(title="Fake Journal Of Things")
        self.assertEqual((f.issn, f.domain, f.note), ("1234-5679", "fakejot.com", "clone"))

    def test_upload_is_super_admin_only(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        f = SimpleUploadedFile("x.csv", b"title\nA\n", content_type="text/csv")
        r = self.client.post("/api/journals/flag-lists/upload?source=HIJACKED", {"file": f})
        self.assertEqual(r.status_code, 403)
