"""The other half of the same spreadsheet bug, in the Scimago table.

Migration 0027 cleaned 50,565 corrupted ISSNs in the SNIP table and the match
rate against Scimago went from 32% to 67%. It also *broke* a handful of
journals that had been matching before, and the reason is worth writing down:
both tables carried the same corruption, so a journal stored as
``15684946.0`` on both sides matched itself. Cleaning one side alone pulled
those pairs apart.

9,993 ISSN values here carry the float suffix and 9,177 change under
`normalize_issn` — the rest are already what it would produce.

The lesson for anyone importing the next dump: normalise on the way in.
`normalize_issn` has known how to undo this since the day a real ISSN belonging
to another journal was reconstructed out of a mangled one; the importers just
never called it. Two tables have now had to be repaired after the fact.
"""

from django.db import migrations


def repair(apps, schema_editor):
    from core.services.normalize import normalize_issn

    ScimagoJournal = apps.get_model("core", "ScimagoJournal")

    fixed = 0
    emptied = 0
    batch = []

    for row in ScimagoJournal.objects.all().only("id", "issn", "eissn").iterator(
        chunk_size=2000
    ):
        touched = False
        for field in ("issn", "eissn"):
            raw = getattr(row, field)
            if not raw:
                continue
            normalised = normalize_issn(str(raw))
            cleaned = normalised.replace("-", "") if normalised else None
            if cleaned != str(raw).strip():
                setattr(row, field, cleaned)
                touched = True
                if cleaned:
                    fixed += 1
                else:
                    emptied += 1
        if touched:
            batch.append(row)
        if len(batch) >= 1000:
            ScimagoJournal.objects.bulk_update(batch, ["issn", "eissn"])
            batch = []

    if batch:
        ScimagoJournal.objects.bulk_update(batch, ["issn", "eissn"])

    print(f"  repaired {fixed} Scimago ISSN values, cleared {emptied} unusable ones")


def noop(apps, schema_editor):
    """Not reversible — the original values are the bug."""


class Migration(migrations.Migration):
    dependencies = [("core", "0027_repair_snip_issns")]
    operations = [migrations.RunPython(repair, noop)]
