"""Admin A: Home's attention list, the readiness checklist, the data-fix queue,
Track's amount notes and "Why this amount"."""
from datetime import timedelta

from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from core.models import Claim, ClaimStatus, FormulaConfig, PaidLedger, Role, User


def make(role, n, **kw):
    return User.objects.create_user(
        email=f"a{n}@x.edu", password="p", name=f"Person {n}", role=role, department=kw.pop("department", "CSE"), **kw
    )


class Base(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = make(Role.SUPER_ADMIN, 1)
        self.faculty = make(Role.FACULTY, 2)
        self.c = Client()
        self.c.force_login(self.admin)

    def as_(self, user):
        c = Client()
        c.force_login(user)
        return c


class ReadinessChecks(Base):
    def test_each_empty_desk_is_reported_with_where_to_fix_it(self):
        body = self.c.get("/api/admin/readiness").json()
        by = {i["key"]: i for i in body["items"]}
        self.assertEqual(body["total"], 10)
        # The daily money check has not run on a fresh install, and says so.
        self.assertFalse(by["safeguards"]["ok"])
        self.assertEqual(by["safeguards"]["to"], "/safeguards")
        # The super admin holds the clearing desk; nobody holds the others.
        self.assertTrue(by["desk_clearing"]["ok"])
        for key in ("desk_principal", "desk_director", "desk_finance"):
            self.assertFalse(by[key]["ok"], key)
            self.assertIn("/people?role=", by[key]["to"])
        self.assertFalse(by["policy"]["ok"])
        self.assertFalse(by["backup"]["ok"])
        self.assertTrue(all(i["to"] and i["fix"] for i in body["items"]))

    def test_a_person_in_the_role_turns_the_desk_green(self):
        make(Role.DIRECTOR, 3)
        by = {i["key"]: i for i in self.c.get("/api/admin/readiness").json()["items"]}
        self.assertTrue(by["desk_director"]["ok"])
        self.assertIn("Person 3", by["desk_director"]["detail"])

    def test_an_inactive_person_does_not_count(self):
        make(Role.FINANCE, 3, active=False)
        by = {i["key"]: i for i in self.c.get("/api/admin/readiness").json()["items"]}
        self.assertFalse(by["desk_finance"]["ok"])

    def test_policy_in_force_turns_green(self):
        FormulaConfig.objects.create(name="Policy v9", active=True, author_point_json="{}")
        by = {i["key"]: i for i in self.c.get("/api/admin/readiness").json()["items"]}
        self.assertTrue(by["policy"]["ok"])
        self.assertIn("Policy v9", by["policy"]["detail"])

    def test_only_the_super_admin(self):
        self.assertEqual(self.as_(self.faculty).get("/api/admin/readiness").status_code, 403)


class AttentionShape(Base):
    def test_items_carry_an_action_and_a_real_count_with_its_unit(self):
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED, paper_title="Old", submitted_at=timezone.now() - timedelta(days=30)
        )
        items = {i["key"]: i for i in self.c.get("/api/admin/attention").json()["items"]}
        stale = items["fault_stale_submitted"]
        self.assertEqual(stale["count"], 1)
        self.assertEqual(stale["unit"], "claims")
        self.assertEqual(stale["to"], "/clearing")
        self.assertTrue(stale["action"])
        # The count is not baked into the title.
        self.assertNotIn(": 1", stale["title"])
        self.assertTrue(all(i["action"] for i in items.values()))

    def test_an_empty_desk_is_an_item_that_links_to_the_role(self):
        items = {i["key"]: i for i in self.c.get("/api/admin/attention").json()["items"]}
        self.assertIn("ready_desk_director", items)
        self.assertEqual(items["ready_desk_director"]["to"], "/people?role=DIRECTOR")


class DataFixes(Base):
    def setUp(self):
        super().setUp()
        self.paid_blank = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="Real title", ticket_number="ERP-PROCESSED-10",
            quartile="Q1", status_note="Accounts",
        )
        self.count_only = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="Real title", ticket_number="ERP-PROCESSED-20",
            quartile="Q1", status_note="Student Publication. No Remuneration. Only for count",
        )
        self.untitled = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED, paper_title="-", ticket_number="ERP-RAW-3",
            quartile="Q2", remuneration=1000,
        )
        self.own_filed = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED, paper_title="", ticket_number="FP-2026-000001",
        )

    def test_counts_only_old_erp_claims_and_skips_count_only_payments(self):
        body = self.c.get("/api/admin/data-fixes").json()
        q = {x["key"]: x["count"] for x in body["queues"]}
        self.assertEqual(q["paid_no_amount"], 1)  # the count-only one is not a lost figure
        self.assertEqual(q["untitled"], 1)  # a claim filed here is not an import gap
        self.assertEqual(body["claims_needing_a_fix"], 2)
        numbers = {r["ticket_number"] for r in body["rows"]}
        self.assertEqual(numbers, {"ERP-PROCESSED-10", "ERP-RAW-3"})

    def test_a_claim_with_two_problems_is_one_row(self):
        Claim.objects.filter(pk=self.untitled.pk).update(status=ClaimStatus.PAID, remuneration=0)
        body = self.c.get("/api/admin/data-fixes").json()
        row = next(r for r in body["rows"] if r["ticket_number"] == "ERP-RAW-3")
        self.assertEqual({p["key"] for p in row["problems"]}, {"paid_no_amount", "untitled"})
        self.assertEqual(body["claims_needing_a_fix"], 2)

    def test_faculty_are_refused(self):
        self.assertEqual(self.as_(self.faculty).get("/api/admin/data-fixes").status_code, 403)

    def test_track_rows_name_the_fixes_for_the_office_only(self):
        body = self.c.get("/api/track?limit=100").json()
        row = next(r for r in body["results"] if r["ticket_number"] == "ERP-PROCESSED-10")
        self.assertEqual(row["fixes"], ["Amount not recorded"])
        head = make(Role.HOD, 5, department="CSE")
        hb = self.as_(head).get("/api/track?limit=100").json()
        self.assertTrue(all("fixes" not in r for r in hb["results"]))


class TrackAmounts(Base):
    def test_a_paid_claim_with_no_amount_says_why_instead_of_being_blank(self):
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="A", ticket_number="ERP-PROCESSED-1",
            status_note="Accounts", payout_month=timezone.now().date().replace(day=1),
        )
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="B", ticket_number="ERP-PROCESSED-2",
            status_note="Not cited. No renumeration. Processed only for count.",
        )
        rows = {r["ticket_number"]: r for r in self.c.get("/api/track?stage=paid").json()["results"]}
        self.assertEqual(rows["ERP-PROCESSED-1"]["amount_note"], "Not recorded")
        self.assertEqual(rows["ERP-PROCESSED-2"]["amount_note"], "₹0")
        self.assertEqual(rows["ERP-PROCESSED-2"]["amount_reason"], "counted only")
        self.assertEqual(rows["ERP-PROCESSED-1"]["amount_reason"], "in the old ERP")
        self.assertIsNone(rows["ERP-PROCESSED-1"]["amount"])

    def test_an_imported_paid_claim_gives_the_month_not_the_import_day(self):
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="A", ticket_number="ERP-PROCESSED-1",
            paid_at=timezone.now(), payout_month=timezone.now().date().replace(day=1).replace(month=1),
        )
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="B", ticket_number="FP-2026-000009",
            paid_at=timezone.now(), remuneration=500,
        )
        rows = {r["ticket_number"]: r for r in self.c.get("/api/track?stage=paid").json()["results"]}
        self.assertTrue(rows["ERP-PROCESSED-1"]["paid_month_only"])
        self.assertTrue(rows["ERP-PROCESSED-1"]["paid_on"].endswith("-01-01"))
        self.assertFalse(rows["FP-2026-000009"]["paid_month_only"])


class FacultyDirectoryCounts(Base):
    def test_leavers_are_left_out_of_the_list_and_the_counts_until_asked_for(self):
        gone = make(Role.FACULTY, 7, active=False)
        body = self.c.get("/api/directory/faculty").json()
        ids = {r["id"] for r in body["results"]}
        self.assertIn(self.faculty.id, ids)
        self.assertNotIn(gone.id, ids)
        self.assertEqual(body["counts"]["left"], 1)
        # The same population the "what is missing" figures count.
        gaps = self.c.get("/api/directory/faculty/gaps").json()
        self.assertEqual(body["counts"]["people"], gaps["population"])
        self.assertEqual(body["counts"]["no_photo"], next(x for x in gaps["categories"] if x["key"] == "photo")["count"])
        body = self.c.get("/api/directory/faculty?include_left=true").json()
        self.assertIn(gone.id, {r["id"] for r in body["results"]})


class WhyThisAmount(Base):
    def priced(self):
        return Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="Priced", ticket_number="FP-2026-000010",
            snip=1.2, quartile="Q1", qf_amount=50000, base_amount=116000, author_point=0.6, author_position=1,
            total_authors=2, remuneration=69600, remuneration_category="I",
            formula_snapshot_json='{"name": "Policy v1", "version": 1, "snip_multiplier": 55000}',
        )

    def test_lists_each_term_the_policy_and_the_ledger(self):
        c = self.priced()
        PaidLedger.objects.create(claim=c, payout_month=timezone.now().date().replace(day=1), amount=69600, voucher_number="V-1")
        body = self.c.get(f"/api/claims/{c.id}/why-amount").json()
        self.assertTrue(body["priced"])
        self.assertEqual(body["amount"], 69600)
        self.assertEqual(body["policy"]["name"], "Policy v1")
        labels = [t["label"] for t in body["terms"]]
        self.assertIn("SNIP", labels)
        self.assertIn("Quartile incentive", labels)
        self.assertIn("This author's share", labels)
        snip = next(t for t in body["terms"] if t["label"] == "SNIP")
        self.assertIn("₹66,000", snip["detail"])
        self.assertEqual(body["ledger"][0]["voucher"], "V-1")
        self.assertEqual(body["ledger_total"], 69600)
        self.assertNotIn("—", str(body))

    def test_an_imported_amount_with_no_working_says_so(self):
        c = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="Old", ticket_number="ERP-PROCESSED-5",
            remuneration=1600,
        )
        body = self.c.get(f"/api/claims/{c.id}/why-amount").json()
        self.assertFalse(body["priced"])
        self.assertIn("old ERP", body["message"])

    def test_an_old_erp_claim_shows_the_accounts_sheets_own_working(self):
        c = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="Old", ticket_number="ERP-PROCESSED-160",
            remuneration=84966,
        )
        PaidLedger.objects.create(
            claim=c, payout_month=timezone.now().date().replace(day=1), amount=84966,
            raw_json='{"SNIP Value": "2.953", "SJR Quartile": "Q1", "Total No of Authors": "2", "Author Position": "2",'
                     ' "Author Position Points": "0.4", "QF Amount": "50000", "(SNIP * 55000)+QF": "212415", "Amount": "84966"}',
        )
        body = self.c.get(f"/api/claims/{c.id}/why-amount").json()
        self.assertFalse(body["priced"])
        self.assertIn("copied from its accounts sheet", body["message"])
        by = {t["label"]: t for t in body["terms"]}
        self.assertEqual(by["Value of the paper"]["amount"], 212415)
        self.assertIn("Author 2 of 2 takes 0.4", by["This author's share"]["detail"])
        self.assertIn("₹55,000", by["SNIP"]["detail"])

    def test_the_threshold_is_explained_when_a_policy_sets_one(self):
        FormulaConfig.objects.create(name="P", active=True, author_point_json="{}", high_value_threshold=50000)
        body = self.c.get(f"/api/claims/{self.priced().id}/why-amount").json()
        self.assertTrue(body["threshold"]["over"])
        self.assertIn("second signature", body["threshold"]["detail"])

    def test_a_head_of_department_and_faculty_never_get_an_amount(self):
        c = self.priced()
        self.assertEqual(self.as_(make(Role.HOD, 6)).get(f"/api/claims/{c.id}/why-amount").status_code, 403)
        self.assertEqual(self.as_(self.faculty).get(f"/api/claims/{c.id}/why-amount").status_code, 403)

    def test_a_draft_is_not_found(self):
        d = Claim.objects.create(owner=self.faculty, status=ClaimStatus.DRAFT, paper_title="d")
        self.assertEqual(self.c.get(f"/api/claims/{d.id}/why-amount").status_code, 404)


class AuthorMatchTriage(Base):
    """Nearly every unmatched college author matches nobody on the roster; the
    page has to say which few have a likely person, and set the rest aside once."""

    def setUp(self):
        super().setUp()
        from core.models import Authorship, Publication

        self.lav = make(Role.FACULTY, 8)
        self.lav.name = "Dr. G. Lavanya"
        self.lav.save()

        def paper(title, author, oa):
            pub = Publication.objects.create(title=title, normalized_title=title.lower(), year=2024)
            Authorship.objects.create(
                publication=pub, position=1, display_name=author, is_college=True, author_key=oa, openalex_author_id=oa
            )

        paper("One", "G Lavanya", "A1")
        paper("Two", "Venkat Rao", "A2")
        paper("Three", "Kumar Selvam", "A3")

    def test_the_list_can_be_split_by_whether_the_roster_has_a_likely_person(self):
        allof = self.c.get("/api/admin/author-matches").json()
        self.assertEqual(allof["total"], 3)
        self.assertEqual(allof["counts"]["open_suggested"], 1)
        self.assertEqual(allof["counts"]["open_unsuggested"], 2)
        yes = self.c.get("/api/admin/author-matches?suggested=yes").json()
        self.assertEqual([i["names"][0] for i in yes["items"]], ["G Lavanya"])
        no = self.c.get("/api/admin/author-matches?suggested=no").json()
        self.assertEqual(no["total"], 2)
        self.assertTrue(all(not i["suggestions"] for i in no["items"]))

    def test_setting_aside_the_names_with_no_match_leaves_the_likely_one_and_is_reversible(self):
        r = self.c.post("/api/admin/author-matches/hide-unsuggested", content_type="application/json").json()
        self.assertEqual(r["count"], 2)
        left = self.c.get("/api/admin/author-matches").json()
        self.assertEqual(left["total"], 1)
        hidden = self.c.get("/api/admin/author-matches?status=hidden").json()
        self.assertEqual(hidden["total"], 2)
        from core.models import AuditLog

        self.assertEqual(AuditLog.objects.filter(action="AUTHOR_ALIAS_NOT_ROSTER_MANY").count(), 1)
        back = self.c.post(
            "/api/admin/author-matches/restore-all", {"status": "hidden"}, content_type="application/json"
        ).json()
        self.assertEqual(back["count"], 2)
        self.assertEqual(self.c.get("/api/admin/author-matches").json()["total"], 3)

    def test_only_the_office_may_set_names_aside(self):
        r = self.as_(self.faculty).post("/api/admin/author-matches/hide-unsuggested", content_type="application/json")
        self.assertEqual(r.status_code, 403)

    def test_home_says_how_many_have_a_likely_match(self):
        items = {i["key"]: i for i in self.c.get("/api/admin/attention").json()["items"]}
        self.assertEqual(items["author_matches"]["count"], 3)
        self.assertIn("1 has a likely match", items["author_matches"]["why"])