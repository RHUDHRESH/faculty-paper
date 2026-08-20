"""Print the permission matrix, so a person can read it and disagree.

The rules are enforced at the point of use and asserted by
PermissionMatrixTests. This is the third thing they need: a version somebody
can put in front of the research cell and the principal and ask "is this
right?" -- which is the only way a wrong line ever gets found.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.permission_matrix import CAPABILITIES, ROLES

#: Short enough to head a column without wrapping.
SHORT = {
    "FACULTY": "Fac",
    "HOD": "HoD",
    "PRINCIPAL": "Prin",
    "RESEARCH_CELL": "Cell",
    "FINANCE": "Fin",
    "SUPER_ADMIN": "Super",
}


class Command(BaseCommand):
    help = "Print who may do what, and why each line is drawn where it is."

    def add_arguments(self, parser):
        parser.add_argument(
            "--why",
            action="store_true",
            help="Print the reason under each capability.",
        )
        parser.add_argument(
            "--role",
            help="Only what this role may do.",
        )

    def handle(self, *args, **opts):
        role_filter = (opts["role"] or "").upper() or None
        if role_filter and role_filter not in ROLES:
            self.stderr.write(f"Unknown role. One of: {', '.join(ROLES)}")
            return

        if role_filter:
            self._one_role(role_filter, opts["why"])
            return

        width = max(len(c.name) for c in CAPABILITIES) + 2
        header = " " * width + "  ".join(f"{SHORT[r]:>5}" for r in ROLES)
        rule = "-" * len(header)

        group = None
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING("Who may do what"))
        self.stdout.write("")
        self.stdout.write(header)
        self.stdout.write(rule)
        for c in CAPABILITIES:
            if c.group != group:
                group = c.group
                self.stdout.write("")
                self.stdout.write(self.style.MIGRATE_LABEL(group.upper()))
            marks = "  ".join(
                f"{('yes' if r in c.allowed else '·'):>5}" for r in ROLES
            )
            self.stdout.write(f"{c.name:<{width}}{marks}")
            if opts["why"]:
                self.stdout.write(f"{'':<4}{c.because}")
                self.stdout.write("")
        self.stdout.write("")
        self.stdout.write(
            f"{len(CAPABILITIES)} capabilities x {len(ROLES)} roles = "
            f"{len(CAPABILITIES) * len(ROLES)} combinations, all asserted by "
            "PermissionMatrixTests."
        )
        self.stdout.write(
            "'yes' means the role reaches the handler, not that the call "
            "succeeds: finance may call mark-paid and still be refused because "
            "the ticket is not approved yet."
        )

    def _one_role(self, role: str, why: bool) -> None:
        allowed = [c for c in CAPABILITIES if role in c.allowed]
        refused = [c for c in CAPABILITIES if role not in c.allowed]
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING(f"{role} may:"))
        for c in allowed:
            self.stdout.write(f"  {c.name}")
            if why:
                self.stdout.write(f"      {c.because}")
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING(f"{role} may not:"))
        for c in refused:
            self.stdout.write(f"  {c.name}")
            if why:
                self.stdout.write(f"      {c.because}")
        self.stdout.write("")
        self.stdout.write(f"{len(allowed)} of {len(CAPABILITIES)} capabilities.")
