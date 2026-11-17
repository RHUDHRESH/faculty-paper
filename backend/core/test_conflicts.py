"""The Data conflicts screen: noting differences once, and settling them by clicking.

Every person, file and amount here is made up in the test.
"""
from __future__ import annotations

import datetime as dt
import json
from unittest import mock

from django.test import Client, TestCase

from core.models import AuditLog, Claim, ClaimStatus, ImportConflict, PaidLedger, Role, User
from core.services import import_conflicts as svc
from core.services.faculty_list_import import import_faculty_list, read_faculty_list
from core.services.settled_claims_import import import_settled_claims, read_settled_claims
from core.test_imports import faculty_workbook, mk, settled_workbook

URL = "/api/admin/conflicts"


def scopus_row(staff="TS002", current="57999999999", incoming="57000000002", name="Conflict Two"):
    return {"staff_id": staff, "name": name, "field": "scopus_author_id", "current": current, "incoming": incoming}


def email_row(staff="TS002", current="old-two@x.edu", incoming="two@x.edu", name="Conflict Two"):
    return {"staff_id": staff, "name": name, "field": "email", "current": current, "incoming": incoming}


def staff_row(staff="TS050", current="TS005O", incoming="TS050", name="Person Fifty"):
    return {"staff_id": staff, "name": name, "field": "staff_id", "current": current, "incoming": incoming}


def amount_row(staff="TS001", title="Beta Paper", ledger=600.0, file=999.0, month="2026-08-01", name="Person One"):
    return {"staff_id": staff, "name": name, "title": title, "ledger_amount": ledger, "file_amount": file, "month": month}


def note(kind, row, status=None, **fields):
    svc.record_conflicts(kind, [row], "file.xlsx")
    c = ImportConflict.objects.get(key=svc.conflict_key(kind, row))
    if status or fields:
        ImportConflict.objects.filter(pk=c.pk).update(**({"status": status} if status else {}), **fields)
        c.refresh_from_db()
    return c


class Base(TestCase):
    def setUp(self):
        self.admin = mk("Super", "super@x.edu", role=Role.SUPER_ADMIN)
        self.cell = mk("Cell", "cell@x.edu", role=Role.RESEARCH_CELL)
        self.fac = mk("Faculty", "fac@x.edu", staff_id="TS777")
        self.two = mk("Conflict Two", "old-two@x.edu", staff_id="TS002", scopus_author_id="57999999999")

    def as_user(self, user):
        c = Client()
        c.force_login(user)
        return c

    def resolve(self, user, conflict, action, note_text="", expect=200):
        r = self.as_user(user).post(
            f"{URL}/{conflict.id}/resolve", {"action": action, "note": note_text}, content_type="application/json"
        )
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def audits(self, action):
        return list(AuditLog.objects.filter(action=action).order_by("created_at"))


# ------------------------------------------------------------------ noting them


class NotingFromTheImporters(TestCase):
    def setUp(self):
        mk("Existing One", "one@x.edu", staff_id="TS001", department="CSE", designation="Lecturer", phone="1")
        mk("Conflict Two", "old-two@x.edu", staff_id="TS002", department="CSE", scopus_author_id="57999999999")
        mk("Person One", "p1@x.edu", staff_id="TS001x", department="CSE")
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="ts001", faculty_name="Person One",
                                  paper_title="ALPHA paper.", amount=500)
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="TS001", faculty_name="Person One",
                                  paper_title="Beta Paper", amount=600)

    def faculty(self, dry_run):
        return import_faculty_list(read_faculty_list(faculty_workbook()), dry_run=dry_run, filename="Faculty_List.xlsx")

    def claims(self, dry_run):
        return import_settled_claims(read_settled_claims(settled_workbook()), dry_run=dry_run, filename="Settled.xlsx")

    def test_the_faculty_check_notes_each_conflict_and_changes_nothing_else(self):
        report = self.faculty(dry_run=True)
        self.assertEqual({c["field"] for c in report["conflicts"]}, {"scopus_author_id", "email"})
        keys = set(ImportConflict.objects.values_list("key", flat=True))
        self.assertEqual(keys, {"faculty:TS002:scopus_author_id", "faculty:TS002:email"})
        c = ImportConflict.objects.get(key="faculty:TS002:email")
        self.assertEqual((c.kind, c.status, c.source_file), ("faculty", "open", "Faculty_List.xlsx"))
        self.assertIn(c.payload, report["conflicts"])
        self.assertTrue(User.objects.filter(email="old-two@x.edu").exists())  # the check still rolled back

    def test_the_import_step_notes_the_same_rows_without_doubling_them(self):
        self.faculty(dry_run=True)
        self.faculty(dry_run=False)
        self.faculty(dry_run=False)
        self.assertEqual(ImportConflict.objects.filter(kind="faculty").count(), 2)
        self.assertEqual(ImportConflict.objects.filter(status="open").count(), 2)

    def test_the_settled_check_notes_the_amount_that_differs(self):
        report = self.claims(dry_run=True)
        self.assertEqual([r["title"] for r in report["amount_differs"]], ["Beta Paper"])
        c = ImportConflict.objects.get(kind="amount")
        self.assertTrue(c.key.startswith("amount:TS001:") and c.key.endswith(":2026-08-01"), c.key)
        self.assertEqual(c.payload, report["amount_differs"][0])
        self.assertEqual(PaidLedger.objects.get(paper_title="Beta Paper").amount, 600)  # never changed here

    def test_the_settled_import_step_notes_it_again_as_one(self):
        self.claims(dry_run=True)
        self.claims(dry_run=False)
        self.claims(dry_run=False)
        self.assertEqual(ImportConflict.objects.filter(kind="amount").count(), 1)

    def test_every_differing_amount_is_kept_though_the_report_lists_fewer(self):
        with mock.patch("core.services.settled_claims_import.MAX_AMOUNT_ROWS", 0):
            report = self.claims(dry_run=True)
        self.assertEqual(report["amount_differs"], [])
        self.assertEqual(report["counts"]["amount_differs"], 1)
        self.assertEqual(ImportConflict.objects.filter(kind="amount").count(), 1)

    def test_a_settled_one_stays_settled_until_the_file_says_something_new(self):
        row = amount_row()
        c = note("amount", row, status="resolved", resolution="keep_ledger", resolution_note="checked with Finance")
        out = svc.record_conflicts("amount", [row], "again.xlsx")
        self.assertEqual(out["unchanged"], 1)
        c.refresh_from_db()
        self.assertEqual((c.status, c.resolution), ("resolved", "keep_ledger"))

        out = svc.record_conflicts("amount", [{**row, "file_amount": 1200.0}], "again.xlsx")
        self.assertEqual(out["reopened"], 1)
        c.refresh_from_db()
        self.assertEqual((c.status, c.resolution, c.resolution_note, c.resolved_at), ("open", "", "", None))
        self.assertEqual(c.payload["file_amount"], 1200.0)

    def test_a_faculty_one_reopens_only_when_the_incoming_value_changes(self):
        row = email_row()
        c = note("faculty", row, status="resolved", resolution="keep_app")
        # the app's own value moved, the file did not: still settled
        svc.record_conflicts("faculty", [{**row, "current": "third@x.edu"}], "f.xlsx")
        c.refresh_from_db()
        self.assertEqual(c.status, "resolved")
        # the same address in another case is not a change either
        svc.record_conflicts("faculty", [{**row, "incoming": "TWO@x.edu"}], "f.xlsx")
        c.refresh_from_db()
        self.assertEqual(c.status, "resolved")
        svc.record_conflicts("faculty", [{**row, "incoming": "other@x.edu"}], "f.xlsx")
        c.refresh_from_db()
        self.assertEqual(c.status, "open")

    def test_an_open_one_follows_the_latest_report(self):
        c = note("faculty", email_row())
        svc.record_conflicts("faculty", [email_row(current="newer@x.edu")], "f2.xlsx")
        c.refresh_from_db()
        self.assertEqual((c.status, c.payload["current"], c.source_file), ("open", "newer@x.edu", "f2.xlsx"))

    def test_a_failure_noting_conflicts_never_stops_an_import(self):
        with mock.patch("core.services.import_conflicts.record_conflicts", side_effect=RuntimeError("boom")):
            with self.assertLogs("core.services.import_conflicts", level="ERROR"):
                report = self.faculty(dry_run=True)
        self.assertEqual(report["counts"]["conflicts"], 2)


# ------------------------------------------------------------------ the list


class ListingTests(Base):
    def test_counts_and_rows_and_who_may_read(self):
        a = note("faculty", scopus_row())
        note("faculty", email_row())
        note("amount", amount_row())
        done = note("faculty", scopus_row(staff="TS777", current="1", incoming="2"), status="resolved",
                    resolved_at=dt.datetime.now(dt.timezone.utc))
        r = self.as_user(self.cell).get(URL).json()
        self.assertEqual(r["counts"], {"open": 3, "open_faculty": 2, "open_amount": 1, "open_double_payment": 0, "to_recover": 0, "resolved_week": 1})
        self.assertEqual(len(r["rows"]), 3)
        row = next(x for x in r["rows"] if x["id"] == a.id)
        self.assertEqual((row["field_label"], row["current"], row["incoming"]), ("Scopus author ID", "57999999999", "57000000002"))
        self.assertEqual(row["actions"], ["use_list", "keep_app", "pause_account"])
        amount = next(x for x in r["rows"] if x["kind"] == "amount")
        self.assertEqual((amount["ledger_amount"], amount["file_amount"], amount["actions"]), (600.0, 999.0, ["update_ledger", "keep_ledger"]))
        self.assertEqual(self.as_user(self.cell).get(URL + "?status=resolved").json()["rows"][0]["id"], done.id)
        self.assertEqual(len(self.as_user(self.cell).get(URL + "?kind=amount").json()["rows"]), 1)
        self.assertEqual(len(self.as_user(self.cell).get(URL + "?status=all").json()["rows"]), 4)
        self.assertEqual(self.as_user(self.cell).get(URL + "?status=nope").status_code, 400)
        self.assertEqual(self.as_user(self.fac).get(URL).status_code, 403)

    def test_a_protected_account_is_locked_for_the_office_and_open_for_a_super_admin(self):
        mk("Director", "dir@x.edu", role=Role.DIRECTOR, staff_id="TS900", scopus_author_id="1")
        note("faculty", scopus_row(staff="TS900", current="1", incoming="2", name="Director"))
        row = self.as_user(self.cell).get(URL).json()["rows"][0]
        self.assertEqual(row["actions"], [])
        self.assertIn("super admin", row["locked"])
        row = self.as_user(self.admin).get(URL).json()["rows"][0]
        self.assertIn("use_list", row["actions"])
        self.assertIsNone(row["locked"])

    def test_the_admin_hub_counts_the_open_ones(self):
        note("faculty", scopus_row())
        note("amount", amount_row())
        counts = self.as_user(self.cell).get("/api/admin/hub").json()["counts"]
        self.assertEqual(counts["/admin/conflicts"]["count"], 2)


# ------------------------------------------------------------------ faculty actions


class FacultyActionTests(Base):
    def test_use_list_sets_the_email_and_audits_before_and_after(self):
        c = note("faculty", email_row())
        out = self.resolve(self.cell, c, "use_list", "Confirmed by phone")
        self.assertTrue(out["changed"])
        self.two.refresh_from_db()
        self.assertEqual(self.two.email, "two@x.edu")
        c.refresh_from_db()
        self.assertEqual((c.status, c.resolution, c.resolution_note, c.resolved_by_id), ("resolved", "use_list", "Confirmed by phone", self.cell.id))
        log = self.audits("IMPORT_CONFLICT_RESOLVE")[0]
        detail = json.loads(log.detail_json)
        self.assertEqual((log.actor_id, log.entity, log.entity_id), (self.cell.id, "User", self.two.id))
        self.assertEqual((detail["before"], detail["after"]), ({"email": "old-two@x.edu"}, {"email": "two@x.edu"}))
        self.assertEqual(detail["note"], "Confirmed by phone")
        self.assertNotIn("password", log.detail_json.lower())

    def test_pressing_it_again_changes_and_logs_nothing_more(self):
        c = note("faculty", email_row())
        self.resolve(self.cell, c, "use_list")
        again = self.resolve(self.cell, c, "use_list")
        self.assertFalse(again["changed"])
        self.assertEqual(len(self.audits("IMPORT_CONFLICT_RESOLVE")), 1)
        # a different answer to one already given is refused, not applied
        self.resolve(self.cell, c, "keep_app", expect=409)
        self.two.refresh_from_db()
        self.assertEqual(self.two.email, "two@x.edu")

    def test_an_email_another_account_holds_is_refused(self):
        mk("Holder", "TWO@x.edu", staff_id="TS555")
        c = note("faculty", email_row())
        body = self.resolve(self.cell, c, "use_list", expect=409)
        self.assertIn("Holder", body["detail"])
        self.two.refresh_from_db()
        self.assertEqual(self.two.email, "old-two@x.edu")
        c.refresh_from_db()
        self.assertEqual(c.status, "open")
        self.assertEqual(self.audits("IMPORT_CONFLICT_RESOLVE"), [])

    def test_an_email_held_by_a_switched_off_account_is_refused_too(self):
        mk("Gone", "two@x.edu", staff_id="TS556", active=False)
        c = note("faculty", email_row())
        self.assertIn("switched off", self.resolve(self.cell, c, "use_list", expect=409)["detail"])

    def test_a_bad_email_is_refused(self):
        c = note("faculty", email_row(incoming="not an address"))
        self.resolve(self.cell, c, "use_list", expect=400)

    def test_scopus_id_is_set_and_the_note_to_resync_is_left(self):
        self.two.scopus_profile_status = "confirmed"
        self.two.save()
        c = note("faculty", scopus_row())
        out = self.resolve(self.cell, c, "use_list")
        self.assertTrue(out["resync"])
        self.assertIn("again", out["message"])
        self.two.refresh_from_db()
        self.assertEqual(self.two.scopus_author_id, "57000000002")
        self.assertIn("57000000002", self.two.scopus_author_url)
        self.assertEqual(self.two.scopus_profile_status, "")
        detail = json.loads(self.audits("IMPORT_CONFLICT_RESOLVE")[0].detail_json)
        self.assertTrue(detail["needs_resync"])
        self.assertEqual(detail["before"], {"scopus_author_id": "57999999999"})

    def test_staff_id_is_set_when_nobody_else_has_it(self):
        mk("Odd", "odd@x.edu", staff_id="TS005O")
        c = note("faculty", staff_row())
        self.resolve(self.cell, c, "use_list")
        self.assertEqual(User.objects.get(email="odd@x.edu").staff_id, "TS050")

    def test_staff_id_another_person_has_is_refused_in_any_case(self):
        mk("Odd", "odd@x.edu", staff_id="TS005O")
        mk("Fifty", "fifty@x.edu", staff_id="ts 050")
        c = note("faculty", staff_row())
        self.assertIn("Fifty", self.resolve(self.cell, c, "use_list", expect=409)["detail"])
        self.assertEqual(User.objects.get(email="odd@x.edu").staff_id, "TS005O")

    def test_the_old_staff_id_s_payments_are_named_in_a_warning(self):
        odd = mk("Odd", "odd@x.edu", staff_id="TS005O")
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="TS005O", paper_title="X", amount=1)
        out = self.resolve(self.cell, note("faculty", staff_row()), "use_list")
        self.assertIn("1 payment", out["warning"])
        odd.refresh_from_db()
        self.assertEqual(odd.staff_id, "TS050")

    def test_keep_app_settles_and_changes_nothing(self):
        c = note("faculty", scopus_row())
        out = self.resolve(self.cell, c, "keep_app")
        self.assertFalse(out["changed"])
        self.two.refresh_from_db()
        self.assertEqual(self.two.scopus_author_id, "57999999999")
        c.refresh_from_db()
        self.assertEqual((c.status, c.resolution), ("resolved", "keep_app"))
        self.assertEqual(json.loads(self.audits("IMPORT_CONFLICT_RESOLVE")[0].detail_json)["before"], {"scopus_author_id": "57999999999"})

    def test_a_value_changed_since_the_check_is_refused(self):
        c = note("faculty", scopus_row())
        User.objects.filter(pk=self.two.pk).update(scopus_author_id="57111111111")
        for action in ("use_list", "keep_app"):
            body = self.resolve(self.cell, c, action, expect=409)
            self.assertIn("57111111111", body["detail"])
        self.two.refresh_from_db()
        self.assertEqual(self.two.scopus_author_id, "57111111111")
        c.refresh_from_db()
        self.assertEqual(c.status, "open")

    def test_a_value_already_fixed_by_hand_settles_without_a_change(self):
        c = note("faculty", scopus_row())
        User.objects.filter(pk=self.two.pk).update(scopus_author_id="57000000002")
        out = self.resolve(self.cell, c, "use_list")
        self.assertFalse(out["changed"])
        c.refresh_from_db()
        self.assertEqual(c.status, "resolved")

    def test_an_account_that_has_gone_is_refused(self):
        c = note("faculty", scopus_row(staff="TS404", current="5", incoming="6"))
        self.resolve(self.cell, c, "keep_app", expect=409)

    def test_pause_switches_the_account_off_and_reactivate_back_on(self):
        c = note("faculty", scopus_row())
        self.resolve(self.cell, c, "pause_account", "Until the ID is confirmed")
        self.two.refresh_from_db()
        self.assertFalse(self.two.active)
        c.refresh_from_db()
        self.assertEqual(c.status, "open")  # pausing does not settle it
        self.assertIsNotNone(c.paused_at)
        # the switched-off account cannot use the app
        self.assertEqual(self.as_user(self.two).get("/api/admin/conflicts").status_code, 403)
        row = self.as_user(self.cell).get(URL).json()["rows"][0]
        self.assertTrue(row["paused"])
        self.assertIn("reactivate", row["actions"])
        self.assertNotIn("pause_account", row["actions"])
        # again: nothing more is written
        self.assertFalse(self.resolve(self.cell, c, "pause_account")["changed"])
        self.assertEqual(len(self.audits("IMPORT_CONFLICT_PAUSE")), 1)
        detail = json.loads(self.audits("IMPORT_CONFLICT_PAUSE")[0].detail_json)
        self.assertEqual((detail["before"], detail["after"]), ({"active": True}, {"active": False}))

        self.resolve(self.cell, c, "reactivate")
        self.two.refresh_from_db()
        self.assertTrue(self.two.active)
        c.refresh_from_db()
        self.assertIsNone(c.paused_at)
        self.assertFalse(self.resolve(self.cell, c, "reactivate")["changed"])
        self.assertEqual(len(self.audits("IMPORT_CONFLICT_REACTIVATE")), 1)

    def test_reactivating_one_pause_clears_the_same_persons_other_conflicts(self):
        a = note("faculty", scopus_row())
        b = note("faculty", email_row())
        self.resolve(self.cell, a, "pause_account")
        ImportConflict.objects.filter(pk=b.pk).update(paused_at=dt.datetime.now(dt.timezone.utc))
        self.resolve(self.cell, a, "reactivate")
        b.refresh_from_db()
        self.assertIsNone(b.paused_at)

    def test_only_an_account_paused_here_is_reactivated_here(self):
        User.objects.filter(pk=self.two.pk).update(active=False)
        c = note("faculty", scopus_row())
        self.resolve(self.cell, c, "reactivate", expect=409)
        self.two.refresh_from_db()
        self.assertFalse(self.two.active)

    def test_you_cannot_pause_yourself(self):
        mine = mk("Me", "me@x.edu", role=Role.RESEARCH_CELL, staff_id="TS300", scopus_author_id="3")
        c = note("faculty", scopus_row(staff="TS300", current="3", incoming="4"))
        self.resolve(mine, c, "pause_account", expect=400)
        mine.refresh_from_db()
        self.assertTrue(mine.active)

    def test_a_head_of_department_cannot_come_back_beside_another_head(self):
        a = mk("Head A", "a@x.edu", role=Role.HOD, staff_id="TS410", department="ECE", scopus_author_id="9")
        c = note("faculty", scopus_row(staff="TS410", current="9", incoming="8"))
        self.resolve(self.cell, c, "pause_account")
        mk("Head B", "b@x.edu", role=Role.HOD, staff_id="TS411", department="ECE")
        body = self.resolve(self.cell, c, "reactivate", expect=409)
        self.assertIn("already head", body["detail"])
        a.refresh_from_db()
        self.assertFalse(a.active)

    def test_faculty_may_not_resolve_and_an_unknown_action_is_refused(self):
        c = note("faculty", scopus_row())
        self.resolve(self.fac, c, "keep_app", expect=403)
        self.resolve(self.cell, c, "update_ledger", expect=400)
        r = self.as_user(self.cell).post(f"{URL}/nope/resolve", {"action": "keep_app"}, content_type="application/json")
        self.assertEqual(r.status_code, 404)

    def test_a_protected_account_is_a_super_admin_s_alone(self):
        boss = mk("Principal", "pr@x.edu", role=Role.PRINCIPAL, staff_id="TS901", scopus_author_id="1")
        c = note("faculty", scopus_row(staff="TS901", current="1", incoming="2", name="Principal"))
        for action in ("use_list", "keep_app", "pause_account"):
            body = self.resolve(self.cell, c, action, expect=403)
            self.assertIn("super admin", body["detail"])
        boss.refresh_from_db()
        self.assertEqual((boss.scopus_author_id, boss.active), ("1", True))
        c.refresh_from_db()
        self.assertEqual(c.status, "open")
        self.assertEqual(len(self.audits("USER_ACTION_REFUSED")), 3)  # the refusals are kept
        self.resolve(self.admin, c, "use_list")
        boss.refresh_from_db()
        self.assertEqual(boss.scopus_author_id, "2")


# ------------------------------------------------------------------ amount actions


class AmountActionTests(Base):
    def setUp(self):
        super().setUp()
        self.one = mk("Person One", "p1@x.edu", staff_id="TS001")
        self.row = PaidLedger.objects.create(
            payout_month=dt.date(2026, 8, 1), staff_id="TS001", faculty_name="Person One", paper_title="Beta Paper", amount=600,
            raw_json=json.dumps({"DOI": "10.1/x", "source": "settled_claims_import"}),
        )

    def test_update_ledger_needs_a_note(self):
        c = note("amount", amount_row())
        body = self.resolve(self.cell, c, "update_ledger", "  ", expect=400)
        self.assertIn("why", body["detail"])
        self.row.refresh_from_db()
        self.assertEqual(self.row.amount, 600)

    def test_update_ledger_sets_the_amount_keeps_the_old_one_and_audits(self):
        c = note("amount", amount_row())
        out = self.resolve(self.cell, c, "update_ledger", "Finance sent the corrected sheet")
        self.assertTrue(out["changed"])
        self.row.refresh_from_db()
        self.assertEqual(self.row.amount, 999)
        raw = json.loads(self.row.raw_json)
        self.assertEqual(raw["DOI"], "10.1/x")  # what was there is kept
        (h,) = raw["amount_history"]
        self.assertEqual((h["from"], h["to"], h["by"], h["note"], h["conflict"]), (600, 999, self.cell.id, "Finance sent the corrected sheet", c.id))
        c.refresh_from_db()
        self.assertEqual((c.status, c.resolution), ("resolved", "update_ledger"))
        log = self.audits("IMPORT_CONFLICT_RESOLVE")[0]
        detail = json.loads(log.detail_json)
        self.assertEqual((log.entity, log.entity_id), ("PaidLedger", self.row.id))
        self.assertEqual((detail["before"], detail["after"]), ({"amount": 600}, {"amount": 999}))

    def test_update_ledger_twice_changes_it_once(self):
        c = note("amount", amount_row())
        self.resolve(self.cell, c, "update_ledger", "why")
        self.assertFalse(self.resolve(self.cell, c, "update_ledger", "why")["changed"])
        self.row.refresh_from_db()
        self.assertEqual(len(json.loads(self.row.raw_json)["amount_history"]), 1)
        self.assertEqual(len(self.audits("IMPORT_CONFLICT_RESOLVE")), 1)
        self.resolve(self.cell, c, "keep_ledger", expect=409)

    def test_a_second_correction_adds_to_the_history(self):
        c = note("amount", amount_row())
        self.resolve(self.cell, c, "update_ledger", "first")
        d = note("amount", amount_row(ledger=999.0, file=1200.0, month="2026-09-01"))
        self.resolve(self.cell, d, "update_ledger", "second")
        self.row.refresh_from_db()
        self.assertEqual([h["to"] for h in json.loads(self.row.raw_json)["amount_history"]], [999, 1200])

    def test_keep_ledger_settles_and_changes_nothing(self):
        c = note("amount", amount_row())
        out = self.resolve(self.cell, c, "keep_ledger")
        self.assertFalse(out["changed"])
        self.row.refresh_from_db()
        self.assertEqual(self.row.amount, 600)
        c.refresh_from_db()
        self.assertEqual((c.status, c.resolution), ("resolved", "keep_ledger"))
        self.assertEqual(len(self.audits("IMPORT_CONFLICT_RESOLVE")), 1)

    def test_an_amount_changed_since_the_check_is_refused(self):
        c = note("amount", amount_row())
        PaidLedger.objects.filter(pk=self.row.pk).update(amount=750)
        for action, text in (("update_ledger", "why"), ("keep_ledger", "")):
            body = self.resolve(self.cell, c, action, text, expect=409)
            self.assertIn("changed", body["detail"])
        self.row.refresh_from_db()
        self.assertEqual(self.row.amount, 750)
        c.refresh_from_db()
        self.assertEqual(c.status, "open")

    def test_an_amount_already_corrected_settles_without_a_change(self):
        c = note("amount", amount_row())
        PaidLedger.objects.filter(pk=self.row.pk).update(amount=999)
        self.assertFalse(self.resolve(self.cell, c, "update_ledger", "why")["changed"])

    def test_no_ledger_row_to_change_is_said_plainly(self):
        c = note("amount", amount_row(title="Never Paid Paper"))
        self.assertIn("no ledger row", self.resolve(self.cell, c, "update_ledger", "why", expect=409)["detail"])

    def test_a_payment_that_belongs_to_a_claim_is_not_changed_here(self):
        claim = Claim.objects.create(owner=self.one, status=ClaimStatus.PAID, paper_title="Beta Paper")
        PaidLedger.objects.filter(pk=self.row.pk).update(claim=claim)
        c = note("amount", amount_row())
        self.assertIn("claim", self.resolve(self.cell, c, "update_ledger", "why", expect=409)["detail"])
        self.row.refresh_from_db()
        self.assertEqual(self.row.amount, 600)

    def test_two_rows_for_the_paper_are_told_apart_by_month_or_refused(self):
        PaidLedger.objects.create(payout_month=dt.date(2026, 9, 1), staff_id="TS001", paper_title="Beta Paper", amount=600)
        c = note("amount", amount_row(month="2026-09-01"))
        self.resolve(self.cell, c, "update_ledger", "why")
        self.assertEqual(sorted(PaidLedger.objects.filter(paper_title="Beta Paper").values_list("payout_month", "amount")),
                         [(dt.date(2026, 8, 1), 600), (dt.date(2026, 9, 1), 999)])
        # two rows still at the old amount, none of them for the file's month: the office is told to pick from the ledger
        PaidLedger.objects.create(payout_month=dt.date(2026, 10, 1), staff_id="TS001", paper_title="Beta Paper", amount=600)
        PaidLedger.objects.filter(payout_month=dt.date(2026, 9, 1)).update(amount=600)
        d = note("amount", amount_row(month="2026-07-01", file=1500.0))
        self.assertIn("More than one", self.resolve(self.cell, d, "update_ledger", "why", expect=409)["detail"])

    def test_a_protected_payee_is_a_super_admin_s_alone(self):
        mk("Finance", "fin@x.edu", role=Role.FINANCE, staff_id="TS902")
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="TS902", paper_title="Fin Paper", amount=10)
        c = note("amount", amount_row(staff="TS902", title="Fin Paper", ledger=10.0, file=20.0, name="Finance"))
        self.resolve(self.cell, c, "update_ledger", "why", expect=403)
        self.assertEqual(PaidLedger.objects.get(paper_title="Fin Paper").amount, 10)
        self.resolve(self.admin, c, "update_ledger", "why")
        self.assertEqual(PaidLedger.objects.get(paper_title="Fin Paper").amount, 20)

    def test_the_whole_way_from_a_file(self):
        """The check notes it, the office clicks, and the ledger holds the file's amount."""
        mk("Person One", "p1b@x.edu", staff_id="TS001b")
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="ts001", paper_title="ALPHA paper.", amount=500)
        import_settled_claims(read_settled_claims(settled_workbook()), dry_run=True, filename="Settled.xlsx")
        c = ImportConflict.objects.get(kind="amount", status="open")
        self.resolve(self.cell, c, "update_ledger", "File is the accounts office's")
        self.assertEqual(PaidLedger.objects.get(paper_title="Beta Paper").amount, 999)
        again = import_settled_claims(read_settled_claims(settled_workbook()), dry_run=True)
        self.assertEqual(again["counts"]["amount_differs"], 0)
