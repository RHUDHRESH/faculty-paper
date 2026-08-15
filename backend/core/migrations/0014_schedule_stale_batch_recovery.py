"""Register the recurring job that rescues stale RUNNING monthly batches.

django-q2 Schedules live in the database, so registering one here means every
environment gets it with migrate — no manual setup step to forget.
"""
from django.db import migrations

SCHEDULE_NAME = "recover-stale-batches"


def forwards(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    if not Schedule.objects.filter(name=SCHEDULE_NAME).exists():
        Schedule.objects.create(
            name=SCHEDULE_NAME,
            func="core.tasks.recover_stale_batches",
            schedule_type="I",  # minutes interval
            minutes=5,
            repeats=-1,
        )


def backwards(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name=SCHEDULE_NAME).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0013_monthly_batch_heartbeat"),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
