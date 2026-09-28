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


def _people(data: Any, out: list[dict]) -> None:
    if isinstance(data, dict):
        uid = data.get("user_id")
        if isinstance(uid, str) and uid and any(k in data for k in _NAME_KEYS) \
                and ("photo_url" not in data or "initials" not in data):
            out.append(data)
        for v in data.values():
            if isinstance(v, (dict, list, tuple)):
                _people(v, out)
    elif isinstance(data, (list, tuple)):
        for v in data:
            if isinstance(v, (dict, list, tuple)):
                _people(v, out)


def fill(data: Any) -> Any:
    """Add `photo_url` and `initials` to every person dict in `data`, in place."""
    from core.models import User
    from core.social import initials

    found: list[dict] = []
    _people(data, found)
    if not found:
        return data
    photos = dict(User.objects.filter(id__in={d["user_id"] for d in found})
                  .exclude(photo="").exclude(photo__isnull=True).values_list("id", "photo"))
    for d in found:
        if "photo_url" not in d:
            p = photos.get(d["user_id"])
            d["photo_url"] = f"{settings.MEDIA_URL}{p}" if p else None
        if "initials" not in d:
            d["initials"] = initials(next((d[k] for k in _NAME_KEYS if d.get(k)), ""))
    return data
