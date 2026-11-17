"""The Vice principal role, and the two accounts that go with it.

Schema: `User.role` gains VICE_PRINCIPAL.

Data, both steps idempotent and each logged to AuditLog:

(a) The account viceprincipal@saveetha.ac.in, if it exists and is FACULTY or
    HOD, becomes VICE_PRINCIPAL. Any other role is left alone: moving a
    Director or Finance account is not this migration's decision.
(b) If no active HOD has the department EEE, a head-of-department account
    hod.eee@saveetha.ac.in is created for it: active, no usable password (the
    super admin issues one in the app), no staff id, nothing forced to change.
    Only on a database that already has accounts: on an empty one the first-run
    setup page (which opens only while there are none) must still be the way in,
    and a new college has no EEE to give a head to.

(a) runs first, so a Vice principal who was also the EEE head leaves that post
open and (b) fills it.
"""
import json

from django.contrib.auth.hashers import make_password
from django.db import migrations, models

VP_EMAIL = "viceprincipal@saveetha.ac.in"
EEE_HEAD_EMAIL = "hod.eee@saveetha.ac.in"
EEE_HEAD_NAME = "Head of Department, EEE"
VIA = "migration 0090_vice_principal"


def _note(apps, action, entity_id, detail):
    AuditLog = apps.get_model("core", "AuditLog")
    AuditLog.objects.create(
        action=action,
        entity="User",
        entity_id=entity_id,
        detail_json=json.dumps({**detail, "via": VIA}),
    )


def make_vice_principal(apps, schema_editor):
    User = apps.get_model("core", "User")
    person = User.objects.filter(email__iexact=VP_EMAIL).first()
    if person is None or person.role not in ("FACULTY", "HOD"):
        return
    was = person.role
    person.role = "VICE_PRINCIPAL"
    person.save(update_fields=["role"])
    _note(apps, "USER_UPDATE", person.pk, {"email": person.email, "from": was, "to": "VICE_PRINCIPAL"})


def add_eee_head(apps, schema_editor):
    User = apps.get_model("core", "User")
    if not User.objects.exists():
        return
    heads = User.objects.filter(role="HOD", active=True)
    if any((u.department or "").strip().casefold() == "eee" for u in heads):
        return
    if User.objects.filter(email__iexact=EEE_HEAD_EMAIL).exists():
        # Somebody already holds the address (switched off, or another role):
        # do not take it over, and do not create a second account.
        return
    account = User.objects.create(
        email=EEE_HEAD_EMAIL,
        name=EEE_HEAD_NAME,
        role="HOD",
        department="EEE",
        active=True,
        password=make_password(None),
        must_change_password=False,
    )
    _note(apps, "USER_CREATE", account.pk, {"email": account.email, "role": "HOD", "department": "EEE"})


def forwards(apps, schema_editor):
    make_vice_principal(apps, schema_editor)
    add_eee_head(apps, schema_editor)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0089_merge_20261117_0951'),
    ]

    operations = [
        migrations.AlterField(
            model_name='user',
            name='role',
            field=models.CharField(choices=[('FACULTY', 'Faculty'), ('HOD', 'Hod'), ('PRINCIPAL', 'Principal'), ('VICE_PRINCIPAL', 'Vice Principal'), ('DIRECTOR', 'Director'), ('RESEARCH_COORDINATOR', 'Research Coordinator'), ('RESEARCH_CELL', 'Research Cell'), ('FINANCE', 'Finance'), ('SUPER_ADMIN', 'Super Admin')], default='FACULTY', max_length=32),
        ),
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
