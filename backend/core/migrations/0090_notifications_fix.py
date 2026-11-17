"""Notifications: when an alert was read, an index for the bell, and old desk alerts settled.

Why a migration at all:

* ``read_at`` -- the list says "Read 12 Nov". Nothing stored when, and a
  timestamp cannot be worked out afterwards.
* the (user, read, -created_at) index -- the bell's number and its list both
  ask for one person's unread rows, newest first, every two minutes from every
  open tab.
* the data step -- a desk alert ("To clear", "Cleared, for your approval",
  "Awaiting your authorisation", "Authorised for payment") used to stay unread
  for ever once the paper had moved on, so the Principal's bell counted work
  that was done. New alerts are settled as the paper moves
  (core.services.notify.settle_desk_alerts); this settles the ones already
  there, so the number is true on the day this ships rather than only for
  alerts written after it.

(Numbered 0090, not 0088: the Report studio, Teams, Conflicts and API tokens
work took the 0088s and the 0089 merge.)
"""
from django.db import migrations, models
from django.utils import timezone

#: The status a paper has to be in for a desk alert at this address to still be
#: asking for something.
WAITING_AT = {
    "/admin/clearing": "SUBMITTED",
    "/clearing": "SUBMITTED",
    "/principal": "CLEARED",
    "/approvals": "CLEARED",
    "/authorisations": "PRINCIPAL_APPROVED",
    "/finance": "DIRECTOR_APPROVED",
    "/payments": "DIRECTOR_APPROVED",
}


def settle_stale_desk_alerts(apps, schema_editor):
    Notification = apps.get_model("core", "Notification")
    Claim = apps.get_model("core", "Claim")
    rows = list(
        Notification.objects.filter(kind="desk", read=False)
        .exclude(claim_id__isnull=True)
        .exclude(claim_id="")
        .values_list("pk", "claim_id", "href")
    )
    if not rows:
        return
    status_of = dict(Claim.objects.filter(pk__in={r[1] for r in rows}).values_list("pk", "status"))
    stale = []
    for pk, claim_id, href in rows:
        waiting = WAITING_AT.get((href or "").split("?")[0])
        if waiting and status_of.get(claim_id) != waiting:
            stale.append(pk)
    now = timezone.now()
    for start in range(0, len(stale), 500):
        Notification.objects.filter(pk__in=stale[start:start + 500]).update(read=True, read_at=now)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0089_merge_20261117_0951'),
    ]

    operations = [
        migrations.AddField(
            model_name='notification',
            name='read_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name='notification',
            index=models.Index(fields=['user', 'read', '-created_at'], name='notif_user_read_created'),
        ),
        migrations.RunPython(settle_stale_desk_alerts, migrations.RunPython.noop),
    ]
