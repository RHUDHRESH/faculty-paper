"""Register the daily off-site backup (core.tasks.run_offsite_backup).

It copies a full backup to the object store the app's files use (R2), so a lost
database can be restored from outside it. Until S3_BUCKET_NAME is set the job
runs, finds no bucket and does nothing.
"""
from datetime import datetime, time, timedelta

from django.db import migrations
from django.utils import timezone

NAME = "backup-offsite-daily"


def forwards(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    if Schedule.objects.filter(name=NAME).exists():
        return
    first = timezone.make_aware(datetime.combine(timezone.localdate() + timedelta(days=1), time(4, 15)))
    Schedule.objects.create(name=NAME, func="core.tasks.run_offsite_backup", schedule_type="D",
                            repeats=-1, next_run=first)


def backwards(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name=NAME).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0077_merge_0076_ai_precheck_0076_ai_usage"),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
