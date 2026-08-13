"""Sync FacultyMaster rows into User accounts for faculty login."""
from __future__ import annotations

import os
import secrets

from django.core.management.base import BaseCommand

from core.models import FacultyMaster, Role, User


class Command(BaseCommand):
    help = "Create or update FACULTY User accounts from FacultyMaster (requires email)"

    def add_arguments(self, parser):
        parser.add_argument(
            "--password",
            type=str,
            default=os.getenv("FACULTY_DEFAULT_PASSWORD", ""),
            help="Default password for new accounts (or set FACULTY_DEFAULT_PASSWORD)",
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        dry = options["dry_run"]
        default_pw = options["password"] or secrets.token_urlsafe(12)
        created = updated = skipped = 0

        for f in FacultyMaster.objects.exclude(email__isnull=True).exclude(email=""):
            email = f.email.strip().lower()
            if not email:
                skipped += 1
                continue
            user = User.objects.filter(email=email).first()
            if not user:
                if dry:
                    self.stdout.write(f"Would create {email} ({f.name})")
                    created += 1
                    continue
                user = User.objects.create_user(
                    email=email,
                    password=default_pw,
                    name=f.name,
                    role=Role.FACULTY,
                    department=f.department,
                    staff_id=f.staff_id,
                    biometric_id=str(f.biometric_id) if f.biometric_id else None,
                    designation=f.designation,
                    scopus_author_id=f.scopus_author_id,
                    must_change_password=not bool(options["password"]),
                )
                created += 1
                self.stdout.write(self.style.SUCCESS(f"Created {email}"))
            else:
                changed = False
                # Never rewrite the role. An HoD, Principal, or Finance user whose
                # email also sits in the faculty master would otherwise be demoted
                # to FACULTY and silently lose their approval rights.
                if user.role != Role.FACULTY:
                    self.stdout.write(
                        self.style.WARNING(
                            f"Keeping role {user.role} for {email} (in faculty master)"
                        )
                    )
                for attr, val in [
                    ("name", f.name),
                    ("department", f.department),
                    ("staff_id", f.staff_id),
                    ("biometric_id", str(f.biometric_id) if f.biometric_id else None),
                    ("designation", f.designation),
                    ("scopus_author_id", f.scopus_author_id),
                ]:
                    if val and getattr(user, attr) != val:
                        setattr(user, attr, val)
                        changed = True
                if changed:
                    if dry:
                        self.stdout.write(f"Would update {email}")
                    else:
                        user.save()
                        self.stdout.write(f"Updated {email}")
                    updated += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Done. created={created} updated={updated} skipped={skipped}"
                + (" (dry-run)" if dry else "")
            )
        )
        if created and not options["password"] and not dry:
            self.stdout.write(
                self.style.WARNING(
                    "New users got random passwords with must_change_password=True"
                )
            )
