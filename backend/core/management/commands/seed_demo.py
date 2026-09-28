"""Give the e2e faculty account a believable record to look at (DEBUG only).

    python manage.py e2e_session --role FACULTY   # creates the account
    python manage.py seed_demo

Seeds ~25 publications 2013-2026 with co-authors inside and outside the
college, claims at several stages, historic ledger payments, and two
colleagues with feed posts. Idempotent: rows it made are tagged and replaced.
"""
from __future__ import annotations

import random
from datetime import date

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

from core.management.commands.e2e_session import email_for
from core.models import Authorship, Claim, ClaimStatus, FeedPost, PaidLedger, Publication, Role, User

TAG = "demo-seed"
VENUES = [
    ("IEEE Access", "Q1"), ("Expert Systems with Applications", "Q1"), ("Materials Today: Proceedings", ""),
    ("Journal of Intelligent & Fuzzy Systems", "Q2"), ("Wireless Personal Communications", "Q2"),
    ("Computers & Electrical Engineering", "Q1"), ("Multimedia Tools and Applications", "Q2"),
    ("International Conference on Communication and Signal Processing", ""),
]
TOPICS = ["federated learning", "IoT intrusion detection", "medical image segmentation", "edge computing",
          "graph neural networks", "crop disease detection", "5G resource allocation", "explainable AI"]


class Command(BaseCommand):
    help = "Seed a demo publication record for the e2e faculty account (DEBUG only)."

    def handle(self, *args, **opts):
        if not settings.DEBUG:
            raise CommandError("seed_demo runs only with DJANGO_DEBUG=true.")
        me = User.objects.filter(email__iexact=email_for(Role.FACULTY)).first()
        if me is None:
            call_command("e2e_session", role="FACULTY")
            me = User.objects.get(email__iexact=email_for(Role.FACULTY))
        rnd = random.Random(7)
        colleagues = []
        for i, name in enumerate(["Dr. Priya Raman", "Dr. Karthik Subramanian"]):
            u, _ = User.objects.get_or_create(
                email=f"demo-colleague-{i}@e2e.invalid",
                defaults={"name": name, "role": Role.FACULTY, "department": "CSE", "active": True,
                          "designation": "Associate Professor"},
            )
            u.set_unusable_password()
            u.save()
            colleagues.append(u)

        Publication.objects.filter(source=TAG).delete()
        Claim.objects.filter(owner=me, paper_title__startswith="[demo]").delete()
        PaidLedger.objects.filter(voucher_number__startswith="DEMO").delete()
        FeedPost.objects.filter(author__in=colleagues).delete()

        outside = [("R. Chen", "National University of Singapore"), ("A. Kumar", "IIT Madras"),
                   ("M. Rossi", "Politecnico di Milano"), ("S. Iyer", "Anna University")]
        for n in range(25):
            year = 2013 + (n * 13) // 24
            venue, q = VENUES[n % len(VENUES)]
            pub = Publication.objects.create(
                title=f"A study of {TOPICS[n % len(TOPICS)]} for {['smart cities', 'healthcare', 'agriculture'][n % 3]} ({n + 1})",
                year=year, date=date(year, 1 + n % 12, 10), venue=venue, quartile=q,
                type="conference-paper" if "Conference" in venue or "Proceedings" in venue else "article",
                doi=f"10.5555/demo.{n + 1}", citations=rnd.randint(0, 60), scopus_indexed=True, source=TAG,
            )
            mypos = 1 if n % 3 == 0 else 2
            authors = []
            if mypos == 2:
                c = colleagues[n % 2]
                authors.append((c.name, c, True, ""))
            authors.append((me.name, me, True, ""))
            ext = outside[n % len(outside)]
            authors.append((ext[0], None, False, ext[1]))
            for pos, (name, user, college, inst) in enumerate(authors, 1):
                Authorship.objects.create(
                    publication=pub, position=pos, display_name=name, is_college=college, user=user,
                    institution_name=inst, author_key=f"n:{name.lower()}", match_confidence=1.0 if user else 0,
                    match_method="manual" if user else "",
                )

        stages = [ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED,
                  ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID]
        for i, st in enumerate(stages):
            c = Claim.objects.create(owner=me, status=st, paper_title=f"[demo] Low-power LoRa mesh for field sensors, part {i + 1}")
            if st == ClaimStatus.PAID:
                PaidLedger.objects.create(claim=c, payout_month=date(2026, 7, 1), amount=15000,
                                          paper_title=c.paper_title, journal_title="IEEE Access",
                                          voucher_number="DEMO-C1", staff_id=me.staff_id)
        for i, (m, amt) in enumerate([(date(2024, 2, 1), 10000), (date(2024, 9, 1), 25000),
                                      (date(2025, 1, 1), 12000), (date(2025, 8, 1), 30000)]):
            PaidLedger.objects.create(payout_month=m, amount=amt, staff_id=me.staff_id,
                                      paper_title=f"A study of {TOPICS[i]} for healthcare",
                                      journal_title=VENUES[i][0], voucher_number=f"DEMO-{i}")
        for c, body in zip(colleagues, ["Looking for a co-author on federated learning for hospitals.",
                                        "Our IoT intrusion paper was accepted in IEEE Access."]):
            FeedPost.objects.create(author=c, body=body, department="CSE")
        self.stdout.write(self.style.SUCCESS(f"Seeded demo record for {me.email}."))
