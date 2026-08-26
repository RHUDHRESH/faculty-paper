"""Appoint somebody to the Director role, without inventing a password for them.

The Director authorises every payment, so the post cannot sit empty -- but a
new account also must not arrive with a password that anybody who has read the
repository already knows. `seed` exists for demo logins and refuses to run
against a database holding real people, which this one does.

So this creates the account with **no usable password at all**. The account
exists, holds the role, and cannot be signed into until a super admin sets a
password through the ordinary reset path, which is already audited and already
forces a change on first sign-in. Nothing here ever handles a credential.

    python manage.py create_director --email director@college.edu --name "..."
    python manage.py create_director --promote someone@college.edu
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core.models import AuditLog, Role, User


class Command(BaseCommand):
    help = "Create or promote the Director account (no password is set)."

    def add_arguments(self, parser):
        parser.add_argument("--email", help="Address for a new Director account")
        parser.add_argument("--name", default="Director", help="Their name")
        parser.add_argument("--department", default=None)
        parser.add_argument("--designation", default="Director")
        parser.add_argument(
            "--promote",
            help="Move an existing account to the Director role instead of creating one",
        )

    def handle(self, *args, **options):
        promote = options.get("promote")
        email = (options.get("email") or "").strip().lower()

        if bool(promote) == bool(email):
            raise CommandError("Pass exactly one of --email (create) or --promote.")

        existing = User.objects.filter(role=Role.DIRECTOR, active=True)
        if existing.exists():
            # Not an error: a college may genuinely want two. But it is worth
            # saying, because "the Director cannot see the queue" is usually
            # somebody signing in as the wrong one of two accounts.
            self.stdout.write(
                self.style.WARNING(
                    "There is already an active Director: "
                    + ", ".join(u.email for u in existing)
                )
            )

        if promote:
            user = User.objects.filter(email__iexact=promote.strip()).first()
            if user is None:
                raise CommandError(f"No account for {promote!r}.")
            was = user.role
            if was == Role.DIRECTOR:
                self.stdout.write(f"{user.email} is already the Director.")
                return
            user.role = Role.DIRECTOR
            user.save(update_fields=["role"])
            AuditLog.objects.create(
                actor=None, action="USER_ROLE_CHANGE", entity="User", entity_id=user.id,
                detail_json=f'{{"from": "{was}", "to": "DIRECTOR", "via": "create_director"}}',
            )
            self.stdout.write(
                self.style.SUCCESS(f"{user.email}: {was} -> DIRECTOR (password unchanged)")
            )
            return

        taken = User.objects.filter(email__iexact=email).first()
        if taken:
            raise CommandError(
                f"{email} already belongs to {taken.name or 'an account'} ({taken.role}). "
                "Use --promote to move it to the Director role."
            )

        user = User(
            email=email,
            name=options["name"],
            role=Role.DIRECTOR,
            department=options.get("department"),
            designation=options.get("designation"),
            # Forces the choose-a-password dialog the moment they first sign
            # in, on whatever screen they land on.
            must_change_password=True,
            active=True,
        )
        # No password is chosen here, by anybody. Until a super admin sets one
        # there is nothing to guess and nothing to leak.
        user.set_unusable_password()
        user.save()

        AuditLog.objects.create(
            actor=None, action="USER_CREATE", entity="User", entity_id=user.id,
            detail_json='{"role": "DIRECTOR", "via": "create_director"}',
        )

        self.stdout.write(self.style.SUCCESS(f"Created {user.email} as DIRECTOR."))
        self.stdout.write("")
        self.stdout.write("No password is set, so the account cannot yet be signed into.")
        self.stdout.write("As a super admin, set one from People, or:")
        self.stdout.write(f"    python manage.py changepassword {user.email}")
