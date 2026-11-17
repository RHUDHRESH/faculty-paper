from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0087_audit_and_ledger_indexes'),
    ]

    operations = [
        migrations.AddField(
            model_name='team',
            name='publications',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
