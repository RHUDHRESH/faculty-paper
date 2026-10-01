"""Run the data-health audit and print it (read-only unless --fix is given)."""
from django.core.management.base import BaseCommand

from core.services import integrity


class Command(BaseCommand):
    help = "Check the database for contradictions; --store keeps the report for the admin page."

    def add_arguments(self, parser):
        parser.add_argument("--store", action="store_true")
        parser.add_argument("--fix", choices=sorted(integrity.FIXES), action="append", default=[])
        parser.add_argument("--rows", type=int, default=3, help="sample rows to print per finding")

    def handle(self, *args, store=False, fix=(), rows=3, **kw):
        for key in fix:
            n = integrity.apply_fix(key, None)
            self.stdout.write(f"fix {key}: {n} rows changed")
        report = integrity.run_and_store() if store else integrity.run_audit()
        self.stdout.write(f"ran in {report['seconds']}s; problems {report['problems']}")
        for f in report["findings"]:
            mark = "  " if not f["count"] else {"error": "E ", "warning": "W ", "info": "i "}[f["severity"]]
            self.stdout.write(f"{mark}{f['count']:>6}  [{f['key']}] {f['title']}")
            for r in f["rows"][:rows] if f["count"] else []:
                self.stdout.write(f"            - {r['label']}")
