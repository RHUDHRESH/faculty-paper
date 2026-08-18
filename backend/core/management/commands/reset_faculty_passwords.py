"""Give every faculty account a fresh random password and write them out.

The rebuild generates passwords inside the job and discards them, so the
accounts exist but nobody can sign in. This resets them and hands back the one
copy, without touching a single claim or payment.

Every account is flagged `must_change_password`, so the generated value only
survives until the person signs in once.

    python manage.py reset_faculty_passwords --out gs://bucket/creds.csv
"""
from __future__ import annotations

import csv
import io
import secrets
import string
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import Role, User

#: Ambiguous characters are left out: these get read off a screen and typed.
ALPHABET = "".join(
    c for c in (string.ascii_letters + string.digits) if c not in "O0oIl1"
)
FIELDS = ["email", "name", "department", "staff_id", "password"]


def password(length: int = 14) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


class Command(BaseCommand):
    help = "Reset every faculty password and write the new ones to a CSV"

    def add_arguments(self, parser):
        parser.add_argument("--out", required=True, help="Local path or gs://bucket/key")
        parser.add_argument(
            "--include-inactive",
            action="store_true",
            help="Also reset accounts that are stood down (former staff). Off by default.",
        )
        parser.add_argument("--limit", type=int, default=0)

    def handle(self, *args, **opts):
        qs = User.objects.filter(role=Role.FACULTY)
        if not opts["include_inactive"]:
            qs = qs.filter(active=True)
        # Holding records for people who have left are not sign-in accounts.
        qs = qs.exclude(email__endswith="@saveetha.invalid")
        if opts["limit"]:
            qs = qs[: opts["limit"]]

        rows = []
        with transaction.atomic():
            for user in qs:
                pw = password()
                user.set_password(pw)
                # The generated value is a delivery mechanism, not a password:
                # it stops working the moment they choose their own.
                user.must_change_password = True
                user.save(update_fields=["password", "must_change_password"])
                rows.append(
                    {
                        "email": user.email,
                        "name": user.name or "",
                        "department": user.department or "",
                        "staff_id": user.staff_id or "",
                        "password": pw,
                    }
                )

        if not rows:
            raise CommandError("No faculty accounts matched — nothing was changed")

        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        payload = buf.getvalue()

        out = str(opts["out"])
        if out.startswith("gs://"):
            from google.cloud import storage

            bucket_name, _, blob_name = out[len("gs://"):].partition("/")
            blob = storage.Client().bucket(bucket_name).blob(blob_name)
            blob.upload_from_string(payload, content_type="text/csv")
            self.stdout.write(self.style.WARNING(
                f"{len(rows)} passwords written to {out}. Download it, hand it out, "
                "and delete the copy in the bucket — it is plain text."
            ))
        else:
            path = Path(out)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(payload, encoding="utf-8", newline="")
            self.stdout.write(self.style.WARNING(
                f"{len(rows)} passwords written to {path}. Keep it out of git."
            ))

        self.stdout.write(f"  every one is flagged must_change_password")
