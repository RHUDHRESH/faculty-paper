"""A claimant hears about their own money: approved, paid (with the amount),
sent back (with the reason), not accepted -- in the app and by email.

What they are told still never names a desk or an officer
(core/test_chain_rules.py pins that for every message); these tests pin what
the new kinds add: each stage its own kind, the amount on "Paid", email per
the person's settings, and WhatsApp only when configured and opted into.
"""
from __future__ import annotations

from unittest.mock import patch

from django.core import mail
from django.test import override_settings
from django.utils import timezone

from core.models import ClaimStatus, Notification, NotificationPreference, NotificationSettings
from core.test_chain_rules import ChainBase

EMAIL_ON = {"EMAIL_HOST": "smtp.test", "APP_BASE_URL": "https://app.test"}
DESK_WORDS = ("principal", "director", "finance", "research cell", "coordinator", "supervisor")


class MoneyBase(ChainBase):
    def _authorised(self, ticket, **extra):
        """A paper the Director authorised on this system, so Finance may pay
        it (an imported approval status is refused, see mark_paid)."""
        return self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket=ticket,
            director_approved_at=timezone.now(), director_approved_by=self.director, **extra,
        )


class MoneyAlertTests(MoneyBase):
    def _told(self):
        return list(Notification.objects.filter(user=self.faculty).order_by("created_at"))

    def _clean_slate(self):
        Notification.objects.all().delete()
        mail.outbox.clear()

    @override_settings(**EMAIL_ON)
    def test_paid_names_the_amount_in_the_app_and_by_email(self):
        claim = self._authorised("MA-P")
        self._clean_slate()
        r = self._post(self.finance, f"/api/claims/{claim.id}/mark-paid",
                       {"expected_amount": claim.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertGreater(claim.remuneration, 0)
        figure = f"₹{claim.remuneration:,.0f}"
        [note] = self._told()
        self.assertEqual(note.kind, "claim_paid")
        self.assertEqual(note.title, "MA-P · Paid")
        self.assertIn(figure, note.body)
        self.assertEqual(note.href, f"/papers/{claim.id}")
        mine = [m for m in mail.outbox if m.to == [self.faculty.email]]
        self.assertEqual(len(mine), 1)
        self.assertIn(figure, mine[0].body)
        self.assertIn(claim.paper_title, mine[0].alternatives[0][0])
        for word in DESK_WORDS:
            self.assertNotIn(word, (note.title + note.body + mine[0].body).lower())

    def test_a_zero_payment_does_not_announce_nought_rupees(self):
        claim = self._authorised("MA-Z", claim_reason="COUNT_ONLY")
        self._clean_slate()
        self._post(self.finance, f"/api/claims/{claim.id}/mark-paid",
                   {"expected_amount": claim.remuneration})
        [note] = self._told()
        self.assertEqual(note.kind, "claim_paid")
        self.assertNotIn("₹0", note.body)

    @override_settings(**EMAIL_ON)
    def test_sent_back_carries_the_reason(self):
        claim = self._claim(ClaimStatus.CLEARED, ticket="MA-S")
        self._clean_slate()
        reason = "Attach the published version, not the preprint"
        self._post(self.principal, f"/api/claims/{claim.id}/return-to-faculty", {"note": reason})
        [note] = self._told()
        self.assertEqual(note.kind, "claim_sent_back")
        self.assertIn(reason, note.body)
        self.assertEqual(len([m for m in mail.outbox if m.to == [self.faculty.email]]), 1)

    def test_not_accepted_is_its_own_kind(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="MA-N")
        self._clean_slate()
        self._post(self.cell, f"/api/claims/{claim.id}/reject-outright",
                   {"note": "The venue is not an indexed journal"})
        [note] = self._told()
        self.assertEqual(note.kind, "claim_not_accepted")
        self.assertIn("not an indexed journal", note.body)

    def test_approved_for_payment_is_its_own_kind(self):
        claim = self._claim(ClaimStatus.PRINCIPAL_APPROVED, ticket="MA-A")
        self._clean_slate()
        self._post(self.director, f"/api/claims/{claim.id}/director-approve",
                   {"expected_amount": claim.remuneration})
        [note] = self._told()
        self.assertEqual(note.kind, "claim_approved")
        self.assertIn("Approved for payment", note.title)

    def test_a_hold_is_an_other_change(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="MA-H")
        self._clean_slate()
        self._post(self.cell, f"/api/claims/{claim.id}/hold", {"reason": "Waiting on the publisher erratum"})
        [note] = self._told()
        self.assertEqual(note.kind, "claim_status")

    def test_switching_paid_off_silences_only_paid(self):
        NotificationPreference.objects.create(user=self.faculty, kind="claim_paid", level="off")
        claim = self._claim(ClaimStatus.PRINCIPAL_APPROVED, ticket="MA-O")
        self._clean_slate()
        amount = {"expected_amount": claim.remuneration}
        self._post(self.director, f"/api/claims/{claim.id}/director-approve", amount)
        self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", amount)
        self.assertEqual([n.kind for n in self._told()], ["claim_approved"])

    @override_settings(EMAIL_HOST="", EMAIL_NOTIFICATIONS=False)
    def test_with_no_mail_server_the_alert_still_arrives(self):
        claim = self._authorised("MA-E")
        self._clean_slate()
        self._post(self.finance, f"/api/claims/{claim.id}/mark-paid",
                   {"expected_amount": claim.remuneration})
        self.assertEqual(len(self._told()), 1)
        self.assertEqual(len(mail.outbox), 0)

    def test_desk_alerts_are_the_desk_kind(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="MA-D")
        self._clean_slate()
        self._post(self.cell, f"/api/claims/{claim.id}/clear",
                   {"expected_amount": claim.remuneration})
        principal = Notification.objects.get(user=self.principal, claim_id=claim.id)
        self.assertEqual(principal.kind, "desk")


@override_settings(WHATSAPP_TOKEN="tok", WHATSAPP_PHONE_ID="12345")
class WhatsAppTests(MoneyBase):
    def setUp(self):
        super().setUp()
        self.faculty.phone = "98765 43210"
        self.faculty.save()
        post = patch("core.services.whatsapp.httpx.post")
        self.sent = post.start()
        self.addCleanup(post.stop)

    def _pay(self, ticket):
        claim = self._authorised(ticket)
        self._post(self.finance, f"/api/claims/{claim.id}/mark-paid",
                   {"expected_amount": claim.remuneration})
        return claim

    def test_nothing_goes_without_the_persons_opt_in(self):
        self._pay("WA-1")
        self.sent.assert_not_called()

    def test_an_opted_in_claimant_gets_the_money_alert_as_a_template(self):
        NotificationSettings.objects.create(user=self.faculty, whatsapp_opt_in=True)
        self._pay("WA-2")
        self.assertEqual(self.sent.call_count, 1)
        url = self.sent.call_args.args[0]
        body = self.sent.call_args.kwargs["json"]
        self.assertIn("/12345/messages", url)
        self.assertEqual(body["to"], "919876543210")
        self.assertEqual(body["type"], "template")
        params = body["template"]["components"][0]["parameters"]
        self.assertIn("Paid", params[0]["text"])

    def test_other_kinds_never_go_to_whatsapp(self):
        NotificationSettings.objects.create(user=self.faculty, whatsapp_opt_in=True)
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="WA-3")
        self._post(self.cell, f"/api/claims/{claim.id}/hold", {"reason": "Waiting on the publisher erratum"})
        self.sent.assert_not_called()

    @override_settings(WHATSAPP_TOKEN="", WHATSAPP_PHONE_ID="")
    def test_unconfigured_means_off(self):
        NotificationSettings.objects.create(user=self.faculty, whatsapp_opt_in=True)
        self._pay("WA-4")
        self.sent.assert_not_called()
