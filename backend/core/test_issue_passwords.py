"""Issue passwords: a super admin hands out new one-time passwords in bulk.

The accounts came from an import that generated passwords and discarded them.
These tests hold the rules that make the bulk reset safe to run on a live
college: who may, who is left out, that a dry run changes nothing, that the
passwords work and are stored nowhere, and that the file is safe to open.
"""
import csv
import io
import json
from io import StringIO

from django.contrib.auth import authenticate
from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client, TestCase
from django.utils import timezone

from core.models import AuditLog, Role, User
from core.services import issue_passwords

URL = "/api/admin/passwords/issue"


def make(role, n, **kw):
    kw.setdefault("department", "CSE")
    return User.objects.create_user(
        email=kw.pop("email", f"p{n}@x.edu"), password="old-pass-1", name=f"Person {n}", role=role, **kw
    )


def rows_of(resp):
    text = resp.content.decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


class Base(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = make(Role.SUPER_ADMIN, 1)
        self.other_admin = make(Role.SUPER_ADMIN, 2)
        self.new1 = make(Role.FACULTY, 3)
        self.new2 = make(Role.FACULTY, 4, department="ECE")
        self.seen = make(Role.FACULTY, 5, last_login=timezone.now())
        self.hod = make(Role.HOD, 6)
        self.left = make(Role.FACULTY, 7, active=False)
        self.holding = make(Role.FACULTY, 8, email="left.person@saveetha.invalid")
        self.c = self.as_(self.admin)

    def as_(self, user):
        c = Client()
        c.force_login(user)
        return c

    def post(self, body, client=None):
        return (client or self.c).post(URL, json.dumps(body), content_type="application/json")

    def passwords_untouched(self, *users):
        for u in users:
            u.refresh_from_db()
            self.assertTrue(u.check_password("old-pass-1"), u.email)
            self.assertFalse(u.must_change_password, u.email)


class WhoMay(Base):
    def test_only_a_super_admin(self):
        for role in Role.values:
            if role == Role.SUPER_ADMIN:
                continue
            u = make(role, f"r-{role}")
            r = self.post({"who": "all", "dry_run": True}, self.as_(u))
            self.assertEqual(r.status_code, 403, role)
        self.passwords_untouched(self.new1, self.seen)

    def test_anonymous_is_refused(self):
        r = Client().post(URL, json.dumps({"who": "all", "dry_run": True}), content_type="application/json")
        self.assertEqual(r.status_code, 401)

    def test_a_super_admin_may(self):
        self.assertEqual(self.post({"who": "all", "dry_run": True}).status_code, 200)

    def test_refused_while_viewing_as_somebody(self):
        r = self.c.post(f"/api/admin/impersonate/{self.new1.id}", "{}", content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        for dry in (True, False):
            r = self.post({"who": "all", "dry_run": dry})
            self.assertEqual(r.status_code, 403, dry)
            self.assertIn("viewing as", r.json()["detail"])
        self.passwords_untouched(self.new1, self.seen)

    def test_a_bad_scope_is_a_400_and_changes_nothing(self):
        for body in (
            {"who": "everybody"},
            {"who": "role"},
            {"who": "role", "role": "WIZARD"},
            {"who": "department"},
            {"who": "ids", "ids": []},
        ):
            self.assertEqual(self.post({**body, "dry_run": True}).status_code, 400, body)
        self.passwords_untouched(self.new1, self.seen)


class DryRun(Base):
    def test_counts_and_breaks_down_and_changes_nothing(self):
        r = self.post({"who": "no_password_yet", "dry_run": True})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        # new1, new2 and hod have never signed in; the seen one, the super
        # admins, the inactive account and the holding record are not counted.
        self.assertEqual(body["count"], 3)
        self.assertEqual({x["role"]: x["count"] for x in body["by_role"]}, {"FACULTY": 2, "HOD": 1})
        self.assertEqual({x["department"]: x["count"] for x in body["by_department"]}, {"CSE": 2, "ECE": 1})
        self.passwords_untouched(self.new1, self.new2, self.seen, self.hod, self.admin)
        self.assertFalse(AuditLog.objects.filter(action="PASSWORDS_ISSUE").exists())

    def test_a_dry_run_does_not_spend_the_hourly_allowance(self):
        for _ in range(8):
            self.assertEqual(self.post({"who": "all", "dry_run": True}).status_code, 200)
        self.assertEqual(self.post({"who": "all"}).status_code, 200)


class RealRun(Base):
    def test_changes_exactly_the_scoped_accounts_and_they_can_sign_in(self):
        r = self.post({"who": "no_password_yet"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r["Content-Type"].startswith("text/csv"))
        self.assertIn("attachment", r["Content-Disposition"])
        self.assertEqual(r["X-Issued-Count"], "3")
        self.assertTrue(r.content.startswith(b"\xef\xbb\xbf"), "a byte-order mark for Excel")

        rows = rows_of(r)
        self.assertEqual({x["Email"] for x in rows}, {self.new1.email, self.new2.email, self.hod.email})
        self.assertEqual(
            list(rows[0].keys()), ["Email", "Name", "Role", "Department", "Staff ID", "Password"]
        )
        for row in rows:
            self.assertTrue(12 <= len(row["Password"]) <= 14, row["Password"])
            self.assertFalse(set(row["Password"]) & set("O0oIl1"))
            user = authenticate(username=row["Email"], password=row["Password"])
            self.assertIsNotNone(user, row["Email"])
            user.refresh_from_db()
            self.assertTrue(user.must_change_password)
            self.assertFalse(user.check_password("old-pass-1"))
        self.assertEqual(len({x["Password"] for x in rows}), 3, "one each, none shared")

        # Everybody else is exactly as they were.
        self.passwords_untouched(self.seen, self.left, self.holding, self.admin, self.other_admin)

    def test_the_caller_and_other_super_admins_are_never_touched_by_a_scope(self):
        rows = rows_of(self.post({"who": "all"}))
        emails = {x["Email"] for x in rows}
        self.assertNotIn(self.admin.email, emails)
        self.assertNotIn(self.other_admin.email, emails)
        self.assertNotIn(self.holding.email, emails)
        self.assertNotIn(self.left.email, emails)
        self.assertEqual(emails, {self.new1.email, self.new2.email, self.seen.email, self.hod.email})
        # Asking for the role does not reach them either.
        self.assertEqual(self.post({"who": "role", "role": "SUPER_ADMIN", "dry_run": True}).json()["count"], 0)
        self.passwords_untouched(self.admin, self.other_admin)

    def test_another_super_admin_only_when_named_and_never_oneself(self):
        rows = rows_of(self.post({"who": "ids", "ids": [self.other_admin.id, self.admin.id]}))
        self.assertEqual([x["Email"] for x in rows], [self.other_admin.email])
        self.passwords_untouched(self.admin)
        self.other_admin.refresh_from_db()
        self.assertFalse(self.other_admin.check_password("old-pass-1"))

    def test_role_and_department_scopes(self):
        rows = rows_of(self.post({"who": "role", "role": "HOD"}))
        self.assertEqual([x["Email"] for x in rows], [self.hod.email])
        rows = rows_of(self.post({"who": "department", "department": "ece"}))
        self.assertEqual([x["Email"] for x in rows], [self.new2.email])

    def test_inactive_only_when_asked_and_holding_records_never(self):
        rows = rows_of(self.post({"who": "role", "role": "FACULTY", "include_inactive": True}))
        emails = {x["Email"] for x in rows}
        self.assertIn(self.left.email, emails)
        self.assertNotIn(self.holding.email, emails)
        self.holding.refresh_from_db()
        self.assertTrue(self.holding.check_password("old-pass-1"))

    def test_an_empty_scope_is_refused_and_writes_nothing(self):
        r = self.post({"who": "role", "role": "FINANCE"})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(AuditLog.objects.filter(action="PASSWORDS_ISSUE").exists())

    def test_a_locked_account_is_unlocked(self):
        for _ in range(12):
            r = Client().post(
                "/api/auth/login",
                json.dumps({"email": self.new1.email, "password": "wrong"}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 429)
        rows = rows_of(self.post({"who": "ids", "ids": [self.new1.id]}))
        r = Client().post(
            "/api/auth/login",
            json.dumps({"email": self.new1.email, "password": rows[0]["Password"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_first_sign_in_upgrades_the_hash_and_marks_them_as_having_signed_in(self):
        rows = rows_of(self.post({"who": "ids", "ids": [self.new1.id]}))
        self.new1.refresh_from_db()
        self.assertTrue(self.new1.password.startswith("pbkdf2_sha256_issued$"))
        r = Client().post(
            "/api/auth/login",
            json.dumps({"email": self.new1.email, "password": rows[0]["Password"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        self.new1.refresh_from_db()
        self.assertTrue(self.new1.password.startswith("pbkdf2_sha256$"), "re-hashed at full cost")
        self.assertIsNotNone(self.new1.last_login)

    def test_rate_limited_after_five_real_runs_an_hour(self):
        # Different groups each time: the same group twice in a row is a
        # double-click, which has its own refusal (below).
        people = [make(Role.FACULTY, f"rl{i}") for i in range(6)]
        for u in people[:5]:
            self.assertEqual(self.post({"who": "ids", "ids": [u.id]}).status_code, 200)
        r = self.post({"who": "ids", "ids": [people[5].id]})
        self.assertEqual(r.status_code, 429)

    def test_the_same_run_twice_in_a_moment_is_refused_and_replaces_nothing(self):
        """A double-click must not replace the passwords the first click handed out."""
        first = self.post({"who": "ids", "ids": [self.new1.id]})
        self.assertEqual(first.status_code, 200)
        given = rows_of(first)[0]["Password"]
        again = self.post({"who": "ids", "ids": [self.new1.id]})
        self.assertEqual(again.status_code, 409, again.content)
        self.assertIn("only copy", again.json()["detail"])
        self.new1.refresh_from_db()
        self.assertTrue(self.new1.check_password(given), "the downloaded list still works")
        self.assertEqual(AuditLog.objects.filter(action="PASSWORDS_ISSUE").count(), 1)

    def test_after_two_minutes_the_same_run_is_a_decision_again(self):
        from datetime import timedelta

        self.assertEqual(self.post({"who": "ids", "ids": [self.new1.id]}).status_code, 200)
        AuditLog._base_manager.filter(action="PASSWORDS_ISSUE").update(created_at=timezone.now() - timedelta(minutes=3))
        self.assertEqual(self.post({"who": "ids", "ids": [self.new1.id]}).status_code, 200)


class NothingKeptAnywhere(Base):
    def test_the_audit_row_holds_no_password(self):
        r = self.post({"who": "role", "role": "FACULTY"})
        rows = rows_of(r)
        row = AuditLog.objects.get(action="PASSWORDS_ISSUE")
        self.assertEqual(row.actor_id, self.admin.id)
        detail = json.loads(row.detail_json)
        self.assertEqual(detail, {"who": "role", "include_inactive": False, "count": len(rows), "role": "FACULTY"})
        for x in rows:
            self.assertNotIn(x["Password"], row.detail_json)
            self.assertNotIn(x["Password"], row.entity_id or "")

    def test_no_password_in_any_database_column_or_log(self):
        with self.assertLogs("core", level="DEBUG") as logs:
            import logging

            logging.getLogger("core").debug("keep the capture open")
            r = self.post({"who": "all"})
        rows = rows_of(r)
        for x in rows:
            self.assertFalse(User.objects.filter(password__contains=x["Password"]).exists())
            self.assertNotIn(x["Password"], "\n".join(logs.output))
        blob = json.dumps(
            list(AuditLog.objects.values("action", "entity", "entity_id", "detail_json"))
        )
        for x in rows:
            self.assertNotIn(x["Password"], blob)

    def test_the_response_is_not_cacheable(self):
        self.assertEqual(self.post({"who": "all"})["Cache-Control"], "no-store")

    def test_the_audit_log_reads_in_plain_words(self):
        self.post({"who": "all"})
        body = self.c.get("/api/admin/audit").json()
        row = next(x for x in body["results"] if x["action"] == "PASSWORDS_ISSUE")
        self.assertIn("issued sign-in passwords", row["what"])


class FormulaSafe(Base):
    def test_no_cell_can_be_a_formula(self):
        evil = make(Role.FACULTY, 20, department="=HYPERLINK(\"http://x\")")
        evil.name = "@SUM(A1)"
        evil.staff_id = "-1+1"
        evil.save()
        r = self.post({"who": "ids", "ids": [evil.id]})
        text = r.content.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text)))
        for line in rows[1:]:
            for cell in line[:5]:
                self.assertNotIn(cell[:1], ("=", "+", "-", "@", "\t", "\r"), cell)
        self.assertIn("'=HYPERLINK", text)
        self.assertIn("'@SUM", text)

    def test_generated_passwords_never_start_with_a_formula_character(self):
        for _ in range(2000):
            self.assertNotIn(issue_passwords.new_password()[:1], "=+-@")


class CommandSharesTheService(Base):
    def run_cmd(self, *args):
        out = StringIO()
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "creds.csv")
            call_command("reset_faculty_passwords", "--out", path, *args, stdout=out)
            with open(path, "rb") as fh:
                raw = fh.read()
        return raw

    def test_default_is_faculty_and_matches_the_screen(self):
        raw = self.run_cmd()
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(
            {r["Email"] for r in rows}, {self.new1.email, self.new2.email, self.seen.email}
        )
        for r in rows:
            self.assertIsNotNone(authenticate(username=r["Email"], password=r["Password"]))
        self.passwords_untouched(self.hod, self.left, self.holding, self.admin)

    def test_role_option_reaches_the_other_desks(self):
        fin = make(Role.FINANCE, 30)
        raw = self.run_cmd("--role", "FINANCE")
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
        self.assertEqual([r["Email"] for r in rows], [fin.email])
        self.passwords_untouched(self.new1)

    def test_never_signed_in_and_limit_and_include_inactive(self):
        raw = self.run_cmd("--never-signed-in")
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
        self.assertEqual(len(rows), 3)
        raw = self.run_cmd("--role", "FACULTY", "--include-inactive", "--limit", "1")
        self.assertEqual(len(list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))), 1)

    def test_nothing_matching_is_an_error_and_a_super_admin_is_not_offered(self):
        with self.assertRaises(CommandError):
            self.run_cmd("--role", "PRINCIPAL")
        with self.assertRaises(CommandError):
            self.run_cmd("--role", "SUPER_ADMIN")
