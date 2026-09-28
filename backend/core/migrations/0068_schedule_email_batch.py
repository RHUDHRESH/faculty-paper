"""The hourly email batch (core.tasks.flush_held_emails), registered with
migrate as 0051 did the other notification jobs."""
from datetime import timedelta

from django.db import migrations
from django.utils import timezone

NAME = "email-batch"


def add(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    if not Schedule.objects.filter(name=NAME).exists():
        Schedule.objects.create(
            name=NAME,
            func="core.tasks.flush_held_emails",
            schedule_type="H",
            repeats=-1,
            next_run=timezone.now() + timedelta(hours=1),
        )


def remove(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name=NAME).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0067_feedpost_publication"),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [migrations.RunPython(add, remove)]
