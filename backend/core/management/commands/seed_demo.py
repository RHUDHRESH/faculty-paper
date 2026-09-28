"""Seed a realistic demo: claims at every stage and 2+ years of ledger payments.

    DJANGO_DEBUG=true python manage.py seed_demo            # add the demo
    DJANGO_DEBUG=true python manage.py seed_demo --reset    # remove it first

Refuses to run without DEBUG, like `e2e_session`. Every account it creates is
at `demo.invalid` (RFC 2606) with an unusable password, so none of it can sign
in or receive mail. Amounts on live-chain claims come from the application's
own calculator (`_apply_calc`), never typed in; ledger history rows carry the
flat rates the ERP import would.
"""
from __future__ import annotations

import random
import uuid
from datetime import date, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from core.models import (
    AttachmentKind, Budget, Claim, ClaimAttachment, ClaimFlag, ClaimStatus, PaidLedger, Role, User,
)

DOMAIN = "demo.invalid"
DEPTS = ["CSE", "ECE", "EEE", "MECH", "CIVIL", "IT", "AIDS", "S&H"]
FIRST = ["Priya", "Karthik", "Lakshmi", "Arun", "Divya", "Senthil", "Meena", "Ramesh",
         "Kavitha", "Vignesh", "Anitha", "Suresh", "Deepa", "Balaji", "Revathi", "Ganesh",
         "Nandhini", "Prakash", "Sangeetha", "Murali"]
LAST = ["Raman", "Subramanian", "Krishnan", "Natarajan", "Venkatesan", "Sundaram",
        "Rajendran", "Iyer", "Pillai", "Murugan"]
JOURNALS = ["IEEE Access", "Scientific Reports", "Materials Today: Proceedings",
            "Journal of Cleaner Production", "Expert Systems with Applications",
            "Sensors", "Energy Reports", "Computers and Electrical Engineering"]
TOPICS = ["deep learning for crop disease detection", "low-power SRAM design",
          "solar microgrid scheduling", "graphene-reinforced composites",
          "IoT-based water quality monitoring", "federated learning in healthcare",
          "self-compacting concrete with fly ash", "EV battery thermal management",
          "sentiment analysis of Tamil tweets", "5G antenna array optimisation"]
RATES = [5000, 7500, 10000, 15000, 20000, 25000]


class Command(BaseCommand):
    help = "Seed demo faculty, claims at every stage, ledger history and budgets (DEBUG only)."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true", help="Delete earlier demo data first.")
        parser.add_argument("--seed", type=int, default=7)

    def handle(self, *args, **opts):
        if not settings.DEBUG:
            raise CommandError("seed_demo runs only with DJANGO_DEBUG=true.")
        rnd = random.Random(opts["seed"])
        with transaction.atomic():
            if opts["reset"]:
                self._reset()
            people = self._people(rnd)
            n_claims = self._claims(rnd, people)
            n_ledger = self._ledger(rnd, people)
            self._budgets()
        self.stdout.write(f"demo: {len(people)} faculty, {n_claims} claims, {n_ledger} ledger rows")

    def _reset(self):
        demo = User.objects.filter(email__iendswith=f"@{DOMAIN}")
        PaidLedger.objects.filter(raw_json__contains='"demo": true').delete()
        PaidLedger.objects.filter(claim__owner__in=demo).delete()
        Claim.objects.filter(owner__in=demo).delete()
        Budget.objects.filter(note__startswith="Demo").delete()
        demo.delete()

    def _people(self, rnd):
        out = []
        for i in range(20):
            name = f"Dr. {FIRST[i]} {LAST[i % len(LAST)]}"
            u, created = User.objects.get_or_create(
                email=f"faculty{i + 1:02d}@{DOMAIN}",
                defaults=dict(name=name, role=Role.FACULTY, department=DEPTS[i % len(DEPTS)],
                              staff_id=f"SEC{1100 + i}", designation="Assistant Professor"),
            )
            if created:
                u.set_unusable_password()
                u.save()
            out.append(u)
        return out

    def _claim(self, owner, status, rnd, when):
        from core.api import _apply_calc
        from core.services.tickets import assign_ticket_number

        c = Claim.objects.create(
            owner=owner, status=ClaimStatus.SUBMITTED,
            paper_title=f"A study of {rnd.choice(TOPICS)} ({uuid.uuid4().hex[:4]})",
            journal_title=rnd.choice(JOURNALS), publication_year=when.year,
            publication_type="Journal", total_authors=rnd.randint(1, 4), author_position=1,
            staff_id=owner.staff_id, designation=owner.designation, submitted_at=when,
            affiliation_ok=True, snip=round(rnd.uniform(0.6, 2.4), 2), snip_source="MANUAL",
            quartile=rnd.choice(["Q1", "Q2", "Q3"]), quartile_source="MANUAL",
            scimago_verified=True,
        )
        for i in (1, 2):
            ClaimAttachment.objects.create(
                claim=c, kind=AttachmentKind.SEC_REFERENCE,
                url=f"{settings.MEDIA_URL}claims/{uuid.uuid4().hex}.pdf",
                filename=f"reference-{i}.pdf", size_bytes=1024, ref_number=str(i),
                ref_title=f"Cited SEC reference {i}", uploaded_by=owner,
            )
        _apply_calc(c)
        c.status = status
        if status != ClaimStatus.SUBMITTED:
            c.cleared_at = when + timedelta(days=3)
        if status in (ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID):
            c.principal_approved_at = when + timedelta(days=6)
        if status in (ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID):
            c.director_approved_at = when + timedelta(days=9)
        c.save()
        assign_ticket_number(c)
        c.save(update_fields=["ticket_number"])
        return c

    def _claims(self, rnd, people):
        now = timezone.now()
        plan = ([ClaimStatus.SUBMITTED] * 4 + [ClaimStatus.CLEARED] * 4
                + [ClaimStatus.PRINCIPAL_APPROVED] * 6 + [ClaimStatus.DIRECTOR_APPROVED] * 6
                + [ClaimStatus.PAID] * 6 + [ClaimStatus.REJECTED] * 1)
        n = 0
        for i, status in enumerate(plan):
            when = now - timedelta(days=rnd.randint(12, 60))
            c = self._claim(people[i % len(people)], status, rnd, when)
            if i in (5, 9, 15, 21):
                # Flagged at clearing, principal, director and paid stages: the
                # Director and Finance must never be told (core.visibility).
                c.duplicate_warning = True
                c.contest_note = "DEMO-FLAG possible duplicate of an older payment"
                c.save(update_fields=["duplicate_warning", "contest_note"])
                ClaimFlag.objects.create(claim=c, kind=ClaimFlag.Kind.DUPLICATE,
                                         note="DEMO-FLAG matches a 2024 payment")
            if status == ClaimStatus.PAID:
                m = date(now.year, now.month, 1) - timedelta(days=1)
                c.payout_month = date(m.year, m.month, 1)
                c.voucher_number = f"PV-{c.ticket_number}"
                c.paid_at = when + timedelta(days=12)
                c.save(update_fields=["payout_month", "voucher_number", "paid_at"])
                PaidLedger.objects.create(
                    claim=c, payout_month=c.payout_month, department=c.owner.department,
                    faculty_name=c.owner.name, staff_id=c.staff_id, paper_title=c.paper_title,
                    journal_title=c.journal_title, amount=c.remuneration or 0,
                    voucher_number=c.voucher_number,
                )
            n += 1
        return n

    def _ledger(self, rnd, people):
        today = timezone.now().date()
        start = date(today.year - 2, 4, 1)
        n, m = 0, start
        while m < date(today.year, today.month, 1) - timedelta(days=31):
            for _ in range(rnd.randint(4, 14)):
                p = rnd.choice(people)
                n += 1
                PaidLedger.objects.create(
                    payout_month=m, department=p.department, faculty_name=p.name,
                    staff_id=p.staff_id, paper_title=f"A study of {rnd.choice(TOPICS)}",
                    journal_title=rnd.choice(JOURNALS), amount=rnd.choice(RATES),
                    voucher_number=f"PV-{m:%Y%m}-{n:04d}",
                    raw_json='{"demo": true, "Month": "%s"}' % m.strftime("%b %Y"),
                )
            m = date(m.year + (m.month // 12), m.month % 12 + 1, 1)
        return n

    def _budgets(self):
        today = timezone.now().date()
        fy0 = today.year if today.month >= 4 else today.year - 1
        for k, amount in ((2, 1500000), (1, 1800000), (0, 2000000)):
            y = fy0 - k
            fy = f"{y}-{str(y + 1)[-2:]}"
            if not Budget.objects.filter(financial_year=fy, department__isnull=True).exists():
                Budget.objects.create(financial_year=fy, department=None, amount=amount,
                                      note=f"Demo college budget {fy}")
