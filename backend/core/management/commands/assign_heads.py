"""Appoint the heads of department from the roster's designations, and the Principal.

The college's rule (2026-09-23) is one head per department, and the head is a
faculty member who also holds the post. The imported roster already says who
holds it -- in the designation column, as "Professor & Head", "HOD",
"Head (i/c)" and so on -- so this reads it rather than having the office click
through thirty departments.

    python manage.py assign_heads --from-designation --dry-run
    python manage.py assign_heads --from-designation
    python manage.py assign_heads --principal principal@college.edu [--dry-run]

`--from-designation`, for each department: the active faculty accounts
(FACULTY or HOD) whose designation contains "head" in any case.

- Exactly one: that account is made HOD. Anybody else holding the post in that
  department becomes FACULTY -- one head per department -- and each change is
  in the audit log.
- None, or several: reported and left exactly as it is. The command does not
  guess; the office decides in People, where the same rule is enforced.

An office account (Principal, Finance, the research cell ...) is never
considered, whatever its designation says: "Head - Accounts" in Finance is not
a head of department, and moving it would take a desk out of the payment chain.

`--principal EMAIL` gives that account the PRINCIPAL role, and is settled
before the heads, so a principal whose designation also says "head" is not
then made a head. It refuses the roles that decide whether money moves (super
admin, Director, Finance) -- change those in People, deliberately. Another
Principal already in post is reported, not demoted, as `create_director` does
for a second Director: whether they have left is not this command's to guess.

`--dry-run` prints exactly what would change and writes nothing.
"""
from __future__ import annotations

import json
from collections import defaultdict

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import AuditLog, Role, User
from core.services import heads, rbac

VIA = "assign_heads"


def _who(u: User) -> str:
    return f"{u.name or u.email} <{u.email}>"


class Command(BaseCommand):
    help = "Make heads of department from the designation column, and/or set the Principal."

    def add_arguments(self, parser):
        parser.add_argument(
            "--from-designation", action="store_true",
            help='Make the one account per department whose designation contains "head" its HOD.',
        )
        parser.add_argument("--principal", metavar="EMAIL", help="Give this account the PRINCIPAL role.")
        parser.add_argument("--dry-run", action="store_true", help="Show what would change; write nothing.")

    def handle(self, *args, **opts):
        if not opts["from_designation"] and not opts["principal"]:
            raise CommandError("Pass --from-designation, --principal EMAIL, or both.")
        dry = opts["dry_run"]
        self.stdout.write("Dry run — nothing will be written." if dry else "Writing changes.")

        with transaction.atomic():
            principal = self._principal(opts["principal"], dry) if opts["principal"] else None
            if opts["from_designation"]:
                self._heads(dry, skip=principal)
            if dry:
                transaction.set_rollback(True)

    # ---- the Principal ---------------------------------------------------

    def _principal(self, email: str, dry: bool) -> User:
        from core.api.admin import PRIVILEGED_ROLES  # late: core.api imports every model

        target = User.objects.filter(email__iexact=email.strip()).first()
        if target is None:
            raise CommandError(f"No account for {email!r}.")
        if not target.active:
            raise CommandError(f"{target.email} is switched off; switch it on in People first.")
        if target.role in PRIVILEGED_ROLES:
            raise CommandError(
                f"{target.email} holds the {target.role} role, which decides whether money "
                "moves. Change it in People if that is really meant."
            )

        others = User.objects.filter(role=Role.PRINCIPAL, active=True).exclude(pk=target.pk)
        if target.role == Role.PRINCIPAL:
            self.stdout.write(f"Principal: already PRINCIPAL — {_who(target)}")
        else:
            was = target.role
            note = (
                f" (was head of {heads.department_of(target)}, which is left with no head)"
                if was == Role.HOD else ""
            )
            self.stdout.write(f"Principal: {_who(target)} {was} -> PRINCIPAL{note}")
            target.role = Role.PRINCIPAL
            target.save(update_fields=["role", "updated_at"])
            AuditLog.objects.create(
                actor=None, action="USER_ROLE_CHANGE", entity="User", entity_id=target.id,
                detail_json=json.dumps({"from": was, "to": Role.PRINCIPAL, "via": f"{VIA} --principal"}),
            )
        for other in others:
            self.stdout.write(
                self.style.WARNING(
                    f"  also PRINCIPAL, left as is: {_who(other)} — change it in People if they have left"
                )
            )
        return target

    # ---- the heads -------------------------------------------------------

    def _heads(self, dry: bool, *, skip: User | None) -> None:
        faculty = (
            # FACULTY_ROLES, not CLAIMANT_ROLES: an office account files its
            # own papers too, and is still never a candidate for head.
            User.objects.filter(active=True, role__in=rbac.FACULTY_ROLES)
            .exclude(department__isnull=True)
            .order_by("email")
        )
        if skip is not None:
            faculty = faculty.exclude(pk=skip.pk)

        departments: dict[str, list[User]] = defaultdict(list)
        label: dict[str, str] = {}
        for u in faculty:
            name = heads.department_of(u)
            if not name:
                continue
            key = name.casefold()
            departments[key].append(u)
            label.setdefault(key, name)

        self.stdout.write('Heads, from the designation column (contains "head", any case):')
        appointed = in_post = undecided = 0
        for key in sorted(departments, key=lambda k: label[k].casefold()):
            dept = label[key]
            members = departments[key]
            in_office = [u for u in members if u.role == Role.HOD]
            named = [u for u in members if "head" in (u.designation or "").casefold()]

            if len(named) != 1:
                undecided += 1
                now = (
                    "head in post: " + ", ".join(_who(u) for u in in_office)
                    if in_office else "no head in post"
                )
                if named:
                    self.stdout.write(
                        f"  {dept}: several — {', '.join(_who(u) for u in named)}; "
                        f"left as is ({now})"
                    )
                else:
                    self.stdout.write(
                        f'  {dept}: none — no active faculty designation contains "head"; '
                        f"left as is ({now})"
                    )
                continue

            chosen = named[0]
            others = [u for u in in_office if u.pk != chosen.pk]
            replaces = (
                f" (replaces {', '.join(_who(u) for u in others)}, who becomes FACULTY)"
                if others else ""
            )
            if chosen.role == Role.HOD and not others:
                in_post += 1
                self.stdout.write(f"  {dept}: already HOD — {_who(chosen)}")
                continue
            appointed += 1
            if chosen.role == Role.HOD:
                self.stdout.write(f"  {dept}: already HOD — {_who(chosen)}{replaces}")
            else:
                self.stdout.write(f"  {dept}: {_who(chosen)} -> HOD{replaces}")

            was = chosen.role
            chosen.role = Role.HOD
            heads.appoint(chosen, replace=True, actor=None, via=VIA)
            if was != Role.HOD:
                chosen.save(update_fields=["role", "updated_at"])
                AuditLog.objects.create(
                    actor=None, action="USER_ROLE_CHANGE", entity="User", entity_id=chosen.id,
                    detail_json=json.dumps(
                        {"from": was, "to": Role.HOD, "via": f"{VIA} --from-designation"}
                    ),
                )

        summary = (
            f"{appointed} to appoint, {in_post} already in post, "
            f"{undecided} need a decision in People."
        )
        if dry:
            self.stdout.write(summary)
        else:
            self.stdout.write(self.style.SUCCESS(summary.replace("to appoint", "appointed")))
