"""A college's worth of demo data, so report pages can be judged with figures.

Runs `seed --demo` (accounts in every role, papers at every stage of the
chain), then adds, deterministically:

- faculty across six departments (all `@college.edu`, demo accounts),
- a publication record for 2022-2026 with college authorships,
- ledger payments for most of those papers, paid 1-5 months after the year,
- a college-wide budget and department ring-fences for FY 2024-25 .. 2026-27.

Debug databases only. Idempotent: rows are keyed by a `DEMO-SEED` marker.
"""
from __future__ import annotations

import random
from datetime import date

from django.conf import settings
from django.core.management import BaseCommand, CommandError, call_command
from django.db import transaction

from core.models import Authorship, Budget, PaidLedger, Publication, Role, User

DEPARTMENTS = {
    # The codes the college's records use (and the `seed --demo` accounts).
    "CSE": (14, 1.4),
    "ECE": (11, 1.1),
    "MECH": (10, 0.6),
    "CIVIL": (8, 0.45),
    "EEE": (9, 0.8),
    "IT": (7, 1.0),
}
FIRST = ["Anitha", "Ramesh", "Kavitha", "Suresh", "Priya", "Arun", "Deepa", "Vijay",
         "Lakshmi", "Karthik", "Meena", "Senthil", "Divya", "Prakash", "Revathi", "Ganesh"]
LAST = ["Kumar", "Raman", "Srinivasan", "Natarajan", "Balaji", "Subramanian", "Iyer", "Murugan"]
QUARTILES = ["Q1", "Q2", "Q2", "Q3", "Q3", "Q4", ""]
RATE = {"Q1": 25000, "Q2": 15000, "Q3": 10000, "Q4": 6000, "": 3000}
MARK = "DEMO-SEED"


class Command(BaseCommand):
    help = "Seed a demo college (departments, 2022-2026 papers, ledger, budgets). Debug only."

    def handle(self, *args, **opts):
        if not settings.DEBUG:
            raise CommandError("seed_demo runs only with DJANGO_DEBUG=true.")
        call_command("seed", demo=True)
        if Publication.objects.filter(source=MARK).exists():
            self.stdout.write("Demo college already seeded.")
            return
        rng = random.Random(2026)
        with transaction.atomic():
            n_pubs = n_pay = 0
            for dept, (size, rate) in DEPARTMENTS.items():
                slug = dept.lower()
                people = []
                for i in range(size):
                    email = f"{slug}{i + 1}@college.edu"
                    u, _ = User.objects.get_or_create(email=email, defaults={
                        "name": f"Dr. {FIRST[(i * 3 + len(slug)) % len(FIRST)]} {LAST[(i + len(dept)) % len(LAST)]}",
                        "role": Role.FACULTY, "department": dept,
                        "designation": ["Assistant Professor", "Associate Professor", "Professor"][i % 3],
                    })
                    people.append(u)
                for year in range(2022, 2027):
                    growth = 1 + 0.18 * (year - 2022)
                    months = 12 if year < 2026 else 8
                    n = int(size * rate * growth * months / 12 + rng.random() * 3)
                    for k in range(n):
                        q = rng.choice(QUARTILES)
                        who = rng.sample(people, k=min(len(people), rng.choice([1, 1, 2])))
                        pub = Publication.objects.create(
                            title=f"{dept.split()[0]} study {year}-{k + 1}: {rng.choice(['adaptive', 'robust', 'low-power', 'sustainable', 'data-driven'])} {rng.choice(['control', 'networks', 'materials', 'sensing', 'learning'])}",
                            year=year, venue=f"Journal of {dept.split()[0]} Research {rng.randint(1, 9)}",
                            issn=f"{rng.randint(1000, 9999)}-{rng.randint(1000, 9999)}",
                            quartile=q, scopus_indexed=rng.random() < 0.85, type="article",
                            doi=f"10.5555/demo.{slug}.{year}.{k + 1}", source=MARK,
                            citations=rng.randint(0, 40),
                        )
                        for pos, u in enumerate(who):
                            Authorship.objects.create(
                                publication=pub, position=pos + 1, display_name=u.name,
                                author_key=f"{MARK}:{u.id}", is_college=True, user=u,
                            )
                        if rng.random() < 0.8 and (year < 2026 or rng.random() < 0.5):
                            pay_year = year + (1 if rng.random() < 0.6 else 0)
                            pay_month = rng.randint(1, 9 if pay_year == 2026 else 12)
                            if pay_year > 2026:
                                continue
                            row = PaidLedger.objects.create(
                                payout_month=date(pay_year, pay_month, 1), department=dept,
                                faculty_name=who[0].name, paper_title=pub.title,
                                journal_title=pub.venue, amount=RATE[q],
                                voucher_number=f"{MARK}-{n_pay + 1}",
                            )
                            pub.ledger_rows.add(row)
                            n_pay += 1
                        n_pubs += 1
            for fy, total in (("2024-25", 1_800_000), ("2025-26", 2_400_000), ("2026-27", 2_800_000)):
                Budget.objects.get_or_create(financial_year=fy, department=None,
                                             defaults={"amount": total})
                for dept, (size, rate) in DEPARTMENTS.items():
                    Budget.objects.get_or_create(financial_year=fy, department=dept, defaults={
                        "amount": round(total * size * rate / 60, -3)})
        self.stdout.write(f"Seeded {n_pubs} publications, {n_pay} ledger payments, budgets.")
