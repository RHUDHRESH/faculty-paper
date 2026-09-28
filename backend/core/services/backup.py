"""Full backups: every row, as a gzipped dumpdata-format JSON file.

The file is exactly what `manage.py loaddata` and POST /api/admin/restore read,
so a backup taken here restores into a fresh installation (a new Postgres on
Neon, a laptop's SQLite) with no conversion. See DEPLOY.md, "Backups".

Built in chunks and compressed as it goes, so the download streams and memory
stays flat on a 512 MB instance. Left out: sessions and the job queue (both
rebuild themselves), content types and permissions (every migrate recreates
them; references to them are written as natural keys), and the stored
backups themselves.

Primary keys are kept as they are -- ids appear inside JSON columns and links,
and renumbering on restore would break them.
"""
from __future__ import annotations

import base64
import gzip
import io
import json
import zlib
from typing import Iterator, Optional

from django.apps import apps
from django.core import serializers
from django.core.serializers.json import DjangoJSONEncoder
from django.utils import timezone

EXCLUDED_APPS = {"sessions", "django_q", "contenttypes"}
EXCLUDED_MODELS = {"auth.permission"}
BACKUP_PREFIX = "backups/"
KEEP = 4
#: A weekly backup bigger than this is not kept in the database (it would
#: eat the free plan's 512 MB); the download still works.
MAX_STORED_BYTES = 40 * 1024 * 1024
CHUNK = 500


def models_in_order():
    app_list = {}
    for cfg in apps.get_app_configs():
        if cfg.label in EXCLUDED_APPS or not cfg.models_module:
            continue
        app_list[cfg] = None
    ordered = serializers.sort_dependencies(app_list.items(), allow_cycles=True)
    return [m for m in ordered if m._meta.label_lower not in EXCLUDED_MODELS
            and not m._meta.proxy and m._meta.managed]


def _queryset(model):
    qs = model._default_manager.order_by(model._meta.pk.name)
    if model._meta.label_lower == "core.storedfile":
        qs = qs.exclude(name__startswith=BACKUP_PREFIX)
    return qs


#: Rows every migrate recreates with its own ids: referenced by natural key.
#: Everything else keeps its primary key -- `--natural-foreign` for all would
#: also write every claim's owner as an email (User has a natural key).
NATURAL = {"contenttypes.contenttype", "auth.permission"}


def _natural_keys() -> dict[str, dict]:
    ContentType = apps.get_model("contenttypes", "ContentType")
    Permission = apps.get_model("auth", "Permission")
    ct = {pk: [a, m] for pk, a, m in ContentType.objects.values_list("pk", "app_label", "model")}
    perm = {pk: [code, *ct.get(c, [None, None])] for pk, code, c in Permission.objects.values_list("pk", "codename", "content_type_id")}
    return {"contenttypes.contenttype": ct, "auth.permission": perm}


def _plan(model):
    """(output name, column attname, converter) for each serialised field."""
    cols = []
    for f in model._meta.concrete_fields:
        if f.primary_key:
            continue
        conv = None
        if f.is_relation:
            target = f.remote_field.model._meta.label_lower
            if target in NATURAL:
                conv = ("natural", target)
        elif f.get_internal_type() == "BinaryField":
            conv = ("binary", None)
        elif f.get_internal_type() == "UUIDField":
            conv = ("str", None)
        cols.append((f.name, f.attname, conv))
    return cols


def _convert(value, conv, natural):
    if value is None or conv is None:
        return value
    kind, arg = conv
    if kind == "natural":
        return natural[arg].get(value, value)
    if kind == "binary":
        return base64.b64encode(bytes(value)).decode("ascii")
    return str(value)


def _m2m(model, pks, natural):
    out = {}
    for f in model._meta.many_to_many:
        through = f.remote_field.through
        if not through._meta.auto_created:
            continue  # an explicit through model is dumped as rows of its own
        src = f.m2m_field_name() + "_id"
        dst = f.m2m_reverse_field_name() + "_id"
        target = f.remote_field.model._meta.label_lower
        links: dict = {pk: [] for pk in pks}
        for a, b in through.objects.filter(**{f"{src}__in": pks}).order_by(src, dst).values_list(src, dst):
            links[a].append(natural[target].get(b, b) if target in NATURAL else b)
        out[f.name] = links
    return out


def _json_chunks() -> Iterator[str]:
    """The dump as text (dumpdata's format), a few hundred rows at a time.

    Read with values_list rather than through Django's serializer: the same
    output at a fraction of the CPU, which matters on a 0.1-CPU host.
    """
    natural = _natural_keys()
    encoder = DjangoJSONEncoder(ensure_ascii=False)
    yield "["
    first = True
    for model in models_in_order():
        label = model._meta.label_lower
        plan = _plan(model)
        pk_name = model._meta.pk.attname
        qs = _queryset(model)
        last_pk = None
        while True:
            page = qs if last_pk is None else qs.filter(pk__gt=last_pk)
            rows = list(page.values_list(pk_name, *[c[1] for c in plan])[:CHUNK])
            if not rows:
                break
            last_pk = rows[-1][0]
            m2m = _m2m(model, [r[0] for r in rows], natural)
            parts = []
            for r in rows:
                fields = {name: _convert(v, conv, natural) for (name, _, conv), v in zip(plan, r[1:])}
                for name, links in m2m.items():
                    fields[name] = links[r[0]]
                parts.append(encoder.encode({"model": label, "pk": r[0], "fields": fields}))
            yield ("" if first else ",") + "\n" + ",\n".join(parts)
            first = False
            if len(rows) < CHUNK:
                break
    yield "\n]\n"


def stream_gzip() -> Iterator[bytes]:
    """The dump, gzip-compressed, as byte chunks for a StreamingHttpResponse."""
    comp = zlib.compressobj(6, zlib.DEFLATED, 31)  # 31: gzip container
    for text in _json_chunks():
        out = comp.compress(text.encode("utf-8"))
        if out:
            yield out
    yield comp.flush()


def filename(kind: str = "backup") -> str:
    return f"{kind}-{timezone.now():%Y%m%d-%H%M%S-%f}.json.gz"


def build_bytes(limit: Optional[int] = None) -> bytes:
    buf = io.BytesIO()
    for part in stream_gzip():
        buf.write(part)
        if limit is not None and buf.tell() > limit:
            raise OverflowError(f"backup larger than {limit // (1024 * 1024)} MB")
    return buf.getvalue()


def store_weekly(kind: str = "auto") -> dict:
    """Keep a copy in the database's own file store; keep the newest KEEP."""
    from core.models import AuditLog, StoredFile

    try:
        data = build_bytes(limit=MAX_STORED_BYTES)
    except OverflowError as exc:
        AuditLog.objects.create(action="BACKUP_SKIPPED", entity="Backup", detail_json=json.dumps({"reason": str(exc)}))
        return {"ok": False, "reason": str(exc)}
    name = BACKUP_PREFIX + filename(kind)
    StoredFile.objects.update_or_create(name=name, defaults={"content": data, "size": len(data)})
    old = list(StoredFile.objects.filter(name__startswith=BACKUP_PREFIX).order_by("-created_at", "-name")
               .values_list("pk", flat=True)[KEEP:])
    StoredFile.objects.filter(pk__in=old).delete()
    AuditLog.objects.create(action="BACKUP_STORED", entity="Backup", entity_id=name[:64],
                            detail_json=json.dumps({"bytes": len(data), "pruned": len(old)}))
    return {"ok": True, "name": name, "bytes": len(data), "pruned": len(old)}


def stored() -> list[dict]:
    from core.models import StoredFile

    return [
        {"name": n, "bytes": s, "created_at": c.isoformat()}
        for n, s, c in StoredFile.objects.filter(name__startswith=BACKUP_PREFIX)
        .order_by("-created_at").values_list("name", "size", "created_at")
    ]


def read_stored(name: str) -> Optional[bytes]:
    from core.models import StoredFile

    if not name.startswith(BACKUP_PREFIX):
        return None
    row = StoredFile.objects.filter(name=name).only("content").first()
    return bytes(row.content) if row else None


def verify(data: bytes) -> int:
    """How many objects a backup holds; raises if it is not a readable dump."""
    return len(json.loads(gzip.decompress(data)))
