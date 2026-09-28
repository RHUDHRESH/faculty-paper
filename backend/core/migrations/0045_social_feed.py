"""The college feed: posts, comments, likes, follows and reports, and profile fields.

Open threads (PUBLIC and DEPARTMENT) are carried into the feed as posts, their
replies as comments, so nothing anybody wrote is lost when the thread list is
retired. Direct conversations and conversations with the office are messages,
not posts, and stay exactly where they are.
"""
import json

import core.models
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

_VISIBILITY = {"PUBLIC": "EVERYONE", "DEPARTMENT": "DEPARTMENT"}
#: The mentions a feed post keeps. A paper mention named a ticket number,
#: which is the office's handle for a claim and not something a colleague's
#: feed should carry.
_KEPT_MENTIONS = {"USER", "DEPARTMENT", "JOURNAL"}


def _mentions(post) -> str:
    rows = []
    for m in post.mentions.all():
        if m.kind not in _KEPT_MENTIONS:
            continue
        rows.append({
            "kind": m.kind,
            "label": m.label,
            "user_id": m.user_id,
            "user_name": m.user.name if m.user_id else None,
            "department": m.department,
            "journal_title": m.journal_title,
        })
    return json.dumps(rows)


def threads_to_posts(apps, schema_editor):
    """Every open thread as a post, once. Running it again changes nothing."""
    Thread = apps.get_model("core", "Thread")
    FeedPost = apps.get_model("core", "FeedPost")
    FeedComment = apps.get_model("core", "FeedComment")

    open_threads = (
        Thread.objects.filter(visibility__in=list(_VISIBILITY), feed_post__isnull=True)
        .select_related("created_by")
        .order_by("created_at")
    )
    for thread in open_threads:
        posts = list(
            thread.posts.select_related("author")
            .prefetch_related("mentions__user")
            .order_by("created_at", "id")
        )
        opening = posts[0] if posts else None
        author = thread.created_by or (opening.author if opening else None)
        if author is None:
            # Nobody to attribute it to. A post needs an author; a thread
            # nobody started and nobody wrote in has nothing to carry over.
            continue

        body = thread.title
        mentions = "[]"
        if opening is not None and opening.deleted_at is None and opening.body:
            body = f"{thread.title}\n\n{opening.body}"
            mentions = _mentions(opening)

        paper = thread.claim if thread.claim_id and thread.claim.owner_id == author.id else None
        post = FeedPost.objects.create(
            author=author,
            body=body,
            visibility=_VISIBILITY[thread.visibility],
            department=(thread.department or author.department)
            if thread.visibility == "DEPARTMENT"
            else author.department,
            paper=paper,
            mentions_json=mentions,
            legacy_thread=thread,
        )
        # `auto_now_add` stamps the moment of the migration; the post belongs
        # where the thread was opened.
        FeedPost.objects.filter(pk=post.pk).update(created_at=thread.created_at)

        for reply in posts[1:]:
            if reply.deleted_at is not None or not reply.body:
                continue
            comment = FeedComment.objects.create(
                post=post,
                author=reply.author if reply.kind == "HUMAN" else None,
                kind=reply.kind,
                body=reply.body,
                mentions_json=_mentions(reply),
            )
            FeedComment.objects.filter(pk=comment.pk).update(
                created_at=reply.created_at, edited_at=reply.edited_at
            )


def posts_to_nothing(apps, schema_editor):
    """Backwards: the carried-over posts go; the threads were never touched."""
    FeedPost = apps.get_model("core", "FeedPost")
    FeedPost.objects.filter(legacy_thread__isnull=False).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0044_close_zero_both_ways_flags'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='bio',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='user',
            name='orcid_id',
            field=models.CharField(blank=True, max_length=19, null=True),
        ),
        migrations.AddField(
            model_name='user',
            name='photo',
            field=models.CharField(blank=True, max_length=255, null=True),
        ),
        migrations.CreateModel(
            name='FeedPost',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('body', models.TextField(blank=True, default='')),
                ('visibility', models.CharField(choices=[('EVERYONE', 'Everybody'), ('DEPARTMENT', 'My department')], db_index=True, default='EVERYONE', max_length=16)),
                ('department', models.CharField(blank=True, db_index=True, max_length=255, null=True)),
                ('link_url', models.CharField(blank=True, max_length=500, null=True)),
                ('mentions_json', models.TextField(default='[]')),
                ('attachment_name', models.CharField(blank=True, max_length=255, null=True)),
                ('attachment_kind', models.CharField(blank=True, max_length=8, null=True)),
                ('attachment_label', models.CharField(blank=True, max_length=255, null=True)),
                ('attachment_size', models.PositiveIntegerField(blank=True, null=True)),
                ('created_at', models.DateTimeField(db_index=True, default=core.models.monotonic_now)),
                ('edited_at', models.DateTimeField(blank=True, null=True)),
                ('hidden_at', models.DateTimeField(blank=True, null=True)),
                ('hidden_reason', models.CharField(blank=True, max_length=300, null=True)),
                ('author', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='feed_posts', to=settings.AUTH_USER_MODEL)),
                ('hidden_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='feed_posts_hidden', to=settings.AUTH_USER_MODEL)),
                ('legacy_thread', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='feed_post', to='core.thread')),
                ('paper', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='feed_posts', to='core.claim')),
            ],
            options={
                'ordering': ['-created_at', '-id'],
            },
        ),
        migrations.CreateModel(
            name='FeedComment',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('kind', models.CharField(choices=[('HUMAN', 'Written by a person'), ('AGENT', 'Answered by the assistant'), ('SYSTEM', 'Recorded by the system')], default='HUMAN', max_length=8)),
                ('body', models.TextField()),
                ('mentions_json', models.TextField(default='[]')),
                ('created_at', models.DateTimeField(default=core.models.monotonic_now)),
                ('edited_at', models.DateTimeField(blank=True, null=True)),
                ('author', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='feed_comments', to=settings.AUTH_USER_MODEL)),
                ('post', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='comments', to='core.feedpost')),
            ],
            options={
                'ordering': ['created_at', 'id'],
            },
        ),
        migrations.CreateModel(
            name='FeedReaction',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('post', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='reactions', to='core.feedpost')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='feed_reactions', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='Follow',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('department', models.CharField(blank=True, max_length=255, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('follower', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='follows', to=settings.AUTH_USER_MODEL)),
                ('person', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='followers', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='PostReport',
            fields=[
                ('id', models.CharField(default=core.models.cuid, editable=False, max_length=32, primary_key=True, serialize=False)),
                ('reason', models.CharField(max_length=500)),
                ('status', models.CharField(choices=[('OPEN', 'Waiting for the super admin'), ('HIDDEN', 'The post was hidden'), ('DISMISSED', 'Looked at, left up')], db_index=True, default='OPEN', max_length=16)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('resolved_at', models.DateTimeField(blank=True, null=True)),
                ('post', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='reports', to='core.feedpost')),
                ('reporter', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='post_reports', to=settings.AUTH_USER_MODEL)),
                ('resolved_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='post_reports_resolved', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='feedpost',
            index=models.Index(fields=['-created_at', '-id'], name='feedpost_newest_first'),
        ),
        migrations.AddIndex(
            model_name='feedpost',
            index=models.Index(fields=['author', '-created_at'], name='feedpost_by_author'),
        ),
        migrations.AddIndex(
            model_name='feedpost',
            index=models.Index(fields=['department', '-created_at'], name='feedpost_by_department'),
        ),
        migrations.AddIndex(
            model_name='feedcomment',
            index=models.Index(fields=['post', 'created_at'], name='feedcomment_by_post'),
        ),
        migrations.AddConstraint(
            model_name='feedreaction',
            constraint=models.UniqueConstraint(fields=('post', 'user'), name='one_like_per_person_per_post'),
        ),
        migrations.AddConstraint(
            model_name='follow',
            constraint=models.UniqueConstraint(condition=models.Q(('person__isnull', False)), fields=('follower', 'person'), name='follow_a_person_once'),
        ),
        migrations.AddConstraint(
            model_name='follow',
            constraint=models.UniqueConstraint(condition=models.Q(('department__isnull', False)), fields=('follower', 'department'), name='follow_a_department_once'),
        ),
        migrations.AddConstraint(
            model_name='follow',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('department__isnull', True), ('person__isnull', False)), models.Q(('department__isnull', False), ('person__isnull', True)), _connector='OR'), name='follow_one_thing'),
        ),
        migrations.AddConstraint(
            model_name='postreport',
            constraint=models.UniqueConstraint(condition=models.Q(('status', 'OPEN')), fields=('post', 'reporter'), name='one_open_report_per_person_per_post'),
        ),
        migrations.RunPython(threads_to_posts, posts_to_nothing),
    ]
