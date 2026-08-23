"""Put the decimal point back into 31,758 SJR values.

The SCImago dump is European: SJR 0.961 ships as "0,961". An early loader
stripped the comma instead of reading it as a decimal point, so the column was
stored a thousand times too large -- Nature at 19713, Ceramics International at
961, the whole table's median at 340 where SCImago's is 0.34.

The parser was fixed afterwards (services/scimago_sync.parse_decimal) but the
rows it had already written were never repaired, and nothing displayed SJR, so
nothing contradicted them. A journal record shows it, which is what made a
number no reader could believe visible at last.

The rule is narrow on purpose. A stripped comma always leaves a whole number,
because SCImago publishes SJR to three decimals; a correctly parsed value
always keeps a fraction. Three rows in the table are correctly parsed --
Nature 18.288, Science 16.902, IEEE TPAMI 4.886, from a later import -- and
each is both under 100 and fractional, so neither half of the test touches
them. Every one of the 31,758 rows at or above 100 is a whole number.

Afterwards the column runs 0.100 to 104.065, which is SCImago's own range.
"""
from django.db import migrations


def repair(apps, schema_editor):
    Scimago = apps.get_model("core", "ScimagoJournal")
    fixed = 0
    batch = []
    for row in Scimago.objects.exclude(sjr=None).filter(sjr__gte=100).iterator(chunk_size=2000):
        # Whole-number test: a real SJR of 104.065 is stored as 104065, and a
        # correctly parsed one is never both this large and this round.
        if row.sjr == int(row.sjr):
            row.sjr = row.sjr / 1000.0
            batch.append(row)
            fixed += 1
        if len(batch) >= 2000:
            Scimago.objects.bulk_update(batch, ["sjr"])
            batch = []
    if batch:
        Scimago.objects.bulk_update(batch, ["sjr"])
    print(f"  repaired SJR on {fixed:,} journal rows")


def undo(apps, schema_editor):
    """Multiplying back is exact -- the division was by a power of ten."""
    Scimago = apps.get_model("core", "ScimagoJournal")
    batch = []
    for row in Scimago.objects.exclude(sjr=None).filter(sjr__lt=100).iterator(chunk_size=2000):
        row.sjr = row.sjr * 1000.0
        batch.append(row)
        if len(batch) >= 2000:
            Scimago.objects.bulk_update(batch, ["sjr"])
            batch = []
    if batch:
        Scimago.objects.bulk_update(batch, ["sjr"])


class Migration(migrations.Migration):
    dependencies = [("core", "0023_budget_standing_findings")]
    operations = [migrations.RunPython(repair, undo)]
