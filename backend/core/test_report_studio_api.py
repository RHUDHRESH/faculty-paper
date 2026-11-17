"""The Report studio's endpoints: files, saved reports and sharing, schedules, feeds, AI and templates.

Synthetic data only (see `core.test_report_studio.Studio`).
"""
import csv
import hashlib
import io
import json
from unittest.mock import patch

import openpyxl
from django.core import mail
from django.test import Client, override_settings
from django.utils import timezone
from pypdf import PdfReader

from core.api import report_studio as report_api
from core.models import AuditLog, ReportSchedule, Role, SavedReport
from core.services import ai_harness as harness
from core.services import report_ai, report_engine, report_studio, report_templates
from core.test_report_studio import Studio, claim
from core.models import ClaimStatus


def post(client, path, body=None):
    return client.post(path, data=json.dumps(body if body is not None else {}), content_type="application/json")


def put(client, path, body):
    return client.put(path, data=json.dumps(body), content_type="application/json")


def as_user(user):
    c = Client()
    c.force_login(user)
    return c


MAIL_ON = dict(EMAIL_HOST="smtp.test", EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")

PAPERS = {"dataset": "papers", "columns": ["title", "faculty", "department"]}
MONEY = {"dataset": "claims", "columns": ["claim_no", "claimant", "amount"],
         "filters": [{"field": "claim_no", "op": "not_empty"}]}


class DatasetsAndRunTests(Studio):
    def test_datasets_listing_and_its_shape(self):
        body = as_user(self.office).get("/api/reports/datasets").json()
        self.assertEqual([d["key"] for d in body], ["papers", "claims", "payments", "faculty", "teams"])
        papers = body[0]
        self.assertEqual({"key", "label", "description", "fields", "default_columns"}, set(papers))
        snip = next(f for f in papers["fields"] if f["key"] == "snip")
        self.assertEqual(snip, {"key": "snip", "label": "SNIP", "type": "number",
                                "groupable": True, "aggregatable": True, "filterable": True})
        quartile = next(f for f in papers["fields"] if f["key"] == "quartile")
        self.assertEqual((quartile["type"], quartile["enum_values"]), ("enum", ["Q1", "Q2", "Q3", "Q4"]))
        amount = next(f for f in body[1]["fields"] if f["key"] == "amount")
        self.assertEqual(amount["type"], "money")
        for d in body:
            for f in d["fields"]:
                self.assertIn(f["type"], ("string", "number", "money", "date", "enum", "bool"))
            self.assertTrue(set(d["default_columns"]) <= {f["key"] for f in d["fields"]})

    def test_a_head_is_never_told_money_exists(self):
        body = as_user(self.hod).get("/api/reports/datasets").json()
        self.assertEqual([d["key"] for d in body], ["papers", "claims", "faculty", "teams"])
        for d in body:
            self.assertFalse([f for f in d["fields"] if f["type"] == "money"], d["key"])
        claims = next(d for d in body if d["key"] == "claims")
        self.assertNotIn("paid", {f["key"] for f in claims["fields"]})
        self.assertNotIn("amount", claims["default_columns"])
        self.assertNotIn("amount", json.dumps(body))

    def test_run_shape_and_sign_in(self):
        self.assertEqual(Client().post("/api/reports/run", data="{}", content_type="application/json").status_code, 401)
        r = post(as_user(self.office), "/api/reports/run", {**PAPERS, "sort": [{"field": "title", "dir": "asc"}]})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(set(body), {"columns", "rows", "total_rows", "truncated", "chart_hint", "scope"})
        self.assertEqual(body["columns"][0], {"key": "title", "label": "Title", "type": "string"})
        self.assertEqual(body["rows"][0]["title"], "Graph methods")
        self.assertEqual(body["scope"], "college")

    def test_refusals_are_400_with_a_sentence(self):
        c = as_user(self.office)
        r = post(c, "/api/reports/run", {"dataset": "papers", "columns": ["title", "salary"]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("no field 'salary'", r.json()["detail"])
        r = post(c, "/api/reports/run", {"dataset": "papers", "filters": [{"field": "title", "op": "like", "value": "x"}]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(post(c, "/api/reports/run", {"dataset": "papers", "limit": 99999}).status_code, 400)
        self.assertEqual(post(c, "/api/reports/run", {"dataset": "nope"}).status_code, 400)

    def test_a_head_asking_for_money_is_refused_clearly(self):
        c = as_user(self.hod)
        for body in (
            {"dataset": "claims", "columns": ["claim_no", "amount"]},
            {"dataset": "claims", "filters": [{"field": "amount", "op": "gt", "value": 1}]},
            {"dataset": "claims", "aggregates": [{"field": "amount", "fn": "sum"}]},
        ):
            r = post(c, "/api/reports/run", body)
            self.assertEqual(r.status_code, 400, body)
            self.assertIn("do not see money", r.json()["detail"])
        self.assertEqual(post(c, "/api/reports/run", {"dataset": "payments"}).status_code, 403)

    def test_a_viewing_admin_can_still_run_but_not_save(self):
        c = as_user(self.admin)
        s = c.session
        s["impersonator_id"] = self.admin.pk
        s.save()
        self.assertEqual(post(c, "/api/reports/run", PAPERS).status_code, 200)
        self.assertEqual(post(c, "/api/reports/saved", {"name": "x", "definition": PAPERS}).status_code, 403)


class ExportTests(Studio):
    def export(self, user, **body):
        return post(as_user(user), "/api/reports/export", body)

    def test_xlsx_carries_the_filters_in_a_header_block(self):
        r = self.export(self.office, **PAPERS, format="xlsx", title="CSE papers",
                        filters=[{"field": "department", "op": "eq", "value": "CSE"},
                                 {"field": "year", "op": "between", "value": [2023, 2025]}],
                        sort=[{"field": "title", "dir": "asc"}])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("spreadsheetml", r["Content-Type"])
        self.assertIn("cse-papers-", r["Content-Disposition"])
        ws = openpyxl.load_workbook(io.BytesIO(r.content)).active
        column_a = [ws.cell(row=i, column=1).value for i in range(1, 9)]
        self.assertEqual(column_a[0], "Dataset: Papers")
        self.assertIn("Department is CSE", column_a)
        self.assertIn("Year is between 2023 and 2025", column_a)
        header = next(i for i, v in enumerate(column_a, start=1) if v == "Title")
        self.assertEqual([c.value for c in ws[header]], ["Title", "Faculty", "Department"])
        self.assertEqual(ws.cell(row=header + 1, column=1).value, "Graph methods")
        self.assertEqual(ws.freeze_panes, f"A{header + 1}")
        self.assertEqual(ws.max_row - header, 3)  # Graph methods x2 (two authors), Older work

    def test_pdf_has_the_filters_and_csv_is_a_bare_table(self):
        r = self.export(self.office, **PAPERS, format="pdf", filters=[{"field": "department", "op": "eq", "value": "CSE"}])
        self.assertEqual(r.status_code, 200)
        text = PdfReader(io.BytesIO(r.content)).pages[0].extract_text()
        self.assertIn("Department is CSE", text)
        self.assertIn("Graph methods", text)
        r = self.export(self.office, **PAPERS, format="csv")
        rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
        self.assertEqual(rows[0], ["Title", "Faculty", "Department"])
        self.assertEqual(len(rows), 5)

    def test_files_are_formula_safe(self):
        claim(self.priya, ClaimStatus.SUBMITTED, 1, title='=HYPERLINK("http://x","click")', ticket="FP-9",
              filed_days_ago=1)
        body = {"dataset": "claims", "columns": ["paper", "claimant"],
                "filters": [{"field": "claim_no", "op": "eq", "value": "FP-9"}]}
        rows = list(csv.reader(io.StringIO(self.export(self.office, **body, format="csv").content.decode("utf-8-sig"))))
        self.assertEqual(rows[1][0], "'=HYPERLINK(\"http://x\",\"click\")")
        ws = openpyxl.load_workbook(io.BytesIO(self.export(self.office, **body, format="xlsx").content)).active
        cell = next(c for row in ws.iter_rows() for c in row if isinstance(c.value, str) and "HYPERLINK" in c.value)
        self.assertEqual(cell.data_type, "s")
        self.assertTrue(cell.value.startswith("'="))

    def test_exports_follow_the_same_visibility_and_audit(self):
        self.assertEqual(self.export(self.hod, **MONEY, format="xlsx").status_code, 400)
        r = self.export(self.arun, **PAPERS, format="csv")
        rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
        self.assertEqual(rows[1:], [["Graph methods", "Arun Kumar", "CSE"]])
        self.assertEqual(self.export(self.office, **PAPERS, format="docx").status_code, 400)
        self.assertTrue(AuditLog.objects.filter(action="DATA_EXPORT", entity="Report").exists())

    def test_money_and_year_cells_are_typed(self):
        r = self.export(self.office, dataset="claims", columns=["claim_no", "year", "amount", "filed"],
                        filters=[{"field": "claim_no", "op": "eq", "value": "FP-2"}], format="xlsx")
        ws = openpyxl.load_workbook(io.BytesIO(r.content)).active
        header = next(i for i in range(1, 12) if ws.cell(row=i, column=1).value == "Claim number")
        amount = ws.cell(row=header + 1, column=3)
        self.assertEqual(amount.value, 15000)
        self.assertIn("₹", amount.number_format)
        self.assertEqual(ws.cell(row=header + 1, column=4).number_format, "dd-mmm-yyyy")


class SavedReportTests(Studio):
    def save(self, user, **extra):
        return post(as_user(user), "/api/reports/saved", {"name": "Mine", "definition": PAPERS, **extra})

    def test_crud_by_the_owner(self):
        c = as_user(self.office)
        made = post(c, "/api/reports/saved", {"name": "  Papers  ", "description": "All of them", "definition": PAPERS})
        self.assertEqual(made.status_code, 200, made.content)
        body = made.json()
        self.assertEqual((body["name"], body["visibility"], body["mine"], body["can_edit"]),
                         ("Papers", "private", True, True))
        self.assertEqual(body["definition"]["dataset"], "papers")
        self.assertEqual(body["definition"]["columns"], ["title", "faculty", "department"])
        self.assertEqual(c.get(f"/api/reports/saved/{body['id']}").json()["description"], "All of them")
        changed = put(c, f"/api/reports/saved/{body['id']}", {"name": "Papers v2", "visibility": "everyone"})
        self.assertEqual((changed.json()["name"], changed.json()["visibility"]), ("Papers v2", "everyone"))
        self.assertEqual([r["name"] for r in c.get("/api/reports/saved").json()], ["Papers v2"])
        self.assertEqual(c.delete(f"/api/reports/saved/{body['id']}").status_code, 200)
        self.assertEqual(c.get(f"/api/reports/saved/{body['id']}").status_code, 404)

    def test_a_saved_definition_is_checked_when_it_is_saved(self):
        r = post(as_user(self.office), "/api/reports/saved",
                 {"name": "Bad", "definition": {"dataset": "papers", "columns": ["salary"]}})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(SavedReport.objects.exists())
        self.assertEqual(post(as_user(self.office), "/api/reports/saved", {"name": " ", "definition": PAPERS}).status_code, 400)
        r = post(as_user(self.hod), "/api/reports/saved", {"name": "Money", "definition": MONEY})
        self.assertEqual(r.status_code, 400)

    def test_private_is_private_and_sharing_by_role_and_everyone(self):
        private = self.save(self.office).json()
        by_role = self.save(self.office, name="For heads", visibility="role", roles=["HOD", "PRINCIPAL"]).json()
        for_all = self.save(self.office, name="For all", visibility="everyone").json()

        def names(u):
            return sorted(r["name"] for r in as_user(u).get("/api/reports/saved").json())

        self.assertEqual(names(self.office), ["For all", "For heads", "Mine"])
        self.assertEqual(names(self.hod), ["For all", "For heads"])
        self.assertEqual(names(self.principal), ["For all", "For heads"])
        self.assertEqual(names(self.arun), ["For all"])
        self.assertEqual(as_user(self.arun).get(f"/api/reports/saved/{private['id']}").status_code, 404)
        self.assertEqual(as_user(self.arun).get(f"/api/reports/saved/{by_role['id']}").status_code, 404)
        self.assertEqual(as_user(self.hod).get(f"/api/reports/saved/{by_role['id']}").status_code, 200)
        self.assertEqual(post(as_user(self.arun), f"/api/reports/saved/{private['id']}/run").status_code, 404)
        self.assertEqual(as_user(self.arun).get(f"/api/reports/saved/{for_all['id']}").json()["mine"], False)

    def test_roles_are_checked(self):
        self.assertEqual(self.save(self.office, visibility="role", roles=["WIZARD"]).status_code, 400)
        self.assertEqual(self.save(self.office, visibility="role", roles=[]).status_code, 400)
        self.assertEqual(self.save(self.office, visibility="public").status_code, 400)

    def test_only_the_owner_or_a_super_admin_changes_one(self):
        shared = self.save(self.office, visibility="everyone").json()
        path = f"/api/reports/saved/{shared['id']}"
        self.assertEqual(put(as_user(self.arun), path, {"name": "Mine now"}).status_code, 403)
        self.assertEqual(as_user(self.arun).delete(path).status_code, 403)
        self.assertEqual(put(as_user(self.admin), path, {"name": "Tidied"}).status_code, 200)
        self.assertEqual(as_user(self.admin).delete(path).status_code, 200)

    def test_a_saved_report_runs_as_the_caller_not_the_owner(self):
        shared = post(as_user(self.office), "/api/reports/saved", {
            "name": "Claims", "definition": MONEY, "visibility": "everyone"}).json()
        path = f"/api/reports/saved/{shared['id']}/run"
        office = post(as_user(self.office), path).json()
        self.assertEqual(office["scope"], "college")
        self.assertGreaterEqual(len(office["rows"]), 5)
        mine = post(as_user(self.arun), path).json()
        self.assertEqual(mine["scope"], "own")
        self.assertEqual({r["claimant"] for r in mine["rows"]}, {"Arun Kumar"})
        head = post(as_user(self.hod), path)
        self.assertEqual(head.status_code, 400)
        self.assertIn("do not see money", head.json()["detail"])
        listed = {r["id"]: r for r in as_user(self.hod).get("/api/reports/saved").json()}
        self.assertFalse(listed[shared["id"]]["runnable"])
        self.assertIn("money", listed[shared["id"]]["problem"])

    def test_duplicate_is_a_private_copy_for_the_caller(self):
        shared = self.save(self.office, name="Shared", visibility="everyone").json()
        copy = post(as_user(self.arun), f"/api/reports/saved/{shared['id']}/duplicate")
        self.assertEqual(copy.status_code, 200)
        body = copy.json()
        self.assertEqual((body["name"], body["visibility"], body["mine"]), ("Shared (copy)", "private", True))
        self.assertEqual(SavedReport.objects.get(pk=body["id"]).owner, self.arun)
        self.assertEqual(body["definition"], shared["definition"])
        self.assertEqual(put(as_user(self.arun), f"/api/reports/saved/{body['id']}", {"name": "Edited"}).status_code, 200)


class ScheduleTests(Studio):
    def make(self, owner=None, definition=None, **extra):
        owner = owner or self.office
        report = post(as_user(owner), "/api/reports/saved", {
            "name": "Weekly papers", "definition": definition or PAPERS, "visibility": "everyone"}).json()
        body = {"frequency": "weekly", "day": 0, "hour": 8, "format": "xlsx",
                "recipients": [self.office.pk, self.arun.pk], **extra}
        return report, post(as_user(owner), f"/api/reports/saved/{report['id']}/schedule", body)

    def test_with_email_off_it_is_saved_and_says_so(self):
        report, r = self.make()
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["email_enabled"])
        self.assertIn("not switched on", body["message"])
        self.assertEqual(body["schedule"]["frequency"], "weekly")
        self.assertEqual(sorted(p["id"] for p in body["schedule"]["recipients"]), sorted([self.office.pk, self.arun.pk]))
        mine = as_user(self.office).get("/api/reports/schedules").json()
        self.assertEqual([s["report_id"] for s in mine], [report["id"]])
        self.assertEqual(as_user(self.arun).get("/api/reports/schedules").json(), [])
        self.assertEqual(report_studio.deliver(body["schedule"]["id"])["sent"], 0)
        self.assertEqual(len(mail.outbox), 0)

    def test_the_django_q_job_is_made_replaced_and_removed(self):
        from django_q.models import Schedule

        report, r = self.make(frequency="monthly", day=15, hour=9)
        sid = r.json()["schedule"]["id"]
        job = Schedule.objects.get(name=f"report-schedule-{sid}")
        self.assertEqual((job.func, job.schedule_type, job.repeats), ("core.tasks.send_report_schedule", Schedule.MONTHLY, -1))
        self.assertEqual(job.args, repr(sid))
        local = job.next_run.astimezone(report_studio.IST)
        self.assertEqual((local.day, local.hour), (15, 9))
        # Setting it again changes the same schedule rather than adding another.
        again = post(as_user(self.office), f"/api/reports/saved/{report['id']}/schedule",
                     {"frequency": "weekly", "day": 2, "hour": 7, "format": "csv", "recipients": [self.office.pk]})
        self.assertEqual(again.json()["schedule"]["id"], sid)
        job.refresh_from_db()
        self.assertEqual(job.schedule_type, Schedule.WEEKLY)
        self.assertEqual(job.next_run.astimezone(report_studio.IST).weekday(), 2)
        self.assertEqual(ReportSchedule.objects.count(), 1)
        gone = as_user(self.office).delete(f"/api/reports/saved/{report['id']}/schedule")
        self.assertEqual(gone.status_code, 200)
        self.assertFalse(Schedule.objects.filter(name=f"report-schedule-{sid}").exists())
        self.assertEqual(as_user(self.office).delete(f"/api/reports/saved/{report['id']}/schedule").status_code, 404)

    def test_deleting_the_report_removes_its_jobs(self):
        from django_q.models import Schedule

        report, _ = self.make()
        as_user(self.office).delete(f"/api/reports/saved/{report['id']}")
        self.assertFalse(Schedule.objects.filter(name__startswith="report-schedule-").exists())

    def test_inputs_are_checked(self):
        for extra in ({"frequency": "daily"}, {"day": 7}, {"frequency": "monthly", "day": 29},
                      {"hour": 24}, {"format": "docx"}, {"recipients": []}, {"recipients": ["nobody"]}):
            _, r = self.make(**extra)
            self.assertEqual(r.status_code, 400, extra)
        self.assertEqual(ReportSchedule.objects.count(), 0)

    def test_faculty_can_only_schedule_to_themselves(self):
        report, r = self.make(owner=self.arun, recipients=[self.priya.pk])
        self.assertEqual(r.status_code, 403)
        _, r = self.make(owner=self.arun, recipients=[self.arun.pk])
        self.assertEqual(r.status_code, 200, r.content)

    @override_settings(**MAIL_ON)
    def test_each_recipient_gets_the_report_as_they_see_it(self):
        _, r = self.make(definition={"dataset": "papers", "columns": ["title", "faculty"]})
        sid = r.json()["schedule"]["id"]
        self.assertTrue(r.json()["email_enabled"])
        out = report_studio.deliver(sid)
        self.assertEqual((out["sent"], out["skipped"]), (2, 0))
        self.assertEqual(len(mail.outbox), 2)
        by_to = {m.to[0]: m for m in mail.outbox}

        def sheet(message):
            (name, content, mime), = message.attachments
            self.assertTrue(name.startswith("weekly-papers-") and name.endswith(".xlsx"))
            ws = openpyxl.load_workbook(io.BytesIO(content)).active
            header = next(i for i in range(1, 12) if ws.cell(row=i, column=1).value == "Title")
            return [(ws.cell(row=i, column=1).value, ws.cell(row=i, column=2).value)
                    for i in range(header + 1, ws.max_row + 1)]

        self.assertEqual(len(sheet(by_to[self.office.email])), 4)
        self.assertEqual(sheet(by_to[self.arun.email]), [("Graph methods", "Arun Kumar")])
        self.assertIn("Weekly papers", by_to[self.arun.email].subject)
        row = ReportSchedule.objects.get(pk=sid)
        self.assertEqual(row.last_result, "Sent to 2")
        self.assertIsNotNone(row.last_sent_at)

    @override_settings(**MAIL_ON)
    def test_a_recipient_who_may_not_see_the_report_is_skipped_not_sent_something_else(self):
        _, r = self.make(definition=MONEY, recipients=[self.office.pk, self.hod.pk], format="csv")
        out = report_studio.deliver(r.json()["schedule"]["id"])
        self.assertEqual((out["sent"], out["skipped"]), (1, 1))
        self.assertIn("do not see money", out["problems"][0])
        self.assertEqual([m.to[0] for m in mail.outbox], [self.office.email])
        (name, content, mime), = mail.outbox[0].attachments
        self.assertTrue(name.endswith(".csv"))
        self.assertIn("Amount", content.decode("utf-8-sig") if isinstance(content, bytes) else content)

    def test_the_job_runs_through_the_task_entry_point(self):
        from core import tasks

        _, r = self.make()
        with patch.object(report_studio, "deliver", return_value={"sent": 0}) as deliver:
            self.assertEqual(tasks.send_report_schedule(r.json()["schedule"]["id"]), {"sent": 0})
        deliver.assert_called_once_with(r.json()["schedule"]["id"])
        # A schedule whose row is gone cleans its own job up.
        from django_q.models import Schedule

        report_studio.deliver("gone")
        self.assertFalse(Schedule.objects.filter(name="report-schedule-gone").exists())

    def test_next_run_is_in_the_future_at_the_hour(self):
        from datetime import datetime

        now = datetime(2026, 11, 17, 10, 0, tzinfo=report_studio.IST)  # a Tuesday
        weekly = report_studio.next_run("weekly", 1, 8, now)
        self.assertEqual((weekly.weekday(), weekly.hour, (weekly - now).days), (1, 8, 6))
        self.assertEqual(report_studio.next_run("weekly", 1, 11, now).date(), now.date())
        self.assertEqual(report_studio.next_run("monthly", 3, 8, now).date().isoformat(), "2026-12-03")
        self.assertEqual(report_studio.next_run("monthly", 28, 8, now).date().isoformat(), "2026-11-28")
        self.assertEqual(report_studio.next_run("monthly", 5, 8, datetime(2026, 12, 20, tzinfo=report_studio.IST)
                                                ).date().isoformat(), "2027-01-05")


class FeedTests(Studio):
    def setUp(self):
        self.owner = as_user(self.office)
        self.report = post(self.owner, "/api/reports/saved", {
            "name": "Feed me", "definition": {"dataset": "claims", "columns": ["claim_no", "paper", "amount"],
                                              "filters": [{"field": "claim_no", "op": "not_empty"}],
                                              "sort": [{"field": "claim_no", "dir": "asc"}]}}).json()

    def link(self):
        r = post(self.owner, f"/api/reports/saved/{self.report['id']}/feed")
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()["url"]
        self.assertIn("/api/reports/feed/", url)
        self.assertTrue(url.endswith(".csv"))
        return url, "/api/" + url.split("/api/", 1)[1]

    def test_the_link_returns_csv_without_signing_in_and_stores_only_a_hash(self):
        url, path = self.link()
        token = path.rsplit("/", 1)[1][:-4]
        stored = SavedReport.objects.get(pk=self.report["id"])
        self.assertEqual(stored.feed_token_hash, hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(token, stored.feed_token_hash)
        got = Client().get(path)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got["Content-Type"], "text/csv; charset=utf-8")
        self.assertEqual(got["Cache-Control"], "no-store")
        rows = list(csv.reader(io.StringIO(got.content.decode("utf-8"))))
        self.assertEqual(rows[0], ["Claim number", "Paper", "Amount"])
        self.assertEqual(rows[1], ["FP-1", "Graph methods", "20000.0"])
        self.assertEqual(len(rows), 6)
        self.assertIsNotNone(SavedReport.objects.get(pk=self.report["id"]).feed_last_read_at)

    def test_the_feed_runs_as_its_owner_whoever_reads_it(self):
        _, path = self.link()
        rows = list(csv.reader(io.StringIO(as_user(self.arun).get(path).content.decode("utf-8"))))
        self.assertEqual(len(rows), 6)  # the owner's college-wide view, not the reader's own claims
        self.assertEqual(as_user(self.office).get(f"/api/reports/saved/{self.report['id']}").json()["has_feed"], True)
        self.assertEqual(as_user(self.arun).get(f"/api/reports/saved/{self.report['id']}").status_code, 404)

    def test_only_the_owner_can_make_a_link(self):
        shared = post(self.owner, "/api/reports/saved", {"name": "S", "definition": PAPERS, "visibility": "everyone"}).json()
        self.assertEqual(post(as_user(self.arun), f"/api/reports/saved/{shared['id']}/feed").status_code, 403)

    def test_revocation_and_replacement(self):
        _, first = self.link()
        _, second = self.link()
        self.assertNotEqual(first, second)
        self.assertEqual(Client().get(first).status_code, 404)
        self.assertEqual(Client().get(second).status_code, 200)
        self.assertEqual(self.owner.delete(f"/api/reports/saved/{self.report['id']}/feed").status_code, 200)
        self.assertEqual(Client().get(second).status_code, 404)
        self.assertEqual(Client().get("/api/reports/feed/not-a-token.csv").status_code, 404)
        self.assertFalse(SavedReport.objects.get(pk=self.report["id"]).feed_token_hash)

    def test_a_link_dies_with_its_owner_account_or_the_report(self):
        _, path = self.link()
        self.office.active = False
        self.office.save()
        self.assertEqual(Client().get(path).status_code, 404)
        self.office.active = True
        self.office.save()
        self.assertEqual(Client().get(path).status_code, 200)
        SavedReport.objects.filter(pk=self.report["id"]).delete()
        self.assertEqual(Client().get(path).status_code, 404)

    def test_the_reader_is_rate_limited_per_link(self):
        _, path = self.link()
        with patch.object(report_api, "FEED_TOKEN_HOURLY", 2):
            codes = [Client().get(path).status_code for _ in range(4)]
        self.assertEqual(codes, [200, 200, 429, 429])
        _, other = self.link()  # a new link has its own allowance
        with patch.object(report_api, "FEED_TOKEN_HOURLY", 2):
            self.assertEqual(Client().get(other).status_code, 200)

    def test_cells_that_look_like_formulas_are_quoted(self):
        claim(self.priya, ClaimStatus.SUBMITTED, 1, title="=1+1", ticket="FP-0", filed_days_ago=1)
        claim(self.priya, ClaimStatus.SUBMITTED, 1, title="@SUM(A1)", ticket="FP-00", filed_days_ago=1)
        _, path = self.link()
        text = Client().get(path).content.decode("utf-8")
        self.assertIn("'=1+1", text)
        self.assertIn("'@SUM(A1)", text)
        self.assertNotIn(",=1+1", text)

    def test_a_feed_of_a_head_has_no_money(self):
        hod = as_user(self.hod)
        saved = post(hod, "/api/reports/saved", {"name": "Dept", "definition": PAPERS}).json()
        path = "/api/" + post(hod, f"/api/reports/saved/{saved['id']}/feed").json()["url"].split("/api/", 1)[1]
        rows = list(csv.reader(io.StringIO(Client().get(path).content.decode("utf-8"))))
        self.assertEqual({r[2] for r in rows[1:]}, {"CSE"})


class FakeModel:
    """A stand-in for the provider: replies in order, the last one repeating."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []

    def __call__(self, request):
        self.requests.append(request)
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return harness.Reply(reply)


GOOD = {
    "definition": {
        "dataset": "papers", "group_by": ["department"], "aggregates": [{"fn": "count"}],
        "filters": [{"field": "quartile", "op": "eq", "value": "Q1"}], "sort": [{"field": "count", "dir": "desc"}],
        "top_n": 5,
    },
    "explanation": "Papers in Q1 journals for each department.",
}
INVENTED = {"definition": {"dataset": "papers", "columns": ["title", "salary"]}, "explanation": "Titles and pay."}


class AITests(Studio):
    def setUp(self):
        harness.reset()

    def ask(self, user, model, question="Q1 papers by department"):
        with patch.object(report_ai, "is_configured", return_value=True), \
                patch.object(harness, "provider_transport", model):
            return post(as_user(user), "/api/reports/ai", {"question": question})

    def test_a_valid_definition_comes_back_normalised_with_its_explanation(self):
        model = FakeModel(GOOD)
        r = self.ask(self.office, model)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["explanation"], "Papers in Q1 journals for each department.")
        self.assertEqual(body["definition"]["dataset"], "papers")
        self.assertEqual(body["definition"]["group_by"], ["department"])
        # It is a definition the engine accepts, and the answer ran nothing by itself.
        self.assertEqual(report_engine.run(self.office, body["definition"])["rows"][0]["department"], "CSE")
        self.assertIn("Q1 papers by department", model.requests[0].prompt)
        self.assertRegex(model.requests[0].prompt, r"<<DATA-\w+ the question>>")
        self.assertIn('Dataset "papers"', model.requests[0].system)

    def test_an_invented_field_is_asked_again_and_then_refused(self):
        model = FakeModel(INVENTED)
        r = self.ask(self.office, model)
        self.assertEqual(r.status_code, 422)
        self.assertNotIn("definition", r.json())
        self.assertGreaterEqual(len(model.requests), 2)
        self.assertIn("no field 'salary'", model.requests[1].prompt)

    def test_a_second_try_that_is_valid_is_taken(self):
        model = FakeModel(INVENTED, GOOD)
        r = self.ask(self.office, model)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(model.requests), 2)

    def test_the_model_cannot_smuggle_anything_but_a_definition(self):
        sneaky = {"definition": {**GOOD["definition"], "sql": "DROP TABLE core_user", "raw": "1=1",
                                 "filters": [{"field": "title", "op": "eq", "value": "x'; DROP TABLE core_user; --"}]},
                  "explanation": "Fine."}
        r = self.ask(self.office, FakeModel(sneaky))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.json()["definition"]), {
            "dataset", "columns", "filters", "group_by", "date_bucket", "aggregates", "pivot", "sort", "limit", "top_n"})
        from core.models import User

        self.assertTrue(User.objects.exists())

    def test_a_head_is_not_told_about_money_and_cannot_be_given_it(self):
        model = FakeModel({"definition": {"dataset": "claims", "aggregates": [{"field": "amount", "fn": "sum"}]},
                           "explanation": "Total amounts."})
        r = self.ask(self.hod, model, "How much money did claims cost?")
        self.assertEqual(r.status_code, 422)
        self.assertNotIn("Amount", model.requests[0].system)
        self.assertNotIn('Dataset "payments"', model.requests[0].system)
        self.assertIn("do not see money", model.requests[1].prompt)

    def test_not_set_up_is_501(self):
        with patch.object(report_ai, "is_configured", return_value=False):
            r = post(as_user(self.office), "/api/reports/ai", {"question": "papers by year"})
        self.assertEqual(r.status_code, 501)
        self.assertEqual(r.json(), {"detail": "AI is not set up"})

    def test_a_question_is_needed_and_bounded(self):
        with patch.object(report_ai, "is_configured", return_value=True):
            self.assertEqual(post(as_user(self.office), "/api/reports/ai", {"question": "  "}).status_code, 400)
            self.assertEqual(post(as_user(self.office), "/api/reports/ai", {"question": "x" * 600}).status_code, 400)
        self.assertEqual(Client().post("/api/reports/ai", data="{}", content_type="application/json").status_code, 401)

    def test_an_unreachable_provider_is_a_sentence_not_a_crash(self):
        def down(request):
            raise OSError("no route")

        r = self.ask(self.office, down)
        self.assertIn(r.status_code, (422, 429, 503))
        self.assertIn("detail", r.json())


class TemplateTests(Studio):
    def test_every_template_validates_and_runs_for_the_office(self):
        body = as_user(self.office).get("/api/reports/templates").json()
        self.assertEqual([t["key"] for t in body], [t["key"] for t in report_templates.TEMPLATES])
        self.assertEqual(len(body), 11)
        for t in body:
            with self.subTest(template=t["key"]):
                self.assertEqual(set(t), {"key", "name", "description", "dataset", "definition"})
                out = report_engine.run(self.office, t["definition"])
                self.assertIn("rows", out)
                self.assertEqual(post(as_user(self.office), "/api/reports/run", t["definition"]).status_code, 200)

    def test_the_templates_say_what_they_were_asked_for(self):
        by_key = {t["key"]: t for t in as_user(self.office).get("/api/reports/templates").json()}
        run = lambda key: report_engine.run(self.office, by_key[key]["definition"])  # noqa: E731
        nobody_this_year = run("faculty-with-no-paper-this-year")["rows"]
        self.assertEqual(len(nobody_this_year), 7)   # every active claimant: no paper is dated this year
        self.assertNotIn("Gone Person", [r["name"] for r in nobody_this_year])
        self.assertEqual(len(run("top-10-by-snip")["rows"]), 2)   # only the two rows whose journal has a SNIP
        self.assertEqual(run("top-10-by-amount")["rows"][0]["amount"], 20000.0)
        quartile = run("quartile-by-department")
        self.assertEqual([c["label"] for c in quartile["columns"]][0], "Department")
        scopus = run("scopus-link-coverage")
        self.assertTrue({"Yes", "No"} & {c["label"] for c in scopus["columns"]})
        payments = run("payments-month-on-month")
        self.assertEqual([r["month"] for r in payments["rows"]], ["2025-04", "2025-07", "2026-02"])
        self.assertEqual(run("fyp-teams-with-publications")["rows"][0]["team"], "T1")
        by_ay = run("papers-and-snip-by-academic-year")["rows"]
        self.assertIn({"department": "CSE", "publication_date": "2025-26", "count": 2, "avg_snip": 1.8}, by_ay)

    def test_a_head_is_offered_only_templates_they_may_run(self):
        keys = [t["key"] for t in as_user(self.hod).get("/api/reports/templates").json()]
        self.assertIn("quartile-by-department", keys)
        self.assertNotIn("payments-month-on-month", keys)
        self.assertNotIn("top-10-by-amount", keys)
        self.assertNotIn("claims-waiting-by-stage", keys)
        for t in as_user(self.hod).get("/api/reports/templates").json():
            report_engine.run(self.hod, t["definition"])

    def test_every_template_runs_for_every_role_it_is_offered_to(self):
        for who in (self.office, self.finance, self.principal, self.admin, self.hod, self.arun):
            for t in report_templates.for_user(who):
                with self.subTest(role=who.role, template=t["key"]):
                    report_engine.run(who, t["definition"])
