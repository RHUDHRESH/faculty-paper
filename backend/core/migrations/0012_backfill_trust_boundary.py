"""Backfill provenance for the money-determining fields.

Historically `snip` and `quartile` mixed faculty declarations with verified
lookups. From 0011 on, the payout is computed only from server-verified
values, so this migration sorts the existing rows:

- Scimago-verified quartiles keep their value and gain source "SCIMAGO".
- Unverified quartiles/SNIPs are copied to the self_reported_* columns and,
  for in-flight claims (DRAFT / SUBMITTED / CLEARED), the verified column is
  cleared — those claims re-verify (or get a manual verification) before any
  money moves. Settled claims (PAID / REJECTED / legacy) keep their values so
  history stays explainable.
"""
from django.db import migrations

BATCH = 500
IN_FLIGHT = ("DRAFT", "SUBMITTED", "CLEARED")
FIELDS = [
    "normalized_title",
    "self_reported_quartile",
    "quartile",
    "quartile_source",
    "self_reported_snip",
    "snip",
    "snip_source",
]


def forwards(apps, schema_editor):
    from core.services.normalize import normalize_title

    Claim = apps.get_model("core", "Claim")
    cleared_touched = set()
    pending = []

    def flush():
        if pending:
            Claim.objects.bulk_update(pending, FIELDS)
            pending.clear()

    for claim in Claim.objects.all().iterator(chunk_size=BATCH):
        changed = False
        nt = normalize_title(claim.paper_title)[:512]
        if (claim.normalized_title or "") != nt:
            claim.normalized_title = nt
            changed = True
        if claim.quartile:
            if claim.scimago_verified:
                claim.quartile_source = "SCIMAGO"
                changed = True
            else:
                if not claim.self_reported_quartile:
                    claim.self_reported_quartile = claim.quartile
                    changed = True
                if claim.status in IN_FLIGHT:
                    claim.quartile = None
                    changed = True
                    if claim.status == "CLEARED":
                        cleared_touched.add(claim.id)
        if claim.snip is not None:
            if claim.scopus_raw_json:
                claim.snip_source = "SCOPUS"
                changed = True
            else:
                if claim.self_reported_snip is None:
                    claim.self_reported_snip = claim.snip
                    changed = True
                if claim.status in IN_FLIGHT:
                    claim.snip = None
                    changed = True
                    if claim.status == "CLEARED":
                        cleared_touched.add(claim.id)
        if changed:
            pending.append(claim)
        if len(pending) >= BATCH:
            flush()
    flush()
    if cleared_touched:
        print(
            f"\n[0012] {len(cleared_touched)} CLEARED claim(s) had unverified "
            "snip/quartile cleared; they need re-verification or a manual "
            "verification before payment."
        )


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0011_trust_boundary_fields"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
