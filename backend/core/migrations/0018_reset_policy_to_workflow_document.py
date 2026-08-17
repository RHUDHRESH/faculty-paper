"""Reset the payout policy to the Publication Processing Workflow document.

The active policy row had drifted from Step 8 in two ways that cost money:

- `qf_others` was ₹4,000, and the calculator paid it as a quartile incentive on
  any Engineering journal whose ranking was "Others" or "No Quartile". The
  policy's QFA table has four rows — Q1, Q2, Q3, Q4 — and no others.
- `qf_only_for_no_snip` looked like a control over that behaviour but was never
  read by the calculator at all.

The previous version is deactivated rather than edited, so the old figures stay
readable next to the claims they priced. `high_value_threshold` is an
operational control rather than a policy figure, so it carries over untouched.
"""

import json

from django.db import migrations, models

POLICY = {
    "name": "Publication Processing Workflow — Step 8",
    "snip_multiplier": 55000,   # [(SNIP x 55000) + QFA] x APP
    "snip_cap": 30,             # a sanity guard, not a policy figure
    "qf_q1": 50000,
    "qf_q2": 30000,
    "qf_q3": 15000,
    "qf_q4": 7000,
    "qf_no_snip": 0,
    "qf_snip_only": 0,
    "qf_others": 0,
    "fixed_journal_no_snip": 5000,   # Category II
    "fixed_other_no_snip": 4000,     # Category III
    "fixed_web_of_science": 5000,    # Category IV base
    "max_authors": 9,
    "min_sec_references": 2,
    "student_remuneration_zero": True,
    "publication_type_multipliers_json": (
        '{"Journal":1,"Conference Proceeding":1,"Book Series":1,"Other":1}'
    ),
}

#: The Author Position Weightage Table, transcribed from the policy.
AUTHOR_POINTS = {
    "1": [1],
    "2": [0.6, 0.4],
    "3": [0.5, 0.3, 0.2],
    "4": [0.4, 0.3, 0.2, 0.1],
    "5": [0.3, 0.25, 0.2, 0.15, 0.1],
    "6": [0.275, 0.225, 0.2, 0.15, 0.1, 0.05],
    "7": [0.275, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05],
    "8": [0.25, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05, 0.025],
    "9": [0.225, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05, 0.03, 0.01],
}


def forwards(apps, schema_editor):
    FormulaConfig = apps.get_model("core", "FormulaConfig")

    # A reset, not a seed: with no policy on record there is nothing to correct,
    # and inventing one here would put a row into every fresh database and every
    # test run. `seed` and the model defaults cover that case.
    if not FormulaConfig.objects.exists():
        return

    current = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    highest = FormulaConfig.objects.order_by("-version").values_list("version", flat=True).first()

    row = dict(POLICY)
    row["version"] = (highest or 0) + 1
    row["author_point_json"] = json.dumps(AUTHOR_POINTS)
    row["high_value_threshold"] = getattr(current, "high_value_threshold", 0) or 0
    row["notes"] = (
        "Reset from the Publication Processing Workflow document. "
        "QFA is Q1-Q4 only and applies to Engineering journals; the previous "
        "version paid an unauthorised Others/No-Quartile incentive."
    )
    row["active"] = True

    FormulaConfig.objects.filter(active=True).update(active=False)
    FormulaConfig.objects.create(**row)


def backwards(apps, schema_editor):
    """Drop the reset row and re-activate whatever it replaced."""
    FormulaConfig = apps.get_model("core", "FormulaConfig")
    FormulaConfig.objects.filter(name=POLICY["name"]).delete()
    previous = FormulaConfig.objects.order_by("-version").first()
    if previous:
        previous.active = True
        previous.save(update_fields=["active"])


class Migration(migrations.Migration):
    dependencies = [("core", "0017_repair_scopus_identity")]

    operations = [
        migrations.AlterField(
            model_name="formulaconfig",
            name="qf_others",
            field=models.FloatField(default=0),
        ),
        migrations.RunPython(forwards, backwards),
    ]
