"""The office's review of college authors nobody matched, and of duplicate accounts.

Unmatched college authorships are grouped by `name_key`, so "Lavanya G",
"G. Lavanya" and "G Lavanya" are one decision. A decision is kept as an
`AuthorAlias`: "this is <user>" links the rows now and match_authors applies
it on every later run; "not on our roster" hides the name; "ambiguous" parks it.

A duplicate account is merged into the one kept: its claims, authorships,
follows and aliases move, blank identity fields are inherited, ledger rows
that carried its staff / biometric id are re-pointed, and it is deactivated.
Nothing here reads or returns an amount.
"""
from __future__ import annotations

import json
from typing import Any

from django.db import transaction
from django.db.models import Count, Q

from core.models import AuditLog, Authorship, AuthorAlias, Claim, Follow, PaidLedger, User
from core.services.author_names import name_key
from core.services.publications import _NameIndex, _people, refresh_metrics

#: Identity fields two accounts for one person should agree on.
IDENTITY = ("employee_id", "staff_id", "biometric_id", "orcid_id", "scopus_author_id")


class ReviewError(ValueError):
    pass


def _audit(actor: User | None, action: str, entity: str, entity_id: str, detail: dict) -> None:
    AuditLog.objects.create(actor=actor, action=action, entity=entity, entity_id=entity_id,
                            detail_json=json.dumps(detail, default=str))


def _person(u: User) -> dict[str, Any]:
    return {"id": u.id, "name": u.name, "department": u.department, "email": u.email}


# --------------------------------------------------------------------------- unmatched names

def _groups() -> dict[str, dict[str, Any]]:
    """Every unmatched college author name, grouped by `name_key`.

    Normalising ~5k names took about a second on the real record and the
    admin home screen asks for it on every load, so it is kept per data
    generation (any write rebuilds it).
    """
    from core.services.aggregate_cache import shared as cached

    def build() -> dict[str, dict[str, Any]]:
        groups: dict[str, dict[str, Any]] = {}
        rows = Authorship.objects.filter(is_college=True, user__isnull=True).values_list(
            "display_name", "publication_id"
        )
        for display, pub_id in rows:
            key = name_key(display)
            if not key:
                continue
            g = groups.setdefault(key, {"key": key, "names": {}, "papers": set()})
            g["names"][display] = g["names"].get(display, 0) + 1
            g["papers"].add(pub_id)
        return groups

    return cached("author_review.groups", {}, build)


def unmatched_groups(*, status: str = "open", q: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """Unmatched college author names, grouped by normalised name, most papers first.

    `status` is "open" (no decision yet), "ambiguous" or "hidden" (not on roster).
    """
    decided = dict(AuthorAlias.objects.values_list("name_key", "status"))
    groups = _groups()
    want = {"open": None, "ambiguous": AuthorAlias.AMBIGUOUS, "hidden": AuthorAlias.NOT_ROSTER}.get(status)
    needle = q.strip().lower()
    picked = []
    for key, g in groups.items():
        if decided.get(key) != want:
            continue
        if needle and needle not in key and not any(needle in n.lower() for n in g["names"]):
            continue
        picked.append(g)
    picked.sort(key=lambda g: (-len(g["papers"]), g["key"]))
    page = picked[offset: offset + limit]
    index = _NameIndex(_people()) if page else None
    out = []
    for g in page:
        names = sorted(g["names"], key=lambda n: -g["names"][n])
        cands = []
        seen = set()
        for n in names[:3]:
            for score, u in index.candidates(n):
                if u.id not in seen:
                    seen.add(u.id)
                    cands.append({**_person(u), "score": round(score, 2)})
        cands.sort(key=lambda c: -c["score"])
        out.append({"key": g["key"], "names": names[:6], "papers": len(g["papers"]),
                    "authorships": sum(g["names"].values()), "suggestions": cands[:4]})
    return {"total": len(picked), "items": out,
            "counts": {s: sum(1 for k in groups if decided.get(k) == v)
                       for s, v in (("open", None), ("ambiguous", AuthorAlias.AMBIGUOUS), ("hidden", AuthorAlias.NOT_ROSTER))}}


def _rows_for(key: str):
    ids = [a_id for a_id, n in Authorship.objects.filter(is_college=True, user__isnull=True)
           .values_list("id", "display_name") if name_key(n) == key]
    return Authorship.objects.filter(id__in=ids)


def decide(key: str, status: str, *, actor: User, user_id: str | None = None) -> dict[str, Any]:
    """Record a decision on one name. MATCHED needs `user_id` and links the rows now."""
    key = (key or "").strip()
    if not key:
        raise ReviewError("Which name?")
    if status not in dict(AuthorAlias.STATUSES):
        raise ReviewError("Unknown decision.")
    user = None
    if status == AuthorAlias.MATCHED:
        user = User.objects.filter(id=user_id, active=True).first()
        if not user:
            raise ReviewError("Pick an active account to link this name to.")
    rows = _rows_for(key)
    sample = rows.values_list("display_name", flat=True).first() or ""
    with transaction.atomic():
        alias, _ = AuthorAlias.objects.update_or_create(
            name_key=key, defaults={"status": status, "user": user, "decided_by": actor,
                                    **({"sample_name": sample[:255]} if sample else {})})
        linked = 0
        if user:
            # One person once per paper: skip a paper they are already on.
            already = set(Authorship.objects.filter(user=user).values_list("publication_id", flat=True))
            for row in rows:
                if row.publication_id in already:
                    continue
                row.user, row.match_confidence, row.match_method, row.match_locked = user, 1.0, "manual", True
                row.save(update_fields=["user", "match_confidence", "match_method", "match_locked"])
                already.add(row.publication_id)
                linked += 1
        _audit(actor, f"AUTHOR_ALIAS_{status}", "AuthorAlias", alias.id,
               {"name_key": key, "sample": sample, "user_id": user.id if user else None, "linked": linked})
    if linked:
        refresh_metrics()
    return {"ok": True, "key": key, "status": status, "linked": linked}


def undo(key: str, *, actor: User) -> dict[str, Any]:
    alias = AuthorAlias.objects.filter(name_key=key).first()
    if not alias:
        raise ReviewError("Nothing was decided about that name.")
    _audit(actor, "AUTHOR_ALIAS_CLEARED", "AuthorAlias", alias.id,
           {"name_key": key, "status": alias.status, "user_id": alias.user_id})
    alias.delete()
    return {"ok": True}


# --------------------------------------------------------------------------- duplicate accounts

def duplicate_accounts() -> list[dict[str, Any]]:
    """Active accounts that share a normalised name, with what each carries."""
    by_key: dict[str, list[User]] = {}
    for u in User.objects.filter(active=True).exclude(role="SUPER_ADMIN"):
        k = name_key(u.name)
        if k:
            by_key.setdefault(k, []).append(u)
    groups = [us for us in by_key.values() if len(us) > 1]
    ids = [u.id for us in groups for u in us]
    claims = dict(Claim.objects.filter(owner_id__in=ids).values("owner_id").annotate(n=Count("id")).values_list("owner_id", "n"))
    papers = dict(Authorship.objects.filter(user_id__in=ids).values("user_id").annotate(n=Count("id")).values_list("user_id", "n"))
    out = []
    for us in sorted(groups, key=lambda us: us[0].name.lower()):
        accounts = [{**_person(u), "role": u.role, **{f: getattr(u, f) for f in IDENTITY},
                     "claims": claims.get(u.id, 0), "papers": papers.get(u.id, 0),
                     "last_login": u.last_login.isoformat() if u.last_login else None} for u in us]
        out.append({"key": name_key(us[0].name), "accounts": accounts,
                    "conflicts": _conflicts(us)})
    return out


def _conflicts(users: list[User]) -> list[str]:
    bad = []
    for f in IDENTITY:
        vals = {(getattr(u, f) or "").strip() for u in users} - {""}
        if len(vals) > 1:
            bad.append(f)
    return bad


def merge_accounts(keep_id: str, drop_id: str, *, actor: User, confirm: bool = False) -> dict[str, Any]:
    if keep_id == drop_id:
        raise ReviewError("Pick two different accounts.")
    keep = User.objects.filter(id=keep_id).first()
    drop = User.objects.filter(id=drop_id).first()
    if not keep or not drop:
        raise ReviewError("One of those accounts no longer exists.")
    if not drop.active:
        raise ReviewError("That account was already merged or switched off.")
    conflicts = _conflicts([keep, drop])
    if conflicts and not confirm:
        return {"ok": False, "needs_confirm": True, "conflicts": conflicts}
    moved: dict[str, Any] = {}
    with transaction.atomic():
        moved["claims"] = Claim.objects.filter(owner=drop).update(owner=keep)
        # Authorships: one person once per paper.
        mine = set(Authorship.objects.filter(user=keep).values_list("publication_id", flat=True))
        dup = Authorship.objects.filter(user=drop, publication_id__in=mine)
        moved["authorships_dropped_as_duplicate"] = dup.update(user=None, match_confidence=0, match_method="", match_locked=False)
        moved["authorships"] = Authorship.objects.filter(user=drop).update(user=keep)
        # Follows, both directions, without breaking the once-only rule.
        n = 0
        for f in Follow.objects.filter(follower=drop):
            clash = Follow.objects.filter(follower=keep, person=f.person, department=f.department,
                                          topic=f.topic, journal=f.journal).exists()
            if clash or f.person_id == keep.id:
                f.delete()
            else:
                f.follower = keep
                f.save(update_fields=["follower"])
                n += 1
        for f in Follow.objects.filter(person=drop):
            if f.follower_id == keep.id or Follow.objects.filter(follower_id=f.follower_id, person=keep).exists():
                f.delete()
            else:
                f.person = keep
                f.save(update_fields=["person"])
                n += 1
        moved["follows"] = n
        moved["aliases"] = AuthorAlias.objects.filter(user=drop).update(user=keep)
        # Ledger rows are tied by staff / biometric id; re-point the dropped ids.
        ledger = 0
        for f in ("staff_id", "biometric_id"):
            old, new = (getattr(drop, f) or "").strip(), (getattr(keep, f) or "").strip()
            if old and new and old != new:
                ledger += PaidLedger.objects.filter(**{f: old}).update(**{f: new})
        moved["ledger_rows"] = ledger
        # Blank identity fields on the kept account are inherited.
        inherited = {}
        for f in IDENTITY:
            if not (getattr(keep, f) or "").strip() and (getattr(drop, f) or "").strip():
                inherited[f] = getattr(drop, f)
        before = {f: getattr(drop, f) for f in IDENTITY}
        drop.active = False
        if drop.employee_id:
            drop.employee_id = None  # unique; may be inherited below
        drop.save(update_fields=["active", "employee_id", "updated_at"])
        for f, v in inherited.items():
            setattr(keep, f, v)
        if inherited:
            keep.save(update_fields=[*inherited, "updated_at"])
        moved["inherited"] = sorted(inherited)
        _audit(actor, "ACCOUNT_MERGED", "User", keep.id,
               {"kept": _person(keep), "dropped": _person(drop), "dropped_identity": before,
                "conflicts_confirmed": conflicts, "moved": moved})
    refresh_metrics()
    return {"ok": True, "moved": moved}
