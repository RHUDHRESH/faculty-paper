"""The publication record: Publication, Authorship, PublicationMetrics, and
the weekly citation refresh (schedule "publication-citations", Sunday 04:00
IST, core.tasks.refresh_publication_citations)."""

import core.models
import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import migrations, models

IST = ZoneInfo("Asia/Kolkata")
SCHEDULE = "publication-citations"


def add_schedule(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    if Schedule.objects.filter(name=SCHEDULE).exists():
        return
    now = datetime.now(IST)
    at = datetime.combine(now.date(), time(4, 0), tzinfo=IST)
    at += timedelta(days=(6 - at.weekday()) % 7)
    while at <= now:
        at += timedelta(days=7)
    Schedule.objects.create(
        name=SCHEDULE, func="core.tasks.refresh_publication_citations",
        schedule_type="W", repeats=-1, next_run=at,
    )


def remove_schedule(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name=SCHEDULE).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0051_notification_hooks'),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name='PublicationMetrics',
            fields=[
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, primary_key=True, related_name='publication_metrics', serialize=False, to=settings.AUTH_USER_MODEL)),
                ('total_publications', models.IntegerField(default=0)),
                ('total_citations', models.IntegerField(default=0)),
                ('h_index', models.IntegerField(default=0)),
                ('i10_index', models.IntegerField(default=0)),
                ('first_year', models.IntegerField(blank=True, null=True)),
                ('last_year', models.IntegerField(blank=True, null=True)),
                ('computed_at', models.DateTimeField(default=django.utils.timezone.now)),
            ],
        ),
        migrations.CreateModel(
            name='Publication',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('openalex_id', models.CharField(blank=True, max_length=32, null=True, unique=True)),
                ('doi', models.CharField(blank=True, db_index=True, max_length=255, null=True)),
                ('eid', models.CharField(blank=True, db_index=True, max_length=64, null=True)),
                ('title', models.TextField(blank=True, default='')),
                ('normalized_title', models.CharField(blank=True, db_index=True, default='', max_length=512)),
                ('year', models.IntegerField(blank=True, db_index=True, null=True)),
                ('date', models.DateField(blank=True, null=True)),
                ('venue', models.CharField(blank=True, default='', max_length=512)),
                ('issn', models.CharField(blank=True, default='', max_length=64)),
                ('type', models.CharField(blank=True, db_index=True, default='', max_length=64)),
                ('quartile', models.CharField(blank=True, db_index=True, default='', max_length=8)),
                ('citations', models.IntegerField(default=0)),
                ('citations_refreshed_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('oa_url', models.TextField(blank=True, default='')),
                ('topics_json', models.TextField(blank=True, default='[]')),
                ('source', models.CharField(default='openalex', max_length=16)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('claims', models.ManyToManyField(blank=True, related_name='publications', to='core.claim')),
                ('ledger_rows', models.ManyToManyField(blank=True, related_name='publications', to='core.paidledger')),
            ],
            options={
                'ordering': ['-year', 'title'],
            },
        ),
        migrations.CreateModel(
            name='Authorship',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('position', models.IntegerField(blank=True, null=True)),
                ('display_name', models.CharField(max_length=255)),
                ('raw_affiliation', models.TextField(blank=True, default='')),
                ('openalex_author_id', models.CharField(blank=True, db_index=True, default='', max_length=32)),
                ('orcid', models.CharField(blank=True, db_index=True, default='', max_length=19)),
                ('institution_name', models.CharField(blank=True, default='', max_length=255)),
                ('institution_country', models.CharField(blank=True, default='', max_length=8)),
                ('author_key', models.CharField(db_index=True, max_length=160)),
                ('is_college', models.BooleanField(db_index=True, default=False)),
                ('match_confidence', models.FloatField(default=0)),
                ('match_method', models.CharField(blank=True, default='', max_length=16)),
                ('match_locked', models.BooleanField(default=False)),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='authorships', to=settings.AUTH_USER_MODEL)),
                ('publication', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='authorships', to='core.publication')),
            ],
            options={
                'ordering': ['publication_id', 'position'],
                'indexes': [models.Index(fields=['user', 'publication'], name='authorship_user_pub')],
            },
        ),
        migrations.RunPython(add_schedule, remove_schedule),
    ]
