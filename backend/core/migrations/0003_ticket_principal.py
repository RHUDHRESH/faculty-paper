# Generated manually for ticket ERP

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0002_sheet_first_raw_data"),
    ]

    operations = [
        migrations.AlterField(
            model_name="user",
            name="role",
            field=models.CharField(
                choices=[
                    ("FACULTY", "Faculty"),
                    ("HOD", "Hod"),
                    ("PRINCIPAL", "Principal"),
                    ("RESEARCH_CELL", "Research Cell"),
                    ("FINANCE", "Finance"),
                    ("SUPER_ADMIN", "Super Admin"),
                ],
                default="FACULTY",
                max_length=32,
            ),
        ),
        migrations.AlterField(
            model_name="claim",
            name="status",
            field=models.CharField(
                choices=[
                    ("DRAFT", "Draft"),
                    ("SUBMITTED", "Submitted"),
                    ("HOD_APPROVED", "Hod Approved"),
                    ("PRINCIPAL_APPROVED", "Principal Approved"),
                    ("RESEARCH_APPROVED", "Research Approved"),
                    ("FINANCE_APPROVED", "Finance Approved"),
                    ("PAID", "Paid"),
                    ("REJECTED", "Rejected"),
                ],
                default="DRAFT",
                max_length=32,
            ),
        ),
        migrations.AlterField(
            model_name="claimaction",
            name="from_status",
            field=models.CharField(
                blank=True,
                choices=[
                    ("DRAFT", "Draft"),
                    ("SUBMITTED", "Submitted"),
                    ("HOD_APPROVED", "Hod Approved"),
                    ("PRINCIPAL_APPROVED", "Principal Approved"),
                    ("RESEARCH_APPROVED", "Research Approved"),
                    ("FINANCE_APPROVED", "Finance Approved"),
                    ("PAID", "Paid"),
                    ("REJECTED", "Rejected"),
                ],
                max_length=32,
                null=True,
            ),
        ),
        migrations.AlterField(
            model_name="claimaction",
            name="to_status",
            field=models.CharField(
                blank=True,
                choices=[
                    ("DRAFT", "Draft"),
                    ("SUBMITTED", "Submitted"),
                    ("HOD_APPROVED", "Hod Approved"),
                    ("PRINCIPAL_APPROVED", "Principal Approved"),
                    ("RESEARCH_APPROVED", "Research Approved"),
                    ("FINANCE_APPROVED", "Finance Approved"),
                    ("PAID", "Paid"),
                    ("REJECTED", "Rejected"),
                ],
                max_length=32,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="claim",
            name="ticket_number",
            field=models.CharField(blank=True, db_index=True, max_length=32, null=True, unique=True),
        ),
        migrations.AddField(
            model_name="claim",
            name="contest_forward",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="claim",
            name="contest_note",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="claim",
            name="verification_snapshot_json",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="claim",
            name="verification_ok",
            field=models.BooleanField(default=True),
        ),
    ]
