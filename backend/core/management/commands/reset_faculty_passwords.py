"""Give a group of accounts a fresh random password and write them out.

The rebuild generates passwords inside the job and discards them, so the
accounts exist but nobody can sign in. This resets them and hands back the one
copy, without touching a single claim or payment. It shares its rules with the
"Issue passwords" screen (core/services/issue_passwords.py), so the two behave
identically.

Every account is flagged `must_change_password`, so the generated value only
survives until the person signs in once.

    python manage.py reset_faculty_passwords --out gs://bucket/creds.csv
    python manage.py reset_faculty_passwords --out creds.csv --role HOD
    python manage.py reset_faculty_passwords --out creds.csv --never-signed-in
"""
from __future__ import annotations

from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from core.models import Role
from core.services import issue_passwords


class Command(BaseCommand):
    help = "Reset the passwords of one role (faculty by default) and write the new ones to a CSV"

    def add_arguments(self, parser):
        parser.add_argument("--out", required=True, help="Local path or gs://bucket/key")
        parser.add_argument(
            "--role",
            default=Role.FACULTY,
            choices=[r for r in Role.values if r != Role.SUPER_ADMIN],
            help="Which role to reset: FACULTY (default), HOD, PRINCIPAL, DIRECTOR, FINANCE, "
            "RESEARCH_CELL or RESEARCH_COORDINATOR. A super admin is never reset from here.",
        )
        parser.add_argument(
            "--never-signed-in",
            action="store_true",
            help="Everybody of any role who has never signed in, instead of one role.",
        )
        parser.add_argument(
            "--include-inactive",
            action="store_true",
            help="Also reset accounts that are stood down (former staff). Off by default.",
        )
        parser.add_argument("--limit", type=int, default=0)

    def handle(self, *args, **opts):
        if opts["never_signed_in"]:
            qs = issue_passwords.scope_queryset(
                "no_password_yet", include_inactive=opts["include_inactive"]
            )
        else:
            qs = issue_passwords.scope_queryset(
                "role", role=opts["role"], include_inactive=opts["include_inactive"]
            )
        rows = issue_passwords.issue(qs, limit=opts["limit"])
        if not rows:
            raise CommandError("No accounts matched. Nothing was changed")
        payload = issue_passwords.to_csv(rows)

        out = str(opts["out"])
        if out.startswith("gs://"):
            from google.cloud import storage

            bucket_name, _, blob_name = out[len("gs://"):].partition("/")
            blob = storage.Client().bucket(bucket_name).blob(blob_name)
            blob.upload_from_string(payload.encode("utf-8"), content_type="text/csv")
            self.stdout.write(self.style.WARNING(
                f"{len(rows)} passwords written to {out}. Download it, hand it out, "
                "and delete the copy in the bucket. It is plain text."
            ))
        else:
            path = Path(out)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload.encode("utf-8"))
            self.stdout.write(self.style.WARNING(
                f"{len(rows)} passwords written to {path}. Keep it out of git."
            ))

        self.stdout.write("  every one is flagged must_change_password")
