"""One staff id, one person -- whatever the case it is typed in.

`user_staff_id_unique` (0062) compared staff ids exactly, so "sec123" and
"SEC123" could belong to two people, and the payments page matched the ledger
case-insensitively: one of them read the other's payments. This adds the
case-insensitive constraint.

It fails loudly rather than skipping quietly the way 0062 did: if two accounts
already share a staff id in different case, the migration stops and names
them. Fix the rows (People > edit) and migrate again. Setting
MIGRATE_ALLOW_STAFF_ID_CASE_DUPES=true skips the constraint with a warning on
stderr instead, for an emergency deploy.
"""
import os
import sys

from django.db import migrations, models
from django.db.models.functions import Lower

CONSTRAINT = models.UniqueConstraint(
    Lower("staff_id"),
    condition=models.Q(staff_id__isnull=False) & ~models.Q(staff_id=""),
    name="user_staff_id_ci_unique",
)


def forwards(apps, schema_editor):
    User = apps.get_model("core", "User")
    dupes = list(
        User.objects.exclude(staff_id__isnull=True).exclude(staff_id="")
        .annotate(k=Lower("staff_id")).values("k").annotate(n=models.Count("pk")).filter(n__gt=1)
        .values_list("k", flat=True)
    )
    if dupes:
        msg = (
            "0068: staff ids shared by more than one account (differing only in case): "
            + ", ".join(sorted(dupes)[:50])
        )
        if os.getenv("MIGRATE_ALLOW_STAFF_ID_CASE_DUPES", "").lower() == "true":
            sys.stderr.write(f"\n  WARNING {msg}. Constraint user_staff_id_ci_unique NOT added.\n")
            return
        raise RuntimeError(msg + ". Fix these accounts, then migrate again.")
    schema_editor.add_constraint(User, CONSTRAINT)


def backwards(apps, schema_editor):
    try:
        schema_editor.remove_constraint(apps.get_model("core", "User"), CONSTRAINT)
    except Exception:
        pass


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0067_feedpost_publication"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.AddConstraint(model_name="user", constraint=CONSTRAINT)],
            database_operations=[migrations.RunPython(forwards, backwards)],
        ),
    ]
