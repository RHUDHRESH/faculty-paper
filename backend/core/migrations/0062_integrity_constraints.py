"""Constraints for invariants the data already keeps, added so it keeps them.

Written to never fail on production data:

1. A data step fixes what has one right answer: extra active formulas are
   deactivated (the newest stays, which is the one the calculator already
   used), and emails are lowercased where that collides with nobody.
2. Each constraint is then added only if no row violates it. A violating
   database still gets the model state (so Django validates new writes the
   same everywhere) and prints what it skipped; the data-health page lists the
   rows, and re-running `manage.py migrate core 0061 && migrate` after fixing
   them adds the constraint.

Postgres also gets trigram indexes for the substring searches (search_all,
people search), if the pg_trgm extension can be created; SQLite has nothing
equivalent and skips them.
"""
from django.db import migrations, models
from django.db.models.functions import Lower


def _fix_data(apps, schema_editor):
    FormulaConfig = apps.get_model("core", "FormulaConfig")
    User = apps.get_model("core", "User")
    active = list(FormulaConfig.objects.filter(active=True).order_by("-updated_at", "-version"))
    if len(active) > 1:
        ids = [f.pk for f in active[1:]]
        FormulaConfig.objects.filter(pk__in=ids).update(active=False)
        print(f"\n  0062: deactivated {len(ids)} extra active formula(s); kept {active[0].pk}")
    lowered = 0
    for pk, email in User.objects.values_list("pk", "email"):
        clean = (email or "").strip().lower()
        if clean and clean != email and not User.objects.exclude(pk=pk).filter(email__iexact=clean).exists():
            User.objects.filter(pk=pk).update(email=clean)
            lowered += 1
    if lowered:
        print(f"\n  0062: lowercased {lowered} email(s)")


# (model, constraint, violations(apps) -> int)
def _violations_email(apps):
    User = apps.get_model("core", "User")
    return User.objects.annotate(e=Lower("email")).values("e").annotate(n=models.Count("pk")).filter(n__gt=1).count()


def _violations_staff(apps):
    User = apps.get_model("core", "User")
    return (User.objects.exclude(staff_id__isnull=True).exclude(staff_id="").values("staff_id")
            .annotate(n=models.Count("pk")).filter(n__gt=1).count())


def _violations_q(model, q):
    def count(apps):
        return apps.get_model("core", model).objects.exclude(q).count()
    return count


FORMULA_OK = models.Q(
    snip_multiplier__gte=0, snip_cap__gte=0, qf_q1__gte=0, qf_q2__gte=0, qf_q3__gte=0, qf_q4__gte=0,
    fixed_journal_no_snip__gte=0, fixed_other_no_snip__gte=0, fixed_web_of_science__gte=0,
    high_value_threshold__gte=0, student_project_amount__gte=0,
)
REMUNERATION_OK = models.Q(remuneration__isnull=True) | models.Q(remuneration__gte=0)
AUTHORS_OK = models.Q(total_authors__gte=1) & models.Q(author_position__gte=1)


def _active_formulas(apps):
    return max(0, apps.get_model("core", "FormulaConfig").objects.filter(active=True).count() - 1)


CONSTRAINTS = [
    ("user", models.UniqueConstraint(Lower("email"), name="user_email_ci_unique"), _violations_email),
    ("user", models.UniqueConstraint(fields=["staff_id"], condition=models.Q(staff_id__isnull=False) & ~models.Q(staff_id=""),
                                     name="user_staff_id_unique"), _violations_staff),
    ("budget", models.CheckConstraint(condition=models.Q(amount__gte=0), name="budget_amount_non_negative"),
     _violations_q("Budget", models.Q(amount__gte=0))),
    ("claim", models.CheckConstraint(condition=REMUNERATION_OK, name="claim_remuneration_non_negative"),
     _violations_q("Claim", REMUNERATION_OK)),
    ("claim", models.CheckConstraint(condition=AUTHORS_OK, name="claim_author_counts_positive"),
     _violations_q("Claim", AUTHORS_OK)),
    ("formulaconfig", models.UniqueConstraint(fields=["active"], condition=models.Q(active=True), name="one_active_formula"),
     _active_formulas),
    ("formulaconfig", models.CheckConstraint(condition=FORMULA_OK, name="formula_amounts_non_negative"),
     _violations_q("FormulaConfig", FORMULA_OK)),
]


SKIPPED: set[str] = set()


def _adder(model_name, constraint, violations):
    def forwards(apps, schema_editor):
        n = violations(apps)
        if n:
            SKIPPED.add(constraint.name)
            print(f"\n  0062: SKIPPED constraint {constraint.name}: {n} row(s) violate it; see /data/health")
            return
        model = apps.get_model("core", model_name)
        # SQLite adds a CHECK by rebuilding the table from the model's own
        # constraint list, so that list must hold this one and none skipped.
        model._meta.constraints = [
            c for c in model._meta.constraints if c.name not in SKIPPED and c.name != constraint.name
        ] + [constraint]
        schema_editor.add_constraint(model, constraint)

    def backwards(apps, schema_editor):
        try:
            with schema_editor.connection.cursor():
                schema_editor.remove_constraint(apps.get_model("core", model_name), constraint)
        except Exception:
            pass

    return forwards, backwards


def _constraint_ops():
    ops = []
    for model_name, constraint, violations in CONSTRAINTS:
        fw, bw = _adder(model_name, constraint, violations)
        ops.append(migrations.SeparateDatabaseAndState(
            state_operations=[migrations.AddConstraint(model_name=model_name, constraint=constraint)],
            database_operations=[migrations.RunPython(fw, bw)],
        ))
    return ops


TRGM = [
    ("core_publication_title_trgm", "core_publication", "title"),
    ("core_publication_venue_trgm", "core_publication", "venue"),
    ("core_authorship_name_trgm", "core_authorship", "display_name"),
    ("core_user_name_trgm", "core_user", "name"),
]


def _trgm(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    try:
        with schema_editor.connection.cursor() as cur:
            cur.execute("SAVEPOINT trgm")
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
            for name, table, column in TRGM:
                # icontains compiles to UPPER(col::text) LIKE UPPER(%s).
                cur.execute(f'CREATE INDEX IF NOT EXISTS {name} ON {table} USING gin ((UPPER("{column}"::text)) gin_trgm_ops)')
            cur.execute("RELEASE SAVEPOINT trgm")
    except Exception as exc:  # no privilege for the extension: searches stay as they were
        with schema_editor.connection.cursor() as cur:
            cur.execute("ROLLBACK TO SAVEPOINT trgm")
        print(f"\n  0062: trigram indexes skipped ({exc})")


def _trgm_back(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cur:
        for name, _, _ in TRGM:
            cur.execute(f"DROP INDEX IF EXISTS {name}")


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0061_merge_20260928_1155"),
    ]

    operations = [
        migrations.RunPython(_fix_data, migrations.RunPython.noop),
        *_constraint_ops(),
        migrations.RunPython(_trgm, _trgm_back),
    ]
