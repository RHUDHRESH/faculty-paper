"""Close the import flags raised where the ERP's amount and working are both zero."""
from django.db import migrations


def forwards(apps, schema_editor):
    from core.services.import_discrepancies import close_zero_both_ways

    close_zero_both_ways(apps)


class Migration(migrations.Migration):
    dependencies = [("core", "0043_claim_flags_and_file_checks")]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
