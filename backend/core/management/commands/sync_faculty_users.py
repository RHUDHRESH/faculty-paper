"""Sync FacultyMaster rows into User accounts for faculty login."""
from __future__ import annotations

import os
import re
import secrets

from django.core.management.base import BaseCommand

from core.models import FacultyMaster, Role, User


COLLEGE_DOMAIN = os.getenv("COLLEGE_EMAIL_DOMAIN", "saveetha.ac.in").lower()
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def pick_email(raw: str | None) -> str | None:
    """The address to sign in with, out of whatever the spreadsheet cell holds.

    The ERP's email cells hold "gmail, college", "college & gmail", two
    addresses separated by a space, or a qualification typed into the wrong
    column. Taken whole, none of those is an address anybody can sign in
    with. The college address wins (it is the one Google sign-in accepts);
    otherwise the first real address; otherwise nothing.
    """
    found = [e.lower() for e in _EMAIL.findall(raw or "")]
    for e in found:
        if e.endswith("@" + COLLEGE_DOMAIN):
            return e
    return found[0] if found else None


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
        # One password for every account created in a run meant one secret
        # opened all of them. Each account now gets its own unless --password
        # is given explicitly (and every new account must change it anyway).
        shared_pw = options["password"] or None
        created = updated = skipped = 0

        for f in FacultyMaster.objects.exclude(email__isnull=True).exclude(email=""):
            email = pick_email(f.email)
            if not email:
                self.stdout.write(self.style.WARNING(f"No usable email for {f.name}: {f.email!r}"))
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
                    password=shared_pw or secrets.token_urlsafe(12),
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
