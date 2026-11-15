"""Check, or import, the college's Faculty_List.xlsx.

    python manage.py import_faculty_list Faculty_List.xlsx            # check only
    python manage.py import_faculty_list Faculty_List.xlsx --apply    # import

The same code as Admin > Imports; a check writes nothing.
"""
import json

from django.core.management.base import BaseCommand, CommandError

from core.models import AuditLog
from core.services.faculty_list_import import import_faculty_list, read_faculty_list


class Command(BaseCommand):
    help = "Check (default) or import Faculty_List.xlsx"

    def add_arguments(self, parser):
        parser.add_argument("xlsx")
        parser.add_argument("--apply", action="store_true", help="Write the changes. Without it nothing is written.")

    def handle(self, *args, **opts):
        try:
            people = read_faculty_list(opts["xlsx"])
        except Exception as exc:
            raise CommandError(f"Could not read the workbook: {exc}") from exc
        r = import_faculty_list(people, dry_run=not opts["apply"])
        if opts["apply"]:
            AuditLog.objects.create(
                actor=None, action="FACULTY_LIST_IMPORT", entity="FacultyMaster",
                detail_json=json.dumps({**r["counts"], "updated_fields": r["updated_fields"],
                                        "not_in_list": r["not_in_list"], "via": "command"}),
            )
        out = self.stdout.write
        out(("Imported" if opts["apply"] else "Check only, nothing written") + ":")
        for sheet, v in r["sheets"].items():
            out(f"  {sheet}: {v['people']} people")
        out("  " + ", ".join(f"{k} {v}" for k, v in r["counts"].items()))
        out("  fields set: " + ", ".join(f"{k} {v}" for k, v in r["updated_fields"].items()))
        for c in r["conflicts"]:
            out(f"  conflict {c['staff_id']} {c['name']}: {c['field']} is {c['current']}, list says {c['incoming']}")
        for n in r["needs_email"]:
            out(f"  needs email: {n['staff_id']} {n['name']}")
        out(f"  active accounts not in the list: {r['not_in_list']}")
        if not opts["apply"]:
            out("Run again with --apply to import.")
