"""Point unread admin notifications at the clearing queue.

They were minted as /admin?claim=… — the overview page, which ignores the
parameter — so clicking one landed on a generic list with no sign of which
ticket it meant. Read ones are left alone; nobody clicks those again.
"""
from django.db import migrations


def forwards(apps, schema_editor):
    Notification = apps.get_model("core", "Notification")
    for note in Notification.objects.filter(read=False, href__startswith="/admin?claim="):
        note.href = note.href.replace("/admin?claim=", "/admin/clearing?claim=", 1)
        note.save(update_fields=["href"])


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0014_schedule_stale_batch_recovery"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
