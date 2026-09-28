from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from core.models import FormulaConfig, Role, ScimagoJournal, SnipSource, User
from core.services.remuneration import DEFAULT_AUTHOR_POINTS
from core.services.scimago import parse_categories_field
import json
import os


class Command(BaseCommand):
    help = "Seed demo users and formula config (blocked in production unless forced)"

    def add_arguments(self, parser):
        parser.add_argument(
            "--force",
            action="store_true",
            help="Allow seeding when DJANGO_DEBUG=false (demo passwords — change after)",
        )
        parser.add_argument(
            "--i-know-this-is-live",
            action="store_true",
            dest="i_know_this_is_live",
            help=(
                "Seed even though the database holds real accounts or real "
                "payments. Almost never what you want."
            ),
        )
        parser.add_argument(
            "--demo",
            action="store_true",
            help=(
                "Also create a demo college: an account for every role, six more "
                "faculty, and fifteen papers spread across every stage of the "
                "chain. Safe to run again; it adds only what is missing."
            ),
        )

    def handle(self, *args, **options):
        allow = (
            settings.DEBUG
            or options.get("force")
            or os.getenv("ALLOW_DEMO_SEED", "").lower() in ("1", "true", "yes")
        )
        if not allow:
            raise CommandError(
                "Refusing to seed demo users while DJANGO_DEBUG=false. "
                "Pass --force or set ALLOW_DEMO_SEED=1, then change all passwords."
            )

        # The flag above is bypassable, and was bypassed: --force once put
        # "admin123" onto a live system holding five hundred real accounts.
        # A database with real people and real payments in it is not a
        # database to seed demo logins into, whatever flags were passed.
        from core.models import Claim, ClaimStatus

        real_people = User.objects.exclude(email__endswith="@college.edu").count()
        # The demo papers are paid to demo accounts; counting those would make
        # `seed --demo` refuse to run a second time on its own output.
        real_payments = (
            Claim.objects.filter(status=ClaimStatus.PAID)
            .exclude(owner__email__endswith="@college.edu")
            .count()
        )
        if (real_people or real_payments) and not options.get("i_know_this_is_live"):
            raise CommandError(
                f"This database holds {real_people} real accounts and "
                f"{real_payments} settled payments. Seeding demo logins into it "
                "would put known passwords on a live system. Pass "
                "--i-know-this-is-live only if that is genuinely what you want."
            )

        users = [
            (
                "admin@college.edu",
                "admin123",
                "Super Admin",
                Role.SUPER_ADMIN,
                None,
                "EMP-ADMIN",
                "SA-001",
                "BIO-ADMIN",
                # No designation. This account is a role, not a person, and
                # the demo title it used to carry ("Director") read on every
                # screen as though the college had one.
                "",
            ),
            (
                "faculty@college.edu",
                "faculty123",
                "Demo Faculty",
                Role.FACULTY,
                "CSE",
                "EMP-001",
                "STF-001",
                "BIO-001",
                "Assistant Professor",
            ),
            # No separate research-cell or HoD login: the research cell works
            # through the admin account and the HoD step no longer exists.
            # Seeding them recreated logins the college had deliberately
            # stood down.
            (
                "finance@college.edu",
                "finance123",
                "Finance",
                Role.FINANCE,
                None,
                "EMP-FIN",
                "STF-FIN",
                "BIO-FIN",
                "Accounts Officer",
            ),
            (
                "principal@college.edu",
                "principal123",
                "Demo Principal",
                Role.PRINCIPAL,
                None,
                "EMP-PRIN",
                "STF-PRIN",
                "BIO-PRIN",
                "Principal",
            ),
        ]
        self._ensure_users(users)

        if not FormulaConfig.objects.filter(active=True).exists():
            # Every figure here comes from Step 8 of the Publication Processing
            # Workflow. The old seed set qf_others=4000, which the calculator
            # then paid as a quartile incentive on unranked Engineering
            # journals — money the policy's QFA table does not provide for.
            FormulaConfig.objects.create(
                name="Publication Processing Workflow — Step 8",
                version=1,
                author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
                snip_multiplier=55000,
                snip_cap=30,
                qf_q1=50000,
                qf_q2=30000,
                qf_q3=15000,
                qf_q4=7000,
                qf_others=0,
                fixed_journal_no_snip=5000,
                fixed_other_no_snip=4000,
                fixed_web_of_science=5000,
                max_authors=9,
                min_sec_references=2,
                student_remuneration_zero=True,
                active=True,
                notes="Seeded from the Publication Processing Workflow document",
            )
            self.stdout.write("Created formula config from the workflow document")
        else:
            self.stdout.write("Formula config already present")

        year = 2024
        sample_journals = [
            {
                "title": "Nature",
                "issn": "0028-0836",
                "eissn": "1476-4687",
                "sjr": 18.288,
                "categories": "Multidisciplinary (Q1)",
            },
            {
                "title": "Science",
                "issn": "0036-8075",
                "eissn": "1095-9203",
                "sjr": 16.902,
                "categories": "Multidisciplinary (Q1)",
            },
            {
                "title": "IEEE Transactions on Pattern Analysis and Machine Intelligence",
                "issn": "0162-8828",
                "eissn": "1939-3539",
                "sjr": 4.886,
                "categories": "Computer Science (Q1)",
            },
        ]
        for j in sample_journals:
            ScimagoJournal.objects.update_or_create(
                issn=j["issn"],
                year=year,
                defaults={
                    "title": j["title"],
                    "eissn": j["eissn"],
                    "sjr": j["sjr"],
                    "categories_json": json.dumps(parse_categories_field(j["categories"])),
                    "raw_json": json.dumps(j),
                },
            )
        self.stdout.write(f"Seeded {len(sample_journals)} ScimagoJournal rows")

        sample_snip = [
            {
                "title": "Nature",
                "print_issn": "0028-0836",
                "e_issn": "1476-4687",
                "snip": 5.516,
                "sjr": 18.288,
                "source_id": "28773",
            },
            {
                "title": "Science",
                "print_issn": "0036-8075",
                "e_issn": "1095-9203",
                "snip": 4.847,
                "sjr": 16.902,
                "source_id": "28774",
            },
            {
                "title": "IEEE Transactions on Pattern Analysis and Machine Intelligence",
                "print_issn": "0162-8828",
                "e_issn": "1939-3539",
                "snip": 4.106,
                "sjr": 4.886,
                "source_id": "21100829234",
            },
        ]
        for s in sample_snip:
            SnipSource.objects.update_or_create(
                print_issn=s["print_issn"],
                year=2025,
                defaults={
                    "title": s["title"],
                    "e_issn": s["e_issn"],
                    "snip": s["snip"],
                    "sjr": s["sjr"],
                    "source_id": s["source_id"],
                    "raw_json": json.dumps(s),
                },
            )
        self.stdout.write(f"Seeded {len(sample_snip)} SnipSource rows")

        if options.get("demo"):
            self._seed_demo()

        self.stdout.write(self.style.SUCCESS("Seed complete."))

    def _seed_demo(self):
        """Every role, six more faculty, and a paper at every stage."""
        from core.api import _apply_calc  # late: core.api imports every model
        from core.management.commands import _demo

        self._ensure_users(_demo.demo_accounts())
        n = _demo.seed_journals()
        self.stdout.write(f"Seeded {n} demo journals")
        emails = {p.owner for p in _demo.PAPERS} | set(_demo._DESK.values())
        people = {u.email: u for u in User.objects.filter(email__in=emails)}
        created, kept = _demo.seed_demo_college(people, _apply_calc)
        self.stdout.write(f"Demo papers: {created} created, {kept} already there")

    def _ensure_users(self, users):
        """Create what is missing; bring the rest's details in line.

        Never re-set the password or reactivate an existing account. Re-running
        seed used to revert a password that had been deliberately changed after
        deployment, and switch a disabled account back on.
        """
        for email, password, name, role, dept, emp, staff_id, bio_id, designation in users:
            u, created = User.objects.get_or_create(
                email=email,
                defaults={
                    "name": name,
                    "role": role,
                    "department": dept,
                    "employee_id": emp,
                    "staff_id": staff_id,
                    "biometric_id": bio_id,
                    "designation": designation,
                    "is_staff": role == Role.SUPER_ADMIN,
                    "must_change_password": role == Role.SUPER_ADMIN,
                },
            )
            if created:
                u.set_password(password)
                u.active = True
                u.save()
                self.stdout.write(f"Created {email}")
                continue

            changed = False
            for attr, val in (
                ("name", name),
                ("role", role),
                ("department", dept),
                ("employee_id", emp),
                ("staff_id", staff_id),
                ("biometric_id", bio_id),
                ("designation", designation),
            ):
                if getattr(u, attr) != val:
                    setattr(u, attr, val)
                    changed = True
            if changed:
                u.save()
                self.stdout.write(f"Updated {email} (password and status left alone)")
            else:
                self.stdout.write(f"OK {email}")
