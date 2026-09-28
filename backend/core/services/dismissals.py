"""Discover "Not interested": which feed ids a person has set aside, and the
suggestion lists with those removed. Ids match research_picture.for_you."""

from __future__ import annotations

from typing import Any

from core.models import DiscoverDismissal


def _fold(text: str) -> str:
    return " ".join((text or "").lower().split())


def dismissed_keys(user) -> set[str]:
    return set(DiscoverDismissal.objects.filter(user=user).values_list("key", flat=True))


def without_dismissed(next_things: dict[str, Any], gone: set[str]) -> dict[str, Any]:
    if not gone:
        return next_things
    out = dict(next_things)
    out["people"] = [p for p in next_things.get("people", []) if f"person:{p.get('id')}" not in gone]
    out["journals"] = [j for j in next_things.get("journals", []) if f"venue:{_fold(j.get('title', ''))}" not in gone]
    out["topics"] = [t for t in next_things.get("topics", []) if f"topic:{_fold(t.get('area', ''))}" not in gone]
    return out
