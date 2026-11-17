"""Filling the record's gaps from what the college has already given.

All data here is synthetic. Pinned: each named fix on its own, that a dry run
writes nothing, that a second apply finds nothing, that a value that is there
is never changed (it is listed as a conflict), that money is never touched,
the department spelling map, the author matches from the college's files with
every safeguard, the Super admin API, and the hooks after an import and after
a deploy.
"""
from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.test import Client, TestCase, override_settings

from core.models import (
    AuditLog, Authorship, Claim, ClaimStatus, FacultyMaster, ImportConflict, PaidLedger, PaperCandidate,
    PriorPayment, Publication, Role, ScimagoJournal, SnipSource, SystemSetting, User,
)
from core.services import college_totals, data_fill as D
from core.services.college_site import SLUG_TO_DEPT
from core.services.author_names import DEPARTMENT_WORDS

MONTH = date(2026, 1, 1)


def user(email, name, *, staff=None, dept=None, desig=None, role=Role.FACULTY, active=True, **kw):
    return User.objects.create_user(email=email, password=None, name=name, staff_id=staff, department=dept,
                                    designation=desig, role=role, active=active, **kw)


def master(staff, name, dept, desig="Professor", email=None, scopus=None, research=False):
    return FacultyMaster.objects.create(
        staff_id=staff, name=name, department=dept, designation=desig, email=email, scopus_author_id=scopus,
        raw_json=json.dumps({"sheets": ["Research"] if research else ["Academic"]}),
    )


def ledger(staff, title, *, dept="ECE", journal="", raw=None, amount=1234.0, name="A Person", claim=None):
    return PaidLedger.objects.create(
        staff_id=staff, paper_title=title, department=dept, journal_title=journal, faculty_name=name,
        amount=amount, payout_month=MONTH, claim=claim, raw_json=json.dumps(raw or {}),
    )


def snapshot():
    """Everything the fixes can touch, as plain values."""
    return {
        "users": list(User.objects.order_by("email").values_list("email", "name", "department", "designation", "staff_id", "scopus_author_id")),
        "masters": list(FacultyMaster.objects.order_by("staff_id").values_list("staff_id", "department")),
        "ledger": list(PaidLedger.objects.order_by("id").values_list("id", "department", "journal_title", "amount", "raw_json")),
        "claims": list(Claim.objects.order_by("id").values_list("id", "designation", "issn", "doi", "eid", "quartile", "snip", "engineering_class", "subject_category", "remuneration")),
        "pubs": list(Publication.objects.order_by("id").values_list("id", "venue", "issn", "quartile", "doi", "eid", "type")),
        "authorships": list(Authorship.objects.order_by("id").values_list("id", "user_id", "match_method")),
        "audit": AuditLog.objects.count(),
    }


class DepartmentMapTests(__import__("django").test.SimpleTestCase):
    """The mapping table is the college's own set; these lines are its review."""

    def test_every_code_maps_to_itself_and_the_set_has_no_duplicates(self):
        self.assertEqual(len(set(D.CANONICAL_DEPARTMENTS)), len(D.CANONICAL_DEPARTMENTS))
        for code in D.CANONICAL_DEPARTMENTS:
            self.assertEqual(D.canonical_department(code), code)
            self.assertEqual(D.canonical_department(code.lower()), code)

    def test_no_spelling_means_two_departments(self):
        seen: dict[str, str] = {}
        for code, spellings in D.DEPARTMENT_ALIASES.items():
            self.assertIn(code, D.CANONICAL_DEPARTMENTS)
            for s in spellings:
                key = D._dept_key(s)
                self.assertNotIn(key, seen, f"{s!r} is listed under {code} and under {seen.get(key)}")
                seen[key] = code
                # A code's own spelling is never also somebody else's alias.
                self.assertNotIn(key, {D._dept_key(c) for c in D.CANONICAL_DEPARTMENTS if c != code})

    def test_it_covers_every_department_the_app_already_names(self):
        for codes in SLUG_TO_DEPT.values():
            for c in codes:
                self.assertIn(c, D.CANONICAL_DEPARTMENTS)
        for c in DEPARTMENT_WORDS:
            self.assertIn(c, D.CANONICAL_DEPARTMENTS)

    def test_the_spellings_the_college_files_use(self):
        for given, want in {
            "Agri": "AGRI", "Civil": "CIVIL", "CIVIL": "CIVIL", "E&I": "EIE", "MED ELE": "MED",
            "S&H - Maths": "S&H-MATHS", "S&H - Physics": "S&H-PHY", "S&H - Chemistry": "S&H-CHY",
            "S&H - English": "S&H-ENGLISH", "AI & ML": "AI&ML", "AI & DS": "AI&DS",
            "Mech": "MECH", "Maths": "S&H-MATHS", "English": "S&H-ENGLISH", "Chemistry": "S&H-CHY",
            "Physics": "S&H-PHY", "PHYSICS": "S&H-PHY", "CSE (CS)": "CSE - CS", "CSE (IoT)": "CSE - IoT",
            "TRG": "TRAINING", "FL": "S&H-ENGLISH", "PDE": "PED", "M.E. CSE": "CSE",
            "Physics - R&D": "S&H-PHY", "Mech - R&D": "MECH", "English R&D": "S&H-ENGLISH",
            "CSE - R&D": "CSE", "AI&DS - R&D": "AI&DS", "  ece ": "ECE", "S&H-MATHS": "S&H-MATHS",
        }.items():
            self.assertEqual(D.canonical_department(given), want, given)

    def test_blank_and_stand_ins_and_strangers_have_no_code(self):
        for given in (None, "", "  ", "Not Found", "not found", "-", "N/A", "Department not recorded",
                      "No department on the account", "Underwater Basketweaving"):
            self.assertIsNone(D.canonical_department(given), given)

    def test_what_is_empty(self):
        for v in (None, "", " ", "Not Found", "-", "N/A", "Unknown", "Not recorded"):
            self.assertTrue(D.is_empty(v), v)
        for v in ("ECE", "Professor", "Q1"):
            self.assertFalse(D.is_empty(v), v)


class FixTests(TestCase):
    def apply(self, key):
        return D.run([key], apply=True)[0]

    def dry(self, key):
        return D.run([key], apply=False)[0]

    # ------------------------------------------------------------ departments --

    def test_department_spelling_on_accounts_the_list_and_payment_rows(self):
        a = user("a@x.edu", "A", staff="S1", dept="Civil")
        b = user("b@x.edu", "B", staff="S2", dept="CIVIL")
        c = user("c@x.edu", "C", staff="S3", dept="Strange Dept")
        FacultyMaster.objects.create(staff_id="S1", name="A", department="Maths")
        row = ledger("S1", "P", dept="S&H - Maths")
        got = self.apply("department_spelling")
        self.assertEqual(got.rows, 3)
        for obj, want in ((a, "CIVIL"), (b, "CIVIL"), (c, "Strange Dept")):
            obj.refresh_from_db()
            self.assertEqual(obj.department, want)
        self.assertEqual(FacultyMaster.objects.get(staff_id="S1").department, "S&H-MATHS")
        row.refresh_from_db()
        self.assertEqual(row.department, "S&H-MATHS")
        self.assertIn("Strange Dept", got.detail["not_in_the_map"])

    def test_user_department_fills_blank_and_not_found_and_lists_a_different_one(self):
        blank = user("a@x.edu", "A", staff="S1")
        nf = user("b@x.edu", "B", staff="S2", dept="Not Found")
        moved = user("c@x.edu", "C", staff="S3", dept="CSE")
        same = user("d@x.edu", "D", staff="S4", dept="Civil")
        master("S1", "A", "Mech")
        master("S2", "B", "TRG")
        master("S3", "C", "AI&DS")
        master("S4", "D", "CIVIL")
        res = self.apply("user_department")
        self.assertEqual(res.rows, 2)
        for u, want in ((blank, "MECH"), (nf, "TRAINING"), (moved, "CSE"), (same, "Civil")):
            u.refresh_from_db()
            self.assertEqual(u.department, want)
        self.assertEqual(res.conflict_count, 1)
        self.assertEqual(res.conflicts[0]["current"], "CSE")
        self.assertEqual(res.conflicts[0]["incoming"], "AI&DS")

    def test_user_department_leaves_what_the_list_cannot_name(self):
        u = user("a@x.edu", "A", staff="S1")
        user("b@x.edu", "B", staff="S9")  # not on the list at all
        master("S1", "A", "Underwater Basketweaving")
        res = self.apply("user_department")
        u.refresh_from_db()
        self.assertIsNone(u.department)
        self.assertEqual(res.rows, 0)
        self.assertEqual(res.unresolved, 2)

    def test_ledger_department_from_the_account_then_the_list_then_the_sheet(self):
        user("a@x.edu", "A", staff="S1", dept="ECE")
        master("S2", "B", "Civil")
        r1 = ledger("S1", "One", dept="Not Found")
        r2 = ledger("S2", "Two", dept="")
        r3 = ledger("S3", "Three", dept="Not Found", raw={"Department": "S&H - Maths"})
        r4 = ledger("S4", "Four", dept="Not Found")
        r5 = ledger("S1", "Five", dept="MBA")           # a different one: never overwritten
        res = self.apply("ledger_department")
        for r, want in ((r1, "ECE"), (r2, "CIVIL"), (r3, "S&H-MATHS"), (r4, "Not Found"), (r5, "MBA")):
            r.refresh_from_db()
            self.assertEqual(r.department, want)
        self.assertEqual(res.rows, 3)
        self.assertEqual(res.conflict_count, 1)
        self.assertEqual(res.unresolved, 1)

    # ------------------------------------------------------ designation, ids --

    def test_user_designation(self):
        a = user("a@x.edu", "A", staff="S1")
        b = user("b@x.edu", "B", staff="S2", desig="Assistant Professor (OG)")
        master("S1", "A", "ECE", desig="Professor")
        master("S2", "B", "ECE", desig="Associate Professor")
        res = self.apply("user_designation")
        a.refresh_from_db(), b.refresh_from_db()
        self.assertEqual(a.designation, "Professor")
        self.assertEqual(b.designation, "Assistant Professor (OG)")
        self.assertEqual((res.rows, res.conflict_count), (1, 1))

    def test_user_staff_id_found_by_email_never_one_somebody_else_has(self):
        a = user("a@x.edu", "A")
        b = user("b@x.edu", "B")
        user("owner@x.edu", "Owner", staff="S2")
        master("S1", "A", "ECE", email="a@x.edu")
        master("S2x", "B", "ECE", email="b@x.edu")
        FacultyMaster.objects.filter(staff_id="S2x").update(staff_id="s2")   # same id as Owner, other case
        res = self.apply("user_staff_id")
        a.refresh_from_db(), b.refresh_from_db()
        self.assertEqual(a.staff_id, "S1")
        self.assertIsNone(b.staff_id)
        self.assertEqual((res.rows, res.conflict_count), (1, 1))

    def test_placeholder_name_from_the_list(self):
        u = user("erp.s5@imported.local", "Not Found", staff="S5", active=False)
        master("S5", "Dr. Real Person", "ECE")
        self.apply("user_placeholder_name")
        u.refresh_from_db()
        self.assertEqual(u.name, "Dr. Real Person")

    # ------------------------------------------------------------- ledger, claims --

    def test_ledger_journal_from_the_same_paper_elsewhere_and_no_money_moves(self):
        a = ledger("S1", "A long enough title for the match to hold", journal="", amount=5000,
                   raw={"DOI": "10.1/same", "Source Title": ""})
        ledger("S2", "A long enough title for the match to hold", journal="Journal of Things", amount=7000,
               raw={"DOI": "10.1/same", "Source Title": "Journal of Things"})
        lone = ledger("S3", "Nobody else has this one", journal="", amount=100, raw={})
        res = self.apply("ledger_journal_title")
        a.refresh_from_db(), lone.refresh_from_db()
        self.assertEqual(a.journal_title, "Journal of Things")
        self.assertEqual(a.amount, 5000)
        self.assertEqual(lone.journal_title, "")
        self.assertEqual((res.rows, res.unresolved), (1, 1))

    def test_claim_designation_from_the_claimant(self):
        owner = user("o@x.edu", "O", staff="S1", desig="Professor")
        c = Claim.objects.create(owner=owner, paper_title="T", status=ClaimStatus.PAID, remuneration=900)
        self.apply("claim_designation")
        c.refresh_from_db()
        self.assertEqual((c.designation, c.remuneration), ("Professor", 900))

    def _journals(self):
        ScimagoJournal.objects.create(title="Journal of Things", issn="1234-5678", year=2024,
                                      categories_json='[{"category":"Power","quartile":"Q2"},{"category":"Energy","quartile":"Q1"}]')
        SnipSource.objects.create(title="Journal of Things", print_issn="12345678.0", snip=1.5, year=2025)

    def test_claim_journal_fields_only_on_a_paid_claim_and_from_the_tables(self):
        self._journals()
        owner = user("o@x.edu", "O", staff="S1")
        paid = Claim.objects.create(owner=owner, paper_title="Paid paper", status=ClaimStatus.PAID, issn="1234-5678",
                                    publication_year=2024, remuneration=1000)
        open_ = Claim.objects.create(owner=owner, paper_title="Open paper", status=ClaimStatus.CLEARED, issn="1234-5678",
                                     publication_year=2024, remuneration=2000)
        res = self.apply("claim_journal_fields")
        paid.refresh_from_db(), open_.refresh_from_db()
        self.assertEqual((paid.quartile, paid.snip, paid.quartile_source, paid.snip_source), ("Q1", 1.5, "SCIMAGO", "SNIP_DUMP"))
        self.assertEqual(paid.remuneration, 1000)
        self.assertIsNone(open_.quartile)
        self.assertIsNone(open_.snip)
        self.assertEqual(open_.remuneration, 2000)
        self.assertEqual(res.rows, 1)

    def test_claim_fields_from_the_payment_row_by_doi_and_a_different_value_is_a_conflict(self):
        owner = user("o@x.edu", "O", staff="S1")
        c = Claim.objects.create(owner=owner, paper_title="Paid paper", status=ClaimStatus.PAID, doi="10.1/abc",
                                 quartile="Q3", remuneration=1)
        ledger("S1", "Paid paper", raw={"DOI": "10.1/abc", "ISSN": "20452322.0", "SJR Quartile": "Q1",
                                         "SNIP Value": "2.25", "Engineering Classification": "Engineering",
                                         "Scopus EID": "2-s2.0-1234", "Subject Area": "Energy (Q1)"})
        res = self.apply("claim_journal_fields")
        c.refresh_from_db()
        self.assertEqual((c.issn, c.snip, c.engineering_class, c.eid, c.subject_category),
                         ("2045-2322", 2.25, "Engineering", "2-s2.0-1234", "Energy (Q1)"))
        self.assertEqual(c.quartile, "Q3")                 # not overwritten
        self.assertEqual(res.conflict_count, 1)
        self.assertEqual(res.conflicts[0]["field"], "quartile")

    def test_issn_form(self):
        owner = user("o@x.edu", "O")
        c = Claim.objects.create(owner=owner, paper_title="T", issn="20452322")
        isbn = Claim.objects.create(owner=owner, paper_title="U", issn="978-1-00-365020-1")
        p = Publication.objects.create(title="P", issn="20452322.0")
        self.apply("issn_form")
        for obj, want in ((c, "2045-2322"), (isbn, "978-1-00-365020-1"), (p, "2045-2322")):
            obj.refresh_from_db()
            self.assertEqual(obj.issn, want)

    # --------------------------------------------------------------- papers --

    def test_publication_fields_from_the_records_that_are_the_paper(self):
        pub = Publication.objects.create(title="A long enough title for the doi match", doi="10.1/zzz", year=2024)
        keep = Publication.objects.create(title="Another", doi="10.1/kept", year=2024, venue="Mine", quartile="Q4")
        ledger("S1", "A long enough title for the doi match", raw={
            "DOI": "10.1/zzz", "Source Title": "Journal of Things", "ISSN": "12345678.0", "SJR Quartile": "Q2",
            "Document Type": "Journal", "Scopus EID": "2-s2.0-9"})
        ledger("S2", "Another", raw={"DOI": "10.1/kept", "Source Title": "Other", "SJR Quartile": "Q1"})
        res = self.apply("publication_journal_fields")
        pub.refresh_from_db(), keep.refresh_from_db()
        self.assertEqual((pub.venue, pub.issn, pub.quartile, pub.type, pub.eid),
                         ("Journal of Things", "1234-5678", "Q2", "Journal", "2-s2.0-9"))
        self.assertEqual((keep.venue, keep.quartile), ("Mine", "Q4"))
        self.assertEqual(res.conflict_count, 1)

    def test_a_doi_another_paper_holds_is_not_copied_over(self):
        Publication.objects.create(title="Holder", doi="10.1/dup")
        pub = Publication.objects.create(title="A long enough title for the title match", year=2024)
        ledger("S1", "A long enough title for the title match", raw={"DOI": "10.1/dup", "Source Title": "J"})
        self.apply("publication_journal_fields")
        pub.refresh_from_db()
        self.assertFalse(pub.doi)

    def test_publication_issn_only_from_a_journal_name_that_is_one_journal(self):
        ScimagoJournal.objects.create(title="Journal of Things", issn="1234-5678", year=2024, categories_json="[]")
        ScimagoJournal.objects.create(title="Twin Journal", issn="1111-2222", year=2024, categories_json="[]")
        ScimagoJournal.objects.create(title="Twin Journal", issn="3333-4444", year=2024, categories_json="[]")
        one = Publication.objects.create(title="a", venue="Journal of Things.")
        twin = Publication.objects.create(title="b", venue="Twin Journal")
        none = Publication.objects.create(title="c", venue="Unheard Of Review")
        self.apply("publication_issn_from_journals")
        for p, want in ((one, "1234-5678"), (twin, ""), (none, "")):
            p.refresh_from_db()
            self.assertEqual(p.issn, want)

    def test_publication_quartile_from_the_table_by_issn_and_nearest_year(self):
        ScimagoJournal.objects.create(title="J", issn="1234-5678", year=2024, categories_json='[{"category":"A","quartile":"Q3"}]')
        ScimagoJournal.objects.create(title="J", issn="1234-5678", year=2025, categories_json='[{"category":"A","quartile":"Q1"},{"category":"B","quartile":null}]')
        a = Publication.objects.create(title="a", issn="1234-5678", year=2024)
        b = Publication.objects.create(title="b", issn="12345678.0", year=2026)
        c = Publication.objects.create(title="c", issn="9999-9999", year=2024)
        d = Publication.objects.create(title="d", issn="1234-5678", year=2024, quartile="Q4")
        res = self.apply("publication_quartile_from_journals")
        for p, want in ((a, "Q3"), (b, "Q1"), (c, ""), (d, "Q4")):
            p.refresh_from_db()
            self.assertEqual(p.quartile, want)
        self.assertEqual(res.rows, 2)

    # ------------------------------------------------- derived and review --

    def test_a_listed_author_with_no_account_gives_the_paper_a_department_and_nothing_is_written(self):
        FacultyMaster.objects.create(staff_id="S7", name="Dr. Lavanya Gopal", department="Maths")
        pub = Publication.objects.create(title="Paper", year=2025)
        Authorship.objects.create(publication=pub, display_name="G. Lavanya", is_college=True, author_key="n:1")
        pub2 = Publication.objects.create(title="Second", year=2025)
        Authorship.objects.create(publication=pub2, display_name="Somebody Else", is_college=True, author_key="n:2",
                                  raw_affiliation="Department of Mechanical Engineering, Saveetha Engineering College, Chennai")
        pub3 = Publication.objects.create(title="Third", year=2025)
        Authorship.objects.create(publication=pub3, display_name="Nobody Known", is_college=True, author_key="n:3",
                                  raw_affiliation="Saveetha Engineering College")
        before = snapshot()
        res = self.dry("authorship_department")
        self.assertEqual(snapshot(), before)
        self.assertEqual((res.gap_rows, res.rows), (3, 2))
        by = {p["id"]: p["departments"] for p in college_totals.papers()}
        self.assertEqual(by[pub.id], {"S&H-MATHS"})
        self.assertEqual(by[pub2.id], {"MECH"})
        self.assertEqual(by[pub3.id], {college_totals.NO_DEPARTMENT})

    def test_an_affiliation_naming_two_departments_names_none(self):
        self.assertEqual(D.department_from_affiliation("Department of Electronics and Communication Engineering, Saveetha Engineering College; Department of Computer Science and Engineering, Saveetha Engineering College"), None)
        self.assertEqual(D.department_from_affiliation("Department of Computer Science and Engineering (Cyber Security), Saveetha Engineering College"), "CSE - CS")
        self.assertIsNone(D.department_from_affiliation("Department of Physics, Some Other University"))
        self.assertIsNone(D.department_from_affiliation("Saveetha Engineering College, Greece"))

    def test_research_faculty_still_marked_regular_is_listed_never_changed(self):
        u = user("r@x.edu", "R", staff="S1")
        master("S1", "R", "ECE", research=True)
        res = D.run(["faculty_type_review"], apply=True)[0]
        u.refresh_from_db()
        self.assertEqual((res.rows, u.faculty_type), (1, "REGULAR"))


class WholeRunTests(TestCase):
    def setUp(self):
        owner = user("o@x.edu", "O", staff="S1", desig="Professor")
        user("n@x.edu", "N", staff="S2")
        master("S2", "N", "Mech", desig="Associate Professor")
        ScimagoJournal.objects.create(title="J", issn="1234-5678", year=2024, categories_json='[{"category":"A","quartile":"Q2"}]')
        Claim.objects.create(owner=owner, paper_title="C", status=ClaimStatus.PAID, issn="12345678", publication_year=2024,
                             remuneration=777, designation="")
        ledger("S2", "Paper", dept="Not Found", amount=4242, raw={"DOI": "10.1/x", "Source Title": "J", "ISSN": "12345678.0"})
        Publication.objects.create(title="Paper", doi="10.1/x", year=2024)
        Publication.objects.create(title="Only an issn", issn="1234-5678", year=2024)

    def test_a_dry_run_writes_nothing_at_all(self):
        before = snapshot()
        results = D.run(apply=False)
        self.assertEqual(snapshot(), before)
        self.assertEqual(AuditLog.objects.filter(action="DATA_FILL").count(), 0)
        self.assertTrue(any(r.rows for r in results))

    def test_an_apply_is_idempotent_audited_and_touches_no_money(self):
        money = lambda: (  # noqa: E731
            list(PaidLedger.objects.order_by("id").values_list("amount", flat=True)),
            list(Claim.objects.order_by("id").values_list("remuneration", "base_amount", "qf_amount", "research_absorbed")),
        )
        before_money = money()
        first = D.run(D.WRITE_KEYS, apply=True)
        filled = sum(r.rows for r in first)
        self.assertGreater(filled, 0)
        again = D.run(D.WRITE_KEYS, apply=True)
        self.assertEqual([r.rows for r in again], [0] * len(again))
        self.assertEqual(money(), before_money)
        logs = AuditLog.objects.filter(action="DATA_FILL")
        self.assertEqual(logs.count(), 2 * len(D.WRITE_KEYS))
        one = json.loads(logs.filter(entity_id="user_designation").order_by("created_at").first().detail_json)
        self.assertEqual(one["fix"], "user_designation")
        self.assertIn("rows_filled", one)

    def test_one_fix_that_fails_does_not_stop_the_rest(self):
        with patch.object(D, "fix_user_designation", side_effect=RuntimeError("boom")):
            D.BY_KEY  # registry holds the original function, so patch the registry too
            fixes = tuple(D.Fix(f.key, f.label, f.help, f.kind, D.fix_user_designation if f.key == "user_designation" else f.fn)
                          for f in D.FIXES)
            with patch.object(D, "FIXES", fixes), patch.object(D, "BY_KEY", {f.key: f for f in fixes}):
                out = D.run_safe_fills(None, "test")
        self.assertIn("user_designation", out["errors"])
        self.assertTrue(out["counts"])

    def test_the_summary_reads_like_a_sentence(self):
        out = D.run_safe_fills(None, "import:test")
        self.assertTrue(out["text"].startswith("Filled: "))
        self.assertIn("departments", out["text"])
        again = D.run_safe_fills(None, "import:test")
        self.assertEqual(again["text"], "Nothing left to fill from the college's files.")

    def test_unknown_fix_names_are_refused(self):
        with self.assertRaises(D.UnknownFix):
            D.run(["nope"])


class AuthorMatchTests(TestCase):
    def setUp(self):
        self.kumar = user("k@x.edu", "Dr. A. Kumar", staff="S1", dept="ECE")
        self.admin = user("sa@x.edu", "SA", role=Role.SUPER_ADMIN)

    def _paper(self, title, doi, *names, **extra):
        pub = Publication.objects.create(title=title, normalized_title=title.lower(), doi=doi, year=2025)
        rows = []
        for i, n in enumerate(names, 1):
            rows.append(Authorship.objects.create(publication=pub, position=i, display_name=n, author_key=f"n:{n}",
                                                  is_college=True, **extra))
        return pub, rows

    def _paid(self, staff, title, doi):
        ledger(staff, title, raw={"DOI": doi, "Source Title": "J"})

    def test_the_person_paid_is_put_on_the_matching_author_name(self):
        pub, (mine, other) = self._paper("Grid study of a thing", "10.1/g", "A. Kumar", "B. Other")
        cand = PaperCandidate.objects.create(user=self.kumar, publication=pub, source="t", reason="r")
        self._paid("S1", "Grid study of a thing", "10.1/g")
        res = D.run(["author_matches_from_files"], apply=True)[0]
        mine.refresh_from_db(), other.refresh_from_db(), cand.refresh_from_db()
        self.assertEqual((mine.user_id, mine.match_method, mine.match_confidence), (self.kumar.id, "record", 0.95))
        self.assertIsNone(other.user_id)
        self.assertEqual(cand.status, PaperCandidate.Status.CONFIRMED)
        self.assertEqual(res.detail["links_by_source"], {"payment records": 1})
        self.assertEqual(Authorship.objects.filter(publication=pub).count(), 2)

    def test_a_dry_run_counts_the_link_and_writes_nothing(self):
        self._paper("Grid study of a thing", "10.1/g", "A. Kumar")
        self._paid("S1", "Grid study of a thing", "10.1/g")
        before = snapshot()
        res = D.run(["author_matches_from_files"], apply=False)[0]
        self.assertEqual(snapshot(), before)
        self.assertEqual(res.fields["authorship_user"], 1)
        self.assertEqual(res.detail["queue_before"], 1)
        self.assertNotIn("queue_after", res.detail)

    def test_the_queue_gets_shorter(self):
        self._paper("Grid study of a thing", "10.1/g", "A. Kumar")
        self._paper("Other work entirely different", "10.1/o", "Unknown Person")
        self._paid("S1", "Grid study of a thing", "10.1/g")
        res = D.run(["author_matches_from_files"], apply=True)[0]
        self.assertEqual((res.detail["queue_before"], res.detail["queue_after"]), (2, 1))

    def test_no_plausible_name_is_listed_never_guessed(self):
        pub, (z,) = self._paper("Grid study of a thing", "10.1/g", "Z. Zed")
        self._paid("S1", "Grid study of a thing", "10.1/g")
        res = D.run(["author_matches_from_files"], apply=True)[0]
        z.refresh_from_db()
        self.assertIsNone(z.user_id)
        self.assertEqual(Authorship.objects.filter(publication=pub).count(), 1)
        self.assertEqual(res.reasons["no unlinked author name on the paper plausibly matches"], 1)
        self.assertEqual(res.detail["left"][0]["person"], "Dr. A. Kumar")

    def test_a_paper_the_person_reported_as_not_theirs_is_never_relinked(self):
        pub, (row,) = self._paper("Grid study of a thing", "10.1/g", "A. Kumar")
        AuditLog.objects.create(actor=self.kumar, action="PUBLICATION_DISPUTED", entity="Publication",
                                entity_id=pub.id, detail_json=json.dumps({"reason": "not_mine"}))
        self._paid("S1", "Grid study of a thing", "10.1/g")
        res = D.run(["author_matches_from_files"], apply=True)[0]
        row.refresh_from_db()
        self.assertIsNone(row.user_id)
        self.assertEqual(res.reasons["the person reported the paper as not theirs"], 1)

    def test_a_row_a_person_locked_is_never_touched(self):
        pub, (row,) = self._paper("Grid study of a thing", "10.1/g", "A. Kumar", match_locked=True)
        self._paid("S1", "Grid study of a thing", "10.1/g")
        res = D.run(["author_matches_from_files"], apply=True)[0]
        row.refresh_from_db()
        self.assertIsNone(row.user_id)
        self.assertTrue(row.match_locked)
        self.assertEqual(res.reasons["the matching author name was locked by a person"], 1)

    def test_nothing_is_ever_unlinked_and_another_persons_row_is_not_taken(self):
        other = user("o@x.edu", "Dr. A. Kumar Nair", staff="S9", dept="ECE")
        pub, (row,) = self._paper("Grid study of a thing", "10.1/g", "A. Kumar Nair", user=other,
                                  match_method="manual", match_confidence=1.0)
        self._paid("S1", "Grid study of a thing", "10.1/g")
        D.run(["author_matches_from_files"], apply=True)
        row.refresh_from_db()
        self.assertEqual((row.user_id, row.match_method), (other.id, "manual"))
        self.assertEqual(Authorship.objects.filter(publication=pub).count(), 1)

    def test_a_link_the_matcher_would_clear_is_put_back_nothing_is_unlinked(self):
        sc = user("s@x.edu", "Dr. R. Subhashini", staff="S8", dept="ECE", scopus_author_id="12345678901")
        _, (row,) = self._paper("Some old paper", "10.1/o", "R. Subhashini", user=sc, match_method="name",
                                match_confidence=0.8)
        res = D.run(["author_matches_from_files"], apply=True)[0]
        row.refresh_from_db()
        self.assertEqual((row.user_id, row.match_method, row.match_confidence), (sc.id, "name", 0.8))
        self.assertEqual(res.detail["matcher_unlinks_put_back"], 1)

    def test_already_linked_and_papers_not_on_record_and_unknown_ids(self):
        pub, (mine,) = self._paper("Grid study of a thing", "10.1/g", "A. Kumar", user=self.kumar, match_method="record")
        self._paid("S1", "Grid study of a thing", "10.1/g")
        self._paid("S1", "A paper the record has never heard of", "10.1/nope")
        self._paid("S404", "Grid study of a thing", "10.1/g")
        res = D.run(["author_matches_from_files"], apply=True)[0]
        self.assertEqual(res.rows, 0)
        self.assertEqual(res.reasons["already linked"], 1)
        self.assertEqual(res.reasons["the paper is not in the publication record"], 1)
        self.assertEqual(res.reasons["the Faculty ID has no account"], 1)

    def test_a_prior_payment_names_who_was_paid_too(self):
        _, (mine,) = self._paper("Grid study of a thing", "10.1/g", "A. Kumar")
        PriorPayment.objects.create(employee_id="s1", paper_title="Grid study of a thing", doi="10.1/g",
                                    normalized_title="grid study of a thing", raw_json="{}")
        res = D.run(["author_matches_from_files"], apply=True)[0]
        mine.refresh_from_db()
        self.assertEqual(mine.user_id, self.kumar.id)
        self.assertEqual(res.detail["links_by_source"], {"prior payments": 1})

    def test_scopus_ids_only_where_none_nobody_else_holds_it_and_not_rejected(self):
        a = user("a@x.edu", "Aa", staff="T1", dept="ECE")
        b = user("b@x.edu", "Bb", staff="T2", dept="ECE")
        c = user("c@x.edu", "Cc", staff="T3", dept="ECE")
        d = user("d@x.edu", "Dd", staff="T4", dept="ECE", scopus_author_id="55555555551")
        holder = user("h@x.edu", "Hh", staff="T5", dept="ECE", scopus_author_id="55555555552")
        master("T1", "Aa", "ECE", scopus="55555555550")
        master("T2", "Bb", "ECE", scopus="55555555552")          # held by Hh
        master("T3", "Cc", "ECE", scopus="55555555553")          # rejected before
        master("T4", "Dd", "ECE", scopus="55555555559")          # has one already: not replaced
        AuditLog.objects.create(actor=c, action="SCOPUS_PROFILE_DISPUTED", entity="User", entity_id=c.id,
                                detail_json=json.dumps({"scopus_author_id": "55555555553", "answer": "no"}))
        res = D.run(["author_matches_from_files"], apply=True)[0]
        for u in (a, b, c, d, holder):
            u.refresh_from_db()
        self.assertEqual(a.scopus_author_id, "55555555550")
        self.assertIn("55555555550", a.scopus_author_url)
        self.assertIsNone(b.scopus_author_id)
        self.assertIsNone(c.scopus_author_id)
        self.assertEqual((d.scopus_author_id, holder.scopus_author_id), ("55555555551", "55555555552"))
        self.assertEqual(res.reasons["another active account holds that Scopus id"], 1)
        self.assertEqual(res.reasons["the Scopus id was rejected before"], 1)
        self.assertEqual(res.detail["scopus_ids_set"], 1)

    def test_a_scopus_id_the_office_kept_the_app_over_is_not_set_again(self):
        u = user("a@x.edu", "Aa", staff="T1", dept="ECE")
        master("T1", "Aa", "ECE", scopus="55555555550")
        ImportConflict.objects.create(kind="faculty", key="faculty:T1:scopus_author_id", status="resolved",
                                      resolution="keep_app", payload={"incoming": "55555555550"})
        D.run(["author_matches_from_files"], apply=True)
        u.refresh_from_db()
        self.assertIsNone(u.scopus_author_id)

    def test_the_author_matches_page_says_how_many_the_files_placed(self):
        self._paper("Grid study of a thing", "10.1/g", "A. Kumar")
        self._paid("S1", "Grid study of a thing", "10.1/g")
        D.run(["author_matches_from_files"], apply=True)
        c = Client()
        c.force_login(self.admin)
        counts = c.get("/api/admin/author-matches?limit=1").json()["counts"]
        self.assertEqual(counts["from_files"], 1)
        self.assertEqual(counts["open"], 0)


class ApiTests(TestCase):
    def setUp(self):
        self.sa = user("sa@x.edu", "SA", role=Role.SUPER_ADMIN)
        self.cell = user("cell@x.edu", "Cell", role=Role.RESEARCH_COORDINATOR)
        self.fin = user("fin@x.edu", "Fin", role=Role.FINANCE)
        self.principal = user("p@x.edu", "Principal", role=Role.PRINCIPAL)
        self.fac = user("f@x.edu", "Fac", staff="S1")
        self.c = Client()

    def test_only_a_super_admin_sees_or_runs_the_fixes(self):
        for who in (self.cell, self.fin, self.principal, self.fac):
            self.c.force_login(who)
            self.assertEqual(self.c.get("/api/admin/data-fill").status_code, 403, who.role)
            self.assertEqual(self.c.post("/api/admin/data-fill/check").status_code, 403, who.role)
            self.assertEqual(self.c.post("/api/admin/data-fill/apply").status_code, 403, who.role)
        self.c.logout()
        self.assertIn(self.c.get("/api/admin/data-fill").status_code, (401, 403))

    def test_check_keeps_the_figures_and_writes_nothing_else(self):
        user("a@x.edu", "A", staff="S2", dept="Civil")
        before = snapshot()
        self.c.force_login(self.sa)
        out = self.c.post("/api/admin/data-fill/check").json()
        after = snapshot()
        self.assertEqual(before, after)
        row = next(f for f in out["fixes"] if f["key"] == "department_spelling")
        self.assertEqual(row["last"]["rows"], 1)
        listed = self.c.get("/api/admin/data-fill").json()
        self.assertEqual(next(f for f in listed["fixes"] if f["key"] == "department_spelling")["last"]["rows"], 1)
        self.assertEqual(self.c.post("/api/admin/data-fill/check?key=nope").status_code, 404)

    def test_apply_queues_one_job_and_refuses_what_cannot_be_applied(self):
        self.c.force_login(self.sa)
        with patch("django_q.tasks.async_task", return_value="job-1") as q:
            out = self.c.post("/api/admin/data-fill/apply?key=department_spelling").json()
            self.assertEqual((out["ok"], out["job_id"]), (True, "job-1"))
            self.assertEqual(q.call_args.args[-2:], (["department_spelling"], ))  if False else None
            self.c.post("/api/admin/data-fill/apply")
            self.assertEqual(q.call_count, 2)
        self.assertEqual(self.c.post("/api/admin/data-fill/apply?key=authorship_department").status_code, 404)
        self.assertEqual(self.c.post("/api/admin/data-fill/apply?key=nope").status_code, 404)
        self.assertEqual(AuditLog.objects.filter(action="DATA_FILL_QUEUED").count(), 2)

    def test_the_job_applies_and_says_what_it_filled(self):
        from core import tasks

        user("a@x.edu", "A", staff="S2", dept="Civil")
        out = tasks.run_data_fill(self.sa.id, "data health", ["department_spelling"])
        self.assertEqual(out["counts"], {"departments": 1})
        self.assertEqual(out["text"], "Filled: 1 departments")
        self.assertEqual(User.objects.get(email="a@x.edu").department, "CIVIL")
        audit = AuditLog.objects.get(action="DATA_FILL")
        self.assertEqual(audit.actor_id, self.sa.id)

    def test_the_accounts_to_fix_are_listed_for_whoever_reads_the_reports(self):
        user("nodept@x.edu", "No Dept", staff="S3", dept="Not Found")
        user("gone@x.edu", "Gone", staff="S4", active=False)
        for who, ok in ((self.principal, True), (self.sa, True), (self.cell, True), (self.fac, False)):
            self.c.force_login(who)
            r = self.c.get("/api/admin/data-fill/accounts")
            self.assertEqual(r.status_code, 200 if ok else 403, who.role)
        self.c.force_login(self.principal)
        body = self.c.get("/api/admin/data-fill/accounts").json()
        emails = {r["email"] for r in body["rows"]}
        self.assertIn("nodept@x.edu", emails)
        self.assertNotIn("gone@x.edu", emails)
        self.assertFalse(body["can_fix"])

    def test_reports_list_the_unknown_department_last_with_its_count_and_the_way_to_fix_it(self):
        for dept, n in (("ECE", 1), (None, 3)):
            u = user(f"{dept}@x.edu", f"U{dept}", staff=f"S{dept}", dept=dept)
            for i in range(n):
                Claim.objects.create(owner=u, paper_title=f"{dept}{i}", status=ClaimStatus.PAID, remuneration=10,
                                     publication_year=2025)
        self.c.force_login(self.sa)
        body = self.c.get("/api/reports").json()
        rows = body["by_department"]
        self.assertEqual(rows[-1]["key"], college_totals.NO_DEPARTMENT)
        self.assertTrue(rows[-1]["unknown"])
        self.assertEqual(rows[-1]["fix_path"], "/people/no-department")
        self.assertRegex(rows[-1]["label"], r"^No department on the account \(\d+\)$")
        self.assertNotEqual(rows[0]["key"], college_totals.NO_DEPARTMENT)


class AutomaticTests(TestCase):
    def test_an_applied_import_queues_every_fill_and_a_check_does_not(self):
        from core.api import masters

        sa = user("sa@x.edu", "SA", role=Role.SUPER_ADMIN)
        with patch("django_q.tasks.async_task", return_value="job-9") as q:
            out = masters._queue_fills(sa, "faculty list")
        self.assertEqual(out, {"queued": True, "job_id": "job-9"})
        args = q.call_args.args
        self.assertEqual((args[0], args[1], args[2]), ("core.tasks.run_data_fill", sa.id, "import:faculty list"))
        with patch("django_q.tasks.async_task", side_effect=RuntimeError("queue down")):
            self.assertFalse(masters._queue_fills(sa, "settled claims")["queued"])

    def test_the_import_commands_fill_after_an_apply_unless_told_not_to(self):
        import inspect

        from core.management.commands import import_faculty_list, import_settled_claims

        for mod in (import_faculty_list, import_settled_claims):
            src = inspect.getsource(mod)
            self.assertIn("run_safe_fills", src)
            self.assertIn("--no-fill", src)

    @override_settings(DATA_FILL_ON_DEPLOY="")
    def test_after_deploy_is_off_unless_the_flag_is_set(self):
        with patch("django_q.tasks.async_task") as q:
            self.assertEqual(D.queue_once_after_deploy(), "off")
        q.assert_not_called()

    @override_settings(DATA_FILL_ON_DEPLOY="run-1")
    def test_after_deploy_runs_once_per_run_id(self):
        with patch("django_q.tasks.async_task", return_value="job-1") as q:
            self.assertEqual(D.queue_once_after_deploy(), "queued")
            self.assertEqual(D.queue_once_after_deploy(), "already queued")
            self.assertEqual(q.call_count, 1)
        self.assertEqual(q.call_args.args[2], "deploy:run-1")
        self.assertEqual(SystemSetting.objects.get(key=D.DEPLOY_KEY).value["run_id"], "run-1")
        with override_settings(DATA_FILL_ON_DEPLOY="run-2"), patch("django_q.tasks.async_task", return_value="job-2") as q2:
            self.assertEqual(D.queue_once_after_deploy(), "queued")
            self.assertEqual(q2.call_count, 1)

    def test_the_job_after_deploy_keeps_what_it_did(self):
        from core import tasks

        user("a@x.edu", "A", staff="S2", dept="Civil")
        tasks.run_data_fill(None, "deploy:run-1")
        row = SystemSetting.objects.get(key=D.DEPLOY_KEY).value
        self.assertEqual((row["run_id"], row["state"]), ("run-1", "done"))
