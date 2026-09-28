from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0058_merge_0055_wall_cheer_0057_scopus_profile"),
    ]

    operations = [
        migrations.AddField(
            model_name="thread",
            name="context",
            field=models.JSONField(blank=True, null=True),
        ),
    ]
