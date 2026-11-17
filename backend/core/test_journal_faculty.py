"""A faculty member opens a journal and sees the journal, and their own papers in it.

Used to be a closed gate. The rule now: the journal's facts and the viewer's
own claims, and nothing that belongs to anybody else (their claims, their
names, their amounts) or to the research office (notes, watch list).
"""
from __future__ import annotations

import json
from datetime import date

from django.test import Client, TestCase

from core.models import (
    Claim,
    ClaimNote,
    ClaimStatus,
    JournalStanding,
    JournalWatch,
    Role,
    ScimagoJournal,
    SnipSource,
    User,
)

TITLE = "Journal of Synthetic Ceramics"
OTHER_AMOUNT = 73_131
MY_AMOUNT = 41_417


class FacultyJournalRecord(TestCase):
    @classmethod
    def setUpTestData(cls):
        def person(email, name, role=Role.FACULTY, dept="ECE"):
            return User.objects.create_user(
                email=email, password=None, name=name, role=role, department=dept
            )

        cls.me = person("jf-me@test.edu", "Maya Mine")
        cls.other = person("jf-other@test.edu", "Omar Colleague", dept="CSE")
        cls.cell = person("jf-cell@test.edu", "Cell Person", Role.RESEARCH_CELL)
        cls.head = person("jf-head@test.edu", "Hema Head", Role.HOD)

        for year, sjr, cats in (
            (2024, 0.81, [{"category": "Ceramics and Composites", "quartile": "Q2"}]),
            (
                2025,
                0.96,
                [
                    {"category": "Ceramics and Composites", "quartile": "Q1"},
                    {"category": "Chemistry (miscellaneous)", "quartile": "Q3"},
                ],
            ),
        ):
            ScimagoJournal.objects.create(
                title=TITLE, issn="02728842", eissn="18733956", year=year, sjr=sjr,
                categories_json=json.dumps(cats), raw_json=json.dumps({"Publisher": "Synthetic Press"}),
            )
        for year, snip in ((2024, 1.1), (2025, 1.4)):
            SnipSource.objects.create(title=TITLE, print_issn="0272-8842", snip=snip, sjr=0.9, year=year)
        JournalStanding.objects.create(
            source=JournalStanding.Source.UGC_CARE, issn="0272-8842", title=TITLE, listed=False,
            changed_on=date(2025, 1, 1), reason="Removed in the 2025 review",
        )
        JournalStanding.objects.create(
            source=JournalStanding.Source.SCOPUS_DISCONTINUED, issn="9999-9999", title="Elsewhere",
            listed=False,
        )

        common = dict(
            journal_title=TITLE, issn="2728842", publication_year=2025, quartile="Q1", snip=1.4,
            indexing_level="Scopus", engineering_class="Engineering", subject_category="Ceramics",
        )
        cls.mine = Claim.objects.create(
            owner=cls.me, paper_title="My own ceramic paper", status=ClaimStatus.PAID,
            remuneration=MY_AMOUNT, ticket_number="FP-2025-000111", **common,
        )
        cls.theirs = Claim.objects.create(
            owner=cls.other, paper_title="Omar secret sintering study", status=ClaimStatus.PAID,
            remuneration=OTHER_AMOUNT, ticket_number="FP-2025-000222", **common,
        )
        ClaimNote.objects.create(
            claim=cls.mine, author=cls.cell, body="Office doubts about this affiliation",
            audience=ClaimNote.Audience.ADMIN,
        )
        JournalWatch.objects.create(
            title=TITLE, issn="0272-8842", reason="Office watch-list reason text", added_by=cls.cell,
        )

    def _get(self, user, title=TITLE):
        c = Client()
        c.force_login(user)
        return c.get("/api/journals/report", {"title": title})

    def test_faculty_get_the_journal_facts(self):
        r = self._get(self.me)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["view"], "faculty")
        j = body["journal"]
        self.assertEqual(j["title"], TITLE)
        self.assertEqual(j["issn"], "0272-8842")
        self.assertEqual(j["eissn"], "1873-3956")
        self.assertEqual(j["publisher"], "Synthetic Press")
        self.assertEqual(j["engineering_class"], "Engineering")
        self.assertEqual(j["indexing"], "Scopus")
        self.assertEqual([(s["year"], s["snip"]) for s in j["snip_by_year"]], [(2025, 1.4), (2024, 1.1)])
        by_year = {s["year"]: s for s in j["sjr_by_year"]}
        self.assertEqual(by_year[2025]["sjr"], 0.96)
        self.assertEqual(by_year[2025]["best_quartile"], "Q1")
        self.assertEqual(
            by_year[2025]["categories"][0], {"category": "Ceramics and Composites", "quartile": "Q1"}
        )
        self.assertEqual(by_year[2024]["best_quartile"], "Q2")
        self.assertEqual(j["standing"]["ugc_care"]["state"], "removed")
        self.assertEqual(j["standing"]["ugc_care"]["since"], "2025-01-01")
        # A discontinued list is loaded, and this journal is not on it.
        self.assertEqual(j["standing"]["scopus_discontinued"]["state"], "not_discontinued")

    def test_faculty_get_their_own_claims_with_their_own_amount(self):
        body = self._get(self.me).json()
        self.assertEqual([c["id"] for c in body["mine"]["claims"]], [self.mine.id])
        self.assertEqual(body["mine"]["claims"][0]["remuneration"], MY_AMOUNT)

    def test_nothing_of_anybody_elses_is_in_the_payload(self):
        raw = self._get(self.me).content.decode()
        for secret in (
            "Omar", "jf-other@test.edu", "Omar secret sintering study", "FP-2025-000222",
            self.theirs.id, self.other.id, str(OTHER_AMOUNT), "CSE",
        ):
            self.assertNotIn(secret, raw, secret)

    def test_the_college_wide_blocks_are_absent(self):
        body = self._get(self.me).json()
        for key in ("totals", "authors", "claims", "by_year", "by_department", "by_status", "by_quartile"):
            self.assertNotIn(key, body, key)

    def test_the_offices_notes_and_watch_list_are_absent(self):
        raw = self._get(self.me).content.decode()
        self.assertNotIn("Office doubts", raw)
        self.assertNotIn("Office watch-list reason", raw)
        self.assertNotIn("watch", raw.lower())

    def test_a_faculty_member_with_no_claim_there_still_sees_the_facts_and_none_of_theirs(self):
        stranger = User.objects.create_user(
            email="jf-new@test.edu", password=None, name="Newcomer", role=Role.FACULTY, department="IT"
        )
        body = self._get(stranger).json()
        self.assertEqual(body["mine"]["claims"], [])
        self.assertEqual(body["journal"]["title"], TITLE)
        self.assertNotIn("73131", json.dumps(body))
        self.assertNotIn("41417", json.dumps(body))

    def test_a_journal_nobody_knows_is_a_404_and_a_blank_name_a_400(self):
        self.assertEqual(self._get(self.me, "No Such Journal At All").status_code, 404)
        self.assertEqual(self._get(self.me, "  ").status_code, 400)

    def test_the_college_view_is_unchanged_for_the_office(self):
        body = self._get(self.cell).json()
        self.assertNotIn("view", body)
        self.assertEqual(body["totals"]["publications"], 2)
        self.assertEqual(body["totals"]["paid_amount"], MY_AMOUNT + OTHER_AMOUNT)

    def test_a_head_still_gets_the_money_blind_department_view(self):
        res = self._get(self.head)
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("view", res.json())

    def test_an_unlisted_flag_state_is_unknown_not_fine(self):
        JournalStanding.objects.all().delete()
        j = self._get(self.me).json()["journal"]
        self.assertEqual(j["standing"]["ugc_care"]["state"], "unknown")
        self.assertEqual(j["standing"]["scopus_discontinued"]["state"], "unknown")
