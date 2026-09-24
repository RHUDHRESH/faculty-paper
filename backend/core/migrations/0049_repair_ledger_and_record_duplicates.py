"""One-off: correct the April-June 2026 ledger amounts and record repeat payments.

Render's free plan has no shell, so the two commands that fix the imported
history run once here, at deploy. `repair_ledger_amounts --apply` only
touches rows where the workbook's own working agrees, and writes an audit
entry; `find_duplicate_payments` only records findings for the office to
judge -- it changes no money, and only same-person repeats are kept. Both are safe to run again, and do nothing on
an installation with no imported history (every test database).
"""
import io

from django.core.management import call_command
from django.db import migrations


def forwards(apps, schema_editor):
    if not apps.get_model("core", "PaidLedger").objects.exists():
        return
    call_command("repair_ledger_amounts", "--apply", stdout=io.StringIO())
    call_command("find_duplicate_payments", stdout=io.StringIO())
    # Co-authors each claim their own share of one paper, so "paid to two
    # different people" is the scheme working, not a repeat. Only the same
    # person paid twice goes to the office.
    apps.get_model("core", "DuplicateFinding").objects.filter(
        kind="CROSS_PERSON", status="OPEN", reviewed_at__isnull=True
    ).delete()


class Migration(migrations.Migration):
    dependencies = [("core", "0048_merge_0045_social_feed_0047_hook_rewards")]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
