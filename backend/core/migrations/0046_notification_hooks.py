"""Alerts people can switch off, citation counts, profile views, and the three
scheduled jobs behind them.

The schedules are registered here, as 0014 did for batch recovery, so every
environment gets them with migrate. Times are India time:

    citation-check   daily, 03:30   core.tasks.check_citations
    daily-nudges     daily, 09:00   core.tasks.send_nudges
    weekly-digest    Monday, 08:00  core.tasks.send_weekly_digest

django-q2 advances a daily or weekly schedule by whole days from next_run,
and Q_CLUSTER has catch_up off, so a run missed while the server slept
happens once when it wakes and the clock time is kept.
"""
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import core.models
import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models

IST = ZoneInfo("Asia/Kolkata")

SCHEDULES = (
    # name, func, type ("D" daily / "W" weekly), weekday (Monday = 0) or None, hour, minute
    ("citation-check", "core.tasks.check_citations", "D", None, 3, 30),
    ("daily-nudges", "core.tasks.send_nudges", "D", None, 9, 0),
    ("weekly-digest", "core.tasks.send_weekly_digest", "W", 0, 8, 0),
)


def _first_run(weekday, hour, minute):
    now = datetime.now(IST)
    at = datetime.combine(now.date(), time(hour, minute), tzinfo=IST)
    if weekday is not None:
        at += timedelta(days=(weekday - at.weekday()) % 7)
    while at <= now:
        at += timedelta(days=7 if weekday is not None else 1)
    return at


def add_schedules(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    for name, func, kind, weekday, hour, minute in SCHEDULES:
        if not Schedule.objects.filter(name=name).exists():
            Schedule.objects.create(
                name=name,
                func=func,
                schedule_type=kind,
                repeats=-1,
                next_run=_first_run(weekday, hour, minute),
            )


def remove_schedules(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name__in=[s[0] for s in SCHEDULES]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0044_close_zero_both_ways_flags'),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [
        migrations.RunPython(add_schedules, remove_schedules),
        migrations.CreateModel(
            name='CitationCount',
            fields=[
                ('doi', models.CharField(max_length=255, primary_key=True, serialize=False)),
                ('count', models.IntegerField(blank=True, null=True)),
                ('openalex_id', models.CharField(blank=True, max_length=64, null=True)),
                ('checked_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('changed_at', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name='NotificationSettings',
            fields=[
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, primary_key=True, related_name='notification_settings', serialize=False, to=settings.AUTH_USER_MODEL)),
                ('share_profile_views', models.BooleanField(default=True)),
                ('whatsapp_opt_in', models.BooleanField(default=False)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
        ),
        migrations.AddField(
            model_name='formulaconfig',
            name='filing_cutoff_day',
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='notification',
            name='actors',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name='notification',
            name='emailed_at',
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name='notification',
            name='group_count',
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.AddField(
            model_name='notification',
            name='group_key',
            field=models.CharField(blank=True, db_index=True, max_length=160, null=True),
        ),
        migrations.AddField(
            model_name='notification',
            name='kind',
            field=models.CharField(db_index=True, default='general', max_length=40),
        ),
        migrations.CreateModel(
            name='CitationHistory',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('count', models.IntegerField()),
                ('at', models.DateTimeField(default=django.utils.timezone.now)),
                ('citation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='history', to='core.citationcount')),
            ],
            options={
                'ordering': ['at'],
            },
        ),
        migrations.CreateModel(
            name='NotificationPreference',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('kind', models.CharField(max_length=40)),
                ('level', models.CharField(choices=[('email', 'In the app and by email'), ('in_app', 'In the app'), ('off', 'Off')], max_length=8)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='notification_preferences', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('user', 'kind'), name='one_preference_per_kind')],
            },
        ),
        migrations.CreateModel(
            name='ProfileView',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('at', models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ('viewed', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='profile_views_received', to=settings.AUTH_USER_MODEL)),
                ('viewer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='profile_views_made', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-at'],
                'indexes': [models.Index(fields=['viewed', 'at'], name='core_profil_viewed__83845b_idx')],
            },
        ),
    ]
