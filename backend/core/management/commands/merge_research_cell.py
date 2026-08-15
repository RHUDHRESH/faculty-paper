"""Fold RESEARCH_CELL accounts into SUPER_ADMIN.

The scheme runs on four roles now — faculty, admin, finance, principal — and the
research cell *was* the admin: it cleared tickets, ran the imports, and filed on
faculty's behalf. Merging is therefore a rename rather than a privilege change,
with the one addition of user management.

    python manage.py merge_research_cell          # show who would move
    python manage.py merge_research_cell --apply  # move them
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import AuditLog, Role, User


class Command(BaseCommand):
    help = "Move every RESEARCH_CELL account to SUPER_ADMIN."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write the change.")

    def handle(self, *args, **opts):
        users = list(User.objects.filter(role=Role.RESEARCH_CELL).order_by("email"))
        if not users:
            self.stdout.write(self.style.SUCCESS("No RESEARCH_CELL accounts remain."))
            return

        self.stdout.write(f"{len(users)} account(s) would become SUPER_ADMIN:")
        for u in users:
            self.stdout.write(f"  {u.email}  ({u.name})")

        if not opts["apply"]:
            self.stdout.write(self.style.WARNING("\nDry run. Re-run with --apply to move them."))
            return

        with transaction.atomic():
            for u in users:
                u.role = Role.SUPER_ADMIN
                u.save(update_fields=["role", "updated_at"])
                AuditLog.objects.create(
                    actor=None,
                    action="ROLE_MERGED",
                    entity="User",
                    entity_id=u.id,
                    detail_json=json.dumps({"from": "RESEARCH_CELL", "to": "SUPER_ADMIN"}),
                )
        self.stdout.write(self.style.SUCCESS(f"\nMoved {len(users)} account(s) to SUPER_ADMIN."))
