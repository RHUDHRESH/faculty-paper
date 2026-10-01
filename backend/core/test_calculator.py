"""The incentive calculator (docs/ux/23): price a paper, check a claim, check many.

Three promises are held here.

* It agrees, to the paisa, with `calculate_remuneration` and with what a claim
  is priced at, because it calls them and does no arithmetic of its own.
* It is read-only: no claim, ledger row or audit entry changes.
* Every difference it reports has a cause a person can act on.
"""
from __future__ import annotations

import csv
import io
import itertools
import json
import random
import time
from datetime import date, timedelta
from unittest import mock

from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from core import api as api_module
from core.models import (
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAttachment,
    ClaimStatus,
    FormulaConfig,
    PaidLedger,
    ResearchThreshold,
    Role,
    User,
)
from core.services import calculator as cal
from core.services import research_threshold as rt
from core.services.remuneration import (
    DEFAULT_AUTHOR_POINTS,
    allocate_shares,
    calculate_remuneration,
    calculate_student_project,
    formula_from_model,
    round2,
)

ALLOWED = (
    Role.SUPER_ADMIN,
    Role.RESEARCH_CELL,
    Role.RESEARCH_COORDINATOR,
    Role.PRINCIPAL,
    Role.DIRECTOR,
    Role.FINANCE,
)
REFUSED = (Role.HOD, Role.FACULTY)


def make_policy(active=True, version=1, **over) -> FormulaConfig:
    fields = dict(snip_multiplier=55000, qf_q1=50000)
    fields.update(over)
    return FormulaConfig.objects.create(
        name=f"Policy v{version}", version=version, active=active,
        author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), **fields,
    )


class Base(TestCase):
    def setUp(self):
        cache.clear()
        self.policy = make_policy()
        self.users = {
            role: User.objects.create_user(
                email=f"calc-{role.lower()}@x.edu", name=f"Calc {role}", role=role, department="EEE"
            )
            for role in (*ALLOWED, *REFUSED)
        }
        self.fac = User.objects.create_user(
            email="calc-fac@x.edu", name="Dr. Asha Rao", role=Role.FACULTY, department="ECE"
        )
        self.research = User.objects.create_user(
            email="calc-res@x.edu", name="Dr. Ravi Research", role=Role.FACULTY,
            department="ECE", faculty_type="RESEARCH",
        )
        self.n = 0
        self.admin = self.client_for(Role.SUPER_ADMIN)

    def client_for(self, role) -> Client:
        c = Client()
        c.force_login(self.users[role])
        return c

    def post(self, body, client=None):
        r = (client or self.admin).post("/api/calculator/price", data=json.dumps(body), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def claim(self, owner=None, status=ClaimStatus.SUBMITTED, refs=2, **extra) -> Claim:
        """A claim priced by the real pipeline, so it carries a snapshot."""
        self.n += 1
        fields = dict(
            owner=owner or self.fac, status=status, ticket_number=f"FP-2026-{self.n:06d}",
            paper_title=f"Paper {self.n}", publication_year=2026, quartile="Q1", quartile_source="SCIMAGO",
            snip=1.0, snip_source="SCOPUS", total_authors=2, author_position=1, indexing_level="Scopus",
            publication_type="Journal", engineering_class="Engineering",
            submitted_at=timezone.now() - timedelta(days=self.n),
        )
        fields.update(extra)
        c = Claim.objects.create(**fields)
        for k in range(refs):
            ClaimAttachment.objects.create(
                claim=c, kind=AttachmentKind.SEC_REFERENCE, url=f"/media/claims/{'q' * 31}{k}.pdf", ref_number=str(14 + k)
            )
        api_module._apply_calc(c)
        c.save()
        return c

    def pay(self, c: Claim, ledger=True) -> Claim:
        c.status = ClaimStatus.PAID
        c.payout_month = date(2026, 9, 1)
        c.paid_at = timezone.now()
        c.save()
        if ledger:
            PaidLedger.objects.create(
                claim=c, payout_month=date(2026, 9, 1), amount=c.remuneration or 0,
                faculty_name=c.owner.name, paper_title=c.paper_title, voucher_number=f"V-{c.ticket_number}",
            )
        return c

    def erp(self, no, amount, status=ClaimStatus.PAID, note="Accounts", **extra) -> Claim:
        fields = dict(
            owner=self.fac, status=status, ticket_number=no, paper_title=f"Imported {no}", quartile="Q2", snip=1.65,
            total_authors=6, author_position=2, indexing_level="SCI, Scopus", publication_type="Journal",
            engineering_class="Engineering", remuneration=amount, status_note=note, payout_month=date(2026, 5, 1),
        )
        fields.update(extra)
        return Claim.objects.create(**fields)


class PermissionMatrix(Base):
    ROUTES = (
        ("get", "/api/calculator/options", None),
        ("post", "/api/calculator/price", {"total_authors": 1, "positions": [1]}),
        ("get", "/api/calculator/prefill?q=FP-2026-000001", None),
        ("get", "/api/calculator/people?q=asha", None),
        ("get", "/api/calculator/claim?q=FP-2026-000001", None),
        ("get", "/api/calculator/many", None),
        ("get", "/api/calculator/many.csv", None),
    )

    def call(self, client, method, path, body):
        if method == "post":
            return client.post(path, data=json.dumps(body), content_type="application/json")
        return client.get(path)

    def test_the_six_money_roles_are_let_in(self):
        self.claim()
        for role in ALLOWED:
            c = self.client_for(role)
            for method, path, body in self.ROUTES:
                r = self.call(c, method, path, body)
                self.assertEqual(r.status_code, 200, f"{role} {path} -> {r.status_code}")

    def test_a_head_and_a_faculty_member_get_403_everywhere(self):
        for role in REFUSED:
            c = self.client_for(role)
            for method, path, body in self.ROUTES:
                r = self.call(c, method, path, body)
                self.assertEqual(r.status_code, 403, f"{role} {path} -> {r.status_code}")
                self.assertNotIn("₹", r.content.decode())

    def test_nobody_signed_out_reads_it(self):
        for method, path, body in self.ROUTES:
            r = self.call(Client(), method, path, body)
            self.assertIn(r.status_code, (401, 403))


class Agreement(Base):
    """The calculator's amount is the engine's amount, for a grid of inputs."""

    def engine(self, cfg, case, position):
        return calculate_remuneration(
            case["snip"], case["quartile"], case["total_authors"], position, cfg,
            publication_type=case["publication_type"], indexing_level=case["indexing_level"],
            engineering_class=case["engineering_class"], sec_reference_count=case["sec_reference_count"],
        )

    def grid(self):
        axes = dict(
            snip=[None, 0, 0.05, 0.3, 1.85, 5.5, 31],
            quartile=[None, "Q1", "Q2", "Q3", "Q4", "NO_SNIP"],
            publication_type=["Journal", "Conference Proceeding", "Book Series", "Book Chapter", "Other", None],
            indexing_level=["Scopus", "SCIE", "Scopus, SCIE", "UGC Care", None],
            engineering_class=["Engineering", "Non-Engineering", None, "Pending"],
            total_authors=[1, 2, 3, 6, 9, 10],
            sec_reference_count=[None, 0, 1, 2, 5],
        )
        keys = list(axes)
        cases = [dict(zip(keys, combo)) for combo in itertools.product(*axes.values())]
        random.Random(23).shuffle(cases)
        return cases[:500]

    def test_the_price_is_calculate_remuneration_for_500_inputs(self):
        cfg = formula_from_model(self.policy)
        rng = random.Random(5)
        for case in self.grid():
            position = rng.randint(1, min(case["total_authors"], 9))
            body = {**case, "positions": [position]}
            body = {k: v for k, v in body.items() if v is not None or k in ("snip",)}
            got = self.post(body)
            want = self.engine(cfg, {**{k: None for k in case}, **case}, position)
            label = f"{case} pos {position}"
            if want.error:
                self.assertFalse(got["ok"], label)
                self.assertEqual(got["problem"], want.error, label)
                self.assertIsNone(got["amount"], label)
                continue
            self.assertEqual(got["amount"], want.remuneration, label)
            self.assertEqual(got["paper_value"], want.base, label)
            self.assertEqual(got["category"], want.category, label)
            value = [w for w in got["working"] if w["key"] == "value"]
            if want.base:
                # The working ends where the engine says the paper is worth.
                self.assertEqual(value[0]["amount"], want.base, label)
                share = [w for w in got["working"] if w["key"] == "share"][0]
                self.assertEqual(share["amount"], want.remuneration, label)
            if not want.remuneration:
                self.assertTrue(got["zero_reason"], f"a zero must say why: {label}")

    def test_it_agrees_with_the_filing_estimate_endpoint(self):
        cases = [
            dict(snip=1.85, quartile="Q1", total_authors=3, author_position=2, publication_type="Journal",
                 indexing_level="Scopus", engineering_class="Engineering", sec_reference_count=2),
            dict(snip=None, quartile=None, total_authors=1, author_position=1, publication_type="Conference Proceeding",
                 indexing_level="Scopus", engineering_class="Engineering", sec_reference_count=2),
            dict(snip=0.02, quartile="Q3", total_authors=4, author_position=4, publication_type="Journal",
                 indexing_level="SCIE", engineering_class="Non-Engineering", sec_reference_count=None),
        ]
        for c in cases:
            est = self.admin.post("/api/calculate", data=json.dumps(c), content_type="application/json").json()
            body = {**{k: v for k, v in c.items() if k != "author_position"}, "positions": [c["author_position"]]}
            self.assertEqual(self.post(body)["amount"], est["remuneration"])

    def test_the_student_project_scheme_is_a_fixed_amount_per_team(self):
        cfg = formula_from_model(self.policy)
        for ptype in ("Conference Proceeding", "Journal"):
            got = self.post({"publication_type": ptype, "student_project": True, "total_authors": 4, "positions": [3]})
            want = calculate_student_project(ptype, cfg)
            self.assertEqual(got["amount"], want.remuneration)
        conf = self.post({"publication_type": "Conference Proceeding", "student_project": True, "positions": [1]})
        self.assertEqual(conf["amount"], 15000)
        self.assertIn("fixed", conf["sentence"].lower())
        jour = self.post({"publication_type": "Journal", "student_project": True, "positions": [1]})
        self.assertEqual(jour["amount"], 0)
        self.assertIn("conference papers only", jour["zero_reason"])

    def test_a_missing_snip_says_it_is_priced_at_the_floor(self):
        got = self.post({"publication_type": "Journal", "indexing_level": "Scopus", "total_authors": 1,
                         "positions": [1], "sec_reference_count": 2})
        self.assertEqual(got["amount"], 5000)
        self.assertEqual(got["category"], "II")
        self.assertIn("no SNIP", " ".join(w["text"] for w in got["working"]))

    def test_a_snip_below_the_floor_shows_the_floor_line(self):
        got = self.post({"publication_type": "Journal", "indexing_level": "Scopus", "snip": 0.02, "quartile": "Q1",
                         "engineering_class": "Non-Engineering", "total_authors": 1, "positions": [1],
                         "sec_reference_count": 2})
        self.assertEqual(got["amount"], 5000)
        self.assertIn("floor", [w["key"] for w in got["working"]])

    def test_fewer_references_than_the_policy_needs_is_zero_with_the_reason(self):
        got = self.post({"publication_type": "Journal", "indexing_level": "Scopus", "snip": 1.0, "quartile": "Q1",
                         "engineering_class": "Engineering", "total_authors": 1, "positions": [1],
                         "sec_reference_count": 1})
        self.assertEqual(got["amount"], 0)
        self.assertIn("SEC-affiliated reference", got["zero_reason"])
        self.assertIn("requires 2", got["zero_reason"])
        self.assertEqual(got["sentence"], got["zero_reason"])

    def test_more_authors_than_the_ceiling_cannot_be_priced(self):
        got = self.post({"publication_type": "Journal", "snip": 1.0, "total_authors": 10, "positions": [1]})
        self.assertFalse(got["ok"])
        self.assertIn("more than 9 authors", got["problem"])

    def test_several_positions_price_every_college_author_and_add_up(self):
        got = self.post({"publication_type": "Journal", "indexing_level": "Scopus", "snip": 1.85, "quartile": "Q1",
                         "engineering_class": "Engineering", "total_authors": 4, "positions": [3, 1],
                         "sec_reference_count": 2})
        base = got["paper_value"]
        shares = allocate_shares(base, DEFAULT_AUTHOR_POINTS["4"])
        by_pos = {a["position"]: a["incentive"] for a in got["authors"]}
        self.assertEqual(by_pos, {1: shares[0], 3: shares[2]})
        self.assertEqual(got["college_total"], round2(shares[0] + shares[2]))
        # The headline is the first position, and the sentence says so.
        self.assertEqual(got["amount"], shares[0])
        self.assertIn("2 authors at the college", got["sentence"])

    def test_a_past_policy_version_prices_by_its_own_rates(self):
        self.policy.active = False
        self.policy.save()
        v2 = make_policy(active=True, version=2, fixed_journal_no_snip=8000)
        body = {"publication_type": "Journal", "indexing_level": "Scopus", "total_authors": 1, "positions": [1],
                "sec_reference_count": 2}
        self.assertEqual(self.post(body)["amount"], 8000)
        old = self.post({**body, "policy_id": self.policy.id})
        self.assertEqual(old["amount"], 5000)
        self.assertFalse(old["policy"]["in_force"])
        self.assertIn("not the policy in force", old["sentence"])
        self.assertEqual(self.post({**body, "policy_id": v2.id})["policy"]["in_force"], True)
        opts = self.admin.get("/api/calculator/options").json()
        self.assertEqual([p["version"] for p in opts["policies"]], [2, 1])
        self.assertIn("Journal", opts["publication_types"])

    def test_a_person_applies_their_research_threshold(self):
        body = {"publication_type": "Journal", "indexing_level": "Scopus", "snip": 1.0, "quartile": "Q1",
                "engineering_class": "Engineering", "total_authors": 1, "positions": [1], "sec_reference_count": 2}
        full = self.post(body)["amount"]
        ResearchThreshold.objects.create(
            user=self.research, amount=full * 1.5, effective_from=rt.today() - timedelta(days=1),
            set_by=self.users[Role.RESEARCH_COORDINATOR],
        )
        got = self.post({**body, "person_id": self.research.id})
        self.assertEqual(got["full"], full)
        self.assertEqual(got["amount"], 0.0)
        self.assertIn("Inside", got["threshold"]["text"])
        self.assertEqual(got["threshold"]["absorbed"], full)
        regular = self.post({**body, "person_id": self.fac.id})
        self.assertEqual(regular["amount"], full)
        self.assertIn("not research faculty", regular["threshold"]["text"])
        unset = User.objects.create_user(email="u@x.edu", name="No Threshold", faculty_type="RESEARCH")
        self.assertIn("No research threshold is set", self.post({**body, "person_id": unset.id})["threshold"]["text"])

    def test_price_writes_nothing(self):
        before = (Claim.objects.count(), AuditLog.objects.count(), PaidLedger.objects.count())
        self.post({"publication_type": "Journal", "snip": 1.0, "total_authors": 1, "positions": [1]})
        self.assertEqual(before, (Claim.objects.count(), AuditLog.objects.count(), PaidLedger.objects.count()))


class Prefill(Base):
    def test_a_claim_number_fills_the_stored_inputs_however_it_was_typed(self):
        c = self.claim(snip=2.5, total_authors=5, author_position=3)
        for typed in (c.ticket_number, c.ticket_number.lower(), "fp 2026 " + str(int(c.ticket_number[-6:]))):
            r = self.admin.get("/api/calculator/prefill", {"q": typed}).json()
            self.assertEqual(r["kind"], "claim", typed)
            self.assertEqual(r["inputs"]["snip"], 2.5)
            self.assertEqual(r["inputs"]["total_authors"], 5)
            self.assertEqual(r["inputs"]["author_position"], 3)

    def test_a_doi_filed_before_fills_from_that_claim(self):
        self.claim(doi="10.1000/abc")
        r = self.admin.get("/api/calculator/prefill", {"q": "https://doi.org/10.1000/ABC"}).json()
        self.assertEqual(r["kind"], "doi_claim")

    def test_a_scopus_failure_is_a_sentence_never_an_error(self):
        with mock.patch("core.services.scopus.lookup_paper_by_doi", side_effect=RuntimeError("no key")):
            r = self.admin.get("/api/calculator/prefill", {"q": "10.1000/nothing"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["kind"], "none")
        self.assertIn("by hand", r.json()["message"])

    def test_an_unknown_number_is_a_sentence(self):
        r = self.admin.get("/api/calculator/prefill", {"q": "FP-2026-999999"}).json()
        self.assertEqual(r["kind"], "none")


class CheckAClaim(Base):
    def check(self, c, client=None):
        r = (client or self.admin).get("/api/calculator/claim", {"q": c.ticket_number})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_a_claim_priced_by_the_pipeline_agrees_everywhere(self):
        c = self.claim()
        body = self.check(c)
        self.assertTrue(body["agrees"])
        self.assertEqual(body["differences"], [])
        self.assertEqual(body["recorded"]["amount"], c.remuneration)
        self.assertEqual(body["under_snapshot"]["amount"], c.remuneration)
        self.assertEqual(body["under_today"]["amount"], c.remuneration)
        self.assertIn("agrees", body["headline"])
        self.assertEqual(body["claim"]["name"], self.fac.name)

    def test_a_claim_is_found_by_a_loosely_typed_number(self):
        c = self.claim()
        r = self.admin.get("/api/calculator/claim", {"q": "fp 2026 " + str(int(c.ticket_number[-6:]))})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["claim"]["id"], c.id)
        self.assertEqual(self.admin.get("/api/calculator/claim", {"q": "FP-2026-424242"}).status_code, 404)

    def test_a_draft_is_not_found(self):
        c = self.claim(status=ClaimStatus.DRAFT)
        self.assertEqual(self.admin.get("/api/calculator/claim", {"q": c.ticket_number}).status_code, 404)

    def test_policy_change_is_expected_and_names_both_policies(self):
        c = self.claim()
        self.policy.active = False
        self.policy.save()
        make_policy(active=True, version=2, fixed_journal_no_snip=9000, snip_multiplier=40000)
        body = self.check(c)
        self.assertTrue(body["agrees"], body["differences"])
        d = {x["cause"]: x for x in body["differences"]}
        self.assertIn("policy_changed", d)
        self.assertTrue(d["policy_changed"]["expected"])
        self.assertEqual(body["under_snapshot"]["amount"], c.remuneration)
        self.assertNotEqual(body["under_today"]["amount"], c.remuneration)
        self.assertEqual(body["under_today"]["policy"], "Policy v2")
        self.assertEqual(body["under_snapshot"]["policy"], "Policy v1")
        self.assertIn("would give", body["headline"])

    def test_inputs_changed_after_pricing(self):
        c = self.claim()
        Claim.objects.filter(pk=c.pk).update(snip=3.0)  # edited, never priced again
        body = self.check(c)
        self.assertFalse(body["agrees"])
        d = body["differences"][0]
        self.assertEqual(d["cause"], "inputs_changed")
        self.assertLess(body["delta"], 0)
        self.assertIn("edited after pricing", d["text"])
        self.assertIn("less than the policy gives", body["headline"])

    def test_a_manual_override_names_who_and_when(self):
        c = self.pay(self.claim())
        Claim.objects.filter(pk=c.pk).update(remuneration=c.remuneration + 4000)
        PaidLedger.objects.filter(claim=c).update(amount=c.remuneration + 4000)
        AuditLog.objects.create(
            actor=self.users[Role.SUPER_ADMIN], action="CLAIM_DATA_FIX", entity="Claim", entity_id=c.id,
            detail_json=json.dumps({"reason": "From voucher 77", "after": {"remuneration": c.remuneration + 4000}}),
        )
        body = self.check(c)
        d = body["differences"][0]
        self.assertEqual(d["cause"], "manual_override")
        self.assertIn(self.users[Role.SUPER_ADMIN].name, d["text"])
        self.assertIn("From voucher 77", d["text"])
        self.assertFalse(body["agrees"])

    def test_a_title_correction_is_not_an_override(self):
        c = self.claim()
        AuditLog.objects.create(
            actor=self.users[Role.SUPER_ADMIN], action="CLAIM_DATA_FIX", entity="Claim", entity_id=c.id,
            detail_json=json.dumps({"reason": "title", "after": {"paper_title": "New"}}),
        )
        self.assertEqual(self.check(c)["differences"], [])

    def test_the_research_threshold_is_expected_not_a_fault(self):
        ResearchThreshold.objects.create(
            user=self.research, amount=1_000_000, effective_from=rt.today() - timedelta(days=1),
            set_by=self.users[Role.RESEARCH_COORDINATOR],
        )
        c = self.claim(owner=self.research)
        c.refresh_from_db()
        self.assertEqual(c.remuneration, 0.0)
        body = self.check(c)
        self.assertTrue(body["agrees"], body["differences"])
        d = {x["cause"]: x for x in body["differences"]}
        self.assertIn("threshold", d)
        self.assertTrue(d["threshold"]["expected"])
        self.assertEqual(body["recorded"]["absorbed"], c.research_absorbed)
        self.assertEqual(body["recorded"]["policy_amount"], round2(c.research_absorbed))
        self.assertEqual(body["under_snapshot"]["amount"], body["recorded"]["policy_amount"])
        self.assertIn("research threshold", body["headline"])

    def test_an_old_erp_import_with_no_snapshot_is_compared_with_the_policy_in_force(self):
        c = self.erp("ERP-PROCESSED-7", amount=99999.0)
        body = self.check(c)
        d = body["differences"][0]
        self.assertEqual(d["cause"], "old_erp")
        self.assertIsNone(body["under_snapshot"])
        self.assertIn("no", d["text"].lower())
        self.assertTrue(body["claim"]["imported"])
        agreeing = self.erp("ERP-PROCESSED-8", amount=self.check(c)["under_today"]["amount"])
        PaidLedger.objects.create(claim=agreeing, payout_month=date(2026, 5, 1), amount=agreeing.remuneration)
        self.assertTrue(self.check(agreeing)["agrees"])

    def test_paid_with_no_amount_is_named_and_says_what_the_formula_gives(self):
        c = self.erp("ERP-PROCESSED-9", amount=0.0)
        body = self.check(c)
        d = body["differences"][0]
        self.assertEqual(d["cause"], "imported_no_amount")
        self.assertGreater(body["under_today"]["amount"], 0)

    def test_counted_only_is_not_a_difference(self):
        c = self.erp("ERP-PROCESSED-10", amount=0.0, note="Student Publication. No Remuneration. Only for count")
        body = self.check(c)
        self.assertTrue(body["agrees"])
        self.assertIn("nothing was paid", body["headline"])

    def test_the_ledger_disagreeing_is_named(self):
        c = self.pay(self.claim())
        PaidLedger.objects.filter(claim=c).update(amount=c.remuneration - 500)
        body = self.check(c)
        d = {x["cause"]: x for x in body["differences"]}
        self.assertIn("ledger_differs", d)
        self.assertFalse(body["agrees"])
        self.assertEqual(body["ledger"]["total"], c.remuneration - 500)
        self.assertEqual(body["ledger"]["rows"][0]["voucher"], f"V-{c.ticket_number}")

    def test_a_check_writes_nothing(self):
        c = self.pay(self.claim())
        before = (Claim.objects.get(pk=c.pk).updated_at, AuditLog.objects.count(), PaidLedger.objects.count())
        self.check(c)
        self.admin.get("/api/calculator/many")
        after = (Claim.objects.get(pk=c.pk).updated_at, AuditLog.objects.count(), PaidLedger.objects.count())
        self.assertEqual(before, after)

    def test_the_director_and_finance_see_no_flags(self):
        c = self.claim(duplicate_warning=True, contest_note="A contested match")
        for role in (Role.DIRECTOR, Role.FINANCE):
            text = json.dumps(self.check(c, self.client_for(role)))
            self.assertNotIn("contest", text.lower())
            self.assertNotIn("duplicate", text.lower())


class CheckMany(Base):
    def many(self, **params):
        r = self.admin.get("/api/calculator/many", params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_totals_over_and_under_and_the_left_out(self):
        good = self.pay(self.claim())
        bad_more = self.pay(self.claim())
        bad_less = self.pay(self.claim())
        Claim.objects.filter(pk=bad_more.pk).update(remuneration=bad_more.remuneration + 3000)
        Claim.objects.filter(pk=bad_less.pk).update(remuneration=bad_less.remuneration - 1200)
        Claim.objects.filter(pk__in=[bad_more.pk, bad_less.pk]).update(snip_source="SCOPUS")
        # Recorded amounts moved by hand, and said so.
        for c, plus in ((bad_more, 3000), (bad_less, -1200)):
            AuditLog.objects.create(
                actor=self.users[Role.SUPER_ADMIN], action="CLAIM_ADMIN_EDIT", entity="Claim", entity_id=c.id,
                detail_json=json.dumps({"after": {"remuneration": str(c.remuneration + plus)}, "reason": "checked"}),
            )
        self.erp("ERP-PROCESSED-1", amount=0.0, note="Only for count")
        self.erp("ERP-PROCESSED-2", amount=0.0)
        body = self.many()
        t = body["totals"]
        self.assertEqual(t["checked"], 5)
        self.assertEqual(t["agree"], 1)
        self.assertEqual(t["differ"], 3)
        self.assertEqual(t["left_out"], 1)
        self.assertEqual(t["over"], 3000.0)
        formula = self.check_amount("ERP-PROCESSED-2")
        self.assertEqual(t["under"], round2(1200 + formula))
        self.assertEqual(t["net"], round2(t["over"] - t["under"]))
        causes = {c["cause"]: c for c in body["causes"]}
        self.assertEqual(causes["manual_override"]["count"], 2)
        self.assertEqual(causes["imported_no_amount"]["count"], 1)
        ids = {r["ticket_number"] for r in body["rows"]}
        self.assertEqual(ids, {bad_more.ticket_number, bad_less.ticket_number, "ERP-PROCESSED-2"})
        self.assertNotIn(good.ticket_number, ids)
        # Largest difference first.
        diffs = [abs(r["difference"]) for r in body["rows"]]
        self.assertEqual(diffs, sorted(diffs, reverse=True))

    def check_amount(self, no):
        return self.admin.get("/api/calculator/claim", {"q": no}).json()["under_today"]["amount"]

    def test_a_difference_of_a_rupee_or_less_is_not_listed(self):
        c = self.pay(self.claim())
        Claim.objects.filter(pk=c.pk).update(remuneration=c.remuneration + 0.5)
        self.assertEqual(self.many()["rows"], [])
        Claim.objects.filter(pk=c.pk).update(remuneration=c.remuneration + 1.5)
        self.assertEqual(len(self.many()["rows"]), 1)

    def test_a_policy_change_alone_lists_nothing_but_is_counted(self):
        self.pay(self.claim())
        self.policy.active = False
        self.policy.save()
        make_policy(active=True, version=2, fixed_journal_no_snip=9000, snip_multiplier=40000)
        body = self.many()
        self.assertEqual(body["rows"], [])
        self.assertEqual(body["totals"]["policy_moved"], 1)
        self.assertEqual(body["totals"]["agree"], 1)

    def test_the_threshold_is_left_out_of_the_differences(self):
        ResearchThreshold.objects.create(
            user=self.research, amount=1_000_000, effective_from=rt.today() - timedelta(days=1),
            set_by=self.users[Role.RESEARCH_COORDINATOR],
        )
        self.pay(self.claim(owner=self.research))
        body = self.many()
        self.assertEqual(body["rows"], [])
        self.assertEqual(body["totals"]["threshold_claims"], 1)
        self.assertGreater(body["totals"]["threshold_total"], 0)

    def test_stage_department_and_month_filters(self):
        paid = self.pay(self.claim())
        waiting = self.claim()
        for c in (paid, waiting):
            Claim.objects.filter(pk=c.pk).update(snip=4.0)
        self.assertEqual({r["ticket_number"] for r in self.many()["rows"]}, {paid.ticket_number})
        with_sub = self.many(submitted="true")
        self.assertEqual({r["ticket_number"] for r in with_sub["rows"]}, {paid.ticket_number, waiting.ticket_number})
        self.assertEqual(self.many(stage="authorised")["rows"], [])
        self.assertEqual([r["ticket_number"] for r in self.many(department="ECE")["rows"]], [paid.ticket_number])
        self.assertEqual(self.many(department="MECH")["rows"], [])
        self.assertEqual(len(self.many(month="2026-09")["rows"]), 1)
        self.assertEqual(self.many(month="2020-01")["rows"], [])
        body = self.many()
        self.assertIn("ECE", body["departments"])
        self.assertIn("2026-09", body["months"])
        self.assertEqual(len(self.many(cause="inputs_changed")["rows"]), 1)
        self.assertEqual(self.many(cause="old_erp")["rows"], [])

    def test_paging(self):
        for _ in range(5):
            c = self.pay(self.claim())
            Claim.objects.filter(pk=c.pk).update(snip=4.0)
        page = self.many(limit=2, offset=2)
        self.assertEqual(page["row_total"], 5)
        self.assertEqual(len(page["rows"]), 2)
        # The footer totals cover the whole list, not just the page.
        self.assertEqual(page["listed"]["count"], 5)
        self.assertEqual(page["listed"]["difference"], round2(page["listed"]["recorded"] - page["listed"]["formula"]))

    def test_direction_narrows_to_above_or_below_the_formula(self):
        more = self.pay(self.claim())
        less = self.pay(self.claim())
        Claim.objects.filter(pk=more.pk).update(snip=0.5)  # formula now below what was recorded
        Claim.objects.filter(pk=less.pk).update(snip=4.0)
        self.assertEqual([r["ticket_number"] for r in self.many(direction="over")["rows"]], [more.ticket_number])
        self.assertEqual([r["ticket_number"] for r in self.many(direction="under")["rows"]], [less.ticket_number])
        self.assertEqual(self.many(direction="over")["listed"]["count"], 1)

    def test_csv_matches_the_list_and_is_safe_in_a_spreadsheet(self):
        c = self.pay(self.claim(paper_title="=HYPERLINK(\"http://x\")"))
        Claim.objects.filter(pk=c.pk).update(snip=4.0)
        r = self.admin.get("/api/calculator/many.csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r["Content-Type"])
        rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
        self.assertEqual(rows[0][0], "Claim no.")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][0], c.ticket_number)
        self.assertTrue(rows[1][3].startswith("'="), rows[1][3])
        self.assertEqual(rows[1][11], "Figures changed after it was priced")

    def test_it_agrees_with_the_data_fix_queue_on_what_is_paid_with_no_amount(self):
        from core.services import data_fixes

        for i in range(4):
            self.erp(f"ERP-PROCESSED-{i}", amount=0.0)
        self.erp("ERP-PROCESSED-77", amount=0.0, note="Only for count")
        queue = set(data_fixes.queryset("paid_no_amount").values_list("ticket_number", flat=True))
        listed = {r["ticket_number"] for r in self.many()["rows"] if r["cause"] == "imported_no_amount"}
        self.assertEqual(queue, listed)
        self.assertTrue(all(r["fix"] == "data" for r in self.many()["rows"]))

    def test_it_is_fast_on_a_whole_college(self):
        """One query for claims, one each for references, ledger and overrides."""
        template = self.pay(self.claim())
        snapshot = template.formula_snapshot_json
        rows = []
        for i in range(3000):
            rows.append(
                Claim(
                    owner=self.fac, status=ClaimStatus.PAID, ticket_number=f"FP-2027-{i:06d}", paper_title=f"P{i}",
                    quartile="Q2", snip=1.2, total_authors=3, author_position=2, indexing_level="Scopus",
                    publication_type="Journal", engineering_class="Engineering", formula_snapshot_json=snapshot,
                    remuneration=1000.0 + (i % 5), payout_month=date(2026, 9, 1),
                )
            )
        Claim.objects.bulk_create(rows, batch_size=500)
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as q:
            t = time.perf_counter()
            body = self.many()
            secs = time.perf_counter() - t
        self.assertEqual(body["totals"]["checked"], 3001)
        self.assertLess(secs, 2.0, f"took {secs:.2f}s")
        # The calculator's own queries do not grow with the number of claims.
        self.assertLess(len(q), 40, len(q))
