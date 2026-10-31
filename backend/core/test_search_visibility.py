"""`/api/search` shows a person the claims the claims list shows them, and no more.

The search box used to read every claim in the college for every signed-in
role: a faculty member searching a word got a colleague's claimant, department,
status, rupee amount and unfiled draft title back. These tests pin the rule the
claims list already follows (`_claims_queryset`) onto the search:

- a faculty member sees their own claims only;
- the Principal, Director, Finance, the research cell and coordinator and the
  super admin see every claim that has been filed, plus their own drafts, and
  nobody's draft but their own;
- a head of department sees their own department's filed claims plus their own
  drafts, never an amount, and never "PAID".

The people results still find a colleague by what they have published, but an
unfiled draft is nobody's publication, so it neither finds a person nor counts.
"""
from __future__ import annotations

import json

from core.models import ClaimStatus, Role, User
from core.services.search import people
from core.test_chain_rules import ChainBase

WORD = "Zirconia"


class SearchClaimVisibility(ChainBase):
    def setUp(self):
        super().setUp()

        def colleague(email, name, department):
            return User.objects.create_user(
                email=email, password=None, name=name, role=Role.FACULTY, department=department
            )

        self.cse_colleague = colleague("pat@test.edu", "Pat Colleague", "CSE")
        self.ece_colleague = colleague("eve@test.edu", "Eve Electronics", "ECE")
        self.draft_only = colleague("dora@test.edu", "Dora Draftonly", "ECE")

        self.own = self._claim(
            ClaimStatus.SUBMITTED, "VIS-1", paper_title=f"{WORD} in my own filing"
        )
        self.paid = self._claim(
            ClaimStatus.PAID, "VIS-2", owner=self.cse_colleague,
            paper_title=f"{WORD} coatings, paid to a colleague",
        )
        self.colleague_draft = self._claim(
            ClaimStatus.DRAFT, "VIS-3", owner=self.cse_colleague, ticket_number=None,
            paper_title=f"{WORD} colleague unfiled draft",
        )
        self.other_department = self._claim(
            ClaimStatus.SUBMITTED, "VIS-4", owner=self.ece_colleague,
            paper_title=f"{WORD} filed in another department",
        )
        self.only_a_draft = self._claim(
            ClaimStatus.DRAFT, "VIS-5", owner=self.draft_only, ticket_number=None,
            paper_title=f"{WORD} the only thing Dora has started",
        )
        self.principal_draft = self._claim(
            ClaimStatus.DRAFT, "VIS-6", owner=self.principal, ticket_number=None,
            paper_title=f"{WORD} the principal's own draft",
        )
        self.head_draft = self._claim(
            ClaimStatus.DRAFT, "VIS-7", owner=self.hod, ticket_number=None,
            paper_title=f"{WORD} the head's own draft",
        )

    # ---- helpers ----------------------------------------------------------

    def _search(self, user, kinds="people"):
        r = self._as(user).get("/api/search", {"q": WORD, "kinds": kinds, "limit": 50})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _ticket_ids(self, user):
        return {t["id"] for t in self._search(user)["tickets"]}

    def _claims_list_ids(self, user):
        r = self._as(user).get("/api/claims", {"q": WORD, "limit": 200})
        self.assertEqual(r.status_code, 200, r.content)
        return {c["id"] for c in r.json()["results"]}

    def _department_list_ids(self, user):
        r = self._as(user).get("/api/hod/publications", {"q": WORD, "limit": 200})
        self.assertEqual(r.status_code, 200, r.content)
        return {c["id"] for c in r.json()["results"]}

    # ---- a faculty member -------------------------------------------------

    def test_faculty_sees_only_their_own_claim(self):
        body = self._search(self.faculty)
        self.assertEqual({t["id"] for t in body["tickets"]}, {self.own.id})

    def test_faculty_is_not_told_a_colleagues_paid_claim_or_draft_exists(self):
        text = json.dumps(self._search(self.faculty))
        for hidden in (self.paid, self.colleague_draft, self.other_department):
            self.assertNotIn(hidden.paper_title, text)
            self.assertNotIn(hidden.id, text)

    def test_the_claims_list_agrees_for_a_faculty_member(self):
        self.assertEqual(self._ticket_ids(self.faculty), self._claims_list_ids(self.faculty))

    # ---- everyone above them ---------------------------------------------

    def test_the_desks_get_exactly_what_the_claims_list_gives_them(self):
        filed = {self.own.id, self.paid.id, self.other_department.id}
        expected = {
            "principal": (self.principal, filed | {self.principal_draft.id}),
            "director": (self.director, filed),
            "finance": (self.finance, filed),
            "research cell": (self.cell, filed),
            "research coordinator": (self.coordinator, filed),
            "super admin": (self.admin, filed),
        }
        for label, (user, ids) in expected.items():
            with self.subTest(role=label):
                self.assertEqual(self._claims_list_ids(user), ids, "the list itself")
                self.assertEqual(self._ticket_ids(user), ids, "the search")

    def test_nobody_but_the_owner_finds_a_draft(self):
        drafts = {
            self.colleague_draft.id, self.only_a_draft.id,
            self.principal_draft.id, self.head_draft.id,
        }
        for user in (self.director, self.finance, self.cell, self.coordinator, self.admin):
            with self.subTest(role=user.role):
                self.assertFalse(self._ticket_ids(user) & drafts)
        self.assertEqual(self._ticket_ids(self.principal) & drafts, {self.principal_draft.id})

    def test_the_desks_still_see_the_amount_and_the_claimant(self):
        for user in (self.principal, self.director, self.finance, self.cell, self.coordinator, self.admin):
            with self.subTest(role=user.role):
                body = self._search(user)
                self.assertTrue(body["money_visible"])
                row = next(t for t in body["tickets"] if t["id"] == self.paid.id)
                self.assertIn("amount", row)
                self.assertEqual(row["claimant"]["name"], "Pat Colleague")

    # ---- a head of department --------------------------------------------

    def test_a_head_sees_their_departments_filed_claims_and_their_own_drafts(self):
        ids = self._ticket_ids(self.hod)
        self.assertEqual(ids, {self.own.id, self.paid.id, self.head_draft.id})
        # The same rule as the department screen, plus the head's own list.
        self.assertEqual(
            ids, self._department_list_ids(self.hod) | self._claims_list_ids(self.hod)
        )

    def test_a_head_is_sent_no_money_and_no_paid_status(self):
        body = self._search(self.hod)
        self.assertFalse(body["money_visible"])
        for ticket in body["tickets"]:
            self.assertNotIn("amount", ticket)
            self.assertNotEqual(ticket["status"], ClaimStatus.PAID)
        self.assertNotIn("PAID", json.dumps(body))

    # ---- people and the DOI badge ----------------------------------------

    def test_a_draft_neither_finds_a_person_nor_counts_towards_them(self):
        for user in (self.faculty, self.hod, self.director, self.admin):
            with self.subTest(role=user.role):
                found = {p["name"]: p for p in self._search(user)["people"]}
                self.assertNotIn("Dora Draftonly", found, "her only match is an unfiled draft")
        # Unchanged: a colleague is still found by what they have filed...
        found = {p["name"]: p for p in self._search(self.faculty)["people"]}
        self.assertIn("Pat Colleague", found)
        # ...and counted by what they have filed, not by what they started.
        self.assertEqual(found["Pat Colleague"]["papers"], 1)

    def test_the_doi_badge_does_not_reveal_a_colleagues_claim_to_faculty(self):
        from core.models import Claim

        Claim.objects.filter(pk=self.paid.pk).update(doi="10.1000/zirconia.paid")
        Claim.objects.filter(pk=self.colleague_draft.pk).update(doi="10.1000/zirconia.draft")
        dois = ["10.1000/zirconia.paid", "10.1000/zirconia.draft"]

        self.assertEqual(people.claims_by_doi(dois, viewer=self.faculty), {})
        seen = people.claims_by_doi(dois, viewer=self.director)
        self.assertEqual(set(seen), {"10.1000/zirconia.paid"}, "a draft has no badge for anyone")
        self.assertFalse(seen["10.1000/zirconia.paid"]["mine"])

        Claim.objects.filter(pk=self.own.pk).update(doi="10.1000/zirconia.own")
        mine = people.claims_by_doi(["10.1000/zirconia.own"], viewer=self.faculty)
        self.assertTrue(mine["10.1000/zirconia.own"]["mine"])
