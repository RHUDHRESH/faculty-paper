"""The three eligibility conditions: required to file, and recorded as the legal acceptance."""
from __future__ import annotations

import json

from django.test import TestCase

from core.models import AuditLog, Claim, ClaimConfirmation, ClaimStatus
from core.services.filing_conditions import CONDITION_IDS, CONDITIONS_VERSION
from core.tests import CONFIRMED, ClaimSubmissionRuleTests


class FilingConditionsTests(TestCase):
    # The fixtures and payload builders, borrowed, so the parent's tests do not run twice.
    setUp = ClaimSubmissionRuleTests.setUp
    _login = ClaimSubmissionRuleTests._login
    _complete_payload = ClaimSubmissionRuleTests._complete_payload
    _submittable_payload = ClaimSubmissionRuleTests._submittable_payload

    def _file(self, **overrides):
        self._login(self.faculty)
        return self.client.post(
            "/api/claims",
            data=json.dumps(self._submittable_payload(**overrides)),
            content_type="application/json",
            HTTP_USER_AGENT="pytest-agent/1.0",
            REMOTE_ADDR="10.1.2.3",
        )

    def test_filing_without_confirmations_is_refused(self):
        r = self._file(confirmations=None)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("three eligibility conditions", r.json()["detail"])
        self.assertFalse(Claim.objects.exists())
        self.assertFalse(ClaimConfirmation.objects.exists())

    def test_two_of_three_is_refused(self):
        r = self._file(confirmations=CONFIRMED[:2])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("documents", r.json()["detail"])

    def test_old_text_version_is_refused(self):
        stale = [{**c, "text_version": "2020-01"} for c in CONFIRMED]
        r = self._file(confirmations=stale)
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_draft_needs_no_confirmations(self):
        r = self._file(confirmations=None, submit=False)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], ClaimStatus.DRAFT)
        self.assertFalse(ClaimConfirmation.objects.exists())

    def test_acceptance_is_recorded_with_who_what_when_where(self):
        r = self._file()
        self.assertEqual(r.status_code, 200, r.content)
        claim = Claim.objects.get(pk=r.json()["id"])
        rows = list(ClaimConfirmation.objects.filter(claim=claim).order_by("condition_id"))
        self.assertEqual(sorted(r.condition_id for r in rows), sorted(CONDITION_IDS))
        for row in rows:
            self.assertEqual(row.user_id, self.faculty.id)
            self.assertEqual(row.text_version, CONDITIONS_VERSION)
            self.assertTrue(row.text)
            self.assertEqual(row.ip_address, "10.1.2.3")
            self.assertEqual(row.user_agent, "pytest-agent/1.0")
            self.assertEqual(row.paper_title, claim.paper_title)
            self.assertIsNotNone(row.ticked_at)
        log = AuditLog.objects.get(action="CLAIM_CONDITIONS_ACCEPTED", entity_id=claim.id)
        self.assertEqual(log.actor_id, self.faculty.id)
        detail = json.loads(log.detail_json)
        self.assertEqual(len(detail["conditions"]), 3)
        self.assertEqual(detail["ip"], "10.1.2.3")

        # Shown back on claim detail.
        got = self.client.get(f"/api/claims/{claim.id}").json()
        self.assertEqual(len(got["confirmations"]), 3)
        self.assertEqual({c["user_name"] for c in got["confirmations"]}, {self.faculty.name})

    def test_filing_a_draft_later_needs_them_too(self):
        self._login(self.faculty)
        r = self._file(submit=False, confirmations=None)
        cid = r.json()["id"]
        body = self._submittable_payload(confirmations=None)
        r2 = self.client.patch(f"/api/claims/{cid}", data=json.dumps(body), content_type="application/json")
        self.assertEqual(r2.status_code, 400, r2.content)
        self.assertEqual(Claim.objects.get(pk=cid).status, ClaimStatus.DRAFT)
        body["confirmations"] = CONFIRMED
        r3 = self.client.patch(f"/api/claims/{cid}", data=json.dumps(body), content_type="application/json")
        self.assertEqual(r3.status_code, 200, r3.content)
        self.assertEqual(ClaimConfirmation.objects.filter(claim_id=cid).count(), 3)

    def test_filing_rules_carry_the_version_and_texts(self):
        self._login(self.faculty)
        body = self.client.get("/api/meta/filing-rules").json()
        self.assertEqual(body["conditions_version"], CONDITIONS_VERSION)
        self.assertEqual([c["id"] for c in body["conditions"]], list(CONDITION_IDS))
