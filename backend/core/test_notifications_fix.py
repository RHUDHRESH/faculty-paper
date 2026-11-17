"""Notifications, end to end: who is told what, once, and how the bell reads it.

Synthetic people and papers only. Each event the college cares about is driven
through the real endpoint, then the notification table is read: the right
people, exactly once, with a link that opens the thing the alert is about --
and nobody else (a head of department never sees money; a faculty member never
hears about somebody else's paper).
"""
from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch

from django.core import mail
from django.db import transaction
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from core import tests as core_tests
from core.models import (
    BatchStatus,
    Claim,
    ClaimReason,
    ClaimStatus,
    MonthlyBatch,
    Notification,
    NotificationPreference,
    Role,
    SocialSettings,
    User,
)
from core.services import notify as notify_service
from core.services.notify import notify
from core.test_chain_rules import ChainBase


def told(kind=None, **filters):
    qs = Notification.objects.filter(**filters)
    if kind:
        qs = qs.filter(kind=kind)
    return sorted(qs.values_list("user__email", flat=True))


class EventBase(ChainBase):
    def setUp(self):
        super().setUp()
        # A second faculty member and the head of department: neither may hear
        # about this paper, and the head must never be shown its money.
        self.other = User.objects.create_user(
            email="other-fac@test.edu", password=None, name="Other Faculty", role=Role.FACULTY, department="ECE",
        )
        Notification.objects.all().delete()

    def amount(self, claim):
        claim.refresh_from_db()
        return claim.remuneration

    def step(self, user, claim, action, **body):
        r = self._post(user, f"/api/claims/{claim.id}/{action}", body)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r

    def everyone_else_silent(self, *allowed):
        silent = {self.faculty, self.cell, self.coordinator, self.admin, self.principal, self.director,
                  self.finance, self.hod, self.other} - set(allowed)
        for person in silent:
            self.assertEqual(
                list(Notification.objects.filter(user=person).values_list("kind", "title")), [],
                f"{person.role} should have heard nothing",
            )


class FilingTests(EventBase):
    _complete_payload = core_tests.ClaimSubmissionRuleTests._complete_payload
    _submittable_payload = core_tests.ClaimSubmissionRuleTests._submittable_payload

    def test_filing_tells_each_office_account_exactly_once_and_nobody_else(self):
        self.faculty.biometric_id = "BIO-N1"
        self.faculty.designation = "Professor"
        self.faculty.save()
        r = self._post(self.faculty, "/api/claims", self._submittable_payload())
        self.assertEqual(r.status_code, 200, r.content[:300])
        claim = Claim.objects.get(owner=self.faculty)
        rows = Notification.objects.filter(title__startswith="To clear")
        # The office: the cell (retired role, still holding accounts), the
        # coordinator and the super admin. Once each.
        self.assertEqual(
            sorted(rows.values_list("user__email", flat=True)),
            sorted([self.cell.email, self.coordinator.email, self.admin.email]),
        )
        self.assertEqual({n.kind for n in rows}, {"desk"})
        self.assertEqual({n.claim_id for n in rows}, {claim.id})
        # The link names the paper, in the queue that opens it.
        self.assertEqual({n.href for n in rows}, {f"/admin/clearing?claim={claim.id}"})
        # Not the claimant, the Principal, the Director, Finance, the head of
        # department or a colleague.
        self.everyone_else_silent(self.cell, self.coordinator, self.admin)


class ChainEventTests(EventBase):
    def walk_to(self, status):
        """A submitted paper, taken through the real endpoints as far as `status`."""
        claim = self._claim(status=ClaimStatus.SUBMITTED, ticket="NF-1")
        amount = self.amount(claim)
        order = [
            (ClaimStatus.CLEARED, self.admin, "clear"),
            (ClaimStatus.PRINCIPAL_APPROVED, self.principal, "principal-approve"),
            (ClaimStatus.DIRECTOR_APPROVED, self.director, "director-approve"),
            (ClaimStatus.PAID, self.finance, "mark-paid"),
        ]
        for target, who, action in order:
            self.step(who, claim, action, expected_amount=amount)
            if target == status:
                break
        return claim

    def test_clearing_asks_the_principal_to_approve_once(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, ticket="NF-2")
        self.step(self.admin, claim, "clear", expected_amount=self.amount(claim))
        rows = Notification.objects.all()
        self.assertEqual([n.user for n in rows], [self.principal])
        n = rows[0]
        self.assertEqual((n.kind, n.claim_id), ("desk", claim.id))
        self.assertTrue(n.title.startswith("Cleared, for your approval"))
        self.assertNotIn("—", n.title)
        self.assertEqual(n.href, f"/principal?claim={claim.id}")
        # The claimant is not told: every hop is "Under review" to them.
        self.everyone_else_silent(self.principal)

    def test_approval_asks_the_director_and_the_standing_in_super_admin_not_finance(self):
        claim = self._claim(status=ClaimStatus.CLEARED, ticket="NF-3")
        self.step(self.principal, claim, "principal-approve", expected_amount=self.amount(claim))
        self.assertEqual(
            told(claim_id=claim.id), sorted([self.director.email, self.admin.email])
        )
        self.assertEqual({n.href for n in Notification.objects.all()}, {f"/authorisations?claim={claim.id}"})
        self.everyone_else_silent(self.director, self.admin)

    def test_authorising_tells_the_claimant_approved_and_finance_to_pay_once_each(self):
        claim = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, ticket="NF-4")
        self.step(self.director, claim, "director-approve", expected_amount=self.amount(claim))
        mine = Notification.objects.get(user=self.faculty)
        self.assertEqual((mine.kind, mine.href, mine.claim_id), ("claim_approved", f"/papers/{claim.id}", claim.id))
        self.assertTrue(mine.title.endswith("Approved for payment"))
        pay = Notification.objects.get(user=self.finance)
        self.assertEqual((pay.kind, pay.href), ("desk", f"/finance?claim={claim.id}"))
        self.assertEqual(Notification.objects.count(), 2)
        self.everyone_else_silent(self.faculty, self.finance)

    def test_paying_tells_the_claimant_the_amount_once_and_replaying_the_batch_adds_nothing(self):
        claim = self.walk_to(ClaimStatus.DIRECTOR_APPROVED)
        Notification.objects.all().delete()
        body = {
            "items": [{"claim_id": claim.id, "expected_amount": self.amount(claim)}],
            "idempotency_key": "batch-key-0001",
        }
        for _ in range(2):
            r = self._post(self.finance, "/api/admin/bulk-mark-paid", body)
            self.assertEqual(r.status_code, 200, r.content[:300])
            self.assertEqual(r.json()["skipped"], [])
        paid = Notification.objects.filter(kind="claim_paid")
        self.assertEqual(paid.count(), 1)
        row = paid.get()
        self.assertEqual(row.user, self.faculty)
        self.assertIn("₹", row.body)
        self.assertEqual(row.href, f"/papers/{claim.id}")

    def test_sending_back_carries_the_reason_to_the_claimant_alone(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, ticket="NF-6")
        self.step(self.admin, claim, "return-to-faculty", note="Attach the published paper as a PDF.")
        row = Notification.objects.get()
        self.assertEqual((row.user, row.kind), (self.faculty, "claim_sent_back"))
        self.assertEqual(row.body, "Attach the published paper as a PDF.")
        self.assertEqual(row.href, f"/papers/{claim.id}")

    def test_not_accepted_is_a_different_kind_with_the_reason(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, ticket="NF-7")
        self.step(self.admin, claim, "reject-outright", note="Not written at this college.")
        row = Notification.objects.get()
        self.assertEqual((row.user, row.kind), (self.faculty, "claim_not_accepted"))
        self.assertIn("Not written at this college.", row.body)

    def test_the_principal_sending_a_paper_back_tells_the_office_not_the_claimant(self):
        claim = self._claim(status=ClaimStatus.CLEARED, ticket="NF-8")
        self.step(self.principal, claim, "principal-reject", note="Check the quartile again.")
        self.assertEqual(
            told(), sorted([self.cell.email, self.coordinator.email, self.admin.email])
        )
        self.assertEqual({n.body for n in Notification.objects.all()}, {"Check the quartile again."})

    def test_a_count_only_paper_says_so_instead_of_rupee_zero(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, ticket="NF-9", claim_reason=ClaimReason.COUNT_ONLY,
                            is_student_publication=True)
        self.assertEqual(self.amount(claim), 0)
        self.step(self.admin, claim, "clear", expected_amount=0)
        row = Notification.objects.get(user=self.principal)
        self.assertIn("Count only", row.body)
        self.assertNotIn("₹0", row.body)

    def test_withdrawing_your_own_paper_does_not_tell_you_what_you_just_did(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, ticket="NF-10")
        Notification.objects.create(
            user=self.admin, kind="desk", title="To clear · NF-10", claim_id=claim.id,
            href=f"/admin/clearing?claim={claim.id}",
        )
        self.step(self.faculty, claim, "withdraw")
        self.assertFalse(Notification.objects.filter(user=self.faculty).exists())
        # ...and the office's "to clear" is done with, not left counting.
        self.assertTrue(Notification.objects.get(user=self.admin).read)

    def test_a_desk_alert_is_settled_when_the_paper_moves_on(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, ticket="NF-11")
        self.step(self.admin, claim, "clear", expected_amount=self.amount(claim))
        self.assertEqual(notify_service.unread_count(self.principal), 1)
        self.step(self.principal, claim, "principal-approve", expected_amount=self.amount(claim))
        # The Principal's "to approve" is done; the Director's "to authorise" is not.
        self.assertEqual(notify_service.unread_count(self.principal), 0)
        self.assertEqual(notify_service.unread_count(self.director), 1)
        self.step(self.director, claim, "director-approve", expected_amount=self.amount(claim))
        self.assertEqual(notify_service.unread_count(self.director), 0)
        self.assertEqual(notify_service.unread_count(self.finance), 1)
        self.step(self.finance, claim, "mark-paid", expected_amount=self.amount(claim))
        self.assertEqual(notify_service.unread_count(self.finance), 0)
        self.assertTrue(Notification.objects.get(user=self.principal).read_at)

    def test_the_whole_chain_never_reaches_the_head_of_department_or_a_colleague(self):
        self.walk_to(ClaimStatus.PAID)
        self.assertFalse(Notification.objects.filter(user__in=[self.hod, self.other]).exists())
        # And the money in desk alerts only ever sits in a desk's own bell.
        money = Notification.objects.filter(body__contains="₹")
        self.assertTrue(money.exists())
        self.assertFalse(money.filter(user__role__in=[Role.HOD, Role.FACULTY]).exclude(user=self.faculty).exists())

    def test_each_claim_link_opens_the_paper_it_is_about(self):
        claim = self.walk_to(ClaimStatus.PAID)
        for n in Notification.objects.filter(claim_id=claim.id):
            path = n.href.split("?")[0]
            self.assertIn(path, {"/papers/" + claim.id, "/principal", "/authorisations", "/finance", "/admin/clearing"}, n.title)
            self.assertIn(claim.id, n.href)


class SettingsTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(email="s1@test.edu", password=None, name="Asha", role=Role.FACULTY)

    def test_off_writes_nothing_and_sends_nothing_even_by_whatsapp(self):
        NotificationPreference.objects.create(user=self.me, kind="claim_paid", level="off")
        with self.settings(WHATSAPP_TOKEN="t", WHATSAPP_PHONE_ID="1"), patch("core.services.whatsapp.httpx.post") as post:
            with self.captureOnCommitCallbacks(execute=True):
                self.assertIsNone(notify(self.me, "claim_paid", "Paid", "Paid."))
        post.assert_not_called()
        self.assertFalse(Notification.objects.exists())

    @override_settings(EMAIL_HOST="smtp.test", EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_nothing_goes_out_by_email_when_the_transaction_rolls_back(self):
        class Boom(Exception):
            pass

        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            try:
                with transaction.atomic():
                    notify(self.me, "claim_paid", "Paid", "Paid.")
                    raise Boom
            except Boom:
                pass
        self.assertEqual(callbacks, [])
        self.assertEqual(mail.outbox, [])
        self.assertFalse(Notification.objects.exists())

    @override_settings(EMAIL_HOST="smtp.test", EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_email_goes_after_commit_once(self):
        with self.captureOnCommitCallbacks(execute=True):
            notify(self.me, "claim_paid", "Paid", "Paid.")
        self.assertEqual(len(mail.outbox), 1)

    @override_settings(EMAIL_HOST="smtp.test", EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_a_failing_mail_server_and_a_failing_whatsapp_are_logged_not_raised(self):
        SocialSettings.objects.update_or_create(user=self.me, defaults={"whatsapp_opt_in": True})
        self.me.phone = "9876543210"
        self.me.save()
        with self.settings(WHATSAPP_TOKEN="t", WHATSAPP_PHONE_ID="1"), \
                patch("core.services.notify._deliver", side_effect=OSError("down")), \
                patch("core.services.whatsapp.httpx.post", side_effect=OSError("down")), \
                self.assertLogs("core.notifications", level="WARNING") as logs:
            with self.captureOnCommitCallbacks(execute=True):
                note = notify(self.me, "claim_paid", "Paid", "Paid.")
        self.assertIsNotNone(note)
        self.assertTrue(Notification.objects.filter(pk=note.pk).exists())
        self.assertTrue(any("email_failed" in m for m in logs.output))
        self.assertTrue(any("whatsapp_failed" in m for m in logs.output))

    def test_whatsapp_goes_only_to_somebody_who_opted_in_and_has_a_phone(self):
        self.me.phone = "9876543210"
        self.me.save()
        with self.settings(WHATSAPP_TOKEN="t", WHATSAPP_PHONE_ID="1"), patch("core.services.whatsapp.httpx.post") as post:
            with self.captureOnCommitCallbacks(execute=True):
                notify(self.me, "claim_paid", "Paid", "Paid.")
            post.assert_not_called()
            SocialSettings.objects.update_or_create(user=self.me, defaults={"whatsapp_opt_in": True})
            with self.captureOnCommitCallbacks(execute=True):
                notify(self.me, "claim_paid", "Paid again", "Paid.")
            self.assertEqual(post.call_count, 1)
            # Not a money kind: never on WhatsApp.
            with self.captureOnCommitCallbacks(execute=True):
                notify(self.me, "follow", "Ravi followed you")
            self.assertEqual(post.call_count, 1)

    def test_the_desk_switch_is_on_every_desk_roles_settings_page_and_nobody_elses(self):
        c = Client()
        for role, listed in [
            (Role.PRINCIPAL, True), (Role.DIRECTOR, True), (Role.FINANCE, True),
            (Role.RESEARCH_COORDINATOR, True), (Role.SUPER_ADMIN, True),
            (Role.FACULTY, False), (Role.HOD, False),
        ]:
            person = User.objects.create_user(
                email=f"role-{role.lower()}@test.edu", password=None, name=role, role=role,
            )
            c.force_login(person)
            keys = {k["key"] for k in c.get("/api/notifications/preferences").json()["kinds"]}
            self.assertEqual("desk" in keys, listed, role)

    def test_a_principal_can_switch_the_desk_off_and_then_hears_nothing(self):
        principal = User.objects.create_user(email="p@test.edu", password=None, name="P", role=Role.PRINCIPAL)
        c = Client()
        c.force_login(principal)
        r = c.put(
            "/api/notifications/preferences", data=json.dumps({"levels": {"desk": "off"}}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(notify(principal, "desk", "Cleared, for your approval · X-1", "x", "/approvals"))
        self.assertEqual(c.get("/api/notifications/unread-count").json(), {"unread": 0})


class BellApiTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(email="b1@test.edu", password=None, name="Asha", role=Role.FACULTY)
        self.you = User.objects.create_user(email="b2@test.edu", password=None, name="Ravi", role=Role.FACULTY)
        self.c = Client()
        self.c.force_login(self.me)

    def post(self, path):
        return self.c.post(path)

    def test_the_count_is_one_query_and_equals_what_the_list_shows_unread(self):
        for i in range(5):
            notify(self.me, "claim_paid", f"Paid {i}", "x")
        notify(self.me, "follow", "Ravi followed you")
        notify(self.you, "claim_paid", "Not mine", "x")
        NotificationPreference.objects.create(user=self.me, kind="follow", level="off")
        Notification.objects.filter(user=self.me, title="Paid 0").update(read=True)
        with self.assertNumQueries(1):
            count = notify_service.unread_count(self.me)
        self.assertEqual(count, 4)
        listed = self.c.get("/api/notifications?unread=true").json()
        self.assertEqual(len(listed), count)
        self.assertEqual(self.c.get("/api/notifications/unread-count").json(), {"unread": count})
        self.assertEqual(self.c.get("/api/shell/badges").json()["notifications"], {"unread": count})

    def test_general_switched_off_hides_unregistered_kinds_in_the_one_query(self):
        Notification.objects.create(user=self.me, kind="retired_kind", title="Old")
        NotificationPreference.objects.create(user=self.me, kind="general", level="off")
        self.assertEqual(notify_service.unread_count(self.me), 0)
        self.assertEqual(self.c.get("/api/notifications").json(), [])

    def test_the_list_is_paged_newest_first(self):
        base = timezone.now()
        for i in range(35):
            n = Notification.objects.create(user=self.me, kind="claim_paid", title=f"N{i:02d}")
            Notification.objects.filter(pk=n.pk).update(created_at=base - timedelta(minutes=35 - i))
        first = self.c.get("/api/notifications").json()
        self.assertEqual(len(first), 30)
        self.assertEqual(first[0]["title"], "N34")
        rest = self.c.get("/api/notifications?offset=30").json()
        self.assertEqual([r["title"] for r in rest], [f"N{i:02d}" for i in (4, 3, 2, 1, 0)])
        self.assertEqual(len(self.c.get("/api/notifications?limit=500").json()), 35)
        self.assertEqual(len(self.c.get("/api/notifications?limit=10&offset=5").json()), 10)

    def test_the_list_costs_the_same_number_of_queries_for_five_rows_and_thirty(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        def make(n, start):
            for i in range(n):
                Notification.objects.create(
                    user=self.me, kind="claim_paid", title=f"P{start + i}",
                    href=f"/papers/{(str(start + i) * 32)[:32]}", claim_id=(str(start + i) * 32)[:32],
                )

        make(5, 0)
        self.c.get("/api/notifications")  # session, caches
        with CaptureQueriesContext(connection) as few:
            self.c.get("/api/notifications")
        make(25, 5)
        with CaptureQueriesContext(connection) as many:
            self.assertEqual(len(self.c.get("/api/notifications").json()), 30)
        self.assertEqual(len(few), len(many))

    def test_the_list_filters_by_read_state_and_tab(self):
        a = notify(self.me, "claim_paid", "Paid", "x")
        notify(self.me, "follow", "Followed")
        Notification.objects.filter(pk=a.pk).update(read=True)
        self.assertEqual([r["title"] for r in self.c.get("/api/notifications?state=read").json()], ["Paid"])
        self.assertEqual([r["title"] for r in self.c.get("/api/notifications?state=unread").json()], ["Followed"])
        self.assertEqual([r["title"] for r in self.c.get("/api/notifications?section=people").json()], ["Followed"])

    def test_marking_read_stamps_when_and_answers_with_the_new_count(self):
        a = notify(self.me, "claim_paid", "Paid", "x")
        notify(self.me, "claim_paid", "Paid 2", "x")
        r = self.post(f"/api/notifications/{a.id}/read")
        self.assertEqual(r.json(), {"ok": True, "unread": 1})
        a.refresh_from_db()
        self.assertTrue(a.read and a.read_at)
        first_stamp = a.read_at
        self.post(f"/api/notifications/{a.id}/read")
        a.refresh_from_db()
        self.assertEqual(a.read_at, first_stamp)
        row = next(x for x in self.c.get("/api/notifications").json() if x["id"] == a.id)
        self.assertTrue(row["read"] and row["read_at"])

    def test_nobody_reads_somebody_elses(self):
        theirs = notify(self.you, "claim_paid", "Theirs", "x")
        self.assertEqual(self.post(f"/api/notifications/{theirs.id}/read").status_code, 404)
        self.post("/api/notifications/read-all")
        theirs.refresh_from_db()
        self.assertFalse(theirs.read)

    def test_mark_all_read_everything_or_one_tab(self):
        notify(self.me, "claim_paid", "Paid", "x")
        notify(self.me, "follow", "Followed")
        r = self.post("/api/notifications/read-all?section=people").json()
        self.assertEqual((r["marked"], r["unread"]), (1, 1))
        r = self.post("/api/notifications/read-all").json()
        self.assertEqual((r["marked"], r["unread"]), (1, 0))
        self.assertEqual(self.c.get("/api/shell/badges").json()["notifications"], {"unread": 0})
        self.assertTrue(all(n.read_at for n in Notification.objects.filter(user=self.me)))

    def test_a_link_to_something_deleted_says_so_instead_of_opening_a_dead_page(self):
        gone_claim, gone_post, gone_thread = "a" * 32, "b" * 32, "c" * 32
        for title, href in [
            ("Paper", f"/papers/{gone_claim}"),
            ("Desk", f"/principal?claim={gone_claim}"),
            ("Post", f"/discussions/p/{gone_post}"),
            ("Thread", f"/discussions/{gone_thread}"),
            ("Chat", f"/messages/c/{gone_thread}"),
            ("Fine", "/me"),
            ("Section page", "/papers/appraisal"),
        ]:
            Notification.objects.create(user=self.me, kind="general", title=title, href=href)
        rows = {r["title"]: r for r in self.c.get("/api/notifications").json()}
        for title in ("Paper", "Desk", "Post", "Thread", "Chat"):
            self.assertTrue(rows[title]["gone"], title)
            self.assertIsNone(rows[title]["href"], title)
        self.assertFalse(rows["Fine"]["gone"])
        self.assertEqual(rows["Fine"]["href"], "/me")
        self.assertFalse(rows["Section page"]["gone"])

    def test_a_link_to_a_claim_that_exists_is_kept(self):
        owner = User.objects.create_user(email="o@test.edu", password=None, name="O", role=Role.FACULTY, department="CSE")
        claim = Claim.objects.create(owner=owner, paper_title="T", status=ClaimStatus.SUBMITTED, ticket_number="Z-1")
        Notification.objects.create(user=self.me, kind="general", title="Here", href=f"/papers/{claim.id}", claim_id=claim.id)
        row = self.c.get("/api/notifications").json()[0]
        self.assertFalse(row["gone"])
        self.assertEqual(row["href"], f"/papers/{claim.id}")


class TestNotificationTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(email="sa@test.edu", password=None, name="Super", role=Role.SUPER_ADMIN)
        self.fac = User.objects.create_user(email="f@test.edu", password=None, name="Fac", role=Role.FACULTY)

    def test_only_the_super_admin_can_send_one(self):
        c = Client()
        c.force_login(self.fac)
        self.assertEqual(c.post("/api/notifications/test").status_code, 403)

    def test_it_reports_which_channels_are_set_up(self):
        c = Client()
        c.force_login(self.admin)
        body = c.post("/api/notifications/test").json()
        self.assertTrue(body["in_app"]["ok"])
        self.assertTrue(Notification.objects.filter(user=self.admin, title="Test notification").exists())
        self.assertFalse(body["email"]["configured"])
        self.assertFalse(body["email"]["sent"])
        self.assertFalse(body["whatsapp"]["configured"])
        self.assertIn("not set up", body["whatsapp"]["message"])
        self.assertIn("smtp", body)

    @override_settings(EMAIL_HOST="smtp.test", EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_with_a_mail_server_the_email_goes_and_says_so(self):
        c = Client()
        c.force_login(self.admin)
        body = c.post("/api/notifications/test").json()
        self.assertTrue(body["email"]["configured"] and body["email"]["sent"])
        self.assertEqual(len(mail.outbox), 1)

    def test_whatsapp_says_what_is_missing(self):
        c = Client()
        c.force_login(self.admin)
        with self.settings(WHATSAPP_TOKEN="t", WHATSAPP_PHONE_ID="1"):
            body = c.post("/api/notifications/test").json()
        self.assertTrue(body["whatsapp"]["configured"])
        self.assertFalse(body["whatsapp"]["has_phone"])
        self.assertFalse(body["whatsapp"]["sent"])
        self.assertIn("phone", body["whatsapp"]["message"])


class FoundAndImportTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="sc@test.edu", password=None, name="Asha Menon", role=Role.FACULTY,
            department="CSE", scopus_author_id="57000000001",
        )

    def fake_search(self, titles):
        entries = [
            {"dc:title": t, "prism:doi": f"10.1/{i}", "eid": f"2-s2.0-{i}{len(t)}", "citedby-count": "0",
             "prism:coverDate": "2026-05-01", "prism:publicationName": "Journal of Tests",
             "dc:creator": "Menon A.", "prism:aggregationType": "Journal"}
            for i, t in enumerate(titles)
        ]

        def search(query, start):
            return {"search-results": {"opensearch:totalResults": str(len(entries)), "entry": entries if start == 0 else []}}

        return search

    def test_the_first_sync_is_a_backfill_and_says_nothing_the_next_one_that_finds_a_paper_says_it_once(self):
        from core.services import scopus_sync

        scopus_sync.sync_user(self.me, search=self.fake_search(["Old one", "Old two"]))
        self.assertFalse(Notification.objects.exists())
        self.me.refresh_from_db()
        scopus_sync.sync_user(self.me, search=self.fake_search(["Old one", "Old two", "A new result"]))
        rows = Notification.objects.all()
        self.assertEqual(rows.count(), 1)
        n = rows[0]
        self.assertEqual((n.user, n.kind, n.href), (self.me, "paper_found", "/papers"))
        self.assertIn("A new result", n.body)
        # Nothing new, nothing said.
        self.me.refresh_from_db()
        scopus_sync.sync_user(self.me, search=self.fake_search(["Old one", "Old two", "A new result"]))
        self.assertEqual(Notification.objects.count(), 1)

    def test_it_can_be_switched_off(self):
        from core.services import scopus_sync

        NotificationPreference.objects.create(user=self.me, kind="paper_found", level="off")
        scopus_sync.sync_user(self.me, search=self.fake_search(["A"]))
        self.me.refresh_from_db()
        scopus_sync.sync_user(self.me, search=self.fake_search(["A", "B"]))
        self.assertFalse(Notification.objects.exists())

    def test_a_finished_batch_and_a_failed_one_tell_whoever_started_it(self):
        from core import tasks

        office = User.objects.create_user(email="of@test.edu", password=None, name="Office", role=Role.SUPER_ADMIN)
        batch = MonthlyBatch.objects.create(name="October", created_by=office)

        def done(batch_id):
            MonthlyBatch.objects.filter(pk=batch_id).update(status=BatchStatus.DONE)

        with patch("core.services.monthly_processor.process_batch", side_effect=done):
            tasks.run_monthly_batch(batch.id)
        row = Notification.objects.get()
        self.assertEqual((row.user, row.kind, row.href), (office, "import_result", f"/batches/{batch.id}"))
        self.assertIn("October", row.title)
        Notification.objects.all().delete()

        def failed(batch_id):
            MonthlyBatch.objects.filter(pk=batch_id).update(status=BatchStatus.FAILED, error_message="Scopus quota")

        with patch("core.services.monthly_processor.process_batch", side_effect=failed):
            tasks.run_monthly_batch(batch.id)
        row = Notification.objects.get()
        self.assertIn("failed", row.title)
        self.assertEqual(row.body, "Scopus quota")

    def test_a_failed_erp_import_tells_the_uploader_and_still_raises(self):
        from core import tasks

        office = User.objects.create_user(email="of2@test.edu", password=None, name="Office", role=Role.SUPER_ADMIN)
        with patch("core.tasks.call_command", side_effect=ValueError("bad sheet")):
            with self.assertRaises(ValueError):
                tasks.run_erp_import("/nowhere.xlsx", {}, office.id, False)
        row = Notification.objects.get()
        self.assertEqual((row.user, row.kind, row.href), (office, "import_result", "/imports"))
        self.assertIn("bad sheet", row.body)

    def test_import_check_flags_go_through_the_persons_settings(self):
        from core.services import import_discrepancies

        office = User.objects.create_user(email="of3@test.edu", password=None, name="Office", role=Role.SUPER_ADMIN)
        owner = User.objects.create_user(email="ow@test.edu", password=None, name="Ow", role=Role.FACULTY, department="CSE")
        Claim.objects.create(
            owner=owner, paper_title="Imported", status=ClaimStatus.PAID, ticket_number="ERP-1",
            remuneration=5000, status_note="Rejected by the cell",
        )
        counts = import_discrepancies.flag_import_discrepancies()
        self.assertEqual(counts["raised"], 1)
        self.assertEqual(Notification.objects.filter(user=office, kind="import_result").count(), 1)
        Notification.objects.all().delete()
        from core.models import ClaimFlag

        ClaimFlag.objects.all().delete()
        NotificationPreference.objects.create(user=office, kind="import_result", level="off")
        self.assertEqual(import_discrepancies.flag_import_discrepancies()["raised"], 1)
        self.assertFalse(Notification.objects.filter(user=office).exists())


class DiscussionMentionTests(TestCase):
    def test_being_named_in_a_thread_you_follow_is_one_notification_and_a_stranger_gets_none(self):
        a = User.objects.create_user(email="da@test.edu", password=None, name="Dee Author", role=Role.FACULTY, department="CSE")
        b = User.objects.create_user(email="db@test.edu", password=None, name="Bee Reader", role=Role.FACULTY, department="CSE")
        stranger = User.objects.create_user(email="dc@test.edu", password=None, name="Cee Other", role=Role.FACULTY, department="ECE")
        c = Client()
        c.force_login(a)
        r = c.post("/api/threads", data=json.dumps({"title": "A thread", "body": "opening post @db"}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content[:200])
        tid = r.json()["id"]
        Notification.objects.all().delete()
        c.post(f"/api/threads/{tid}/posts", data=json.dumps({"body": "again @db"}), content_type="application/json")
        rows = Notification.objects.all()
        self.assertEqual([(n.user, n.kind) for n in rows], [(b, "mention")])
        self.assertEqual(rows[0].href, f"/discussions/{tid}")
        self.assertFalse(Notification.objects.filter(user__in=[a, stranger]).exists())


class StaleDeskAlertMigrationTests(EventBase):
    def test_old_desk_alerts_for_papers_that_have_moved_on_are_settled_and_the_rest_left(self):
        import importlib

        from django.apps import apps

        migration = importlib.import_module("core.migrations.0090_notifications_fix")
        waiting = self._claim(status=ClaimStatus.CLEARED, ticket="MG-1")
        moved = self._claim(status=ClaimStatus.PAID, ticket="MG-2")
        Notification.objects.create(user=self.principal, kind="desk", title="Cleared, for your approval", claim_id=waiting.id,
                                    href=f"/principal?claim={waiting.id}")
        Notification.objects.create(user=self.principal, kind="desk", title="Cleared, for your approval", claim_id=moved.id,
                                    href=f"/principal?claim={moved.id}")
        Notification.objects.create(user=self.principal, kind="desk", title="Claim missing", claim_id="d" * 32,
                                    href=f"/principal?claim={'d' * 32}")
        # Not a queue address: left alone whatever the paper did.
        Notification.objects.create(user=self.admin, kind="desk", title="Safeguards", href="/safeguards")
        migration.settle_stale_desk_alerts(apps, None)
        unread = set(Notification.objects.filter(read=False).values_list("title", flat=True))
        self.assertEqual(unread, {"Cleared, for your approval", "Safeguards"})
        self.assertEqual(Notification.objects.filter(read=True, read_at__isnull=False).count(), 2)
        self.assertEqual(notify_service.unread_count(self.principal), 1)
