"""Repair the SNIP table's ISSNs, which a spreadsheet turned into floats.

53,848 of the ISSN values across 32,087 SNIP rows are stored like
``14327643.0`` — a column read as a number on the way in. Two things follow,
and both are silent:

* The trailing ``.0`` means an ISSN never equals the same ISSN in the Scimago
  table, which stores ``14327643``. So a journal we hold a SNIP for looks like
  a journal we hold no SNIP for.
* Read as a number, ``0390-6663`` loses its leading zero and arrives as
  ``3906663``. Seven characters, so even stripping the suffix does not fix it;
  the zero has to be put back.

The visible consequence was that only about a third of journals could be
priced. SNIP is a term in the payout formula, so a missing SNIP is not a
cosmetic gap — it is the difference between telling somebody a venue is worth
₹115,448 and telling them we cannot say.

The live verification path had been quietly papering over this by falling back
to matching on journal *title* when the ISSN missed, which works often enough
to hide the problem and pairs the wrong two rows the rest of the time.

`normalize_issn` already knew how to undo both mistakes. Nothing had applied it
to the stored data.
"""

from django.db import migrations


def repair(apps, schema_editor):
    from core.services.normalize import normalize_issn

    SnipSource = apps.get_model("core", "SnipSource")

    fixed = 0
    emptied = 0
    batch = []

    for row in SnipSource.objects.all().only("id", "print_issn", "e_issn").iterator(
        chunk_size=2000
    ):
        touched = False
        for field in ("print_issn", "e_issn"):
            raw = getattr(row, field)
            if not raw:
                continue
            normalised = normalize_issn(str(raw))
            # Stored without the hyphen, because that is how the Scimago table
            # stores it and these two are compared against each other.
            cleaned = normalised.replace("-", "") if normalised else None
            if cleaned != str(raw).strip():
                setattr(row, field, cleaned)
                touched = True
                if cleaned:
                    fixed += 1
                else:
                    # Unsalvageable — better empty than a value that will match
                    # the wrong journal.
                    emptied += 1
        if touched:
            batch.append(row)
        if len(batch) >= 1000:
            SnipSource.objects.bulk_update(batch, ["print_issn", "e_issn"])
            batch = []

    if batch:
        SnipSource.objects.bulk_update(batch, ["print_issn", "e_issn"])

    print(f"  repaired {fixed} SNIP ISSN values, cleared {emptied} unusable ones")


def noop(apps, schema_editor):
    """Not reversible.

    The original values are corrupt; putting them back would only restore the
    bug, and the correct value cannot be derived from what replaced it.
    """


class Migration(migrations.Migration):
    dependencies = [("core", "0026_research_interest")]
    operations = [migrations.RunPython(repair, noop)]
