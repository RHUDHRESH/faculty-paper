"""Load a full export into a fresh installation: streamed, bounded, resumable.

`loaddata` reads the whole file into memory and saves one object at a time,
which on the free host (512 MB, ~0.1 CPU, one 55-minute job) runs out of
either. This loader instead:

* streams the file (.jsonl, .json, either optionally gzipped) and never holds
  more than one batch of it;
* turns each object into a model instance itself -- the same field-by-field
  `to_python` Django's own deserializer uses -- but resolves natural keys
  (users by email, permissions) from a cache instead of one query per row;
* groups consecutive objects of one model and inserts ~1000 of them per
  statement, in one transaction per batch, writing the exported values as
  they are (the `raw` insert `loaddata` uses: `auto_now` fields are kept);
* writes the checkpoint (how many objects of the file are done) in the same
  transaction as the batch, so a stopped job continues from exactly there;
* sets many-to-many links in a second pass, once every row exists, straight
  into the through tables;
* stops cleanly at a time budget and queues itself again.

Progress and the checkpoint live in one `SystemSetting` row (`restore_run`),
so the admin page can show them and a re-upload of the same file (matched by
SHA-256) carries on instead of starting again.

Signals: `loaddata` saves with raw=True, so the claim threshold re-decision
and the identifier tidying never ran on a restore either; only the shared
figures' cache is made stale, once, at the end. Sequences are reset at the
end, as `loaddata` does.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import io
import json
import re
import time
from datetime import datetime
from typing import Any, Iterator, Optional

from django.apps import apps
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.management.color import no_style
from django.db import IntegrityError, connection, reset_queries, transaction
from django.utils import timezone

KEY = "restore_run"
BATCH = 1000
BATCH_BYTES = 8 * 1024 * 1024
MAX_OBJECT_CHARS = 64 * 1024 * 1024
#: A "running" run that has not written for this long is taken as dead.
STALE_SECONDS = 180
MAX_FIXUPS = 5000
MAX_CHAIN = 400
ACCEPTED = (".jsonl", ".jsonl.gz", ".json", ".json.gz")
#: Labels an unfiltered dumpdata includes that a migrate recreates by itself.
SKIP_LABELS = {"contenttypes.contenttype", "auth.permission", "sessions.session"}
SKIP_APPS = {"django_q", "sessions", "contenttypes"}

_MODEL_RX = re.compile(r'^\s*\{\s*"model"\s*:\s*"([^"]+)"')


class RestoreError(Exception):
    """The export cannot be loaded; the message is shown to the admin."""


class Refused(Exception):
    """A restore may not start now (HTTP status, message)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ------------------------------------------------------------ reading ----


def _open_text(path: str):
    with open(path, "rb") as f:
        magic = f.read(2)
    raw = gzip.open(path, "rb") if magic == b"\x1f\x8b" else open(path, "rb")
    return io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")


def _first_char(fh) -> str:
    while True:
        c = fh.read(1)
        if c == "":
            return ""
        if not c.isspace():
            return c


def _iter_array(fh, buf: str) -> Iterator[tuple[dict, int]]:
    """Objects of a JSON array, parsed incrementally from `fh`."""
    dec = json.JSONDecoder()
    pos, want, started = 0, 1 << 20, False
    while True:
        n = len(buf)
        while pos < n and buf[pos] in " \t\r\n,":
            pos += 1
        if pos >= n:
            more = fh.read(want)
            if not more:
                if started:
                    raise RestoreError("The file ends before the closing ] of the list")
                return
            buf, pos = buf[pos:] + more, 0
            continue
        c = buf[pos]
        if not started:
            if c != "[":
                raise RestoreError("Not an export: a .json file must be a list of objects")
            started, pos = True, pos + 1
            continue
        if c == "]":
            return
        try:
            obj, end = dec.raw_decode(buf, pos)
        except json.JSONDecodeError:
            more = fh.read(want)
            if not more or len(buf) - pos > MAX_OBJECT_CHARS:
                raise RestoreError("The file is not valid JSON")
            buf, pos = buf[pos:] + more, 0
            want = min(want * 2, 16 << 20)
            continue
        yield obj, end - pos
        pos = end


def iter_objects(path: str, skip: int = 0, only: Optional[set] = None) -> Iterator[tuple[int, dict, int]]:
    """(absolute index, object, size) for each object after the first `skip`.

    With `only` (a set of model labels) other objects are passed over without
    being parsed where the format allows. Lines of a .jsonl file that are
    skipped are counted, not decoded.
    """
    with _open_text(path) as fh:
        c = _first_char(fh)
        if c == "":
            return
        if c == "[":
            for i, (obj, size) in enumerate(_iter_array(fh, "[")):
                if i < skip or not isinstance(obj, dict):
                    continue
                if only is not None and obj.get("model") not in only:
                    continue
                yield i, obj, size
            return
        if c != "{":
            raise RestoreError("Not an export: expected JSON objects, one per line")
        i = -1
        first = True
        while True:
            line = c + fh.readline() if first else fh.readline()
            first = False
            if not line:
                return
            if not line.strip():
                continue
            i += 1
            if i < skip:
                continue
            if only is not None:
                m = _MODEL_RX.match(line[:200])
                if m and m.group(1) not in only:
                    continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RestoreError(f"Line {i + 1} is not valid JSON: {exc.msg}") from exc
            yield i, obj, len(line)


def count_objects(path: str) -> int:
    with _open_text(path) as fh:
        c = _first_char(fh)
        if c == "":
            return 0
        if c == "[":
            return sum(1 for _ in _iter_array(fh, "["))
        n = 0
        for line in fh:
            if line.strip():
                n += 1
        return n


def fingerprint(path: str) -> tuple[str, int]:
    h, size = hashlib.sha256(), 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def sniff(path: str) -> None:
    """Raise RestoreError unless the file starts like an export."""
    try:
        with _open_text(path) as fh:
            c = _first_char(fh)
    except (OSError, EOFError, UnicodeDecodeError) as exc:
        raise RestoreError(f"The file cannot be read ({exc}). Is it a damaged .gz?") from exc
    if c not in ("[", "{"):
        raise RestoreError("Not an export: it must hold JSON objects (dumpdata --format json or jsonl)")


# ------------------------------------------------------ the run record ----


def get_run() -> Optional[dict]:
    from core.models import SystemSetting

    row = SystemSetting.objects.filter(key=KEY).first()
    return row.value if row and row.value else None


def save_run(run: dict) -> None:
    from core.models import SystemSetting

    run["updated_at"] = timezone.now().isoformat()
    SystemSetting.objects.update_or_create(key=KEY, defaults={"value": run})


def new_run(sha: str, filename: str, size: int, saved_path: str, actor_id) -> dict:
    return {
        "sha": sha, "filename": filename, "bytes": size, "saved_path": saved_path,
        "actor_id": str(actor_id) if actor_id else None,
        "status": "queued", "phase": "start", "done": 0, "links_done": 0, "total": None,
        "loaded": 0, "kept_existing": 0, "model": "", "per_model": {}, "links": 0,
        "dropped": {}, "unknown_fields": 0, "fixups": [], "stood_down": None,
        "chain": 0, "alias": {}, "seconds": 0.0, "error": "", "job_id": None,
        "started_at": timezone.now().isoformat(), "updated_at": None, "finished_at": None,
    }


def _age(run: dict) -> float:
    try:
        return (timezone.now() - datetime.fromisoformat(run["updated_at"])).total_seconds()
    except (KeyError, TypeError, ValueError):
        return 1e9


def is_stalled(run: dict) -> bool:
    return run.get("status") in ("running", "queued") and _age(run) > STALE_SECONDS


def public(run: Optional[dict]) -> Optional[dict]:
    """The run as the admin page sees it (no paths, no fix-up list)."""
    if not run:
        return None
    import os

    out = {k: run.get(k) for k in (
        "filename", "bytes", "status", "phase", "done", "total", "loaded", "kept_existing", "model",
        "per_model", "links", "dropped", "chain", "seconds", "error", "job_id", "started_at",
        "updated_at", "finished_at")}
    out["fixups"] = len(run.get("fixups") or [])
    out["stalled"] = is_stalled(run)
    path = run.get("saved_path")
    out["file_kept"] = bool(path and os.path.exists(path))
    t, d = run.get("total"), run.get("done") or 0
    if run.get("phase") in ("start", "load"):
        out["percent"] = round(100 * d / t) if t else 0
    elif run.get("status") == "done":
        out["percent"] = 100
    else:
        out["percent"] = 99 if t else 0
    return out


def check_can_start(sha: str) -> str:
    """"fresh" or "resume"; raises Refused. Called by the upload endpoint."""
    from core.models import Claim

    run = get_run()
    same = bool(run and run.get("sha") == sha)
    if same and run["status"] == "done":
        raise Refused(409, "This file has already been restored.")
    if same and run["status"] in ("queued", "running") and not is_stalled(run):
        raise Refused(409, "This restore is already running; watch its progress.")
    if Claim.objects.exists() and not same:
        raise Refused(409, "This installation already holds claims; a restore is only for a fresh one "
                           "(or to continue an interrupted restore of the same file)")
    if run and not same and run["status"] in ("queued", "running") and not is_stalled(run):
        raise Refused(409, "A restore of another file is running.")
    return "resume" if same else "fresh"


# ------------------------------------------------------------ loading ----


class _Info:
    """What the loader needs to know about one model, worked out once."""

    def __init__(self, model):
        self.model = model
        self.label = model._meta.label_lower
        self.pk = model._meta.pk
        self.fields = {f.name: f for f in model._meta.concrete_fields}
        self.fields.update({f.name: f for f in model._meta.many_to_many})
        self.fks = [f for f in model._meta.concrete_fields if f.remote_field]
        self.m2m = [f for f in model._meta.many_to_many if f.remote_field.through._meta.auto_created]
        self.natural = hasattr(model, "natural_key") and hasattr(model._default_manager, "get_by_natural_key")
        self.insert_fields = list(model._meta.concrete_fields)
        self.pk_is_relation = bool(self.pk.remote_field)


class Loader:
    def __init__(self, run: dict):
        self.run = run
        self.infos: dict[str, _Info] = {}
        self.known: dict[tuple, set] = {}       # (label, field name) -> values seen to exist
        self.natural: dict[tuple, Any] = {}     # (label, key tuple) -> value of the target field
        # label -> {exported pk: pk kept in this database}; lives in the run record so a continued job knows it
        self.alias: dict[str, dict] = run.setdefault("alias", {})

    # models
    def info(self, label: str) -> Optional[_Info]:
        if label in self.infos:
            return self.infos[label]
        app = label.split(".")[0]
        if label in SKIP_LABELS or app in SKIP_APPS:
            self.infos[label] = None
            return None
        try:
            model = apps.get_model(label)
        except (LookupError, ValueError) as exc:
            raise RestoreError(f"The file holds '{label}', which this version of the app does not have") from exc
        self.infos[label] = _Info(model)
        return self.infos[label]

    # keys
    def _natural_value(self, target: _Info, key, field_name: str):
        k = (target.label, tuple(key))
        if k in self.natural:
            return self.natural[k]
        try:
            obj = target.model._default_manager.get_by_natural_key(*key)
        except target.model.DoesNotExist:
            return None
        v = getattr(obj, field_name)
        if target.pk_is_relation:
            v = v.pk
        self.natural[k] = v
        return v

    def aliased(self, target: _Info, fname: str, v):
        new = self.alias.get(target.label, {}).get(str(v))
        return target.model._meta.get_field(fname).to_python(new) if new else v

    def _fk(self, f, value):
        """(value for the column, resolved?) -- unresolved ones are deferred."""
        if value is None:
            return None, True
        target = self.info(f.remote_field.model._meta.label_lower) or _Info(f.remote_field.model)
        fname = f.remote_field.field_name
        if isinstance(value, (list, tuple)):
            v = self._natural_value(target, value, fname)
            return v, v is not None
        v = target.model._meta.get_field(fname).to_python(value)
        v = self.aliased(target, fname, v)
        return v, True

    # one object -> an instance
    def build(self, info: _Info, obj: dict):
        data, links, deferred = {}, {}, []
        for name, value in (obj.get("fields") or {}).items():
            f = info.fields.get(name)
            if f is None:
                self.run["unknown_fields"] += 1
                continue
            if f.many_to_many:
                if f in info.m2m and value:
                    links[name] = value
                continue
            try:
                if f.remote_field:
                    v, ok = self._fk(f, value)
                    if not ok:
                        deferred.append((f, value))
                    data[f.attname] = v
                else:
                    data[f.attname] = f.to_python(value)
            except ValidationError as exc:
                raise RestoreError(f"{info.label} {obj.get('pk')}: bad value for {name}: {exc.messages[0]}") from exc
        pk = obj.get("pk")
        if pk is not None:
            try:
                if info.pk_is_relation:
                    v, _ = self._fk(info.pk, pk)
                    data[info.pk.attname] = v
                else:
                    data[info.pk.attname] = info.pk.to_python(pk)
            except ValidationError as exc:
                raise RestoreError(f"{info.label}: bad primary key {pk!r}") from exc
        inst = info.model(**data)
        return inst, links, deferred, pk

    def pk_of(self, info: _Info, obj: dict):
        """The pk this object has (or will have) here; None if it cannot be told."""
        if obj.get("pk") is not None:
            if info.pk_is_relation:
                return self._fk(info.pk, obj["pk"])[0]
            return info.pk.to_python(obj["pk"])
        inst, _, _, _ = self.build(info, obj)
        if info.natural:
            return self._natural_value(info, inst.natural_key(), info.pk.attname)
        return inst.pk

    # existence of foreign-key targets
    def _exists(self, target, fname: str, values: set, extra: set) -> set:
        known = self.known.setdefault((target._meta.label_lower, fname), set())
        new = values - known - extra
        if new:
            found = set(target._base_manager.filter(**{f"{fname}__in": list(new)}).values_list(fname, flat=True))
            known |= found
            new -= found
        return new  # the missing ones

    def remember(self, info: _Info, instances):
        s = self.known.setdefault((info.label, info.pk.name), set())
        s.update(i.pk for i in instances)
        if info.natural:
            for i in instances:
                self.natural[(info.label, tuple(i.natural_key()))] = i.pk

    # -------------------------------------------------- phase 1: rows ----
    def insert(self, info: _Info, objs: list, last_index: int):
        run = self.run
        snap = copy.deepcopy({k: run[k] for k in ("done", "loaded", "per_model", "fixups", "dropped", "kept_existing", "model")})
        try:
            self._insert_batch(info, objs, last_index)
        except Exception:
            run.update(snap)  # the batch rolled back; so does the record of it
            raise

    def _insert_batch(self, info: _Info, objs: list, last_index: int):
        run, model = self.run, info.model
        built = []
        for o in objs:
            inst, links, deferred, raw_pk = self.build(info, o)
            built.append((inst, deferred, raw_pk))
        # Rows that already have a counterpart here: the same natural key
        # (the account setup just made) is kept as it is, and later references
        # to the exported key follow it.
        keep, rows = [], []
        for inst, deferred, raw_pk in built:
            if info.natural:
                existing = self._natural_value(info, inst.natural_key(), info.pk.attname)
                if existing is not None:
                    if raw_pk is not None and existing != inst.pk:
                        self.alias.setdefault(info.label, {})[str(inst.pk)] = str(existing)
                    self.known.setdefault((info.label, info.pk.name), set()).add(existing)
                    run["kept_existing"] += 1
                    continue
            rows.append((inst, deferred))
        # Unresolved foreign keys.
        batch_pks = {i.pk for i, _ in rows}
        for f in info.fks:
            vals = {getattr(i, f.attname) for i, _ in rows if getattr(i, f.attname) is not None}
            if not vals:
                continue
            extra = batch_pks if f.remote_field.model is model and f.remote_field.field_name == info.pk.name else set()
            # only plain values need the check; natural-key results came from the database
            missing = self._exists(f.remote_field.model, f.remote_field.field_name, vals, extra)
            if not missing:
                continue
            kept = []
            for inst, deferred in rows:
                v = getattr(inst, f.attname)
                if v in missing:
                    if info.pk_is_relation and f is info.pk:
                        run["dropped"][info.label] = run["dropped"].get(info.label, 0) + 1
                        continue
                    if not f.null:
                        raise RestoreError(f"{info.label} {inst.pk}: {f.name} points to {v}, which is in neither "
                                           "the file nor the database. Was the file made with "
                                           "--natural-primary? Export again without it.")
                    if len(run["fixups"]) >= MAX_FIXUPS:
                        raise RestoreError("Too many forward references to defer; export again")
                    run["fixups"].append([info.label, str(inst.pk), f.attname, json.dumps(str(v))])
                    setattr(inst, f.attname, None)
                kept.append((inst, deferred))
            rows = kept
        for inst, deferred in rows:
            for f, raw in deferred:
                if f.null:
                    run["fixups"].append([info.label, str(inst.pk), f.attname, json.dumps(raw)])
                else:
                    raise RestoreError(f"{info.label} {inst.pk}: {f.name} refers to {raw!r}, which does not exist")
        insts = [i for i, _ in rows]
        run["done"] = last_index + 1
        run["loaded"] += len(insts)
        run["per_model"][info.label] = run["per_model"].get(info.label, 0) + len(insts)
        run["model"] = info.label
        try:
            with transaction.atomic():
                existing = set(model._base_manager.filter(pk__in=[i.pk for i in insts]).values_list("pk", flat=True)) if insts else set()
                fresh = [i for i in insts if i.pk not in existing]
                qs = model._base_manager.get_queryset()
                step = max(1, connection.ops.bulk_batch_size(info.insert_fields, fresh)) if fresh else 1
                for a in range(0, len(fresh), step):
                    qs._insert(fresh[a:a + step], fields=info.insert_fields, using=qs.db, raw=True)
                for i in insts:
                    if i.pk in existing:        # seed data the college's own replaces
                        i.save_base(raw=True)
                save_run(run)
        except IntegrityError as exc:
            raise RestoreError(f"{info.label} (objects {last_index + 2 - len(objs)}-{last_index + 1}): {exc}") from exc
        self.remember(info, insts)
        reset_queries()


def _load_rows(run: dict, path: str, loader: Loader, deadline: float) -> bool:
    """True when the whole file is loaded, False when stopped by the time budget."""
    batch: list = []
    label, nbytes, last = None, 0, run["done"] - 1

    def flush() -> None:
        nonlocal batch, nbytes
        if batch:
            info = loader.info(label)
            if info is not None:
                loader.insert(info, batch, last)
            else:
                run["done"] = last + 1
                save_run(run)
            batch, nbytes = [], 0

    for i, obj, size in iter_objects(path, skip=run["done"]):
        lab = obj.get("model")
        if batch and (lab != label or len(batch) >= BATCH or nbytes >= BATCH_BYTES):
            flush()
            if time.monotonic() > deadline:
                return False
        if not batch:
            label = lab
        batch.append(obj)
        nbytes += size
        last = i
    flush()
    run["done"] = max(run["done"], (run["total"] or 0))
    return True


# ------------------------------------------------- phase 2: M2M links ----


def _m2m_labels() -> set:
    out = set()
    for m in apps.get_models():
        if any(f.remote_field.through._meta.auto_created for f in m._meta.many_to_many):
            out.add(m._meta.label_lower)
    return out


def _load_links(run: dict, path: str, loader: Loader, deadline: float) -> bool:
    pending: dict = {}      # through model -> [instances]
    size = 0
    last = run["links_done"] - 1

    def flush() -> None:
        nonlocal size
        with transaction.atomic():
            for through, rows in pending.items():
                if rows:
                    through._base_manager.bulk_create(rows, ignore_conflicts=True, batch_size=BATCH)
            run["links_done"] = last + 1
            save_run(run)
        pending.clear()
        size = 0
        reset_queries()

    for i, obj, _ in iter_objects(path, skip=run["links_done"], only=_m2m_labels()):
        info = loader.info(obj.get("model"))
        if info is None or not info.m2m:
            continue
        last = i
        owner = loader.pk_of(info, obj)
        if owner is None:
            continue
        owner = loader.aliased(info, info.pk.name, owner)
        for f in info.m2m:
            vals = (obj.get("fields") or {}).get(f.name) or []
            if not vals:
                continue
            target = loader.info(f.remote_field.model._meta.label_lower) or _Info(f.remote_field.model)
            tvals = []
            for v in vals:
                if isinstance(v, (list, tuple)):
                    tv = loader._natural_value(target, v, target.pk.attname)
                else:
                    tv = target.pk.to_python(v)
                    tv = loader.aliased(target, target.pk.name, tv)
                if tv is not None:
                    tvals.append(tv)
            if not tvals:
                continue
            missing = loader._exists(target.model, target.pk.name, set(tvals), set())
            through = f.remote_field.through
            src, dst = f"{f.m2m_field_name()}_id", f"{f.m2m_reverse_field_name()}_id"
            rows = pending.setdefault(through, [])
            for tv in tvals:
                if tv in missing:
                    run["dropped"][f"{info.label}.{f.name}"] = run["dropped"].get(f"{info.label}.{f.name}", 0) + 1
                    continue
                rows.append(through(**{src: owner, dst: tv}))
                run["links"] += 1
                size += 1
        if size >= BATCH:
            flush()
            if time.monotonic() > deadline:
                return False
    flush()
    return True


# ----------------------------------------------- phase 3/4: tidy up ----


def _apply_fixups(run: dict, loader: Loader) -> None:
    left = []
    for label, pk, attname, raw in run.get("fixups") or []:
        info = loader.info(label)
        f = next(x for x in info.model._meta.concrete_fields if x.attname == attname)
        value, ok = loader._fk(f, json.loads(raw))
        if ok and value is not None and not loader._exists(f.remote_field.model, f.remote_field.field_name, {value}, set()):
            info.model._base_manager.filter(pk=info.pk.to_python(pk)).update(**{attname: value})
        else:
            left.append([label, pk, attname, raw])
    if left:
        run["dropped"]["unresolved references (left empty)"] = len(left)
    run["fixups"] = []


def _finish(run: dict, loader: Loader) -> dict:
    from core.models import AuditLog, Claim, FormulaConfig, PaidLedger, User
    from core.services.aggregate_cache import bump

    stood = run.get("stood_down") or []
    if not FormulaConfig.objects.filter(active=True).exists() and stood:
        FormulaConfig.objects.filter(pk__in=stood[:1]).update(active=True)
    labels = list(run["per_model"])
    models = [loader.info(l).model for l in labels if loader.info(l)]
    sql = connection.ops.sequence_reset_sql(no_style(), models)
    if sql:
        with connection.cursor() as cur:
            for s in sql:
                cur.execute(s)
    bump()
    counts = {"users": User.objects.count(), "claims": Claim.objects.count(),
              "ledger_rows": PaidLedger.objects.count()}
    run.update(status="done", phase="done", model="", finished_at=timezone.now().isoformat())
    save_run(run)
    actor = User.objects.filter(pk=run["actor_id"]).first() if run.get("actor_id") else None
    AuditLog.objects.create(actor=actor, action="RESTORE_DONE", entity="Export",
                            detail_json=json.dumps({**counts, "rows": run["loaded"], "links": run["links"],
                                                    "kept_existing": run["kept_existing"], "dropped": run["dropped"],
                                                    "seconds": round(run["seconds"]), "chain": run["chain"]}))
    return {"ok": True, **counts, "rows": run["loaded"], "links": run["links"], "dropped": run["dropped"]}


def queue_next(saved_path: str, actor_id):
    from django_q.tasks import async_task

    return async_task("core.tasks.run_restore", saved_path, actor_id)


def execute(saved_path: str, actor_id=None, budget: Optional[float] = None) -> dict:
    """Run (or carry on with) the restore of `saved_path`. Used by the job.

    Returns a summary; when the time budget runs out it saves its place,
    queues the same job again and returns {"continued": True}.
    """
    import os

    from core.models import AuditLog, FormulaConfig

    if budget is None:
        budget = float(getattr(settings, "RESTORE_JOB_SECONDS", 3000))
    started = time.monotonic()
    deadline = started + budget
    sha, size = fingerprint(saved_path)
    run = get_run()
    if not run or run.get("sha") != sha:
        sniff(saved_path)
        run = new_run(sha, os.path.basename(saved_path), size, saved_path, actor_id)
    elif run["status"] == "done":
        return {"ok": True, "already": True}
    elif run["status"] == "running" and not is_stalled(run):
        return {"ok": False, "busy": True}
    run.update(saved_path=saved_path, status="running", error="")
    if actor_id:
        run["actor_id"] = str(actor_id)
    save_run(run)
    loader = Loader(run)
    try:
        if run["total"] is None:
            run["total"] = count_objects(saved_path)
        if run["stood_down"] is None:
            # First-run setup made a default active formula; the export brings
            # the college's own and only one may be active (one_active_formula).
            ids = [str(p) for p in FormulaConfig.objects.filter(active=True).values_list("pk", flat=True)]
            FormulaConfig.objects.filter(active=True).update(active=False)
            run["stood_down"] = ids
        if run["phase"] in ("start", "load"):
            run["phase"] = "load"
            save_run(run)
            if not _load_rows(run, saved_path, loader, deadline):
                return _pause(run, saved_path, actor_id, started)
            run["phase"] = "links"
            run["model"] = ""
            save_run(run)
        if run["phase"] == "links":
            if not _load_links(run, saved_path, loader, deadline):
                return _pause(run, saved_path, actor_id, started)
            run["phase"] = "tidy"
            save_run(run)
        _apply_fixups(run, loader)
        run["seconds"] += time.monotonic() - started
        out = _finish(run, loader)
    except Exception as exc:
        run["seconds"] += time.monotonic() - started
        run.update(status="failed", error=str(exc)[:1500])
        try:
            save_run(run)
            AuditLog.objects.create(action="RESTORE_FAILED", entity="Export",
                                    detail_json=json.dumps({"error": run["error"], "done": run["done"],
                                                            "phase": run["phase"]}))
        except Exception:
            pass
        raise
    try:
        os.remove(saved_path)
    except OSError:
        pass
    return out


def _pause(run: dict, saved_path: str, actor_id, started: float) -> dict:
    """Out of time for this job: note where we are and queue the next one."""
    from core.models import AuditLog

    run["seconds"] += time.monotonic() - started
    run["chain"] += 1
    if run["chain"] > MAX_CHAIN:
        raise RestoreError("Gave up after too many continuations")
    run["status"] = "queued"
    save_run(run)
    queue_next(saved_path, actor_id)
    AuditLog.objects.create(action="RESTORE_CONTINUES", entity="Export",
                            detail_json=json.dumps({"done": run["done"], "total": run["total"],
                                                    "phase": run["phase"], "chain": run["chain"]}))
    return {"ok": True, "continued": True, "done": run["done"], "total": run["total"]}
