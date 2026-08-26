"""The third pass at the same spreadsheet bug, and the one that finishes it.

Migrations 0027 and 0028 repaired the ISSNs that had lost a *single* leading
zero. They did not repair the ones that had lost two, because `normalize_issn`
only ever padded one — and nothing said so, because a six-character value fails
the eight-character check and falls through returning the original string. It
looked like a value nothing could be done with rather than one the repair had
skipped.

ISSN 0010-0161 read as a number is 100161. Six characters. Every such row has
been unmatchable against the reference data since the import, which means every
paper in one of those journals was priced without a quartile.

  Scimago      823 rows
  SNIP       3,291 rows
  Claims       430 rows

Padding is a guess, so it is verified rather than trusted. An ISSN's last
character is a mod-11 check digit over the first seven, and a wrong number of
zeros almost never satisfies it — `normalize_issn` now accepts a padded value
only when the checksum agrees. That distinction is the whole safety of this
migration: a fabricated ISSN is not a null, it is a real identifier belonging
to a different journal, and it would attach that journal's quartile to this
one. 100459 is in the data and does not check out; it is left exactly as it is.

Recovery, measured before writing this: 823 of 823 Scimago, 3,280 of 3,291
SNIP, 391 of 430 claims. The remainder are values no padding makes valid, and
they stay untouched rather than being guessed at.
"""

from django.db import migrations

#: (model, field) pairs carrying an ISSN that the importers wrote raw.
TARGETS = [
    ("ScimagoJournal", "issn"),
    ("ScimagoJournal", "eissn"),
    ("SnipSource", "print_issn"),
    ("SnipSource", "e_issn"),
    ("Claim", "issn"),
]


def repair(apps, schema_editor):
    import re

    from core.services.normalize import normalize_issn

    total_fixed = 0
    for model_name, field in TARGETS:
        Model = apps.get_model("core", model_name)
        batch = []
        for pk, raw in Model.objects.exclude(**{f"{field}__isnull": True}).exclude(
            **{field: ""}
        ).values_list("pk", field):
            text = str(raw)
            bare = re.sub(r"[^0-9Xx]", "", text).upper()
            # Only the rows the earlier repairs could not reach. A value that
            # is already eight characters is either correct or wrong in a way
            # this migration has no business guessing about.
            if len(bare) == 8:
                continue
            fixed = normalize_issn(text)
            if fixed and fixed != text and len(re.sub(r"[^0-9Xx]", "", fixed)) == 8:
                obj = Model(pk=pk)
                setattr(obj, field, fixed)
                batch.append(obj)

        if batch:
            Model.objects.bulk_update(batch, [field], batch_size=500)
            total_fixed += len(batch)
            print(f"  repaired {len(batch):,} {model_name}.{field} values")

    print(f"  {total_fixed:,} ISSNs recovered in total")


def unrepair(apps, schema_editor):
    """Deliberately not reversible.

    The original values are corrupt and carry no information the repaired ones
    do not — putting the missing zeros back would be restoring damage, and
    there is nothing to restore it from.
    """


class Migration(migrations.Migration):
    dependencies = [("core", "0033_quota_position")]
    operations = [migrations.RunPython(repair, unrepair)]
