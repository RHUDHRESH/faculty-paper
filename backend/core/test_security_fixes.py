"""Regression tests for the second security review (findings A to D).

Each asserts the fix: what a role must not be told, it is not told.
"""
from __future__ import annotations

import json

from core.models import ClaimStatus, Role, User
from core.test_chain_rules import ChainBase


# ---- A: the public-thread agent reads only what the asker may see ---------


class ThreadAgentPaperScope(ChainBase):
    def _ask(self, user, ticket):
        from core.models import Post

        r = self._post(user, "/api/threads", {
            "title": f"Where is {ticket} please", "body": f"@agent @paper:{ticket}",
        })
        self.assertEqual(r.status_code, 200, r.content)
        posts = list(Post.objects.filter(thread_id=r.json()["id"]))
        mentions = [m for p in posts for m in p.mentions.all() if m.kind == "PAPER"]
        replies = [p.body for p in posts if p.kind == "AGENT"]
        return mentions, "\n".join(replies)

    def _colleague(self):
        return User.objects.create_user(
            email="sr-col@test.edu", password=None, name="Colleen Colleague",
            role=Role.FACULTY, department="CSE", staff_id="STF-SRC",
        )

    def test_faculty_naming_a_colleagues_draft_gets_nothing(self):
        draft = self._claim(status=ClaimStatus.DRAFT, ticket="SR-D1", owner=self._colleague(),
                            paper_title="Colleague Secret Draft Title")
        mentions, said = self._ask(self.faculty, draft.ticket_number)
        self.assertEqual(mentions, [])
        self.assertNotIn("Colleague Secret Draft Title", said)
        self.assertNotIn("Nature", said)

    def test_faculty_naming_a_colleagues_filed_paper_gets_nothing(self):
        filed = self._claim(ticket="SR-F1", owner=self._colleague(), duplicate_warning=True,
                            paper_title="Colleague Filed Paper Title")
        mentions, said = self._ask(self.faculty, filed.ticket_number)
        self.assertEqual(mentions, [])
        self.assertNotIn("Colleague Filed Paper Title", said)
        self.assertNotIn("warning", said.lower())

    def test_faculty_asking_about_their_own_paper_is_answered_without_a_warning(self):
        own = self._claim(ticket="SR-O1", duplicate_warning=True)
        mentions, said = self._ask(self.faculty, own.ticket_number)
        self.assertEqual(len(mentions), 1)
        self.assertIn("Chain Rules Paper SR-O1", said)
        self.assertNotIn("warning", said.lower())

    def test_director_and_finance_never_get_the_warning(self):
        self._claim(ticket="SR-W1", duplicate_warning=True)
        for who in (self.director, self.finance):
            mentions, said = self._ask(who, "SR-W1")
            self.assertNotIn("warning", said.lower(), who.role)
            self.assertNotIn("payment-history", said.lower(), who.role)

    def test_a_desk_that_judges_papers_gets_the_warning(self):
        self._claim(ticket="SR-W2", duplicate_warning=True)
        for who in (self.cell, self.principal):
            mentions, said = self._ask(who, "SR-W2")
            self.assertEqual(len(mentions), 1, who.role)
            self.assertIn("payment-history warning", said, who.role)

    def test_nobody_reads_another_persons_draft_not_even_a_desk(self):
        draft = self._claim(status=ClaimStatus.DRAFT, ticket="SR-D2", owner=self._colleague(),
                            paper_title="Another Draft Title")
        for who in (self.cell, self.principal, self.finance):
            mentions, said = self._ask(who, draft.ticket_number)
            self.assertEqual(mentions, [], who.role)
            self.assertNotIn("Another Draft Title", said, who.role)

    def test_a_stored_mention_the_asker_may_not_see_is_not_answered(self):
        from core.models import Mention, Post, Thread
        from core.services import thread_agent

        other = self._claim(ticket="SR-S1", owner=self._colleague(),
                            paper_title="Stored Mention Title")
        thread = Thread.objects.create(title="Old thread", created_by=self.faculty, post_count=1)
        post = Post.objects.create(thread=thread, author=self.faculty, body="@agent @paper:SR-S1")
        Mention.objects.create(post=post, kind=Mention.Kind.AGENT, label="agent")
        Mention.objects.create(post=post, kind=Mention.Kind.PAPER, label="SR-S1", claim=other)
        said = thread_agent.answer(post, self.faculty) or ""
        self.assertNotIn("Stored Mention Title", said)


# ---- B: record history keeps flags and double-payment reviews from the
# ---- contest-blind roles ------------------------------------------------


class RecordHistoryContestBlind(ChainBase):
    def _entries(self, user, entity, entity_id):
        return self._as(user).get(f"/api/admin/history?entity={entity}&id={entity_id}")

    def _audit(self, action, entity, entity_id):
        from core.models import AuditLog

        AuditLog.objects.create(
            actor=self.cell, action=action, entity=entity, entity_id=entity_id,
            detail_json=json.dumps({"status": "CONFIRMED"}),
        )

    def test_director_and_finance_see_no_flag_check_or_watch_entries_on_a_claim(self):
        claim = self._claim(ticket="HB-1")
        for action in ("CLAIM_FLAG_RAISE", "CLAIM_FLAG_RESOLVE", "CLAIM_FILES_CHECK",
                       "JOURNAL_WATCH_ADD", "DUPLICATE_REVIEW"):
            self._audit(action, "Claim", claim.id)
        self._audit("STATUS_OVERRIDE", "Claim", claim.id)
        # The desk sees all six; the two seats after it see only the ordinary one.
        self.assertEqual(len(self._entries(self.cell, "Claim", claim.id).json()["entries"]), 6)
        for who in (self.director, self.finance):
            r = self._entries(who, "Claim", claim.id)
            self.assertEqual(r.status_code, 200, r.content)
            whats = [e["what"] for e in r.json()["entries"]]
            self.assertEqual(whats, ["changed where the claim stands"], who.role)
            body = json.dumps(r.json()).lower()
            for leak in ("flag", "double payment", "checked a claim", "watch"):
                self.assertNotIn(leak, body, who.role)

    def test_director_and_finance_are_refused_the_duplicate_finding_history(self):
        self._audit("DUPLICATE_REVIEW", "DuplicateFinding", "dup-1")
        self.assertEqual(self._entries(self.cell, "DuplicateFinding", "dup-1").status_code, 200)
        for who in (self.director, self.finance):
            self.assertEqual(self._entries(who, "DuplicateFinding", "dup-1").status_code, 403, who.role)


# ---- C: a claimant is told the stage, not the desk's status ---------------

DESK_WORDS = ("CLEARED", "PRINCIPAL_APPROVED", "DIRECTOR_APPROVED", "SUBMITTED",
              "HOD_APPROVED", "RESEARCH_APPROVED", "FINANCE_APPROVED")


class ClaimantStageWords(ChainBase):
    def test_ticket_lookup_gives_faculty_the_stage(self):
        self._claim(status=ClaimStatus.CLEARED, ticket="ST-1")
        r = self._as(self.faculty).get("/api/lookup/ticket?q=ST-1")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["tickets"]
        self.assertEqual([row["status"] for row in rows], ["Under review"])
        for word in DESK_WORDS:
            self.assertNotIn(f'"{word}"', r.content.decode())

    def test_ticket_lookup_still_tells_the_desk_its_own_status(self):
        self._claim(status=ClaimStatus.CLEARED, ticket="ST-2")
        rows = self._as(self.cell).get("/api/lookup/ticket?q=ST-2").json()["tickets"]
        self.assertEqual([row["status"] for row in rows], [ClaimStatus.CLEARED])

    def test_the_faculty_net_converts_raw_status_in_payloads_that_are_not_claims(self):
        from core.visibility import for_viewer

        payload = {
            "papers": [{"claim_id": "x", "claim_status": "CLEARED"}],
            "card": {"existing": {"ticket_number": "T-1", "status": "PRINCIPAL_APPROVED"}},
            "loose": {"status": "DIRECTOR_APPROVED"},
            "unrelated": {"status": "ok"},
        }
        out = for_viewer(self.faculty, payload)
        body = json.dumps(out)
        for word in DESK_WORDS:
            self.assertNotIn(f'"{word}"', body)
        self.assertEqual(out["papers"][0]["claim_status"], "Under review")
        self.assertEqual(out["card"]["existing"]["status"], "Under review")
        self.assertEqual(out["loose"]["status"], "Approved for payment")
        self.assertEqual(out["unrelated"]["status"], "ok")
        # The desk's own view is untouched.
        self.assertEqual(for_viewer(self.cell, payload)["papers"][0]["claim_status"], "CLEARED")


# ---- D: nobody decides a question about themselves ------------------------


class NoSelfDecisions(ChainBase):
    def _threshold(self, actor, target, amount=50000):
        return self._as(actor).put(
            f"/api/research-faculty/{target.id}/threshold",
            data=json.dumps({"amount": amount}), content_type="application/json",
        )

    def test_the_coordinator_cannot_set_their_own_threshold(self):
        User.objects.filter(pk=self.coordinator.pk).update(faculty_type="RESEARCH")
        r = self._threshold(self.coordinator, self.coordinator)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("own research threshold", r.json()["detail"])
        from core.models import ResearchThreshold

        self.assertFalse(ResearchThreshold.objects.filter(user=self.coordinator).exists())

    def test_a_super_admin_cannot_set_their_own_threshold_but_can_set_a_colleagues(self):
        User.objects.filter(pk__in=[self.admin.pk, self.faculty.pk]).update(faculty_type="RESEARCH")
        self.assertEqual(self._threshold(self.admin, self.admin).status_code, 403)
        self.assertEqual(self._threshold(self.admin, self.faculty).status_code, 200)

    def _finding(self, rows, name="Somebody Else"):
        import json as _json

        from core.models import DuplicateFinding

        return DuplicateFinding.objects.create(
            kind="CROSS_PERSON", match_key=f"k-{len(rows)}-{name}", faculty_name=name,
            rows_json=_json.dumps(rows), payment_count=len(rows),
        )

    def _review(self, user, finding):
        return self._post(user, f"/api/admin/duplicate-findings/{finding.id}",
                          {"status": "CONFIRMED", "note": "checked"})

    def test_an_officer_cannot_review_a_finding_about_their_own_claim(self):
        own = self._claim(ticket="ND-1", owner=self.cell)
        finding = self._finding([{"source": "claim", "id": own.id, "person": "x", "person_key": "x"}])
        r = self._review(self.cell, finding)
        self.assertEqual(r.status_code, 403, r.content)
        finding.refresh_from_db()
        self.assertEqual(finding.status, "OPEN")

    def test_an_officer_cannot_review_a_finding_about_their_own_payment_key(self):
        User.objects.filter(pk=self.cell.pk).update(staff_id="STF-CELL1")
        self.cell.refresh_from_db()
        finding = self._finding([{"source": "prior", "id": "p1", "person": "Z", "person_key": "stf-cell1"}])
        self.assertEqual(self._review(self.cell, finding).status_code, 403)

    def test_an_officer_still_reviews_somebody_elses_finding(self):
        other = self._claim(ticket="ND-2")
        finding = self._finding([{"source": "claim", "id": other.id, "person": "A", "person_key": "stf-ch1"}])
        r = self._review(self.cell, finding)
        self.assertEqual(r.status_code, 200, r.content)
        finding.refresh_from_db()
        self.assertEqual(finding.status, "CONFIRMED")
