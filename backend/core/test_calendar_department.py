"""Department dates on the calendar: target reviews and assignment due dates
the head set, shown to the department's faculty (docs/jtbd/hod-audit.md)."""
from __future__ import annotations

from datetime import date

from django.test import Client, TestCase

from core.models import DepartmentAssignment, DepartmentTarget, Role, User


class CalendarDepartmentDatesTests(TestCase):
    def setUp(self):
        mk = lambda e, role, d: User.objects.create_user(  # noqa: E731
            email=f"{e}@x.edu", password="p", name=e.title(), role=role, department=d)
        self.head = mk("head", Role.HOD, "CSE")
        self.asha = mk("asha", Role.FACULTY, "CSE")
        self.ravi = mk("ravi", Role.FACULTY, "cse")
        self.ece = mk("eve", Role.FACULTY, "ECE")
        DepartmentTarget.objects.create(department="CSE", year=2026, metric="Q1", target=12,
                                        due_date=date(2026, 11, 30), set_by=self.head)
        DepartmentTarget.objects.create(department="CSE", year=2026, metric="PUBLICATIONS", target=3,
                                        person=self.ravi, due_date=date(2026, 10, 15), set_by=self.head)
        DepartmentAssignment.objects.create(department="CSE", kind="TASK", title="Draft criterion 3",
                                            assignee=self.asha, due_date=date(2026, 10, 20), created_by=self.head)
        DepartmentAssignment.objects.create(department="CSE", kind="TASK", title="Finished",
                                            assignee=self.asha, due_date=date(2026, 10, 21), status="DONE")

    def titles(self, user):
        c = Client()
        c.force_login(user)
        r = c.get("/api/calendar", {"start": "2026-10-01", "end": "2026-12-31"})
        self.assertEqual(r.status_code, 200)
        return sorted(e["title"] for e in r.json()["record"] if e["kind"] == "DEPT")

    def test_faculty_see_department_target_and_their_own_work(self):
        self.assertEqual(self.titles(self.asha), [
            "Due: Draft criterion 3", "Target review: 12 q1 publications (2026)"])

    def test_personal_target_only_to_that_person(self):
        got = self.titles(self.ravi)
        self.assertIn("Target review: 3 publications for Ravi (2026)", got)
        self.assertNotIn("Due: Draft criterion 3", got)

    def test_head_sees_every_open_date_in_the_department(self):
        got = self.titles(self.head)
        self.assertEqual(len(got), 3)
        self.assertIn("Due: Draft criterion 3 (Asha)", got)

    def test_other_departments_see_nothing(self):
        self.assertEqual(self.titles(self.ece), [])
