"""A realistic department to judge the head-of-department screens against.

    python manage.py seed_demo            # CSE, 48 faculty, plus three smaller departments
    python manage.py seed_demo --department ECE --faculty 40

Seeds faculty with designations, publications 2021-2026 with quartiles and
subject areas, tickets at every stage of the chain, and a ledger row for each
paid one. Deterministic (fixed random seed) and idempotent: every paper is
keyed by a SEED-... ticket number and every person by a seed.invalid address,
so a second run adds nothing. Refuses to run unless DEBUG is on.

The figures are invented for a demo database. They describe no real person,
journal or payment.
"""
from __future__ import annotations

import random
from datetime import date, datetime, timezone as dt_tz

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import Claim, ClaimStatus, PaidLedger, Role, User

DOMAIN = "seed.invalid"

FIRST = [
    "Arun", "Priya", "Karthik", "Divya", "Suresh", "Lakshmi", "Vignesh", "Meena",
    "Ramesh", "Anitha", "Senthil", "Kavitha", "Harish", "Deepa", "Manoj", "Revathi",
    "Balaji", "Sangeetha", "Prakash", "Nithya", "Ganesh", "Swathi", "Dinesh", "Janani",
    "Murali", "Keerthana", "Rajesh", "Pavithra", "Sathish", "Gayathri", "Vinoth", "Bhuvana",
    "Ashok", "Uma", "Naveen", "Shalini", "Kumar", "Radha", "Elango", "Hema",
    "Mohan", "Sowmya", "Venkat", "Ishwarya", "Saravanan", "Malathi", "Gokul", "Preethi",
    "Selvam", "Charulatha",
]
LAST = [
    "Raman", "Subramanian", "Krishnan", "Natarajan", "Sundaram", "Venkatesan", "Murugan",
    "Balasubramanian", "Chandrasekar", "Rajendran", "Srinivasan", "Palani", "Govindan",
    "Arumugam", "Kannan", "Mani",
]
DESIGNATIONS = (
    ["Professor"] * 5 + ["Associate Professor"] * 12 + ["Assistant Professor"] * 31
)
AREAS = [
    "Machine learning", "Computer networks", "Cyber security", "Internet of things",
    "Image processing", "Cloud computing", "Natural language processing", "Data mining",
]
JOURNALS = {
    "Q1": [("IEEE Access Letters (demo)", "2169-0001"), ("Expert Systems Review (demo)", "0957-0002"),
           ("Pattern Analysis Journal (demo)", "0031-0003")],
    "Q2": [("Journal of Networked Systems (demo)", "1084-0004"), ("Applied Soft Computing Notes (demo)", "1568-0005")],
    "Q3": [("International Journal of Computing (demo)", "1727-0006"), ("Wireless Personal Letters (demo)", "0929-0007")],
    "Q4": [("Journal of Engineering Studies (demo)", "2321-0008"), ("Indian Journal of Science Notes (demo)", "0974-0009")],
    None: [("Proceedings of ICICT (demo)", None), ("Conference on Smart Systems (demo)", None)],
}
TITLE_BITS = [
    "A lightweight approach to", "Towards robust", "An efficient framework for",
    "Deep learning based", "A comparative study of", "Secure and scalable",
]
TOPICS = {
    "Machine learning": ["crop yield prediction", "credit risk scoring", "fault diagnosis"],
    "Computer networks": ["SDN traffic engineering", "5G handover", "vehicular routing"],
    "Cyber security": ["intrusion detection", "phishing URL detection", "malware triage"],
    "Internet of things": ["smart irrigation", "energy metering", "patient monitoring"],
    "Image processing": ["retinal image segmentation", "license plate recognition", "crop disease detection"],
    "Cloud computing": ["container scheduling", "serverless cold starts", "VM consolidation"],
    "Natural language processing": ["Tamil sentiment analysis", "legal text summarisation", "fake news detection"],
    "Data mining": ["student dropout prediction", "frequent pattern mining", "churn analysis"],
}
OTHER_DEPARTMENTS = {"ECE": 22, "MECH": 18, "EEE": 15}


def _status_for(year: int, rng: random.Random) -> tuple[str, bool]:
    """Older papers have mostly been paid; this year's are spread along the chain."""
    if year <= 2024:
        r = rng.random()
        if r < 0.85:
            return ClaimStatus.PAID, False
        if r < 0.93:
            return ClaimStatus.REJECTED, True
        return ClaimStatus.DIRECTOR_APPROVED, False
    options = [
        (ClaimStatus.SUBMITTED, 0.22), (ClaimStatus.CLEARED, 0.15),
        (ClaimStatus.PRINCIPAL_APPROVED, 0.12), (ClaimStatus.DIRECTOR_APPROVED, 0.1),
        (ClaimStatus.PAID, 0.3), (ClaimStatus.REJECTED, 0.07), (ClaimStatus.DRAFT, 0.04),
    ]
    r, acc = rng.random(), 0.0
    for status, weight in options:
        acc += weight
        if r < acc:
            return status, status == ClaimStatus.REJECTED and rng.random() < 0.5
    return ClaimStatus.PAID, False


class Command(BaseCommand):
    help = "Seed a realistic department (faculty, publications 2021-2026, claims, ledger). DEBUG only."

    def add_arguments(self, parser):
        parser.add_argument("--department", default="CSE")
        parser.add_argument("--faculty", type=int, default=48)

    def handle(self, *args, **opts):
        if not settings.DEBUG:
            raise CommandError("seed_demo runs only with DJANGO_DEBUG=true.")
        rng = random.Random(20260928)
        made = {"people": 0, "papers": 0}
        with transaction.atomic():
            self._department(opts["department"], opts["faculty"], rng, made, main=True)
            for dept, n in OTHER_DEPARTMENTS.items():
                if dept != opts["department"]:
                    self._department(dept, n, rng, made, main=False)
        self.stdout.write(f"seed_demo: {made['people']} people, {made['papers']} papers added")

    def _department(self, dept: str, n: int, rng: random.Random, made: dict, main: bool):
        people: list[tuple[User, str, float]] = []
        for i in range(n):
            email = f"{dept.lower()}.{i:02d}@{DOMAIN}"
            name = f"Dr. {FIRST[(i * 7 + sum(map(ord, dept))) % len(FIRST)]} {LAST[(i * 3 + sum(map(ord, dept)) // 3) % len(LAST)]}"
            designation = DESIGNATIONS[i % len(DESIGNATIONS)] if main else random.Random(email).choice(DESIGNATIONS)
            user = User.objects.filter(email=email).first()
            if user is None:
                user = User.objects.create_user(
                    email, None, name=name, role=Role.FACULTY, department=dept,
                    designation=designation, staff_id=f"{dept}{1000 + i}",
                )
                user.set_unusable_password()
                user.save(update_fields=["password"])
                made["people"] += 1
            prng = random.Random(email)
            area = AREAS[(i * 5) % len(AREAS)]
            # Output is skewed the way it is in a real department: a few
            # prolific people, a long middle, and a handful with nothing.
            activity = 0.0 if i % 9 == 4 else prng.choice([0.4, 0.8, 1.2, 1.6, 2.4, 3.5])
            if designation == "Professor":
                activity *= 1.5
            people.append((user, area, activity))

        # The head files papers too; their own screen should have some.
        if main:
            for head in User.objects.filter(role=Role.HOD, department__iexact=dept):
                for k in range(6):
                    ticket = f"SEED-{dept}-H{head.id[:6]}-{k}"
                    if not Claim.objects.filter(ticket_number=ticket).exists():
                        self._paper(dept, ticket, head, AREAS[0], 2021 + k, people, random.Random(ticket))
                        made["papers"] += 1

        index = 0
        for user, area, activity in people:
            yrng = random.Random(user.email)
            for year in range(2021, 2027):
                count = int(activity * (0.6 if year == 2026 else 1.0) + yrng.random())
                for _ in range(count):
                    index += 1
                    ticket = f"SEED-{dept}-{index:04d}"
                    if Claim.objects.filter(ticket_number=ticket).exists():
                        continue
                    self._paper(dept, ticket, user, area, year, people, random.Random(ticket))
                    made["papers"] += 1

    def _paper(self, dept, ticket, user, area, year, people, rng):
        quartile = rng.choices(["Q1", "Q2", "Q3", "Q4", None], weights=[18, 24, 26, 16, 16])[0]
        journal, issn = rng.choice(JOURNALS[quartile])
        status, outright = _status_for(year, rng)
        co = rng.sample([p for p in people if p[0] != user], k=min(len(people) - 1, rng.randint(0, 3)))
        total = len(co) + 1 + rng.randint(0, 2)
        position = rng.choice([1, 1, 1, 2, 3]) if total > 1 else 1
        month = rng.randint(1, 9 if year == 2026 else 12)
        filed = datetime(year, month, rng.randint(1, 27), 10, 0, tzinfo=dt_tz.utc)
        amount = {"Q1": 40000, "Q2": 25000, "Q3": 15000, "Q4": 8000, None: 4000}[quartile]
        authors = [{"name": user.name, "position": position}] + [
            {"name": p[0].name, "position": k + 2} for k, p in enumerate(co)
        ]
        claim = Claim.objects.create(
            owner=user, status=status, ticket_number=ticket,
            paper_title=f"{rng.choice(TITLE_BITS)} {rng.choice(TOPICS[area])}",
            journal_title=journal, issn=issn,
            doi=(f"10.5555/seed.{dept.lower()}.{ticket[-4:]}" if rng.random() > 0.12 else None),
            publication_year=year, publication_date=f"{year}-{month:02d}-15",
            publication_type="Journal" if quartile else "Conference",
            aggregation_type="Journal" if quartile else "Conference Proceeding",
            indexing_level="Scopus" if quartile else "Scopus, Web of Science" if rng.random() < 0.2 else "Scopus",
            quartile=quartile, snip=round(rng.uniform(0.3, 2.4), 2) if quartile else None,
            subject_category=area, total_authors=total, author_position=position,
            authors_json=__import__("json").dumps(authors),
            staff_id=user.staff_id, designation=user.designation,
            remuneration=amount if status != ClaimStatus.REJECTED else None,
            rejected_outright=outright,
            status_note="Journal not in the approved list" if outright else None,
            submitted_at=None if status == ClaimStatus.DRAFT else filed,
            paid_at=filed if status == ClaimStatus.PAID else None,
            payout_month=date(year, month, 1) if status == ClaimStatus.PAID else None,
        )
        if status == ClaimStatus.PAID:
            PaidLedger.objects.create(
                claim=claim, payout_month=claim.payout_month, department=dept,
                faculty_name=user.name, staff_id=user.staff_id,
                paper_title=claim.paper_title, journal_title=journal,
                amount=amount, voucher_number=f"SEED-V-{ticket[-4:]}",
            )
