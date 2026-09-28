"""Register the nightly data-health audit and the weekly stored backup.

django-q2 schedules live in the database, so every environment gets them with
migrate (as 0014 and 0047 do). The first runs are set for the small hours,
when nobody is filing.
"""
from datetime import datetime, time, timedelta

from django.db import migrations
from django.utils import timezone

SCHEDULES = [
    ("integrity-audit-nightly", "core.tasks.run_integrity_audit", "D", time(2, 30)),
    ("backup-weekly", "core.tasks.run_stored_backup", "W", time(3, 15)),
]


def forwards(apps, schema_editor):
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


def backwards(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name__in=[s[0] for s in SCHEDULES]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0062_integrity_constraints"),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
