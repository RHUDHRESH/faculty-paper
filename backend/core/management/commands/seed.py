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
                "Director",
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
            (
                "research@college.edu",
                "research123",
                "Admin",
                Role.SUPER_ADMIN,
                None,
                "EMP-RC",
                "STF-RC",
                "BIO-RC",
                "Research Coordinator",
            ),
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

            # Never re-set the password or reactivate an existing account. Re-running
            # seed used to revert a password that had been deliberately changed after
            # deployment, and switch a disabled account back on.
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

        if not FormulaConfig.objects.filter(active=True).exists():
            FormulaConfig.objects.create(
                name="Policy v1",
                version=1,
                author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
                qf_others=4000,
                snip_cap=30,
                student_remuneration_zero=True,
                qf_only_for_no_snip=True,
                active=True,
                notes="Default seed formula — Policy v1",
            )
            self.stdout.write("Created formula config Policy v1")
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

        self.stdout.write(self.style.SUCCESS("Seed complete."))
