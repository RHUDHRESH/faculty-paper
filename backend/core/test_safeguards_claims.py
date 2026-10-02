"""The same paper claimed twice, and what the claimant and the research cell are told.

One class per risk in docs/ops/safeguards.md. Two answers come out and are
kept apart: the claimant is told in plain words, at the moment they pick the
paper, with no desk and no colleague named; the research cell is told through
an automatic DUPLICATE flag the claimant never sees.
"""
from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.db import IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from core.models import Claim, ClaimFlag, ClaimStatus, PriorPayment, Role, User
from core.services import claim_standing
from core.test_chain_rules import ChainBase

DOI = "10.1000/safeguard.claims.1"
TITLE = "A Sufficiently Long Title About Adaptive Control Of Chillers"
DESK_WORDS = ("research cell", "research supervisor", "coordinator", "principal", "director", "finance", "clearing desk")


def draft_payload(**extra):
    body = {
        "paper_title": TITLE, "doi": DOI, "journal_title": "Journal of Safeguards", "issn": "1234-5679",
        "publication_date": "2026-03-01", "indexing_level": "Scopus", "yukthi_id": "YK1",
        "scopus_author_url": "https://scopus.com/authid/detail.uri?authorId=1", "total_authors": 2,
        "author_position": 1, "affiliation_ok": True,
    }
    body.update(extra)
    return body


class ClaimsBase(ChainBase):
    def file(self, owner=None, ticket="SGC-1", status=ClaimStatus.SUBMITTED, **extra):
        extra.setdefault("doi", DOI)
        extra.setdefault("paper_title", TITLE)
        extra.setdefault("normalized_title", claim_standing.normalize_title(extra["paper_title"]))
        return self._claim(status, ticket=ticket, owner=owner or self.faculty, **extra)

    def create(self, who, **extra):
        return self._post(who, "/api/claims", draft_payload(**extra))

    def other_author(self, n=1):
        return User.objects.create_user(email=f"co{n}@t.edu", password=None, name=f"Co Author {n}",
                                        role=Role.FACULTY, department="CSE", staff_id=f"STF-CO{n}")


class SamePersonSamePaper(ClaimsBase):
    """Risk: one person claims one paper twice (same DOI, or same title with no DOI)."""

    def test_a_second_claim_for_a_paper_in_the_chain_is_refused_in_plain_words(self):
        self.file()
        r = self.create(self.faculty)
        self.assertEqual(r.status_code, 409, r.content)
        message = r.json()["detail"]
        self.assertIn("already claimed this paper", message)
        self.assertIn("SGC-1", message)
        self.assertIn("under review", message.lower())
        for word in DESK_WORDS:
            self.assertNotIn(word, message.lower())
        self.assertEqual(Claim.objects.filter(owner=self.faculty).count(), 1)

    def test_a_draft_is_told_not_refused_and_only_a_filed_claim_holds_the_paper(self):
        """A submit that fails its checks leaves a draft; trying again must work."""
        self.assertEqual(self.create(self.faculty).status_code, 200)
        self.assertEqual(self.create(self.faculty).status_code, 200)
        got = claim_standing.own_standing(self.faculty, doi=DOI)
        self.assertEqual((got["code"], got["blocks"]), ("draft", False))
        self.assertIn("already one of your drafts", got["message"])

    def test_the_doi_may_be_pasted_in_any_form(self):
        self.file()
        r = self.create(self.faculty, doi=f"https://doi.org/{DOI.upper()}")
        self.assertEqual(r.status_code, 409, r.content)

    def test_the_same_long_title_with_no_doi_is_the_same_paper(self):
        self.file(doi=None)
        r = self.create(self.faculty, doi=None)
        self.assertEqual(r.status_code, 409, r.content)

    def test_a_short_generic_title_is_not_evidence(self):
        self.file(doi=None, paper_title="Introduction")
        r = self.create(self.faculty, doi=None, paper_title="Introduction")
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_same_title_with_two_different_dois_is_two_papers_the_cell_is_told(self):
        """A conference paper and its journal extension share a title."""
        self.file(doi="10.1000/conference.version")
        r = self.create(self.faculty, doi="10.1000/journal.version")
        self.assertEqual(r.status_code, 200, r.content)
        draft = Claim.objects.get(pk=r.json()["id"])
        notes = claim_standing.routing_notes(draft)
        # Drafts are not yet filed, so ask as the claim stands once filed.
        Claim.objects.filter(pk=draft.pk).update(status=ClaimStatus.SUBMITTED, ticket_number="SGC-2")
        draft.refresh_from_db()
        self.assertEqual([n["auto_key"].split(":")[0] for n in claim_standing.routing_notes(draft)], ["similar-title"])
        self.assertEqual(notes, claim_standing.routing_notes(draft))

    def test_editing_a_draft_never_collides_with_itself(self):
        made = self.create(self.faculty)
        self.assertEqual(made.status_code, 200)
        r = self._as(self.faculty).patch(
            f"/api/claims/{made.json()['id']}", data=json.dumps(draft_payload(journal_title="Renamed")),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_database_holds_when_two_requests_race_past_the_check(self):
        self.file()
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.file(ticket="SGC-RACE")

    def test_the_database_rule_is_case_blind_and_leaves_drafts_sent_back_and_history_alone(self):
        self.file(doi=DOI.upper())
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.file(ticket="SGC-LOWER", doi=DOI.lower())
        self.file(ticket="SGC-DRAFT", status=ClaimStatus.DRAFT)
        self.file(ticket="SGC-BACK", status=ClaimStatus.REJECTED)
        self.file(ticket="ERP-RAW-7")  # imported history: the workbook did pay some papers twice

    def test_a_filing_that_loses_the_race_is_told_so_not_given_a_500(self):
        from core.api import journals

        first = self.file()
        loser = self.file(ticket="SGC-L", status=ClaimStatus.DRAFT)
        with self.assertRaises(IntegrityError):
            journals._file_claim(loser)
        # And the endpoint's wrapper turns it into the sentence.
        with patch.object(journals, "_file_claim", side_effect=IntegrityError), \
                patch.object(journals, "_check_mandatory_fields"), \
                patch.object(journals, "_verification_issues", return_value=[]), \
                patch.object(journals, "apply_verify_to_claim"):
            with self.assertRaises(HttpError) as ctx:
                journals._submit_claim(loser, self.faculty, contest=False, contest_note=None)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("claimed this paper already", ctx.exception.message)
        self.assertEqual(first.status, ClaimStatus.SUBMITTED)


class AlreadyPaidOrRefused(ClaimsBase):
    """Risk: re-filing a paper already paid, sent back, or not accepted."""

    def test_a_paper_you_were_paid_for_cannot_be_filed_again(self):
        self.file(status=ClaimStatus.PAID, payout_month=date(2026, 5, 1))
        r = self.create(self.faculty)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("You were paid for this paper in May 2026", r.json()["detail"])

    def test_a_paper_paid_in_the_old_workbook_cannot_be_filed_again(self):
        PriorPayment.objects.create(
            faculty_name="Asha Faculty", employee_id="STF-CH1", paper_title=TITLE,
            normalized_title=claim_standing.normalize_title(TITLE), doi=DOI.lower(), amount_paid=4000,
            paid_at=timezone.now(), claim_ref="ERP-OLD-9",
        )
        r = self.create(self.faculty)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("payment record shows this paper was paid to you", r.json()["detail"])

    def test_a_colleagues_old_payment_does_not_stop_you(self):
        PriorPayment.objects.create(
            faculty_name="Someone Else", employee_id="STF-OTHER", paper_title=TITLE,
            normalized_title=claim_standing.normalize_title(TITLE), doi=DOI.lower(), amount_paid=4000,
        )
        self.assertEqual(self.create(self.faculty).status_code, 200)

    def test_a_rejected_or_not_accepted_claim_never_blocks_filing_again(self):
        """The owner's rule: a refusal is not a hold on the paper."""
        for outright in (False, True):
            Claim.objects.all().delete()
            self.file(status=ClaimStatus.REJECTED, rejected_outright=outright)
            self.assertIsNone(claim_standing.own_standing(self.faculty, doi=DOI, title=TITLE))
            self.assertEqual(self.create(self.faculty).status_code, 200)


class WhatTheFilingFormSays(ClaimsBase):
    """The form tells the claimant at the moment they pick the paper."""

    def lookup_standing(self, **kw):
        return claim_standing.own_standing(self.faculty, **kw)

    def test_each_state_has_its_own_plain_sentence_and_names_no_desk(self):
        cases = {
            ClaimStatus.SUBMITTED: "filed",
            ClaimStatus.CLEARED: "filed",
            ClaimStatus.PRINCIPAL_APPROVED: "filed",
            ClaimStatus.DIRECTOR_APPROVED: "filed",
            ClaimStatus.PAID: "paid",
            ClaimStatus.DRAFT: "draft",
        }
        for i, (status, code) in enumerate(cases.items()):
            Claim.objects.all().delete()
            self.file(ticket=f"SGC-S{i}", status=status, payout_month=date(2026, 5, 1))
            got = self.lookup_standing(doi=DOI)
            self.assertEqual(got["code"], code, status)
            for word in DESK_WORDS:
                self.assertNotIn(word, got["message"].lower(), status)

    def test_the_lookup_endpoint_carries_the_sentence(self):
        from core.services import paper_lookup

        self.file(ticket="SGC-LK")
        out = paper_lookup._already_filed(self.faculty, DOI, None, title=TITLE)
        self.assertEqual(out["code"], "filed")
        self.assertEqual(out["ticket_number"], "SGC-LK")
        self.assertTrue(out["blocks"])
        self.assertIn("already claimed this paper", out["message"])
        self.assertIsNone(paper_lookup._already_filed(self.faculty, "10.1000/free", None, title="Another Unrelated Paper Title"))

    def test_a_rejected_claim_is_not_reported_at_all(self):
        self.file(ticket="SGC-RJ", status=ClaimStatus.REJECTED)
        self.assertIsNone(self.lookup_standing(doi=DOI))

    def test_the_draft_being_edited_is_not_reported_against_itself(self):
        draft = self.file(ticket="SGC-ED", status=ClaimStatus.DRAFT)
        self.assertIsNone(claim_standing.own_standing(self.faculty, doi=DOI, exclude_claim_id=draft.pk))

    def test_a_colleagues_claim_is_never_mentioned_to_you(self):
        self.file(owner=self.other_author(), ticket="SGC-CO0")
        self.assertIsNone(self.lookup_standing(doi=DOI, title=TITLE))
        self.assertEqual(self.create(self.faculty).status_code, 200)


class CoAuthorsAtTheCollege(ClaimsBase):
    """Risk: co-authors both claim one paper. The scheme pays each by author
    position, so a second claim is allowed; two people at one position is not
    allowed to go unnoticed."""

    def test_a_co_authors_claim_is_allowed_and_told_to_the_cell_not_the_claimant(self):
        other = self.other_author()
        self.file(owner=other, ticket="SGC-CO1", author_position=2, total_authors=2)
        mine = self.file(ticket="SGC-ME", author_position=1, total_authors=2)
        notes = claim_standing.routing_notes(mine)
        self.assertEqual(len(notes), 1)
        self.assertFalse(notes[0]["same_slot"])
        self.assertIn("Co Author 1", notes[0]["note"])
        self.assertIn("allowed", notes[0]["note"])

    def test_two_people_at_the_same_author_position_is_the_stronger_note(self):
        other = self.other_author()
        self.file(owner=other, ticket="SGC-CO2", author_position=1, total_authors=3)
        mine = self.file(ticket="SGC-ME2", author_position=1, total_authors=3)
        notes = claim_standing.routing_notes(mine)
        self.assertTrue(notes[0]["same_slot"])
        self.assertIn("Two people cannot both be that author", notes[0]["note"])

    def test_filing_raises_one_flag_for_the_cell_and_the_claimant_never_sees_it(self):
        from core.api import journals

        other = self.other_author()
        self.file(owner=other, ticket="SGC-CO3", author_position=1, total_authors=2)
        mine = self.file(ticket="SGC-ME3", author_position=1, total_authors=2)
        journals._raise_routing_flags(mine)
        journals._raise_routing_flags(mine)  # running it twice raises nothing twice
        flags = ClaimFlag.objects.filter(claim=mine, kind="DUPLICATE", source="AUTO")
        self.assertEqual(flags.count(), 1)
        for who, code in ((self.cell, 200), (self.coordinator, 200), (self.principal, 200), (self.admin, 200)):
            body = self._as(who).get(f"/api/claims/{mine.id}")
            self.assertEqual(body.status_code, code, who.role)
        mine_view = self._as(self.faculty).get(f"/api/claims/{mine.id}").json()
        self.assertNotIn("Co Author", json.dumps(mine_view))
        for who in (self.director, self.finance):
            self.assertNotIn("Co Author", self._as(who).get(f"/api/claims/{mine.id}").content.decode())

    def test_a_rejected_or_draft_co_author_claim_is_not_a_doubt(self):
        other = self.other_author()
        self.file(owner=other, ticket="SGC-CO4", status=ClaimStatus.REJECTED)
        self.file(owner=other, ticket="SGC-CO5", status=ClaimStatus.DRAFT, doi=DOI + "x", paper_title="Other Paper Entirely Different")
        mine = self.file(ticket="SGC-ME4")
        self.assertEqual(claim_standing.routing_notes(mine), [])
