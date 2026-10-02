"""Money safeguards the database itself enforces.

Written to never fail on production data, in the same way as 0062:

1. New columns first (the ledger's `kind` and `cycle`, the claim's
   `authorised_amount`, the bank-export record), then one data step that gives
   every existing row its right answer:
   - ledger rows: a negative "-VOID" row is a REVERSAL, any other negative or a
     "-ADJ" row is an ADJUSTMENT, everything else is a PAYMENT; the cycle is
     one more than the number of reversals the claim had before it;
   - claims waiting for Finance (DIRECTOR_APPROVED) have the amount they stand
     at recorded as the amount that was authorised.
2. Each unique constraint is then added only if no row violates it. If some
   rows do, the model state still gets the constraint (so Django validates
   every new write the same way) and the migration prints what it skipped and
   why; the nightly safeguards check lists those rows as Faults, and
   `migrate core 0074 && migrate` after they are resolved adds the constraint.
   A migration that fails on the day a duplicate was already in the data would
   be the worst time to learn about it.
3. On PostgreSQL the audit log also gets a trigger that refuses UPDATE and
   DELETE (except the SET NULL Django writes when an account is removed). It is
   installed inside a savepoint so a database that will not take it does not
   stop the deploy.
4. A daily schedule for the safeguards check, as 0063 did for the data-health
   audit.
"""
import sys
from datetime import datetime, time, timedelta

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models.functions import Lower
from django.utils import timezone

import core.models

TRIGGER_SQL = """
CREATE OR REPLACE FUNCTION core_auditlog_append_only() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'core_auditlog is append-only: rows cannot be deleted';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- Django clears actor_id when a person's account is removed. Nothing else may change.
  IF NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.action = OLD.action AND NEW.entity = OLD.entity
     AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.detail_json IS NOT DISTINCT FROM OLD.detail_json
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'core_auditlog is append-only: rows cannot be edited';
END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS core_auditlog_append_only ON core_auditlog;
CREATE TRIGGER core_auditlog_append_only BEFORE UPDATE OR DELETE ON core_auditlog
  FOR EACH ROW EXECUTE FUNCTION core_auditlog_append_only();
"""


def _backfill(apps, schema_editor):
    PaidLedger = apps.get_model("core", "PaidLedger")
    Claim = apps.get_model("core", "Claim")

    by_claim: dict[str, list] = {}
    for row in PaidLedger.objects.exclude(claim__isnull=True).order_by("created_at", "id").only(
        "id", "claim_id", "amount", "voucher_number", "raw_json", "created_at"
    ):
        by_claim.setdefault(row.claim_id, []).append(row)

    changed = []
    for rows in by_claim.values():
        cycle = 1
        for r in rows:
            voucher = (r.voucher_number or "")
            if (r.amount or 0) < 0:
                is_void = voucher.endswith("-VOID") or '"voided_by"' in (r.raw_json or "")
                kind = "REVERSAL" if is_void else "ADJUSTMENT"
            elif voucher.endswith("-ADJ"):
                kind = "ADJUSTMENT"
            else:
                kind = "PAYMENT"
            r.kind, r.cycle = kind, cycle
            if kind != "PAYMENT" or cycle != 1:
                changed.append(r)
            if kind == "REVERSAL":
                cycle += 1
    if changed:
        PaidLedger.objects.bulk_update(changed, ["kind", "cycle"], batch_size=500)

    # What Finance would be paying right now is what the Director authorised.
    # The policy amount (before the research threshold took its share), which
    # is what the Director's screen shows as the claim's worth.
    for claim in Claim.objects.filter(status="DIRECTOR_APPROVED", director_approved_at__isnull=False,
                                      authorised_amount__isnull=True).only("id", "remuneration", "research_absorbed"):
        Claim.objects.filter(pk=claim.pk).update(
            authorised_amount=round((claim.remuneration or 0) + (claim.research_absorbed or 0), 2))


# (model, constraint, violations(apps) -> list of printable lines)
def _dup_payments(kind):
    def found(apps):
        PaidLedger = apps.get_model("core", "PaidLedger")
        rows = (PaidLedger.objects.filter(kind=kind, claim__isnull=False).values("claim", "cycle")
                .annotate(n=models.Count("pk")).filter(n__gt=1))
        return [f"claim {r['claim']} has {r['n']} {kind.lower()} rows in cycle {r['cycle']}" for r in rows]
    return found


def _dup_filed(apps):
    Claim = apps.get_model("core", "Claim")
    rows = (Claim.objects.exclude(doi__isnull=True).exclude(doi="").exclude(status__in=["DRAFT", "REJECTED"])
            .exclude(ticket_number__startswith="ERP-")
            .annotate(d=Lower("doi")).values("d", "owner").annotate(n=models.Count("pk")).filter(n__gt=1))
    return [f"owner {r['owner']} has {r['n']} filed claims for {r['d']}" for r in rows]


CONSTRAINTS = [
    ("claim", models.UniqueConstraint(
        Lower("doi"), "owner",
        condition=(models.Q(doi__isnull=False) & ~models.Q(doi="") & ~models.Q(status__in=["DRAFT", "REJECTED"])
                   & (models.Q(ticket_number__isnull=True) | ~models.Q(ticket_number__startswith="ERP-"))),
        name="one_filed_claim_per_person_per_doi"), _dup_filed),
    ("paidledger", models.UniqueConstraint(
        fields=["claim", "cycle"], condition=models.Q(kind="PAYMENT"),
        name="one_payment_per_claim_cycle"), _dup_payments("PAYMENT")),
    ("paidledger", models.UniqueConstraint(
        fields=["claim", "cycle"], condition=models.Q(kind="REVERSAL"),
        name="one_reversal_per_claim_cycle"), _dup_payments("REVERSAL")),
]

SKIPPED: set[str] = set()


def _adder(model_name, constraint, violations):
    def forwards(apps, schema_editor):
        found = violations(apps)
        if found:
            SKIPPED.add(constraint.name)
            msg = (f"0075: SKIPPED constraint {constraint.name}: {len(found)} group(s) violate it "
                   f"(first: {found[0]}). The safeguards check lists them as Faults; resolve them, "
                   "then migrate core 0074 and migrate again.")
            sys.stderr.write(f"\n  WARNING {msg}\n")
            return
        schema_editor.add_constraint(apps.get_model("core", model_name), constraint)

    def backwards(apps, schema_editor):
        try:
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


def _audit_trigger(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    try:
        with schema_editor.connection.cursor() as cur:
            cur.execute("SAVEPOINT audit_trigger")
            cur.execute(TRIGGER_SQL)
            cur.execute("RELEASE SAVEPOINT audit_trigger")
    except Exception as exc:  # noqa: BLE001 -- the model-level guard still holds
        with schema_editor.connection.cursor() as cur:
            cur.execute("ROLLBACK TO SAVEPOINT audit_trigger")
        sys.stderr.write(f"\n  WARNING 0075: audit-log trigger skipped ({exc})\n")


def _audit_trigger_back(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cur:
        cur.execute("DROP TRIGGER IF EXISTS core_auditlog_append_only ON core_auditlog")
        cur.execute("DROP FUNCTION IF EXISTS core_auditlog_append_only()")


SCHEDULES = [("safeguards-daily", "core.tasks.run_safeguard_check", "D", time(3, 45))]


def _schedule(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    today = timezone.localdate()
    for name, func, kind, at in SCHEDULES:
        if Schedule.objects.filter(name=name).exists():
            continue
        first = timezone.make_aware(datetime.combine(today + timedelta(days=1), at))
        Schedule.objects.create(name=name, func=func, schedule_type=kind, repeats=-1, next_run=first)


def _unschedule(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name__in=[s[0] for s in SCHEDULES]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0074_merge_20260930_1112"),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="BankExport",
            fields=[
                ("id", models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ("month", models.CharField(db_index=True, max_length=7)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("row_count", models.PositiveIntegerField(default=0)),
                ("total_amount", models.FloatField(default=0)),
                ("sha256", models.CharField(blank=True, default="", max_length=64)),
                ("scope", models.CharField(default="all", max_length=8)),
                ("reason", models.TextField(blank=True, null=True)),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                 related_name="bank_exports", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.AddField(model_name="claim", name="authorised_amount",
                            field=models.FloatField(blank=True, null=True)),
        migrations.AddField(model_name="paidledger", name="cycle",
                            field=models.PositiveSmallIntegerField(default=1)),
        migrations.AddField(model_name="paidledger", name="idempotency_key",
                            field=models.CharField(blank=True, max_length=128, null=True, unique=True)),
        migrations.AddField(model_name="paidledger", name="kind",
                            field=models.CharField(choices=[("PAYMENT", "Payment"), ("REVERSAL", "Reversal of a payment"),
                                                            ("ADJUSTMENT", "Correction to a payment")],
                                                   default="PAYMENT", max_length=12)),
        migrations.AddField(model_name="paidledger", name="bank_export",
                            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                    related_name="rows", to="core.bankexport")),
        migrations.RunPython(_backfill, migrations.RunPython.noop),
        *_constraint_ops(),
        migrations.RunPython(_audit_trigger, _audit_trigger_back),
        migrations.RunPython(_schedule, _unschedule),
    ]
