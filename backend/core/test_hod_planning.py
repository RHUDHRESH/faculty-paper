"""What a head of department plans, hands out and chases -- and who may.

A head could see what their department had published and set a number to
aim at, and had nowhere to say what the department is *for*, who should be
doing what, or to remind somebody who has gone quiet. Those three are the
rest of the job, and each one comes with the same two limits as everything
else a head does:

- **Their own department, checked on the server.** Work handed to somebody
  outside it, or a reminder sent to them, is refused rather than merely left
  off a picker -- a head reaching into another department's staff is not a
  filter mistake, it is somebody else's business.
- **No money.** A head is money-blind everywhere; a response carrying a
  rupee figure is a leak however it got there.

A super admin may do everything a head can, for any department, by naming
it. Everybody else is refused, except that a member of the department may
read its plan and the people an assignment is for may move its status.
"""
from __future__ import annotations

import json
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from core.hod import MONEY_KEYS
from core.models import (
    AuditLog,
    Claim,
    ClaimStatus,
    DepartmentAssignment,
    DepartmentPlan,
    DepartmentTarget,
    Notification,
    Role,
    User,
)


def _person(email, name, department, role=Role.FACULTY, **extra):
    return User.objects.create_user(
        email=email, password="pass", name=name, role=role, department=department, **extra
    )


def _keys(value) -> set[str]:
    """Every key anywhere in a decoded JSON structure."""
    found: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            found.add(k)
            found |= _keys(v)
    elif isinstance(value, list):
        for v in value:
            found |= _keys(v)
    return found


class _Base(TestCase):
    def setUp(self):
        self.head = _person("pl-head@test.edu", "Head of Physics", "Physics", Role.HOD)
        self.mine = _person("pl-mine@test.edu", "Asha Physicist", "Physics")
        self.mine2 = _person("pl-mine2@test.edu", "Ravi Physicist", "Physics")
        self.theirs = _person("pl-theirs@test.edu", "Chem Person", "Chemistry")
        self.other_head = _person("pl-chead@test.edu", "Head of Chemistry", "Chemistry", Role.HOD)
        self.admin = _person("pl-admin@test.edu", "Super Admin", None, Role.SUPER_ADMIN)
        self.principal = _person("pl-princ@test.edu", "The Principal", None, Role.PRINCIPAL)
        self.client = Client()

    def as_(self, user):
        self.client.force_login(user)
        return self.client

    def post(self, user, path, body):
        return self.as_(user).post(path, data=json.dumps(body), content_type="application/json")

    def put(self, user, path, body):
        return self.as_(user).put(path, data=json.dumps(body), content_type="application/json")

    def patch(self, user, path, body):
        return self.as_(user).patch(path, data=json.dumps(body), content_type="application/json")

    MESSAGE = "A reminder from your head of department: please file this year's papers."

    def nudge(self, who, ids, message=None, query=""):
        return self.post(
            who, f"/api/hod/nudge{query}",
            {"user_ids": ids, "message": self.MESSAGE if message is None else message},
        )


# ---------------------------------------------------------------------------
# The department plan
# ---------------------------------------------------------------------------


class DepartmentPlanTests(_Base):
    PLAN = {
        "vision": "A department known for condensed-matter work that industry reads.",
        "research_areas": ["Condensed matter", "Photonics"],
    }

    def test_a_plan_nobody_has_written_reads_as_empty_not_missing(self):
        r = self.as_(self.head).get("/api/hod/plan")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["department"], "Physics")
        self.assertEqual(body["vision"], "")
        self.assertEqual(body["research_areas"], [])
        self.assertIsNone(body["updated_at"])

    def test_a_head_writes_the_plan_and_their_faculty_can_read_it(self):
        r = self.put(self.head, "/api/hod/plan", self.PLAN)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["research_areas"], ["Condensed matter", "Photonics"])
        self.assertEqual(r.json()["updated_by"], "Head of Physics")

        r = self.as_(self.mine).get("/api/hod/plan")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["vision"], self.PLAN["vision"])

    def test_writing_twice_replaces_the_plan_rather_than_adding_a_second(self):
        self.put(self.head, "/api/hod/plan", self.PLAN)
        self.put(self.head, "/api/hod/plan", {"vision": "Revised.", "research_areas": []})
        self.assertEqual(DepartmentPlan.objects.count(), 1)
        self.assertEqual(DepartmentPlan.objects.get().vision, "Revised.")

    def test_faculty_elsewhere_read_their_own_department_s_plan(self):
        self.put(self.head, "/api/hod/plan", self.PLAN)
        r = self.as_(self.theirs).get("/api/hod/plan")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["department"], "Chemistry")
        self.assertNotIn("condensed", r.content.decode().lower())

    def test_a_faculty_member_cannot_ask_for_another_department_s_plan(self):
        r = self.as_(self.theirs).get("/api/hod/plan?department=Physics")
        self.assertEqual(r.status_code, 403, r.content)

    def test_a_head_cannot_ask_for_another_department_s_plan(self):
        r = self.as_(self.head).get("/api/hod/plan?department=Chemistry")
        self.assertEqual(r.status_code, 403, r.content)

    def test_faculty_cannot_write_the_plan(self):
        r = self.put(self.mine, "/api/hod/plan", self.PLAN)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(DepartmentPlan.objects.exists())

    def test_a_head_cannot_write_another_department_s_plan(self):
        r = self.put(self.head, "/api/hod/plan?department=Chemistry", self.PLAN)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(DepartmentPlan.objects.exists())

    def test_other_roles_cannot_read_a_department_plan(self):
        r = self.as_(self.principal).get("/api/hod/plan")
        self.assertEqual(r.status_code, 403, r.content)

    def test_a_super_admin_writes_any_department_s_plan_by_naming_it(self):
        r = self.put(self.admin, "/api/hod/plan?department=Chemistry", self.PLAN)
        self.assertEqual(r.status_code, 200, r.content)
        body = self.as_(self.other_head).get("/api/hod/plan").json()
        self.assertEqual(body["vision"], self.PLAN["vision"])

    def test_a_super_admin_reads_any_department_s_plan_by_naming_it(self):
        self.put(self.head, "/api/hod/plan", self.PLAN)
        r = self.as_(self.admin).get("/api/hod/plan?department=physics")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["vision"], self.PLAN["vision"])

    def test_a_super_admin_with_no_department_named_is_told_to_name_one(self):
        r = self.put(self.admin, "/api/hod/plan", self.PLAN)
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_super_admin_cannot_invent_a_department(self):
        r = self.put(self.admin, "/api/hod/plan?department=Astrology", self.PLAN)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(DepartmentPlan.objects.exists())

    def test_research_areas_are_trimmed_and_deduplicated(self):
        r = self.put(
            self.head,
            "/api/hod/plan",
            {"vision": "  Spaced.  ", "research_areas": [" Photonics ", "", "photonics", "Optics"]},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["research_areas"], ["Photonics", "Optics"])
        self.assertEqual(r.json()["vision"], "Spaced.")

    def test_a_research_area_that_is_a_paragraph_is_refused(self):
        r = self.put(self.head, "/api/hod/plan", {"vision": "", "research_areas": ["x" * 81]})
        self.assertEqual(r.status_code, 400, r.content)

    def test_changing_the_plan_is_audited(self):
        self.put(self.head, "/api/hod/plan", self.PLAN)
        log = AuditLog.objects.get(action="PLAN_UPDATE")
        self.assertEqual(log.actor, self.head)
        self.assertEqual(log.entity, "DepartmentPlan")
        self.assertEqual(json.loads(log.detail_json)["department"], "Physics")


# ---------------------------------------------------------------------------
# Assignments: tasks, co-author pairings, research areas
# ---------------------------------------------------------------------------


class AssignmentCreateTests(_Base):
    def test_a_head_assigns_a_task_and_the_assignee_is_told(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {
                "kind": "TASK",
                "title": "Draft the NAAC criterion 3 narrative",
                "notes": "Two pages.",
                "assignee_id": self.mine.id,
                "due_date": "2026-10-15",
            },
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["kind"], "TASK")
        self.assertEqual(body["status"], "OPEN")
        self.assertEqual(body["assignee_name"], "Asha Physicist")
        self.assertEqual(body["due_date"], "2026-10-15")
        self.assertEqual(body["department"], "Physics")

        a = DepartmentAssignment.objects.get()
        self.assertEqual(a.created_by, self.head)
        note = Notification.objects.get(user=self.mine)
        # A faculty member's notification opens their home screen, where the
        # assignment is listed -- not the department page they cannot open.
        self.assertEqual(note.href, "/")
        self.assertIn("NAAC", note.title + (note.body or ""))
        self.assertTrue(AuditLog.objects.filter(action="ASSIGNMENT_CREATE").exists())

    def test_a_pairing_tells_both_people(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {
                "kind": "PAIRING",
                "title": "A joint paper on thin-film sensors",
                "assignee_id": self.mine.id,
                "partner_id": self.mine2.id,
            },
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["partner_name"], "Ravi Physicist")
        self.assertEqual(Notification.objects.filter(user=self.mine).count(), 1)
        self.assertEqual(Notification.objects.filter(user=self.mine2).count(), 1)
        self.assertEqual(
            set(Notification.objects.values_list("href", flat=True)), {"/"}
        )
        # Each is told who the other one is.
        self.assertIn("Ravi", Notification.objects.get(user=self.mine).title)
        self.assertIn("Asha", Notification.objects.get(user=self.mine2).title)

    def test_a_research_area_assignment_is_accepted(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {"kind": "RESEARCH_AREA", "title": "Photonics", "assignee_id": self.mine.id},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["kind_label"], "Research area")

    def test_a_pairing_without_a_partner_is_refused(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {"kind": "PAIRING", "title": "Joint paper", "assignee_id": self.mine.id},
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(DepartmentAssignment.objects.exists())

    def test_a_person_cannot_be_paired_with_themselves(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {
                "kind": "PAIRING", "title": "Joint paper",
                "assignee_id": self.mine.id, "partner_id": self.mine.id,
            },
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_partner_from_another_department_is_refused(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {
                "kind": "PAIRING", "title": "Joint paper",
                "assignee_id": self.mine.id, "partner_id": self.theirs.id,
            },
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Physics", r.json()["detail"])
        self.assertFalse(Notification.objects.exists())

    def test_only_a_pairing_takes_a_partner(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {
                "kind": "TASK", "title": "Something",
                "assignee_id": self.mine.id, "partner_id": self.mine2.id,
            },
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_assigning_somebody_outside_the_department_is_refused(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {"kind": "TASK", "title": "Something", "assignee_id": self.theirs.id},
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Physics", r.json()["detail"])
        self.assertFalse(DepartmentAssignment.objects.exists())
        self.assertFalse(Notification.objects.exists())

    def test_an_unknown_person_is_refused(self):
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {"kind": "TASK", "title": "Something", "assignee_id": "nobody"},
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_an_inactive_account_cannot_be_given_work(self):
        self.mine.active = False
        self.mine.save()
        r = self.post(
            self.head,
            "/api/hod/assignments",
            {"kind": "TASK", "title": "Something", "assignee_id": self.mine.id},
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_an_unknown_kind_or_a_blank_title_is_refused(self):
        for body in (
            {"kind": "CHORE", "title": "Something", "assignee_id": self.mine.id},
            {"kind": "TASK", "title": "   ", "assignee_id": self.mine.id},
        ):
            r = self.post(self.head, "/api/hod/assignments", body)
            self.assertEqual(r.status_code, 400, f"{body}: {r.content}")
        self.assertFalse(DepartmentAssignment.objects.exists())

    def test_faculty_and_other_roles_cannot_hand_out_work(self):
        body = {"kind": "TASK", "title": "Something", "assignee_id": self.mine2.id}
        for who in (self.mine, self.principal):
            r = self.post(who, "/api/hod/assignments", body)
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")
        self.assertFalse(DepartmentAssignment.objects.exists())

    def test_another_head_cannot_hand_work_to_this_department(self):
        r = self.post(
            self.other_head,
            "/api/hod/assignments",
            {"kind": "TASK", "title": "Something", "assignee_id": self.mine.id},
        )
        self.assertEqual(r.status_code, 400, r.content)
        r = self.post(
            self.other_head,
            "/api/hod/assignments?department=Physics",
            {"kind": "TASK", "title": "Something", "assignee_id": self.mine.id},
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(DepartmentAssignment.objects.exists())

    def test_a_super_admin_assigns_within_the_department_they_name(self):
        r = self.post(
            self.admin,
            "/api/hod/assignments?department=Chemistry",
            {"kind": "TASK", "title": "Something", "assignee_id": self.theirs.id},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["department"], "Chemistry")
        # ...and the named department is still a limit, not a formality.
        r = self.post(
            self.admin,
            "/api/hod/assignments?department=Chemistry",
            {"kind": "TASK", "title": "Something", "assignee_id": self.mine.id},
        )
        self.assertEqual(r.status_code, 400, r.content)


class AssignmentListTests(_Base):
    def _make(self, department, assignee, **extra):
        defaults = {"kind": "TASK", "title": "A task", "created_by": self.head}
        defaults.update(extra)
        return DepartmentAssignment.objects.create(
            department=department, assignee=assignee, **defaults
        )

    def test_a_head_sees_their_own_department_s_work_only(self):
        ours = self._make("Physics", self.mine)
        self._make("Chemistry", self.theirs)
        r = self.as_(self.head).get("/api/hod/assignments")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([a["id"] for a in r.json()], [ours.id])

    def test_the_list_filters_by_status_and_kind(self):
        done = self._make("Physics", self.mine, status="DONE")
        self._make("Physics", self.mine)
        pairing = self._make("Physics", self.mine, kind="PAIRING", partner=self.mine2)

        ids = [a["id"] for a in self.as_(self.head).get("/api/hod/assignments?status=DONE").json()]
        self.assertEqual(ids, [done.id])
        ids = [a["id"] for a in self.as_(self.head).get("/api/hod/assignments?kind=PAIRING").json()]
        self.assertEqual(ids, [pairing.id])

    def test_an_unknown_filter_is_refused_rather_than_ignored(self):
        r = self.as_(self.head).get("/api/hod/assignments?status=FINISHED")
        self.assertEqual(r.status_code, 400, r.content)

    def test_faculty_cannot_list_the_department_s_work(self):
        r = self.as_(self.mine).get("/api/hod/assignments")
        self.assertEqual(r.status_code, 403, r.content)

    def test_a_super_admin_lists_the_department_they_name(self):
        theirs = self._make("Chemistry", self.theirs)
        r = self.as_(self.admin).get("/api/hod/assignments?department=Chemistry")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([a["id"] for a in r.json()], [theirs.id])

    def test_my_assignments_are_the_ones_i_am_assignee_or_partner_on(self):
        mine = self._make("Physics", self.mine)
        paired = self._make("Physics", self.mine2, kind="PAIRING", partner=self.mine)
        self._make("Physics", self.mine2)

        r = self.as_(self.mine).get("/api/me/assignments")
        self.assertEqual(r.status_code, 200, r.content)
        rows = {a["id"]: a for a in r.json()}
        self.assertEqual(set(rows), {mine.id, paired.id})
        # From where I stand, the other person on a pairing is who I work with.
        self.assertEqual(rows[paired.id]["my_part"], "PARTNER")
        self.assertEqual(rows[paired.id]["with_name"], "Ravi Physicist")
        self.assertEqual(rows[mine.id]["my_part"], "ASSIGNEE")
        self.assertIsNone(rows[mine.id]["with_name"])

    def test_my_assignments_is_open_to_any_account_and_empty_when_there_are_none(self):
        r = self.as_(self.principal).get("/api/me/assignments")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), [])

    def test_my_assignments_needs_a_signed_in_account(self):
        r = Client().get("/api/me/assignments")
        self.assertEqual(r.status_code, 401, r.content)

    def test_unfinished_work_is_listed_before_finished_work(self):
        self._make("Physics", self.mine, title="Finished", status="DONE")
        self._make("Physics", self.mine, title="Unfinished")
        titles = [a["title"] for a in self.as_(self.mine).get("/api/me/assignments").json()]
        self.assertEqual(titles, ["Unfinished", "Finished"])


class AssignmentChangeTests(_Base):
    def setUp(self):
        super().setUp()
        self.task = DepartmentAssignment.objects.create(
            department="Physics", kind="PAIRING", title="Joint paper",
            assignee=self.mine, partner=self.mine2, created_by=self.head,
        )
        self.path = f"/api/hod/assignments/{self.task.id}"

    def test_a_head_edits_anything_on_their_department_s_assignment(self):
        r = self.patch(
            self.head, self.path,
            {"title": "Joint paper, revised", "due_date": "2026-11-01", "status": "IN_PROGRESS"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.task.refresh_from_db()
        self.assertEqual(self.task.title, "Joint paper, revised")
        self.assertEqual(str(self.task.due_date), "2026-11-01")
        self.assertEqual(self.task.status, "IN_PROGRESS")
        self.assertTrue(AuditLog.objects.filter(action="ASSIGNMENT_UPDATE").exists())

    def test_a_head_can_clear_a_due_date(self):
        self.task.due_date = timezone.localdate()
        self.task.save()
        r = self.patch(self.head, self.path, {"due_date": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.task.refresh_from_db()
        self.assertIsNone(self.task.due_date)

    def test_the_assignee_moves_the_status(self):
        r = self.patch(self.mine, self.path, {"status": "DONE"})
        self.assertEqual(r.status_code, 200, r.content)
        self.task.refresh_from_db()
        self.assertEqual(self.task.status, "DONE")

    def test_the_partner_moves_the_status(self):
        r = self.patch(self.mine2, self.path, {"status": "IN_PROGRESS"})
        self.assertEqual(r.status_code, 200, r.content)
        self.task.refresh_from_db()
        self.assertEqual(self.task.status, "IN_PROGRESS")

    def test_the_assignee_may_change_nothing_but_the_status(self):
        r = self.patch(self.mine, self.path, {"status": "DONE", "title": "Something easier"})
        self.assertEqual(r.status_code, 403, r.content)
        self.task.refresh_from_db()
        self.assertEqual(self.task.title, "Joint paper")
        self.assertEqual(self.task.status, "OPEN")

    def test_somebody_not_on_it_cannot_touch_it(self):
        outsider = _person("pl-out@test.edu", "Another Physicist", "Physics")
        for who in (outsider, self.other_head, self.principal):
            r = self.patch(who, self.path, {"status": "DONE"})
            self.assertEqual(r.status_code, 403, f"{who.name}: {r.content}")
        self.task.refresh_from_db()
        self.assertEqual(self.task.status, "OPEN")

    def test_an_unknown_status_is_refused(self):
        r = self.patch(self.mine, self.path, {"status": "ABANDONED"})
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_head_cannot_reassign_to_somebody_outside_the_department(self):
        r = self.patch(self.head, self.path, {"assignee_id": self.theirs.id})
        self.assertEqual(r.status_code, 400, r.content)
        self.task.refresh_from_db()
        self.assertEqual(self.task.assignee, self.mine)

    def test_an_edit_that_would_leave_a_broken_pairing_is_refused(self):
        r = self.patch(self.head, self.path, {"partner_id": None})
        self.assertEqual(r.status_code, 400, r.content)
        r = self.patch(self.head, self.path, {"partner_id": self.mine.id})
        self.assertEqual(r.status_code, 400, r.content)

    def test_somebody_newly_put_on_an_assignment_is_told(self):
        newcomer = _person("pl-new@test.edu", "New Physicist", "Physics")
        r = self.patch(self.head, self.path, {"partner_id": newcomer.id})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Notification.objects.filter(user=newcomer).count(), 1)
        # The people already on it heard when it was made; a second message
        # for an unchanged role is noise.
        self.assertFalse(Notification.objects.filter(user=self.mine).exists())

    def test_a_missing_assignment_is_a_404(self):
        r = self.patch(self.head, "/api/hod/assignments/nope", {"status": "DONE"})
        self.assertEqual(r.status_code, 404, r.content)

    def test_a_super_admin_edits_any_department_s_assignment(self):
        r = self.patch(self.admin, self.path, {"title": "Retitled by the office"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_head_deletes_their_department_s_assignment(self):
        r = self.as_(self.head).delete(self.path)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(DepartmentAssignment.objects.exists())
        self.assertTrue(AuditLog.objects.filter(action="ASSIGNMENT_DELETE").exists())

    def test_the_people_on_it_and_other_heads_cannot_delete_it(self):
        for who in (self.mine, self.mine2, self.other_head, self.principal):
            r = self.as_(who).delete(self.path)
            self.assertEqual(r.status_code, 403, f"{who.name}: {r.content}")
        self.assertTrue(DepartmentAssignment.objects.exists())

    def test_a_super_admin_deletes_any_department_s_assignment(self):
        r = self.as_(self.admin).delete(self.path)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(DepartmentAssignment.objects.exists())


# ---------------------------------------------------------------------------
# Target deadlines
# ---------------------------------------------------------------------------


class TargetDeadlineTests(_Base):
    def test_a_target_carries_its_deadline(self):
        r = self.post(
            self.head,
            "/api/hod/targets",
            {"year": 2026, "metric": "Q1", "target": 4, "due_date": "2026-12-31"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(str(DepartmentTarget.objects.get().due_date), "2026-12-31")
        body = self.as_(self.head).get("/api/hod/targets?year=2026").json()
        self.assertEqual(body["department_targets"][0]["due_date"], "2026-12-31")

    def test_a_target_without_a_deadline_still_works(self):
        r = self.post(self.head, "/api/hod/targets", {"year": 2026, "metric": "Q1", "target": 4})
        self.assertEqual(r.status_code, 200, r.content)
        body = self.as_(self.head).get("/api/hod/targets?year=2026").json()
        self.assertIsNone(body["department_targets"][0]["due_date"])


# ---------------------------------------------------------------------------
# Nudges
# ---------------------------------------------------------------------------


class NudgeTests(_Base):
    def test_a_head_reminds_people_in_their_department(self):
        r = self.nudge(self.head, [self.mine.id, self.mine2.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sent"], 2)
        self.assertEqual(r.json()["skipped"], [])
        note = Notification.objects.get(user=self.mine)
        self.assertEqual(note.body, self.MESSAGE)
        self.assertEqual(note.href, "/")
        self.assertEqual(AuditLog.objects.filter(action="HOD_NUDGE").count(), 2)

    def test_somebody_outside_the_department_is_refused_and_nobody_is_sent_anything(self):
        r = self.nudge(self.head, [self.mine.id, self.theirs.id])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Physics", r.json()["detail"])
        self.assertFalse(Notification.objects.exists())

    def test_one_reminder_per_person_per_day(self):
        self.nudge(self.head, [self.mine.id])
        r = self.nudge(self.head, [self.mine.id, self.mine2.id])
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["sent"], 1)
        self.assertEqual([s["id"] for s in body["skipped"]], [self.mine.id])
        self.assertEqual(body["skipped"][0]["name"], "Asha Physicist")
        self.assertEqual(Notification.objects.filter(user=self.mine).count(), 1)

    def test_the_day_is_per_person_whoever_sends_it(self):
        self.nudge(self.head, [self.mine.id])
        r = self.nudge(self.admin, [self.mine.id], query="?department=Physics")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sent"], 0)

    def test_a_reminder_can_be_sent_again_after_a_day(self):
        self.nudge(self.head, [self.mine.id])
        AuditLog.objects.filter(action="HOD_NUDGE").update(
            created_at=timezone.now() - timedelta(hours=25)
        )
        r = self.nudge(self.head, [self.mine.id])
        self.assertEqual(r.json()["sent"], 1)
        self.assertEqual(Notification.objects.filter(user=self.mine).count(), 2)

    def test_a_person_named_twice_is_reminded_once(self):
        r = self.nudge(self.head, [self.mine.id, self.mine.id])
        self.assertEqual(r.json()["sent"], 1)
        self.assertEqual(Notification.objects.filter(user=self.mine).count(), 1)

    def test_the_message_must_be_between_ten_and_five_hundred_characters(self):
        for message in ("Too short", "x" * 501, "          padded   "):
            r = self.nudge(self.head, [self.mine.id], message=message)
            self.assertEqual(r.status_code, 400, f"{len(message)}: {r.content}")
        self.assertFalse(Notification.objects.exists())

    def test_nobody_named_is_refused(self):
        r = self.nudge(self.head, [])
        self.assertEqual(r.status_code, 400, r.content)

    def test_faculty_and_other_roles_cannot_send_reminders(self):
        for who in (self.mine, self.principal):
            r = self.nudge(who, [self.mine2.id])
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")
        self.assertFalse(Notification.objects.exists())

    def test_a_super_admin_reminds_people_in_the_department_they_name(self):
        r = self.nudge(self.admin, [self.theirs.id], query="?department=Chemistry")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sent"], 1)
        r = self.nudge(self.admin, [self.mine.id], query="?department=Chemistry")
        self.assertEqual(r.status_code, 400, r.content)


# ---------------------------------------------------------------------------
# Money-blindness, asked of every new response a head receives
# ---------------------------------------------------------------------------


class PlanningCarriesNoMoneyTests(_Base):
    def test_no_new_head_response_carries_a_money_key_or_figure(self):
        Claim.objects.create(
            owner=self.mine, status=ClaimStatus.PAID, ticket_number="PL-1",
            paper_title="Paid paper", journal_title="J", publication_year=2026,
            remuneration=123456.0, voucher_number="V-98765",
        )
        self.put(self.head, "/api/hod/plan", DepartmentPlanTests.PLAN)
        created = self.post(
            self.head, "/api/hod/assignments",
            {
                "kind": "PAIRING", "title": "Joint paper", "notes": "Start with the survey.",
                "assignee_id": self.mine.id, "partner_id": self.mine2.id,
                "due_date": "2026-12-01",
            },
        ).json()
        self.post(self.head, "/api/hod/targets", {"year": 2026, "metric": "Q1", "target": 2})

        responses = {
            "GET plan": self.as_(self.head).get("/api/hod/plan"),
            "GET assignments": self.as_(self.head).get("/api/hod/assignments"),
            "GET targets": self.as_(self.head).get("/api/hod/targets?year=2026"),
            "PATCH assignment": self.patch(
                self.head, f"/api/hod/assignments/{created['id']}", {"status": "IN_PROGRESS"}
            ),
            "POST nudge": self.nudge(self.head, [self.mine.id]),
        }
        for label, r in responses.items():
            self.assertEqual(r.status_code, 200, f"{label}: {r.content}")
            raw = r.content.decode()
            for figure in ("123456", "V-98765"):
                self.assertNotIn(figure, raw, f"{label} leaked {figure}")
            leaked = _keys(r.json()) & MONEY_KEYS
            self.assertEqual(leaked, set(), f"{label} carries {sorted(leaked)}")
        # The notes on an assignment are the head's own words, and survive:
        # `notes` is not `note`, which the money filter strips.
        self.assertEqual(created["notes"], "Start with the survey.")
