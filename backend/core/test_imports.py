"""The two monthly Excel importers: Faculty_List.xlsx and the settled-claims workbook.

Every workbook here is tiny and made up in the test with openpyxl.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import tempfile
from pathlib import Path

import openpyxl
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import Client, TestCase

from core.models import (
    AuditLog, Authorship, FacultyMaster, PaidLedger, PriorPayment, Publication, Role, User,
)
from core.services.faculty_list_import import import_faculty_list, parse_doj, read_faculty_list
from core.services.settled_claims_import import import_settled_claims, parse_amount, read_settled_claims

FL_HEAD = ["S.No", "Department", "Bio-ID", "Staff-ID", "Scopus ID", "DOJ", "Name of the Staff", "Designation",
           "Phone Number", "Certificate", "Ph.D Pursuing", "Email ID", "Title", "Current Designation"]


def save(wb) -> io.BytesIO:
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out


def faculty_workbook() -> io.BytesIO:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Academic"
    ws.append([])
    ws.append([None, "A title line that is not the header"])
    ws.append([None, *FL_HEAD])  # one blank column in front: columns found by text
    ws.append([None, 1, "cse", 201.0, "TS001", 57000000001.0, "26.04.2021/ \n28.07.2023", "Dr. Existing One",
               "Asst Prof", "9000000001", "Yes", "No", "one@x.edu", "Dr.", "Associate Professor"])
    ws.append([None, 2, "CSE", 202.0, " ts002 ", 57000000002.0, "01.06.2019", "Mr. Conflict Two",
               "Lecturer", None, None, None, "two@x.edu", "Mr.", None])
    ws.append([None, 3, "ECE - R&D", 203.0, "TS003", None, None, "Dr. New Three", "Prof", 9000000003.0,
               None, None, "three@x.edu", "Dr.", "Professor"])
    ws.append([None, 4, "Mech", 204.0, "TS004", None, None, "Mr. No Email Four", "Lecturer", None,
               None, None, "not an email", "Mr.", None])
    ws.append([None] * 15)
    rs = wb.create_sheet("Research")
    rs.append(FL_HEAD)
    rs.append([1, "CSE - R&D", 301.0, "TS005", 57000000005.0, "03.03.2022", "Dr. Research Five", "Research Fellow",
               "9000000005", None, None, "five@x.edu", "Dr.", "Research Associate"])
    return save(wb)


def mk(name, email, **kw):
    return User.objects.create_user(email=email, password="p", name=name, role=kw.pop("role", Role.FACULTY), **kw)


class FacultyListServiceTests(TestCase):
    def setUp(self):
        self.one = mk("Existing One", "one@x.edu", staff_id="TS001", department="CSE", designation="Lecturer",
                      phone="1", active=True)
        # matched by Staff-ID in a different case; holds a different Scopus id and a different email
        self.two = mk("Conflict Two", "old-two@x.edu", staff_id="TS002", department="CSE",
                      scopus_author_id="57999999999")
        self.admin = mk("Office", "office@x.edu", role=Role.SUPER_ADMIN, department="Admin")
        self.gone = mk("Not Listed", "gone@x.edu", staff_id="TS777", department="Mech")
        self.password = self.one.password

    def run_it(self, dry_run):
        return import_faculty_list(read_faculty_list(faculty_workbook()), dry_run=dry_run)

    def test_reads_sheets_and_columns_by_header_text(self):
        people = read_faculty_list(faculty_workbook())
        self.assertEqual([p["staff_id"] for p in people], ["TS001", "ts002", "TS003", "TS004", "TS005"])
        one = people[0]
        self.assertEqual(one["scopus_id"], "57000000001")
        self.assertEqual(one["phone"], "9000000001")
        self.assertEqual(one["current_designation"], "Associate Professor")
        self.assertEqual(one["doj"], "2021-04-26")
        self.assertIn("26.04.2021", one["doj_raw"])
        self.assertTrue(people[4]["research"])
        self.assertEqual(parse_doj("x 31.02.2020 / 05.01.2021"), "2021-01-05")

    def test_dry_run_writes_nothing(self):
        before = (User.objects.count(), FacultyMaster.objects.count())
        r = self.run_it(True)
        self.assertTrue(r["dry_run"])
        self.assertEqual(r["counts"]["created"], 2)
        self.assertEqual((User.objects.count(), FacultyMaster.objects.count()), before)
        self.one.refresh_from_db()
        self.assertEqual(self.one.designation, "Lecturer")
        self.assertIsNone(self.one.scopus_author_id)

    def test_apply_rules(self):
        r = self.run_it(False)
        self.assertEqual(r["sheets"], {"Academic": {"people": 4}, "Research": {"people": 1}})
        # existing account: designation from Current Designation, phone, empty scopus id filled
        self.one.refresh_from_db()
        self.assertEqual(self.one.designation, "Associate Professor")
        self.assertEqual(self.one.phone, "9000000001")
        self.assertEqual(self.one.scopus_author_id, "57000000001")
        self.assertIn("57000000001", self.one.scopus_author_url)
        self.assertEqual(self.one.password, self.password)
        self.assertEqual(self.one.role, Role.FACULTY)
        # conflicts are listed, not written
        self.two.refresh_from_db()
        self.assertEqual(self.two.scopus_author_id, "57999999999")
        self.assertEqual(self.two.email, "old-two@x.edu")
        self.assertEqual(self.two.designation, "Lecturer")  # falls back to Designation
        fields = {(c["staff_id"], c["field"]): c for c in r["conflicts"]}
        self.assertEqual(fields[("ts002", "scopus_author_id")]["current"], "57999999999")
        self.assertEqual(fields[("ts002", "scopus_author_id")]["incoming"], "57000000002")
        self.assertEqual(fields[("ts002", "email")]["incoming"], "two@x.edu")
        self.assertEqual(r["counts"]["conflicts"], 2)
        # a new account
        three = User.objects.get(email="three@x.edu")
        self.assertEqual((three.role, three.faculty_type, three.active, three.must_change_password),
                         (Role.FACULTY, "REGULAR", True, False))
        self.assertTrue(three.has_usable_password())
        self.assertEqual(three.staff_id, "TS003")
        self.assertEqual(three.phone, "9000000003")
        five = User.objects.get(email="five@x.edu")
        self.assertEqual(five.faculty_type, "RESEARCH")
        self.assertEqual(five.department, "CSE")  # the college's own spelling, R&D dropped
        self.assertEqual(three.department, "ECE - R&D")  # matches nothing: kept as given
        self.assertEqual({c["staff_id"] for c in r["created"]}, {"TS003", "TS005"})
        # no email: master row only
        self.assertEqual(r["needs_email"], [{"staff_id": "TS004", "name": "Mr. No Email Four"}])
        self.assertFalse(User.objects.filter(staff_id="TS004").exists())
        self.assertTrue(FacultyMaster.objects.filter(staff_id="TS004").exists())
        # the master row keeps the whole row
        m = FacultyMaster.objects.get(staff_id="TS001")
        raw = json.loads(m.raw_json)
        self.assertEqual(raw["Certificate"], "Yes")
        self.assertEqual(raw["doj_date"], "2021-04-26")
        self.assertEqual(m.designation, "Associate Professor")
        # nobody removed; the unlisted active accounts (admin, TS777) are only counted
        self.assertEqual(r["not_in_list"], 2)
        self.gone.refresh_from_db()
        self.assertTrue(self.gone.active)

    def test_second_run_changes_nothing(self):
        self.run_it(False)
        snapshot = (User.objects.count(), FacultyMaster.objects.count(), AuditLog.objects.count(),
                    sorted(User.objects.values_list("email", "designation", "phone", "scopus_author_id")),
                    sorted(FacultyMaster.objects.values_list("staff_id", "raw_json")))
        again = self.run_it(False)
        self.assertEqual((again["counts"]["created"], again["counts"]["updated"]), (0, 0))
        self.assertEqual(again["counts"]["unchanged"], 4)
        self.assertEqual((again["counts"]["master_created"], again["counts"]["master_updated"]), (0, 0))
        self.assertEqual(again["updated_fields"], {"designation": 0, "phone": 0, "scopus_author_id": 0,
                                                   "email": 0, "staff_id": 0})
        self.assertEqual(snapshot, (User.objects.count(), FacultyMaster.objects.count(), AuditLog.objects.count(),
                                    sorted(User.objects.values_list("email", "designation", "phone", "scopus_author_id")),
                                    sorted(FacultyMaster.objects.values_list("staff_id", "raw_json"))))

    def test_apply_returns_working_one_time_passwords_for_the_new_people_only(self):
        from core.services.issue_passwords import ALPHABET

        r = self.run_it(False)
        creds = {c["staff_id"]: c for c in r["credentials"]}
        self.assertEqual(set(creds), {"TS003", "TS005"})
        self.assertEqual(creds["TS003"]["email"], "three@x.edu")
        self.assertEqual(creds["TS003"]["name"], "Dr. New Three")
        self.assertEqual(set(creds["TS003"]), {"staff_id", "name", "email", "password"})
        for c in creds.values():
            self.assertTrue(12 <= len(c["password"]) <= 14)
            self.assertTrue(set(c["password"]) <= set(ALPHABET))
            u = User.objects.get(email=c["email"])
            self.assertTrue(u.check_password(c["password"]))
            self.assertFalse(u.must_change_password)
        self.assertNotEqual(creds["TS003"]["password"], creds["TS005"]["password"])
        # the people who already had accounts keep their own passwords
        self.one.refresh_from_db()
        self.assertEqual(self.one.password, self.password)
        # the password is nowhere else in the returned report or the stored rows
        stored = json.dumps(r["created"]) + "".join(FacultyMaster.objects.values_list("raw_json", flat=True))
        for c in creds.values():
            self.assertNotIn(c["password"], stored)

    def test_a_check_never_makes_or_returns_passwords(self):
        r = self.run_it(True)
        self.assertEqual(r["counts"]["created"], 2)
        self.assertEqual(r["credentials"], [])
        self.assertFalse(User.objects.filter(email="three@x.edu").exists())

    def test_a_second_run_returns_no_passwords(self):
        self.run_it(False)
        self.assertEqual(self.run_it(False)["credentials"], [])

    def test_account_found_by_email_when_staff_id_is_unknown(self):
        mk("Mail Match", "three@x.edu")  # no staff id yet
        r = self.run_it(False)
        self.assertEqual([c["staff_id"] for c in r["created"]], ["TS005"])
        u = User.objects.get(email="three@x.edu")
        self.assertEqual(u.staff_id, "TS003")
        self.assertEqual(u.designation, "Professor")


def one_person_workbook(staff, email_cell) -> io.BytesIO:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Academic"
    ws.append(FL_HEAD)
    ws.append([1, "CSE", 1, staff, None, None, "Dr. Someone", "Prof", None, None, None, email_cell, "Dr.", None])
    return save(wb)


class FacultyListJunkEmailTests(TestCase):
    def run_for(self, current, cell, dry_run=False):
        u = mk("Someone", current, staff_id="TSX1")
        r = import_faculty_list(read_faculty_list(one_person_workbook("TSX1", cell)), dry_run=dry_run)
        u.refresh_from_db()
        return u, r

    def test_junk_text_is_replaced(self):
        u, r = self.run_for("m.phil., ph.d.,", "good@saveetha.ac.in")
        self.assertEqual(u.email, "good@saveetha.ac.in")
        self.assertEqual(r["updated_fields"]["email"], 1)
        self.assertEqual(r["conflicts"], [])

    def test_imported_local_placeholder_is_replaced_and_college_address_picked(self):
        u, r = self.run_for("erp.tsx1@imported.local", "me@gmail.com, me@saveetha.ac.in")
        self.assertEqual(u.email, "me@saveetha.ac.in")
        self.assertEqual((r["updated_fields"]["email"], r["counts"]["updated"], r["conflicts"]), (1, 1, []))

    def test_dry_run_counts_it_but_writes_nothing(self):
        u, r = self.run_for("erp.tsx1@imported.local", "me@saveetha.ac.in", dry_run=True)
        self.assertEqual(u.email, "erp.tsx1@imported.local")
        self.assertEqual(r["updated_fields"]["email"], 1)

    def test_a_real_differing_email_is_still_a_conflict(self):
        u, r = self.run_for("me@gmail.com", "me@saveetha.ac.in")
        self.assertEqual(u.email, "me@gmail.com")
        self.assertEqual(r["updated_fields"]["email"], 0)
        self.assertEqual([(c["field"], c["current"], c["incoming"]) for c in r["conflicts"]],
                         [("email", "me@gmail.com", "me@saveetha.ac.in")])


class FacultyListEndpointTests(TestCase):
    def setUp(self):
        self.admin = mk("Office", "office@x.edu", role=Role.SUPER_ADMIN)
        self.fac = mk("Faculty", "fac@x.edu", staff_id="TS001")

    def post(self, user, **data):
        c = Client()
        c.force_login(user)
        f = SimpleUploadedFile("Faculty_List.xlsx", faculty_workbook().read())
        return c.post("/api/admin/faculty-list/import", {"file": f, **data})

    def test_faculty_is_refused(self):
        self.assertEqual(self.post(self.fac).status_code, 403)

    def test_dry_run_is_the_default_and_writes_nothing(self):
        r = self.post(self.admin)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["dry_run"])
        self.assertEqual(r.json()["counts"]["created"], 3)
        self.assertEqual(User.objects.count(), 2)
        self.assertFalse(FacultyMaster.objects.exists())
        self.assertFalse(AuditLog.objects.filter(action="FACULTY_LIST_IMPORT").exists())

    def test_apply_writes_and_audits(self):
        r = self.post(self.admin, dry_run="false")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["dry_run"])
        self.assertEqual(User.objects.count(), 5)
        log = AuditLog.objects.get(action="FACULTY_LIST_IMPORT")
        self.assertEqual(json.loads(log.detail_json)["created"], 3)
        creds = r.json()["credentials"]
        self.assertEqual(len(creds), 3)
        for c in creds:
            self.assertTrue(User.objects.get(email=c["email"]).check_password(c["password"]))
            self.assertNotIn(c["password"], log.detail_json)
        again = self.post(self.admin, dry_run="false").json()
        self.assertEqual((again["counts"]["created"], again["counts"]["updated"]), (0, 0))
        self.assertEqual(again["credentials"], [])

    def test_the_check_response_has_no_passwords(self):
        self.assertEqual(self.post(self.admin).json()["credentials"], [])

    def test_bad_file_is_a_400(self):
        c = Client()
        c.force_login(self.admin)
        r = c.post("/api/admin/faculty-list/import", {"file": SimpleUploadedFile("x.xlsx", b"not excel")})
        self.assertEqual(r.status_code, 400)


# ---------------------------------------------------------------- settled claims

SC_HEAD = ["Month", "Overall S No", "Department", "Faculty Name", "Biometric ID", "Faculty ID", "Scopus Article Title",
           "Source Title", "ISSN", "Document Type", "SNIP Value", "Engineering Classification", "SJR Quartile",
           "Scopus ID", "Indexing Status", "Scopus ID Link Status", "Publication Date", "Scopus EID", "DOI",
           "Scopus Article Link", "Subject Area", "Amount", None]
SEP = dt.datetime(2026, 9, 1)
AUG = dt.datetime(2026, 8, 1)


def sc_row(month, sno, staff, title, amount, *, name=None, doi=None, pub=None, notes=None):
    return [month, sno, "CSE", name or f"Person {staff}", 100, staff, title, "Journal of Tests", "1234-5678",
            "Article", 1.5, "Eng", "Q1", 57000000001, "Indexed", "Linked", pub, "2-s2.0-1", doi,
            "https://scopus.example/x", "Computer Science", amount, notes]


def settled_workbook() -> io.BytesIO:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Settled"
    ws.append(SC_HEAD)
    ws.append(sc_row(AUG, 1, "TS001", "Alpha Paper", 500))                         # already on the ledger, same amount
    ws.append(sc_row(AUG, 2, "TS001", "Beta Paper", 999))                          # on the ledger at 600
    ws.append(sc_row(SEP, 3, "TS001", "Gamma Paper", 1000, doi="https://doi.org/10.1/Gamma",
                     pub=dt.datetime(2026, 7, 1)))                                 # new; fills a paper's DOI
    ws.append(sc_row(SEP, 4, "TS009", "Delta Paper", 200, pub=45366))              # new; nobody known; serial date
    ws.append(sc_row(SEP, 5, "TS001", "Epsilon Paper", "N/A"))                     # text amount
    ws.append(sc_row(SEP, 6, "TS001", "Zeta Paper", None, notes="No remuneration"))  # count only
    ws.append(sc_row(SEP, 7, "TS001", "Eta Paper", 0))                             # zero
    ws.append([None] * 23)                                                         # blank row
    ws.append(sc_row(SEP, 8, "TS002", "Another Title Entirely", 300, doi="10.1/PAID"))  # DOI on a prior payment
    return save(wb)


class SettledServiceTests(TestCase):
    def setUp(self):
        self.t1 = mk("Person One", "p1@x.edu", staff_id="TS001", department="CSE")
        self.t2 = mk("Person Two", "p2@x.edu", staff_id="TS002", department="CSE")
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="ts001", faculty_name="Person One",
                                  paper_title="ALPHA paper.", amount=500)
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="TS001", faculty_name="Person One",
                                  paper_title="Beta Paper", amount=600)
        PriorPayment.objects.create(employee_id="TS002", paper_title="Some Other Title",
                                    normalized_title="some other title", doi="10.1/paid", amount_paid=300, raw_json="{}")
        # a paper of that person with no DOI yet
        self.pub = Publication.objects.create(title="Gamma Paper", normalized_title="gamma paper", year=2026)
        Authorship.objects.create(publication=self.pub, display_name="Person One", author_key="n:person one",
                                  user=self.t1)
        # same title, but nobody of ours wrote it: left alone
        self.other = Publication.objects.create(title="Delta Paper", normalized_title="delta paper", year=2026)
        self.rows = read_settled_claims(settled_workbook())

    def test_reads_serial_dates_text_amounts_and_skips_blank_rows(self):
        self.assertEqual(len(self.rows), 8)
        delta = next(r for r in self.rows if r["title"] == "Delta Paper")
        self.assertEqual(delta["pub_date"], dt.date(2024, 3, 15))  # serial 45366
        self.assertEqual(delta["month"], dt.date(2026, 9, 1))
        eps = next(r for r in self.rows if r["title"] == "Epsilon Paper")
        self.assertEqual((eps["amount"], eps["amount_ok"]), (None, False))
        self.assertEqual(next(r for r in self.rows if r["title"] == "Zeta Paper")["notes"], "No remuneration")
        self.assertEqual(parse_amount("1,250"), (1250.0, True))
        self.assertEqual(parse_amount(None), (None, False))
        self.assertEqual(parse_amount("N/A"), (None, False))

    def test_check_classifies_and_writes_nothing(self):
        before = (PaidLedger.objects.count(), PriorPayment.objects.count())
        r = import_settled_claims(self.rows, dry_run=True)
        self.assertEqual(r["rows"], 8)
        self.assertEqual(r["counts"], {
            "already_recorded": 2, "new": 3, "amount_differs": 1, "zero_amount": 2, "unmatched_staff": 1,
            "unparseable_amount": 1, "doi_filled": 1, "skipped_no_title": 0,
        })
        self.assertEqual(r["new_total_amount"], 1200.0)
        self.assertEqual(r["by_month"], [{"month": "2026-09", "new": 5, "amount": 1200.0}])
        self.assertEqual(r["amount_differs"], [{"staff_id": "TS001", "name": "Person TS001", "title": "Beta Paper",
                                                "ledger_amount": 600, "file_amount": 999.0, "month": "2026-08-01"}])
        self.assertEqual(r["unmatched_staff"], [{"staff_id": "TS009", "name": "Person TS009"}])
        self.assertEqual((PaidLedger.objects.count(), PriorPayment.objects.count()), before)
        self.pub.refresh_from_db()
        self.assertFalse(self.pub.doi)

    def test_apply_writes_history_like_the_old_import(self):
        r = import_settled_claims(self.rows, dry_run=False, actor=self.t1)
        self.assertFalse(r["dry_run"])
        ledger = PaidLedger.objects.filter(raw_json__contains="settled_claims_import")
        # Gamma, Delta, Zeta (0), Eta (0); Epsilon has no money so no ledger row
        self.assertEqual(ledger.count(), 4)
        self.assertEqual(sorted(ledger.values_list("amount", flat=True)), [0, 0, 200, 1000])
        gamma = ledger.get(paper_title="Gamma Paper")
        self.assertEqual((gamma.kind, gamma.cycle, gamma.claim_id, gamma.payout_month),
                         ("PAYMENT", 1, None, dt.date(2026, 9, 1)))
        self.assertTrue(gamma.idempotency_key.startswith("settled-import:"))
        self.assertEqual(gamma.staff_id, "TS001")
        raw = json.loads(gamma.raw_json)
        self.assertEqual(raw["Scopus EID"], "2-s2.0-1")
        self.assertEqual(raw["Scopus Article Link"], "https://scopus.example/x")
        self.assertEqual(raw["Subject Area"], "Computer Science")
        zeta = json.loads(ledger.get(paper_title="Zeta Paper").raw_json)
        self.assertEqual(zeta["Notes"], "No remuneration")
        # prior payments: one per written row, the unparseable one with no amount
        priors = PriorPayment.objects.filter(import_batch__isnull=False)
        self.assertEqual(priors.count(), 5)
        eps = priors.get(paper_title="Epsilon Paper")
        self.assertIsNone(eps.amount_paid)
        self.assertEqual(priors.get(paper_title="Gamma Paper").doi, "10.1/gamma")
        # the existing rows were not touched
        self.assertEqual(PaidLedger.objects.get(paper_title="Beta Paper").amount, 600)
        # a DOI filled onto the right paper only
        self.pub.refresh_from_db()
        self.other.refresh_from_db()
        self.assertEqual(self.pub.doi, "10.1/gamma")
        self.assertFalse(self.other.doi)

    def test_second_run_is_all_already_recorded_and_writes_nothing(self):
        import_settled_claims(self.rows, dry_run=False, actor=self.t1)
        counts = (PaidLedger.objects.count(), PriorPayment.objects.count())
        again = import_settled_claims(read_settled_claims(settled_workbook()), dry_run=False, actor=self.t1)
        c = again["counts"]
        self.assertEqual((c["new"], c["zero_amount"], c["doi_filled"], c["unmatched_staff"]), (0, 0, 0, 0))
        self.assertEqual(c["already_recorded"] + c["amount_differs"], 8)
        self.assertEqual(c["amount_differs"], 1)  # Beta, still only reported
        self.assertEqual(again["new_total_amount"], 0)
        self.assertEqual((PaidLedger.objects.count(), PriorPayment.objects.count()), counts)

    def test_co_author_with_the_same_doi_is_not_swallowed(self):
        # The DOI is on person two's payment; person one's row for it is their own payment.
        ws = openpyxl.Workbook().active
        wb = ws.parent
        ws.append(SC_HEAD)
        ws.append(sc_row(SEP, 1, "TS001", "Co-authored Thing", 400, doi="10.1/paid"))
        r = import_settled_claims(read_settled_claims(save(wb)), dry_run=True)
        self.assertEqual(r["counts"]["new"], 1)

    def test_a_paper_twice_in_one_file_is_written_once(self):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(SC_HEAD)
        ws.append(sc_row(SEP, 1, "TS001", "Twice", 100))
        ws.append(sc_row(SEP, 2, "TS001", "twice", 100))
        r = import_settled_claims(read_settled_claims(save(wb)), dry_run=False, actor=self.t1)
        self.assertEqual((r["counts"]["new"], r["counts"]["already_recorded"]), (1, 1))
        self.assertEqual(PaidLedger.objects.filter(paper_title__iexact="twice").count(), 1)


class SettledEndpointTests(TestCase):
    def setUp(self):
        self.admin = mk("Office", "office@x.edu", role=Role.SUPER_ADMIN)
        self.fac = mk("Faculty", "fac@x.edu", staff_id="TS001")

    def post(self, user, **data):
        c = Client()
        c.force_login(user)
        f = SimpleUploadedFile("Claim_Settled.xlsx", settled_workbook().read())
        return c.post("/api/admin/settled-claims/import", {"file": f, **data})

    def test_faculty_is_refused(self):
        self.assertEqual(self.post(self.fac).status_code, 403)

    def test_dry_run_default_then_apply_then_again(self):
        r = self.post(self.admin)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["counts"]["new"], 6)
        self.assertEqual(body["rows"], 8)
        self.assertFalse(PaidLedger.objects.exists())
        self.assertFalse(PriorPayment.objects.exists())
        self.assertFalse(AuditLog.objects.filter(action="SETTLED_CLAIMS_IMPORT").exists())
        r = self.post(self.admin, dry_run="false")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(PaidLedger.objects.count(), 7)
        log = AuditLog.objects.get(action="SETTLED_CLAIMS_IMPORT")
        self.assertEqual(json.loads(log.detail_json)["new"], 6)
        again = self.post(self.admin, dry_run="false").json()
        self.assertEqual((again["counts"]["new"], again["counts"]["already_recorded"]), (0, 8))
        self.assertEqual(PaidLedger.objects.count(), 7)

    def test_bad_file_is_a_400(self):
        c = Client()
        c.force_login(self.admin)
        r = c.post("/api/admin/settled-claims/import", {"file": SimpleUploadedFile("x.xlsx", b"nope")})
        self.assertEqual(r.status_code, 400)


class CommandTests(TestCase):
    def setUp(self):
        mk("Person One", "p1@x.edu", staff_id="TS001", department="CSE")
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def path(self, name, book):
        p = Path(self.dir.name) / name
        p.write_bytes(book.read())
        return str(p)

    def test_commands_check_then_apply(self):
        out = io.StringIO()
        fl = self.path("fl.xlsx", faculty_workbook())
        call_command("import_faculty_list", fl, stdout=out)
        self.assertIn("Check only", out.getvalue())
        self.assertFalse(FacultyMaster.objects.exists())
        call_command("import_faculty_list", fl, "--apply", stdout=out)
        self.assertTrue(FacultyMaster.objects.exists())
        sc = self.path("sc.xlsx", settled_workbook())
        call_command("import_settled_claims", sc, stdout=out)
        self.assertFalse(PaidLedger.objects.exists())
        call_command("import_settled_claims", sc, "--apply", stdout=out)
        self.assertEqual(PaidLedger.objects.count(), 7)
        self.assertTrue(AuditLog.objects.filter(action="SETTLED_CLAIMS_IMPORT").exists())
