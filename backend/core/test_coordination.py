"""The coordination desk: who may open it, assigning claims, and what it counts.

The rules pinned here:

- only the research cell, the research coordinator and the super admin open it;
- a claim goes only to someone who reviews at the desk it is at, and never to
  the person who filed it; bulk assignment skips what fails, by name;
- an assignment stops counting when the claim moves to a desk its holder does
  not sit at;
- the queue carries `assigned_to` and filters on `assigned=me`;
- nothing on the page carries money or flags.
"""
from __future__ import annotations

import json
from datetime import timedelta

from django.utils import timezone

from core.models import AuditLog, ClaimAction, ClaimStatus, JournalWatch, Role, User
from core.test_chain_rules import ChainBase

OVERVIEW = "/api/coordination/overview"
CLAIMS = "/api/coordination/claims"
ASSIGN = "/api/coordination/assign"
RESEARCH = "/api/coordination/research"


class Who(ChainBase):
    def person(self, email, name, role, **extra):
        return User.objects.create_user(email=email, password=None, name=name, role=role, **extra)


class PermissionTests(Who):
    ENDPOINTS = (OVERVIEW, CLAIMS, RESEARCH, "/api/coordination/reviewers")

    def test_the_office_roles_open_it(self):
        for user in (self.coordinator, self.admin, self.cell):
            for path in self.ENDPOINTS:
                self.assertEqual(self._as(user).get(path).status_code, 200, f"{user.role} {path}")

    def test_nobody_else_does(self):
        for user in (self.faculty, self.hod, self.principal, self.director, self.finance):
            for path in self.ENDPOINTS:
                self.assertEqual(self._as(user).get(path).status_code, 403, f"{user.role} {path}")
            r = self._post(user, ASSIGN, {"claim_ids": ["x"], "assignee_id": self.cell.id})
            self.assertEqual(r.status_code, 403, user.role)

    def test_signed_out_is_refused(self):
        self.client.logout()
        self.assertIn(self.client.get(OVERVIEW).status_code, (401, 403))


class AssignTests(Who):
    def test_assign_one_and_the_queue_shows_it(self):
        claim = self._claim(ticket="A-1")
        r = self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": self.cell.id})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["assigned"], 1)
        claim.refresh_from_db()
        self.assertEqual(claim.assigned_to, self.cell)
        self.assertIsNotNone(claim.assigned_at)
        self.assertTrue(AuditLog.objects.filter(action="CLAIM_ASSIGN", entity_id=claim.id).exists())

        rows = self._as(self.cell).get("/api/admin/clearing-queue?status=SUBMITTED").json()
        row = next(x for x in rows if x["id"] == claim.id)
        self.assertEqual(row["assigned_to"]["user_id"], self.cell.id)
        self.assertEqual(row["assigned_to"]["name"], "Ravi Cellperson")

    def test_assigned_to_me_filter(self):
        mine = self._claim(ticket="A-2")
        other = self._claim(ticket="A-3")
        free = self._claim(ticket="A-4")
        self._post(self.coordinator, ASSIGN, {"claim_ids": [mine.id], "assignee_id": self.cell.id})
        self._post(self.coordinator, ASSIGN, {"claim_ids": [other.id], "assignee_id": self.admin.id})
        ids = lambda q: {x["id"] for x in self._as(self.cell).get(f"/api/admin/clearing-queue?{q}").json()}
        self.assertEqual(ids("assigned=me"), {mine.id})
        self.assertEqual(ids("assigned=none"), {free.id})
        self.assertEqual(ids(f"assigned={self.admin.id}"), {other.id})
        self.assertEqual(ids(""), {mine.id, other.id, free.id})

    def test_reassign_and_unassign(self):
        claim = self._claim(ticket="A-5")
        self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": self.cell.id})
        self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": self.admin.id})
        claim.refresh_from_db()
        self.assertEqual(claim.assigned_to, self.admin)
        r = self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": None})
        self.assertEqual(r.json()["unassigned"], 1)
        claim.refresh_from_db()
        self.assertIsNone(claim.assigned_to)
        self.assertIsNone(claim.assigned_at)

    def test_never_to_the_person_who_filed_it(self):
        owner = self.person("owner-cell@test.edu", "Owen Cell", Role.RESEARCH_CELL)
        claim = self._claim(ticket="A-6", owner=owner)
        ok = self._claim(ticket="A-7")
        r = self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id, ok.id], "assignee_id": owner.id})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["assigned"], 1)
        self.assertEqual(body["skipped"][0]["ticket_number"], "A-6")
        self.assertIn("filed it", body["skipped"][0]["reason"])
        claim.refresh_from_db()
        self.assertIsNone(claim.assigned_to)

    def test_only_to_someone_who_reviews(self):
        claim = self._claim(ticket="A-8")
        for bad in (self.faculty, self.hod, self.director, self.finance):
            r = self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": bad.id})
            self.assertEqual(r.status_code, 400, bad.role)
        gone = self.person("gone@test.edu", "Gone Cell", Role.RESEARCH_CELL, active=False)
        r = self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": gone.id})
        self.assertEqual(r.status_code, 400)
        claim.refresh_from_db()
        self.assertIsNone(claim.assigned_to)

    def test_the_assignee_must_sit_at_the_desk_the_claim_is_at(self):
        submitted = self._claim(ticket="A-9")
        cleared = self._claim(ticket="A-10", status=ClaimStatus.CLEARED)
        paid_up = self._claim(ticket="A-11", status=ClaimStatus.DIRECTOR_APPROVED)
        r = self._post(
            self.coordinator, ASSIGN,
            {"claim_ids": [submitted.id, cleared.id, paid_up.id], "assignee_id": self.principal.id},
        ).json()
        self.assertEqual(r["claim_ids"], [cleared.id])
        self.assertEqual({s["ticket_number"] for s in r["skipped"]}, {"A-9", "A-11"})

    def test_your_own_claim_is_left_to_someone_else(self):
        mine = self._claim(ticket="A-12", owner=self.coordinator)
        r = self._post(self.coordinator, ASSIGN, {"claim_ids": [mine.id], "assignee_id": self.cell.id}).json()
        self.assertEqual(r["assigned"], 0)
        self.assertIn("own claim", r["skipped"][0]["reason"])
        # and another coordinator can
        r = self._post(self.admin, ASSIGN, {"claim_ids": [mine.id], "assignee_id": self.cell.id}).json()
        self.assertEqual(r["assigned"], 1)

    def test_bulk_and_empty(self):
        claims = [self._claim(ticket=f"B-{i}") for i in range(5)]
        r = self._post(self.coordinator, ASSIGN, {"claim_ids": [c.id for c in claims], "assignee_id": self.cell.id})
        self.assertEqual(r.json()["assigned"], 5)
        self.assertEqual(self._post(self.coordinator, ASSIGN, {"claim_ids": []}).status_code, 400)
        missing = self._post(self.coordinator, ASSIGN, {"claim_ids": ["nope"], "assignee_id": self.cell.id}).json()
        self.assertEqual(missing["skipped"][0]["reason"], "No such claim.")

    def test_a_moved_claim_stops_belonging_to_its_old_reviewer(self):
        claim = self._claim(ticket="A-13")
        self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": self.cell.id})
        claim.status = ClaimStatus.CLEARED
        claim.cleared_at = timezone.now()
        claim.save()
        rows = self._as(self.cell).get("/api/admin/clearing-queue?status=CLEARED").json()
        row = next(x for x in rows if x["id"] == claim.id)
        self.assertIsNone(row["assigned_to"])

    def test_assigning_leaves_no_trace_the_claimant_can_read(self):
        claim = self._claim(ticket="A-14")
        self._post(self.coordinator, ASSIGN, {"claim_ids": [claim.id], "assignee_id": self.cell.id})
        self.assertFalse(ClaimAction.objects.filter(claim=claim).exists())
        body = self._as(self.faculty).get(f"/api/claims/{claim.id}").content.decode()
        self.assertNotIn("assigned", body)
        self.assertNotIn(self.cell.name, body)


class OverviewTests(Who):
    def test_counts_workload_ageing_breaches_and_stages(self):
        now = timezone.now()
        old = self._claim(ticket="O-1", submitted_at=now - timedelta(days=20))
        mid = self._claim(ticket="O-2", submitted_at=now - timedelta(days=10))
        new = self._claim(ticket="O-3", submitted_at=now - timedelta(days=2))
        self._claim(ticket="O-4", status=ClaimStatus.CLEARED, cleared_at=now - timedelta(days=16))
        self._claim(ticket="O-5", status=ClaimStatus.PRINCIPAL_APPROVED, principal_approved_at=now - timedelta(days=1))
        self._post(self.coordinator, ASSIGN, {"claim_ids": [old.id, mid.id], "assignee_id": self.cell.id})
        ClaimAction.objects.create(
            claim=new, actor=self.cell, from_status=ClaimStatus.SUBMITTED,
            to_status=ClaimStatus.CLEARED, action="CLEAR",
        )

        body = self._as(self.coordinator).get(OVERVIEW).json()
        self.assertEqual(body["sla_days"], 14)
        self.assertEqual(body["desk_open"], 3)
        self.assertEqual(body["unassigned"], 1)

        cell = next(r for r in body["reviewers"] if r["user_id"] == self.cell.id)
        self.assertEqual(cell["open"], 2)
        self.assertEqual(cell["cleared_this_week"], 1)
        self.assertIsNotNone(cell["median_days"])

        buckets = {a["bucket"]: a for a in body["ageing"]}
        self.assertEqual(buckets["a week or less"]["count"], 1)
        self.assertEqual(buckets["8 to 14 days"]["count"], 1)
        self.assertEqual(buckets["15 to 30 days"]["count"], 1)
        self.assertTrue(buckets["15 to 30 days"]["breach"])
        self.assertFalse(buckets["8 to 14 days"]["breach"])

        self.assertEqual(body["breaches"]["count"], 1)
        self.assertEqual(body["breaches"]["rows"][0]["ticket_number"], "O-1")
        self.assertEqual(body["breaches"]["rows"][0]["assigned_to"]["name"], "Ravi Cellperson")

        stages = {s["key"]: s for s in body["stages"]}
        self.assertEqual(stages["research"]["count"], 3)
        self.assertEqual(stages["research"]["over_sla"], 1)
        self.assertEqual(stages["principal"]["count"], 1)
        self.assertEqual(stages["principal"]["over_sla"], 1)
        self.assertEqual(stages["director"]["count"], 1)
        self.assertEqual(stages["director"]["over_sla"], 0)

        self.assertEqual(len(body["throughput"]), 12)
        self.assertEqual(sum(w["decided"] for w in body["throughput"]), 1)

    def test_no_money_and_no_flags_anywhere(self):
        self._claim(ticket="N-1", contest_forward=True, contest_note="something odd")
        text = json.dumps(self._as(self.coordinator).get(OVERVIEW).json()) + json.dumps(
            self._as(self.coordinator).get(CLAIMS).json()
        )
        for word in ("remuneration", "amount", "flag", "contest", "duplicate", "verification"):
            self.assertNotIn(word, text.lower(), word)

    def test_claims_list_scopes(self):
        now = timezone.now()
        a = self._claim(ticket="L-1", submitted_at=now - timedelta(days=30))
        b = self._claim(ticket="L-2", submitted_at=now - timedelta(days=3))
        self._claim(ticket="L-3", owner=self.coordinator)
        self._post(self.coordinator, ASSIGN, {"claim_ids": [b.id], "assignee_id": self.cell.id})
        get = lambda s: [r["ticket_number"] for r in self._as(self.coordinator).get(f"{CLAIMS}?scope={s}").json()["results"]]
        self.assertEqual(get("all"), ["L-1", "L-2"], "oldest first, and never their own claim")
        self.assertEqual(get("unassigned"), ["L-1"])
        self.assertEqual(get("assigned"), ["L-2"])
        self.assertEqual(get("breach"), ["L-1"])
        self.assertEqual(self._as(self.coordinator).get(f"{CLAIMS}?scope=nonsense").status_code, 400)
        self.assertEqual(a.owner, self.faculty)


class ResearchTests(Who):
    def test_teams_and_watch_count(self):
        JournalWatch.objects.create(title="Doubtful Journal", reason="clone", added_by=self.cell)
        body = self._as(self.cell).get(RESEARCH).json()
        self.assertEqual(body["watch"]["count"], 1)
        self.assertIn("teams", body["fyp"])
        self.assertNotIn("quota", body)
