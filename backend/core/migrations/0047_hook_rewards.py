"""Badges, celebrations, department milestones, goals, impact sharing, wall pins.

Also registers the hourly job that awards badges and checks department
targets (`core.tasks.award_badges_and_milestones`). django-q2 schedules live
in the database, so every environment gets it with `migrate`, as 0014 does
for the stale-batch rescue.
"""

import core.models
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

SCHEDULE_NAME = "award-badges-and-milestones"


def schedule_forwards(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    if not Schedule.objects.filter(name=SCHEDULE_NAME).exists():
        Schedule.objects.create(
            name=SCHEDULE_NAME,
            func="core.tasks.award_badges_and_milestones",
            schedule_type="H",  # hourly
            repeats=-1,
        )


def schedule_backwards(apps, schema_editor):
    try:
        Schedule = apps.get_model("django_q", "Schedule")
    except LookupError:
        return
    Schedule.objects.filter(name=SCHEDULE_NAME).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0044_close_zero_both_ways_flags'),
        ("django_q", "0019_alter_task_options_alter_ormq_key_alter_ormq_lock_and_more"),
    ]

    operations = [
        migrations.RunPython(schedule_forwards, schedule_backwards),
        migrations.CreateModel(
            name='Badge',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('kind', models.CharField(db_index=True, max_length=32)),
                ('key', models.CharField(max_length=80)),
                ('earned_on', models.DateField()),
                ('evidence_title', models.TextField(blank=True, default='')),
                ('evidence_journal', models.CharField(blank=True, default='', max_length=512)),
                ('evidence_year', models.IntegerField(blank=True, null=True)),
                ('detail', models.CharField(blank=True, default='', max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('evidence_claim', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='badges', to='core.claim')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='badges', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-earned_on', 'kind'],
            },
        ),
        migrations.CreateModel(
            name='Celebration',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('kind', models.CharField(choices=[('BADGE', 'A badge'), ('TARGET', 'A department target')], max_length=16)),
                ('key', models.CharField(max_length=160)),
                ('title', models.CharField(max_length=200)),
                ('body', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('seen_at', models.DateTimeField(blank=True, null=True)),
                ('badge', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='celebrations', to='core.badge')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='celebrations', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
        migrations.CreateModel(
            name='DepartmentMilestone',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('department', models.CharField(db_index=True, max_length=255)),
                ('year', models.PositiveIntegerField()),
                ('metric', models.CharField(max_length=24)),
                ('target', models.PositiveIntegerField()),
                ('threshold', models.PositiveSmallIntegerField()),
                ('done', models.PositiveIntegerField()),
                ('reached_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'ordering': ['-reached_at'],
                'constraints': [models.UniqueConstraint(fields=('department', 'year', 'metric', 'target', 'threshold'), name='one_milestone_per_target_threshold')],
            },
        ),
        migrations.CreateModel(
            name='ImpactShare',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('token', models.CharField(max_length=64, unique=True)),
                ('enabled', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='impact_share', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='ResearchGoal',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('year', models.PositiveIntegerField()),
                ('metric', models.CharField(choices=[('PAPERS', 'Papers'), ('Q1', 'Q1 papers'), ('FIRST_AUTHOR', 'First-author papers'), ('CITATIONS', 'Citations')], max_length=16)),
                ('target', models.PositiveIntegerField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='research_goals', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['year', 'metric'],
            },
        ),
        migrations.CreateModel(
            name='WallPin',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('department', models.CharField(blank=True, default='', max_length=255)),
                ('month', models.DateField()),
                ('paper_key', models.CharField(max_length=512)),
                ('title', models.TextField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('pinned_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='wall_pins', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddConstraint(
            model_name='badge',
            constraint=models.UniqueConstraint(fields=('user', 'key'), name='one_badge_per_key_per_person'),
        ),
        migrations.AddConstraint(
            model_name='celebration',
            constraint=models.UniqueConstraint(fields=('user', 'key'), name='one_celebration_per_occasion'),
        ),
        migrations.AddConstraint(
            model_name='researchgoal',
            constraint=models.UniqueConstraint(fields=('user', 'year', 'metric'), name='one_goal_per_metric_per_year'),
        ),
        migrations.AddConstraint(
            model_name='wallpin',
            constraint=models.UniqueConstraint(fields=('department', 'month'), name='one_pin_per_wall_month'),
        ),
    ]
