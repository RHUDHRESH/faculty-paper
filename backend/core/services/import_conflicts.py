"""Differences between the college's files and the app, kept until a person settles them.

The faculty-list and settled-claims importers list what differs and never
overwrite it. Both of their steps (the check and the import) hand that list to
`record_conflicts`, which keeps one `ImportConflict` per `key`:

* a new difference is added as open;
* one still open is brought up to date (the app's value may have moved);
* one already settled stays settled, unless the file now says something
  different from what it said when the person decided, which reopens it.

`resolve` is what the office's buttons call. Each action changes one thing,
refuses when the record no longer matches what the file was compared with,
writes one audit entry with what it was and what it became (never a password),
and does nothing the second time it is pressed.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import timedelta
from typing import Any, Callable, Iterable

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.db.models import Value
from django.db.models.functions import Replace, Upper
from django.utils import timezone

from core.models import AuditLog, ImportConflict, PaidLedger, PriorPayment, Role, User
from core.services import heads
from core.services.fyp_roster import staff_key
from core.services.normalize import normalize_title
from core.services.scopus import author_profile_url
from core.services.scopus_profiles import normalize_scopus_id

log = logging.getLogger(__name__)

FACULTY, AMOUNT = ImportConflict.Kind.FACULTY.value, ImportConflict.Kind.AMOUNT.value
OPEN, RESOLVED = ImportConflict.Status.OPEN.value, ImportConflict.Status.RESOLVED.value

FACULTY_ACTIONS = ("use_list", "keep_app", "pause_account", "reactivate")
AMOUNT_ACTIONS = ("update_ledger", "keep_ledger")

FIELD_LABEL = {"email": "Email", "scopus_author_id": "Scopus author ID", "staff_id": "Staff ID"}
_CHUNK = 400


class ConflictError(Exception):
    """A refusal the office should read: `status` is the HTTP code, `message` the words."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------------- keys


def conflict_key(kind: str, row: dict[str, Any]) -> str:
    """The same key for the same difference, in any run."""
    who = staff_key(row.get("staff_id"))
    if kind == FACULTY:
        return f"faculty:{who}:{row.get('field') or ''}"[:191]
    digest = hashlib.sha1(normalize_title(row.get("title") or "")[:512].encode("utf-8")).hexdigest()[:16]
    return f"amount:{who}:{digest}:{row.get('month') or 'none'}"[:191]


def _norm_value(field: str, value: Any) -> str:
    text = str(value or "").strip()
    if field == "email":
        return text.lower()
    if field == "scopus_author_id":
        return normalize_scopus_id(text) or text
    if field == "staff_id":
        return staff_key(text)
    return text


def _incoming_changed(kind: str, old: dict[str, Any], new: dict[str, Any]) -> bool:
    if kind == FACULTY:
        field = new.get("field") or ""
        return _norm_value(field, old.get("incoming")) != _norm_value(field, new.get("incoming"))
    a, b = old.get("file_amount"), new.get("file_amount")
    if a is None or b is None:
        return a != b
    return not _same_amount(float(a), float(b))


def _same_amount(a: float, b: float) -> bool:
    return abs(a - b) < 0.005


def record_conflicts(kind: str, rows: Iterable[dict[str, Any]], source_file: str = "") -> dict[str, int]:
    """Note each reported difference once. See the module docstring for the rules."""
    wanted: dict[str, dict[str, Any]] = {}
    for row in rows:
        wanted[conflict_key(kind, row)] = row
    out = {"opened": 0, "reopened": 0, "updated": 0, "unchanged": 0}
    if not wanted:
        return out
    keys = list(wanted)
    existing: dict[str, ImportConflict] = {}
    for i in range(0, len(keys), _CHUNK):
        for c in ImportConflict.objects.filter(key__in=keys[i:i + _CHUNK]):
            existing[c.key] = c
    now = timezone.now()
    fresh: list[ImportConflict] = []
    touched: list[ImportConflict] = []
    for key, row in wanted.items():
        c = existing.get(key)
        if c is None:
            fresh.append(ImportConflict(kind=kind, key=key, payload=row, source_file=source_file[:255], detected_at=now))
            out["opened"] += 1
        elif c.status == OPEN:
            if c.payload != row or (source_file and c.source_file != source_file[:255]):
                c.payload = row
                c.source_file = source_file[:255] or c.source_file
                touched.append(c)
                out["updated"] += 1
            else:
                out["unchanged"] += 1
        elif _incoming_changed(kind, c.payload, row):
            c.status = OPEN
            c.payload = row
            c.source_file = source_file[:255] or c.source_file
            c.detected_at = now
            c.resolution = ""
            c.resolution_note = ""
            c.resolved_by = None
            c.resolved_at = None
            touched.append(c)
            out["reopened"] += 1
        else:
            out["unchanged"] += 1
    if fresh:
        ImportConflict.objects.bulk_create(fresh, batch_size=500)
    if touched:
        ImportConflict.objects.bulk_update(
            touched,
            ["payload", "source_file", "status", "detected_at", "resolution", "resolution_note", "resolved_by", "resolved_at"],
            batch_size=500,
        )
    return out


def note_conflicts(kind: str, rows: list[dict[str, Any]], source_file: str = "") -> None:
    """`record_conflicts` for an importer: a failure here must never undo an import."""
    try:
        with transaction.atomic():
            record_conflicts(kind, rows, source_file)
    except Exception:  # noqa: BLE001
        log.exception("could not note %s conflicts", kind)


# --------------------------------------------------------------------------- finding the records


def by_staff(keys: set[str]) -> dict[str, list[User]]:
    """Accounts by Faculty ID, compared the way the importers compare it."""
    out: dict[str, list[User]] = {}
    keys = {k for k in keys if k}
    ordered = sorted(keys)
    for i in range(0, len(ordered), _CHUNK):
        qs = User.objects.annotate(_sk=Upper(Replace("staff_id", Value(" "), Value("")))).filter(_sk__in=ordered[i:i + _CHUNK])
        for u in qs:
            out.setdefault(staff_key(u.staff_id), []).append(u)
    return out


def current_value(user: User, field: str) -> str:
    if field == "email":
        return (user.email or "").strip().lower()
    if field == "scopus_author_id":
        return normalize_scopus_id(user.scopus_author_id) or normalize_scopus_id(user.scopus_author_url) or ""
    if field == "staff_id":
        return staff_key(user.staff_id)
    return ""


def targets_for(payloads: list[dict[str, Any]]) -> dict[int, User | None]:
    """The one account each faculty-list row is about, by position; None when there is not exactly one."""
    wanted = set()
    for p in payloads:
        wanted.add(staff_key(p.get("current")) if p.get("field") == "staff_id" else staff_key(p.get("staff_id")))
    staff_map = by_staff(wanted)
    out: dict[int, User | None] = {}
    for i, p in enumerate(payloads):
        field = p.get("field")
        key = staff_key(p.get("current")) if field == "staff_id" else staff_key(p.get("staff_id"))
        found = staff_map.get(key, []) if key else []
        if len(found) == 1:
            out[i] = found[0]
            continue
        out[i] = None
        if field == "email" and p.get("current"):
            hit = list(User.objects.filter(email__iexact=str(p["current"]).strip())[:2])
            out[i] = hit[0] if len(hit) == 1 else None
        elif field == "scopus_author_id" and p.get("current"):
            hit = list(User.objects.filter(scopus_author_id=str(p["current"]).strip())[:2])
            out[i] = hit[0] if len(hit) == 1 else None
    return out


def _ledger_rows(staff_id: str | None, title: str) -> list[PaidLedger]:
    """The payment rows on the ledger for this person and paper."""
    who = staff_key(staff_id)
    qs = PaidLedger.objects.filter(kind=PaidLedger.Kind.PAYMENT)
    if who:
        qs = qs.annotate(_sk=Upper(Replace("staff_id", Value(" "), Value("")))).filter(_sk=who)
    else:
        qs = qs.filter(staff_id__isnull=True) | qs.filter(staff_id="")
    want = normalize_title(title)[:512]
    return [r for r in qs if normalize_title(r.paper_title or "")[:512] == want]


def _prior_amounts(staff_id: str | None, title: str) -> list[float]:
    who = staff_key(staff_id)
    want = normalize_title(title)[:512]
    qs = PriorPayment.objects.filter(normalized_title=want)
    return [p.amount_paid for p in qs if staff_key(p.employee_id) == who and p.amount_paid is not None]


# --------------------------------------------------------------------------- resolving


def _audit(actor: User, action: str, entity: str, entity_id: str | None, detail: dict[str, Any]) -> None:
    AuditLog.objects.create(actor=actor, action=action, entity=entity, entity_id=entity_id, detail_json=json.dumps(detail, default=str))


def _settle(c: ImportConflict, actor: User, action: str, note: str) -> None:
    c.status = RESOLVED
    c.resolution = action
    c.resolution_note = note
    c.resolved_by = actor
    c.resolved_at = timezone.now()
    c.save(update_fields=["status", "resolution", "resolution_note", "resolved_by", "resolved_at"])


def _done(c: ImportConflict, message: str, *, changed: bool, **extra: Any) -> dict[str, Any]:
    return {"ok": True, "changed": changed, "id": c.id, "status": c.status, "message": message, **extra}


#: What `protect` is told, in the sentence "Only a super admin can ___ the principal account".
Protect = Callable[[User, str], None]


def resolve(actor: User, conflict_id: str, action: str, note: str, protect: Protect) -> dict[str, Any]:
    """Carry out one action on one conflict. Raises `ConflictError` for a refusal."""
    note = (note or "").strip()[:2000]
    first = ImportConflict.objects.filter(pk=conflict_id).first()
    if first is None:
        raise ConflictError(404, "That conflict is not in the list any more.")
    allowed = FACULTY_ACTIONS if first.kind == FACULTY else AMOUNT_ACTIONS
    if action not in allowed:
        raise ConflictError(400, "That choice is not available for this kind of difference.")
    # Before the transaction: a refusal writes its own audit entry, which a rollback would take back.
    _guard(first, action, protect)
    with transaction.atomic():
        c = ImportConflict.objects.select_for_update().get(pk=conflict_id)
        if c.kind == FACULTY:
            return _faculty(actor, c, action, note)
        return _amount(actor, c, action, note)


_DOING = {
    "use_list": "change", "keep_app": "settle the conflict of", "pause_account": "pause", "reactivate": "reactivate",
    "update_ledger": "change the ledger of", "keep_ledger": "settle the conflict of",
}


def _guard(c: ImportConflict, action: str, protect: Protect) -> None:
    """Accounts that decide whether money moves are a super admin's alone."""
    p = c.payload
    if c.kind == FACULTY:
        who = targets_for([p])[0]
    else:
        found = by_staff({staff_key(p.get("staff_id"))}).get(staff_key(p.get("staff_id")), [])
        who = found[0] if len(found) == 1 else None
    if who is not None:
        protect(who, _DOING[action])


def _settled_as(c: ImportConflict, action: str) -> dict[str, Any] | None:
    """The answer for an action already carried out; refuses a different earlier decision."""
    if c.status == OPEN:
        return None
    if c.resolution == action:
        return _done(c, "Already done. Nothing changed.", changed=False)
    raise ConflictError(409, "This was already settled another way. Nothing changed.")


def _faculty(actor: User, c: ImportConflict, action: str, note: str) -> dict[str, Any]:
    p = c.payload
    field = p.get("field") or ""
    if field not in FIELD_LABEL:
        raise ConflictError(400, "This difference is not one the app can settle.")
    target = targets_for([p])[0]
    if target is None:
        raise ConflictError(409, "No single account matches this row any more. Check the file again.")

    if action == "pause_account":
        return _pause(actor, c, target, note)
    if action == "reactivate":
        return _reactivate(actor, c, target, note)

    again = _settled_as(c, action)
    if again:
        return again
    incoming = _norm_value(field, p.get("incoming"))
    now_value = current_value(target, field)
    seen = _norm_value(field, p.get("current"))
    matches_file = now_value == incoming
    if now_value != seen and not matches_file:
        raise ConflictError(
            409,
            f"The {FIELD_LABEL[field].lower()} in the app is now {now_value or 'empty'}, not {seen or 'empty'} as when the file was checked. "
            "Check the file again, then decide.",
        )

    if action == "keep_app":
        _settle(c, actor, action, note)
        _audit(actor, "IMPORT_CONFLICT_RESOLVE", "User", target.id, {
            "conflict": c.id, "key": c.key, "action": action, "note": note, "field": field,
            "before": {field: now_value}, "after": {field: now_value}, "file_value": incoming,
        })
        return _done(c, f"Kept the app's {FIELD_LABEL[field].lower()}. Nothing was changed.", changed=False)

    # use_list
    before = {field: now_value}
    extra: dict[str, Any] = {}
    if matches_file:
        after = dict(before)
        message = f"The app already has the file's {FIELD_LABEL[field].lower()}. Nothing was changed."
    else:
        after, message, extra = _write_field(target, field, incoming)
    _settle(c, actor, action, note)
    _audit(actor, "IMPORT_CONFLICT_RESOLVE", "User", target.id, {
        "conflict": c.id, "key": c.key, "action": action, "note": note, "field": field,
        "before": before, "after": after, **({"needs_resync": True} if extra.get("resync") else {}),
    })
    return _done(c, message, changed=not matches_file, **extra)


def _write_field(user: User, field: str, incoming: str) -> tuple[dict[str, Any], str, dict[str, Any]]:
    if field == "email":
        try:
            validate_email(incoming)
        except ValidationError:
            raise ConflictError(400, f"{incoming} is not an email address the app can use.")
        other = User.objects.filter(email__iexact=incoming).exclude(pk=user.pk).first()
        if other is not None:
            who = other.name or other.email
            state = "" if other.active else " (switched off)"
            raise ConflictError(409, f"{incoming} already belongs to {who}{state}. Sort out that account first. Nothing was changed.")
        user.email = incoming
        user.save(update_fields=["email", "updated_at"])
        return {"email": incoming}, f"Email set to {incoming}.", {}
    if field == "staff_id":
        clash = [u for u in by_staff({staff_key(incoming)}).get(staff_key(incoming), []) if u.pk != user.pk]
        if clash:
            raise ConflictError(409, f"{incoming} is already the Staff ID of {clash[0].name or clash[0].email}. Nothing was changed.")
        old = user.staff_id
        user.staff_id = incoming[:64]
        user.save(update_fields=["staff_id", "updated_at"])
        paid = len(_ledgerby_staff(old)) if old else 0
        warning = (
            f"{paid} payment{'s' if paid != 1 else ''} on the ledger stay under the old Staff ID {old}." if paid else None
        )
        return {"staff_id": user.staff_id}, f"Staff ID set to {user.staff_id}." + (f" {warning}" if warning else ""), (
            {"warning": warning} if warning else {}
        )
    # scopus_author_id
    if not incoming.isdigit():
        raise ConflictError(400, "The Scopus author ID in the file is not a number. Nothing was changed.")
    user.scopus_author_id = incoming
    user.scopus_author_url = author_profile_url(incoming)
    user.scopus_profile_status = ""
    user.scopus_profile_checked_at = None
    user.scopus_synced_at = None
    user.save(update_fields=[
        "scopus_author_id", "scopus_author_url", "scopus_profile_status", "scopus_profile_checked_at", "scopus_synced_at", "updated_at",
    ])
    return (
        {"scopus_author_id": incoming},
        f"Scopus author ID set to {incoming}. Sync this person's papers from Scopus again.",
        {"resync": True},
    )


def _ledgerby_staff(staff_id: str | None) -> list[str]:
    who = staff_key(staff_id)
    if not who:
        return []
    qs = PaidLedger.objects.annotate(_sk=Upper(Replace("staff_id", Value(" "), Value("")))).filter(_sk=who)
    return list(qs.values_list("id", flat=True)[:1000])


def _pause(actor: User, c: ImportConflict, target: User, note: str) -> dict[str, Any]:
    if target.pk == actor.pk:
        raise ConflictError(400, "You cannot pause your own account.")
    if c.status != OPEN:
        raise ConflictError(409, "This conflict is settled. Pause the account from the people page if you need to.")
    if not target.active:
        return _done(c, "The account is already switched off. Nothing changed.", changed=False)
    target.active = False
    target.save(update_fields=["active", "updated_at"])
    c.paused_at = timezone.now()
    c.save(update_fields=["paused_at"])
    _audit(actor, "IMPORT_CONFLICT_PAUSE", "User", target.id, {
        "conflict": c.id, "key": c.key, "action": "pause_account", "note": note,
        "before": {"active": True}, "after": {"active": False},
    })
    return _done(c, f"{target.name or target.email} cannot sign in until the account is reactivated.", changed=True)


def _reactivate(actor: User, c: ImportConflict, target: User, note: str) -> dict[str, Any]:
    if c.paused_at is None:
        if target.active:
            return _done(c, "The account is already active. Nothing changed.", changed=False)
        raise ConflictError(409, "This account was not paused from this screen. Switch it back on from the people page.")
    if not target.active:
        target.active = True
        if target.role == Role.HOD:
            # Switching a head back on is a change of post like any other: one head a department.
            try:
                heads.appoint(target, replace=False, actor=actor, via="data conflicts")
            except heads.NoDepartment as exc:
                raise ConflictError(400, str(exc))
            except heads.HeadAlreadyAppointed as exc:
                raise ConflictError(409, str(exc))
        target.save(update_fields=["active", "updated_at"])
        changed = True
    else:
        changed = False
    # Every conflict of this person that was paused stops being paused with the account.
    who = staff_key(c.payload.get("staff_id"))
    ImportConflict.objects.filter(kind=FACULTY, paused_at__isnull=False, key__startswith=f"faculty:{who}:").update(paused_at=None)
    c.paused_at = None
    if changed:
        _audit(actor, "IMPORT_CONFLICT_REACTIVATE", "User", target.id, {
            "conflict": c.id, "key": c.key, "action": "reactivate", "note": note,
            "before": {"active": False}, "after": {"active": True},
        })
    return _done(c, f"{target.name or target.email} can sign in again.", changed=changed)


def _amount(actor: User, c: ImportConflict, action: str, note: str) -> dict[str, Any]:
    p = c.payload
    file_amount = p.get("file_amount")
    ledger_amount = p.get("ledger_amount")
    if file_amount is None or ledger_amount is None:
        raise ConflictError(400, "This row has no amount to compare.")
    again = _settled_as(c, action)
    if again:
        return again

    rows = _ledger_rows(p.get("staff_id"), p.get("title") or "")
    at_ledger = [r for r in rows if _same_amount(r.amount, float(ledger_amount))]
    at_file = [r for r in rows if _same_amount(r.amount, float(file_amount))]

    if action == "keep_ledger":
        known = at_ledger or [a for a in _prior_amounts(p.get("staff_id"), p.get("title") or "") if _same_amount(a, float(ledger_amount))]
        if not known and not at_file:
            raise ConflictError(409, "The amount recorded for this paper has changed since the file was checked. Check the file again, then decide.")
        _settle(c, actor, action, note)
        kept = (at_ledger or at_file)
        _audit(actor, "IMPORT_CONFLICT_RESOLVE", "PaidLedger", kept[0].id if kept else None, {
            "conflict": c.id, "key": c.key, "action": action, "note": note, "title": p.get("title"),
            "before": {"amount": ledger_amount}, "after": {"amount": ledger_amount}, "file_amount": file_amount,
        })
        return _done(c, "Kept the recorded amount. Nothing was changed.", changed=False)

    # update_ledger
    if not note:
        raise ConflictError(400, "Say why the ledger amount is being changed.")
    if float(file_amount) < 0:
        raise ConflictError(400, "The amount in the file is negative. Nothing was changed.")
    if not at_ledger:
        if at_file:
            _settle(c, actor, action, note)
            return _done(c, "The ledger already has the file's amount. Nothing was changed.", changed=False)
        if rows:
            raise ConflictError(409, "The ledger amount for this paper has changed since the file was checked. Check the file again, then decide.")
        raise ConflictError(409, "The amount comes from the earlier payments record, not the ledger, so there is no ledger row to change.")
    if len(at_ledger) > 1:
        month = p.get("month")
        by_month = [r for r in at_ledger if month and r.payout_month.isoformat()[:7] == str(month)[:7]]
        at_ledger = by_month if len(by_month) >= 1 else at_ledger
    if len(at_ledger) != 1:
        raise ConflictError(409, "More than one ledger row matches this paper. Change the right one from the ledger.")
    row = at_ledger[0]
    if row.claim_id:
        raise ConflictError(409, "This payment belongs to a claim. Correct it from the claim, not from here.")

    before = {"amount": row.amount}
    try:
        raw = json.loads(row.raw_json) if row.raw_json else {}
        if not isinstance(raw, dict):
            raise ValueError
    except ValueError:
        raw = {"previous_raw_json": row.raw_json}
    history = raw.get("amount_history")
    if not isinstance(history, list):
        history = []
    history.append({
        "from": row.amount, "to": float(file_amount), "at": timezone.now().isoformat(),
        "by": actor.id, "by_name": actor.name or actor.email, "note": note, "conflict": c.id,
    })
    raw["amount_history"] = history
    row.amount = float(file_amount)
    row.raw_json = json.dumps(raw, ensure_ascii=False)
    row.save(update_fields=["amount", "raw_json"])
    _settle(c, actor, action, note)
    _audit(actor, "IMPORT_CONFLICT_RESOLVE", "PaidLedger", row.id, {
        "conflict": c.id, "key": c.key, "action": action, "note": note, "title": p.get("title"),
        "before": before, "after": {"amount": row.amount},
    })
    return _done(c, f"Ledger amount changed from ₹{before['amount']:,.0f} to ₹{row.amount:,.0f}.", changed=True)


# --------------------------------------------------------------------------- reading


def counts() -> dict[str, int]:
    week = timezone.now() - timedelta(days=7)
    open_faculty = ImportConflict.objects.filter(status=OPEN, kind=FACULTY).count()
    open_amount = ImportConflict.objects.filter(status=OPEN, kind=AMOUNT).count()
    return {
        "open": open_faculty + open_amount,
        "open_faculty": open_faculty,
        "open_amount": open_amount,
        "resolved_week": ImportConflict.objects.filter(status=RESOLVED, resolved_at__gte=week).count(),
    }
