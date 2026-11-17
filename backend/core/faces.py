"""Faces on every person the API returns.

Many endpoints describe a colleague as a small dict -- `{"user_id", "name",
...}` -- built by hand, and most of them forgot the photo, so half the app
drew initials (or "?") for people whose picture is on file. Rather than patch
each builder and miss the next one, the renderer runs `fill` on the way out:
every dict with a string `user_id` and a `name` gets `photo_url` and
`initials` when it lacks them, from one query per response.
"""
from __future__ import annotations

from typing import Any

from django.conf import settings

_NAME_KEYS = ("name", "display_name")


def _uid(d: dict) -> str | None:
    """The user this dict describes: `user_id`, or -- for person-shaped dicts
    keyed by `id` (a name plus a department or designation) -- `id`."""
    uid = d.get("user_id")
    if isinstance(uid, str) and uid:
        return uid
    if isinstance(d.get("id"), str) and "name" in d and ("department" in d or "designation" in d):
        return d["id"]
    return None


def _people(data: Any, out: list[dict]) -> None:
    if isinstance(data, dict):
        if _uid(data) and any(k in data for k in _NAME_KEYS) \
                and ("photo_url" not in data or "initials" not in data):
            out.append(data)
        for v in data.values():
            if isinstance(v, (dict, list, tuple)):
                _people(v, out)
    elif isinstance(data, (list, tuple)):
        for v in data:
            if isinstance(v, (dict, list, tuple)):
                _people(v, out)


#: A person named by a pair of keys rather than by a nested dict:
#: (id key, name key, prefix for the photo and initials keys). Claims name
#: their claimant `owner_*`, a post names its writer `author_*`, and a thread
#: names whoever opened it `created_by*`.
_PAIRS = (
    ("owner_id", "owner_name", "owner"),
    ("author_id", "author_name", "author"),
    ("created_by_id", "created_by", "created_by"),
)


def _owners(data: Any, out: list[tuple[dict, str, str, str]]) -> None:
    if isinstance(data, dict):
        for id_key, name_key, prefix in _PAIRS:
            if (
                isinstance(data.get(id_key), str)
                and isinstance(data.get(name_key), (str, type(None)))
                and name_key in data
                and f"{prefix}_photo_url" not in data
            ):
                out.append((data, id_key, name_key, prefix))
        for v in data.values():
            if isinstance(v, (dict, list, tuple)):
                _owners(v, out)
    elif isinstance(data, (list, tuple)):
        for v in data:
            if isinstance(v, (dict, list, tuple)):
                _owners(v, out)


def _unidentified(data: Any) -> None:
    """Say "Claimant not identified" where the person is the import's "Not Found".

    The old workbooks' "Not Found" owns claims nobody could be matched to. It
    is not a person and not a department, so no response may print it as
    either; the claims stay, named for what they are. Lists of people leave the
    account out at the source (`core.services.placeholders`); this is the
    net under every claim-shaped dict that names its claimant.
    """
    from core.services import placeholders

    if isinstance(data, dict):
        for _id_key, name_key, prefix in _PAIRS[:1]:
            if name_key in data and isinstance(data.get(name_key), str) and placeholders.is_placeholder_name(data[name_key]):
                data[name_key] = placeholders.UNIDENTIFIED
                dept_key = f"{prefix}_department"
                if dept_key in data and placeholders.is_not_a_department(data[dept_key]):
                    data[dept_key] = None
        if _uid(data) and isinstance(data.get("name"), str) and placeholders.is_placeholder_name(data["name"]):
            data["name"] = placeholders.UNIDENTIFIED
            if "department" in data and placeholders.is_not_a_department(data["department"]):
                data["department"] = None
        for v in data.values():
            if isinstance(v, (dict, list, tuple)):
                _unidentified(v)
    elif isinstance(data, (list, tuple)):
        for v in data:
            if isinstance(v, (dict, list, tuple)):
                _unidentified(v)


def fill(data: Any) -> Any:
    """Add `photo_url` and `initials` to every person dict in `data`, and
    `owner_photo_url` (or `author_`, `created_by_`) to every claim, post and
    thread, in place."""
    from core.models import User
    from core.social import initials

    _unidentified(data)
    owners: list[tuple[dict, str, str, str]] = []
    _owners(data, owners)
    if owners:
        photos = dict(User.objects.filter(id__in={d[id_key] for d, id_key, _n, _p in owners})
                      .exclude(photo="").exclude(photo__isnull=True).values_list("id", "photo"))
        for d, id_key, name_key, prefix in owners:
            p = photos.get(d[id_key])
            d[f"{prefix}_photo_url"] = f"{settings.MEDIA_URL}{p}" if p else None
            d.setdefault(f"{prefix}_initials", initials(d.get(name_key) or ""))

    found: list[dict] = []
    _people(data, found)
    if not found:
        return data
    ids = {_uid(d) for d in found}
    photos = dict(User.objects.filter(id__in=ids).values_list("id", "photo"))
    for d in found:
        uid = _uid(d)
        if "user_id" not in d and uid not in photos:
            continue  # an `id` that is not a person (a department, a journal)
        if "photo_url" not in d:
            p = photos.get(uid)
            d["photo_url"] = f"{settings.MEDIA_URL}{p}" if p else None
        if "initials" not in d:
            d["initials"] = initials(next((d[k] for k in _NAME_KEYS if d.get(k)), ""))
    return data
