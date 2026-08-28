"""Open a signed-in session for a throwaway account, without a password.

The browser tests need to be signed in as six different roles. Every other way
of doing that puts a credential somewhere: a password in a spec file, a
password in CI configuration, a password typed into a field by a robot. All
three are the same mistake -- a real, working credential for this application
sitting in a place that is read by more people than the account is meant for.

So nothing here handles a credential at all. The command creates (or finds) an
account whose password is *unusable* -- `set_unusable_password()`, so no string
exists that would sign it in -- and then writes a `django.contrib.sessions` row
by hand, exactly as `django.contrib.auth.login` would. It prints the session
key. Playwright puts that key in a cookie and is signed in.

    python manage.py e2e_session --role FACULTY
    python manage.py e2e_session --role FINANCE --json

Two further jobs, because a browser test also needs something to look at:

    python manage.py e2e_session --role FACULTY --claim   # seed a ticket
    python manage.py e2e_session --cleanup                # remove it all

Why this is safe to have in the tree
------------------------------------
It refuses to run unless `settings.DEBUG` is on, which is `DJANGO_DEBUG=true`.
A production deployment has `DJANGO_DEBUG=false` -- `settings.py` will not even
start without a real `DJANGO_SECRET_KEY` in that mode -- so on production this
command raises before it touches the database. There is no flag to override it,
deliberately: `seed.py` has a `--force` and the comment above it records that
`--force` once put a known password onto a live system holding five hundred
real people. A guard with a bypass is a guard that gets bypassed.

The accounts it makes are also inert on their own: no usable password, an
address at `.invalid` (RFC 2606 -- a TLD guaranteed never to resolve), and a
name that says what they are.
"""
from __future__ import annotations

import json as jsonlib
import uuid

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.models import AttachmentKind, Claim, ClaimAttachment, ClaimStatus, Role, User

#: Every throwaway account lives under this domain and nothing else does.
#: `.invalid` is reserved by RFC 2606 and can never be a deliverable address,
#: so one of these can never receive a notification meant for a person.
E2E_DOMAIN = "e2e.invalid"

#: The department the fixtures sit in. A head of department with a department
#: nobody publishes in gets an empty screen, which tests nothing.
E2E_DEPARTMENT = "CSE"

#: Roles a spec may ask for. Kept explicit rather than accepting anything in
#: `Role.choices`, so a typo is an error and not a silently created account.
ROLES = [
    Role.FACULTY,
    Role.HOD,
    Role.PRINCIPAL,
    Role.DIRECTOR,
    Role.FINANCE,
    Role.RESEARCH_CELL,
    Role.RESEARCH_COORDINATOR,
    Role.SUPER_ADMIN,
]

DESIGNATION = {
    Role.FACULTY: "Assistant Professor",
    Role.HOD: "Head of Department",
    Role.PRINCIPAL: "Principal",
    Role.DIRECTOR: "Director",
    Role.FINANCE: "Finance Officer",
    Role.RESEARCH_CELL: "Research Cell",
    Role.RESEARCH_COORDINATOR: "Research Coordinator",
    Role.SUPER_ADMIN: "Administrator",
}


def email_for(role: str) -> str:
    return f"e2e-{str(role).lower().replace('_', '-')}@{E2E_DOMAIN}"


class Command(BaseCommand):
    help = "Open a passwordless session for a throwaway test account (DEBUG only)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--role",
            choices=[str(r) for r in ROLES],
            help="Which role to sign in as.",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="Print a JSON object instead of the bare session key.",
        )
        parser.add_argument(
            "--claim",
            action="store_true",
            help=(
                "Also seed a SUBMITTED ticket owned by the faculty fixture, and "
                "report its ticket number. Used by the payment-chain spec."
            ),
        )
        parser.add_argument(
            "--claim-title",
            default=None,
            help="Title for the seeded ticket (default: a unique generated one).",
        )
        parser.add_argument(
            "--cleanup",
            action="store_true",
            help="Delete every fixture account, session and ticket, then stop.",
        )

    # -- the guard ---------------------------------------------------------

    def _refuse_outside_debug(self) -> None:
        """The whole safety story of this file, in four lines.

        `settings.DEBUG` is `DJANGO_DEBUG` and nothing else (see
        `config/settings.py`), so this is exactly the check asked for. There
        is no flag that turns it off.
        """
        if not settings.DEBUG:
            raise CommandError(
                "e2e_session refuses to run with DJANGO_DEBUG=false. It creates "
                "sign-in sessions without a password, which is a development "
                "and test convenience and must never be reachable on a live "
                "system. There is no override flag."
            )

    # -- fixtures ----------------------------------------------------------

    def _account(self, role: str) -> User:
        email = email_for(role)
        user = User.objects.filter(email__iexact=email).first()
        if user is None:
            user = User(email=email)
        user.name = f"E2E {str(role).replace('_', ' ').title()}"
        user.role = role
        user.designation = DESIGNATION.get(role, "Test account")
        user.active = True
        # An account that has to change its password on arrival is an account
        # every screen refuses (`require_user` 403s it) and whose first sight
        # is a modal. Neither is what a test is looking at.
        user.must_change_password = False
        user.is_staff = False
        user.is_superuser = False
        # Only the two roles whose screens are scoped to one department need
        # one; a Principal with a department reads as a departmental Principal.
        if role in (Role.FACULTY, Role.HOD):
            user.department = E2E_DEPARTMENT
        else:
            user.department = None
        if role == Role.FACULTY:
            user.staff_id = user.staff_id or "E2E0001"
        # No password exists for this account -- not a weak one, none at all.
        #
        # Only when there is not already one, though. `set_unusable_password`
        # writes a fresh random string every time it is called, and the
        # password field is an input to `get_session_auth_hash()` -- so
        # calling it unconditionally silently signs out every session this
        # account already had. That is correct behaviour for a real password
        # change and a trap here, because the suite asks for this account
        # more than once per run: the second ask logged out the first.
        if user.has_usable_password() or not user.password:
            user.set_unusable_password()
        user.save()
        return user

    def _open_session(self, user: User) -> str:
        """Exactly what `django.contrib.auth.login` writes, minus the request.

        Three keys: who, which backend vouched for them, and the hash that
        invalidates the session if the password ever changes. Anything less
        and `AuthenticationMiddleware` treats the session as anonymous.
        """
        store = SessionStore()
        store[SESSION_KEY] = str(user.pk)
        store[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
        store[HASH_SESSION_KEY] = user.get_session_auth_hash()
        store.create()
        return store.session_key

    def _seed_claim(self, owner: User, title: str | None) -> Claim:
        """A ticket sitting where the chain begins, for the payment spec.

        Filing one through the browser would be the better test, but the file
        form verifies against Scopus live and prices the result, so what the
        chain spec would be asserting is partly Elsevier's uptime. The filing
        form is covered by its own spec; this exists so the four *decisions*
        after it -- clear, approve, authorise, pay -- can be driven with a
        known amount and asserted exactly.

        The amount is **not** written directly, because writing it would prove
        nothing: `_guard_recomputed_amount` recomputes from the verified
        columns before every transition and refuses any figure that does not
        match. So the fixture instead carries the inputs that price a paper --
        a SNIP, a quartile, an author position, and the two SEC-affiliated
        references the policy requires -- and lets the real calculator produce
        the figure. That is what makes the spec's assertion meaningful: the
        amount on the button is the application's own arithmetic.

        `snip_source` and `quartile_source` are `MANUAL` on purpose. A title
        that is not in Scopus verifies as "not indexed", and
        `apply_verify_to_claim` clears any verified value that the index did
        not supply -- *unless* an admin entered it by hand, which is exactly
        what the clearing screen's "Enter verified values" does. Marking the
        fixture the same way is not a way around the check; it is the state a
        real ticket for an unindexed journal is in when it reaches the queue.
        """
        title = title or f"E2E payment chain fixture {uuid.uuid4().hex[:10]}"
        now = timezone.now()
        claim = Claim.objects.create(
            owner=owner,
            status=ClaimStatus.SUBMITTED,
            paper_title=title,
            journal_title="Journal of End To End Testing",
            publication_year=now.year,
            publication_type="Journal",
            total_authors=1,
            author_position=1,
            staff_id=owner.staff_id,
            designation=owner.designation,
            submitted_at=now,
            affiliation_ok=True,
            snip=1.0,
            snip_source="MANUAL",
            quartile="Q1",
            quartile_source="MANUAL",
            scimago_verified=True,
        )
        # Two cited SEC-affiliated references, because `min_sec_references` is
        # 2 and a ticket short of them prices at zero -- which would leave the
        # chain spec proving that ₹0 can be moved from one desk to the next.
        for i in (1, 2):
            ClaimAttachment.objects.create(
                claim=claim,
                kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/e2e/reference-{i}.pdf",
                filename=f"e2e-reference-{i}.pdf",
                size_bytes=1024,
                ref_number=str(i),
                ref_title=f"An E2E fixture reference, number {i}",
                uploaded_by=owner,
            )
        # Priced by the application's own calculator rather than by a number
        # typed here, so the queue row and the confirm button agree from the
        # first render. This is the same call every transition makes.
        from core.api import _apply_calc  # imported late: core.api imports models

        _apply_calc(claim)
        claim.save()

        # The real allocator, so the ticket reads FP-YYYY-###### like every
        # other one and the spec is searching for the shape a person would.
        from core.services.tickets import assign_ticket_number

        assign_ticket_number(claim)
        claim.save(update_fields=["ticket_number"])
        return claim

    def _cleanup(self) -> dict:
        users = list(User.objects.filter(email__iendswith=f"@{E2E_DOMAIN}"))
        ids = [u.id for u in users]
        claims = Claim.objects.filter(owner_id__in=ids)
        n_claims = claims.count()
        claims.delete()
        # Sessions carry the user id inside an encoded blob, so they are found
        # by decoding rather than by a column.
        n_sessions = 0
        for row in Session.objects.all().iterator():
            try:
                data = row.get_decoded()
            except Exception:
                continue
            if str(data.get(SESSION_KEY, "")) in ids:
                row.delete()
                n_sessions += 1
        n_users = len(users)
        User.objects.filter(id__in=ids).delete()
        return {"users": n_users, "claims": n_claims, "sessions": n_sessions}

    # -- entry point -------------------------------------------------------

    def handle(self, *args, **options):
        self._refuse_outside_debug()

        if options.get("cleanup"):
            removed = self._cleanup()
            self.stdout.write(jsonlib.dumps({"cleaned": removed}))
            return

        role = options.get("role")
        if not role:
            raise CommandError("Pass --role (or --cleanup).")

        user = self._account(role)
        key = self._open_session(user)

        out = {
            "session_key": key,
            "cookie_name": settings.SESSION_COOKIE_NAME,
            "email": user.email,
            "user_id": user.id,
            "name": user.name,
            "role": user.role,
            "department": user.department,
        }

        if options.get("claim"):
            # The ticket always belongs to the faculty fixture whoever asked
            # for it, because that is the only account that may own one.
            owner = user if user.role == Role.FACULTY else self._account(Role.FACULTY)
            claim = self._seed_claim(owner, options.get("claim_title"))
            out["claim"] = {
                "id": claim.id,
                "ticket_number": claim.ticket_number,
                "title": claim.paper_title,
                "remuneration": float(claim.remuneration or 0),
                "owner_email": owner.email,
            }

        if options.get("json"):
            self.stdout.write(jsonlib.dumps(out))
        else:
            self.stdout.write(key)
