"""Repair the identity fields carried in from the ERP spreadsheet.

Two problems, both silent:

1. Excel returns whole numbers as floats, so author IDs landed as
   "57306678000.0" and biometric IDs as "4168.0". Neither is an ID.
2. The importer never derived `scopus_author_url`, and the claim wizard
   requires it — so every imported faculty member was blocked from filing.

All of it is derivable, so it is fixed here rather than asked of 400 people.

PaidLedger is deliberately untouched: it records what was written at the
moment money moved, and biometric_id is only ever copied for display, never
joined on.
"""

from django.db import migrations

SCOPUS_AUTHOR_URL = "https://www.scopus.com/authid/detail.uri?authorId={}"


def _clean(value):
    if not value:
        return None
    v = str(value).strip()
    if v.endswith(".0") and v[:-2].isdigit():
        v = v[:-2]
    return v or None


def forwards(apps, schema_editor):
    User = apps.get_model("core", "User")
    Claim = apps.get_model("core", "Claim")
    FacultyMaster = apps.get_model("core", "FacultyMaster")

    for model, backfill_url in ((User, True), (Claim, False), (FacultyMaster, False)):
        dirty = []
        for row in model.objects.all().iterator(chunk_size=500):
            changed = False
            for field in ("scopus_author_id", "biometric_id"):
                current = getattr(row, field, None)
                if not current:
                    continue
                cleaned = _clean(current)
                if cleaned != current:
                    setattr(row, field, cleaned)
                    changed = True
            if (
                backfill_url
                and row.scopus_author_id
                and not (row.scopus_author_url or "").strip()
            ):
                row.scopus_author_url = SCOPUS_AUTHOR_URL.format(row.scopus_author_id)
                changed = True
            if changed:
                dirty.append(row)

        fields = ["scopus_author_id", "biometric_id"]
        if backfill_url:
            fields.append("scopus_author_url")
        for i in range(0, len(dirty), 500):
            model.objects.bulk_update(dirty[i : i + 500], fields)


class Migration(migrations.Migration):
    dependencies = [("core", "0016_second_approval_off_by_default")]

    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
