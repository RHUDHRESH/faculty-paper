"""Leaderboard weights: how the overall score is made, who set it, and the history.

The overall score is a sum over factors of

    weight (percent) x the person's percentile on that factor

so it runs from 0 to 100 and a factor with weight 0 does not matter.

Normalisation, the same for every factor: a person's **percentile** is the
share of the people in the scope (the college, or the department chosen) whose
figure is the same as theirs or lower, times 100. The top person, and anybody
tied with them, gets 100; somebody with nothing on that factor gets 0 however
many others also have nothing. Percentiles use rank, not size, so papers,
citations, SNIP and years can sit on one scale and one huge figure cannot
drown the rest. A factor with no figure for a person (first-author share on a
paper with no author order) counts as nothing, not as a guess.

Every figure comes from the Scopus-linked papers on the person's record
(`core.services.honours_board`); nothing here reads a claim, the paid ledger or
money. Each factor's points are rounded to two places and the score is their
sum, so the breakdown always adds up to the score shown.

Storage needs no migration: one `SystemSetting` row ("leaderboard_weights")
holds every saved version, newest last. A save appends {version, weights, note,
saved_by, saved_at, applies_from}; a reset appends the default as a new version.
"""

from __future__ import annotations

import json
from bisect import bisect_right
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable, Mapping, Optional

from django.db import transaction
from django.utils import timezone

from core.models import AuditLog, SystemSetting, User

SETTING_KEY = "leaderboard_weights"
#: Versions kept. Far more than anybody will save; it only bounds the row.
KEEP_VERSIONS = 200
NOTE_MAX = 500
CONSISTENCY_MONTHS = 24
RECENT_DAYS = 365
YEAR_DAYS = 365.25


@dataclass(frozen=True)
class Factor:
    key: str
    name: str
    meaning: str
    default: int


FACTORS: tuple[Factor, ...] = (
    Factor("snip", "Cumulative SNIP",
           "The SNIP of the journal of each paper, added up. A journal's SNIP is read from the journal tables by ISSN and year.", 25),
    Factor("papers", "Papers",
           "How many Scopus-linked papers you have in the period.", 15),
    Factor("q1q2", "Q1 and Q2 papers",
           "How many of your papers are in a Q1 or Q2 journal.", 20),
    Factor("citations", "Citations",
           "Scopus citations of your papers, added up.", 10),
    Factor("h_index", "h-index",
           "The largest h for which h of your papers have at least h Scopus citations each.", 10),
    Factor("span", "Publishing span",
           "Years between your first and your latest paper at the college.", 5),
    Factor("consistency", "Consistency",
           "The share of the last 24 months in which you had at least one paper.", 5),
    Factor("recent", "Recent output",
           "Papers in the last 12 months.", 5),
    Factor("author_role", "First or corresponding author",
           "The share of your papers where you are first or corresponding author. Papers with no author order on record are left out.", 5),
    Factor("fyp", "Student projects mentored",
           "Final-year project papers from teams you mentor, found in Scopus.", 0),
)
KEYS = tuple(f.key for f in FACTORS)
DEFAULTS: dict[str, int] = {f.key: f.default for f in FACTORS}

NORMALISATION = (
    "Each factor is turned into a percentile among the people on the board: the share of people "
    "with the same figure or less. The score is the weights, as percents, times those percentiles, "
    "so it runs from 0 to 100."
)
SOURCE = "Counted from Scopus-linked papers only"


# --------------------------------------------------------------------------- #
# Validation                                                                  #
# --------------------------------------------------------------------------- #


class WeightsError(ValueError):
    """The words go straight to the person who sent the weights."""


def clean(weights: Any) -> dict[str, int]:
    """Every factor, as a whole number from 0 to 100, adding up to 100."""
    if not isinstance(weights, Mapping):
        raise WeightsError("Send one weight for each factor.")
    unknown = [k for k in weights if k not in KEYS]
    if unknown:
        raise WeightsError(f"There is no factor called {str(unknown[0])[:40]}.")
    out: dict[str, int] = {}
    for key in KEYS:
        v = weights.get(key, 0)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v):
            raise WeightsError("Each weight must be a whole number from 0 to 100.")
        v = int(v)
        if not 0 <= v <= 100:
            raise WeightsError("Each weight must be a whole number from 0 to 100.")
        out[key] = v
    if sum(out.values()) != 100:
        raise WeightsError("Weights must add up to 100")
    return out


def clean_note(note: Any) -> str:
    text = " ".join(str(note or "").split())
    if not text:
        raise WeightsError("Say why you are changing the weights.")
    if len(text) > NOTE_MAX:
        raise WeightsError(f"Keep the note under {NOTE_MAX} characters.")
    return text


# --------------------------------------------------------------------------- #
# Storage: one SystemSetting row, versioned                                   #
# --------------------------------------------------------------------------- #


def _default_entry() -> dict[str, Any]:
    return {
        "version": 0, "weights": dict(DEFAULTS), "note": "The college's starting weights.",
        "saved_by": None, "saved_at": None, "applies_from": None,
    }


def _versions() -> list[dict[str, Any]]:
    row = SystemSetting.objects.filter(key=SETTING_KEY).first()
    value = row.value if row and isinstance(row.value, dict) else {}
    versions = value.get("versions")
    return [v for v in versions if isinstance(v, dict)] if isinstance(versions, list) else []


def current() -> dict[str, Any]:
    versions = _versions()
    if not versions:
        return _default_entry()
    last = versions[-1]
    try:
        return {**last, "weights": clean(last.get("weights"))}
    except WeightsError:
        # A hand-edited row that no longer adds up must not break the board.
        return _default_entry()


def history() -> list[dict[str, Any]]:
    """Every saved version, newest first. The starting weights are not a save."""
    return list(reversed(_versions()))


def _audit(user: User, action: str, entry: dict[str, Any]) -> None:
    # The version and the weights only. The note is free text and stays in the
    # setting, not in the log.
    AuditLog.objects.create(
        actor=user, action=action, entity="leaderboard_weights", entity_id=str(entry["version"]),
        detail_json=json.dumps({"version": entry["version"], "weights": entry["weights"]}),
    )


def _append(user: User, weights: dict[str, int], note: str, action: str) -> dict[str, Any]:
    with transaction.atomic():
        row = SystemSetting.objects.select_for_update().filter(key=SETTING_KEY).first()
        versions = (row.value.get("versions") if row and isinstance(row.value, dict) else None) or []
        now = timezone.now().isoformat()
        entry = {
            "version": (versions[-1]["version"] + 1) if versions else 1,
            "weights": weights, "note": note,
            "saved_by": {"id": user.pk, "name": user.name or "A colleague"},
            "saved_at": now,
            # Weights apply from the moment they are saved; nothing is back-dated.
            "applies_from": now,
        }
        versions = [*versions, entry][-KEEP_VERSIONS:]
        SystemSetting.objects.update_or_create(
            key=SETTING_KEY, defaults={"value": {"versions": versions}, "updated_by": user}
        )
        _audit(user, action, entry)
    return entry


def save(user: User, weights: Any, note: Any) -> dict[str, Any]:
    return _append(user, clean(weights), clean_note(note), "LEADERBOARD_WEIGHTS_SAVE")


def reset(user: User) -> dict[str, Any]:
    return _append(user, dict(DEFAULTS), "Reset to the college's starting weights.", "LEADERBOARD_WEIGHTS_RESET")


def catalogue() -> list[dict[str, Any]]:
    return [{"key": f.key, "name": f.name, "meaning": f.meaning, "default": f.default} for f in FACTORS]


def describe(weights: dict[str, int]) -> list[dict[str, Any]]:
    """The factors with a weight, for the page's "How the leaderboard is scored"."""
    return [
        {"key": f.key, "name": f.name, "meaning": f.meaning, "weight": weights[f.key]}
        for f in FACTORS if weights.get(f.key)
    ]


# --------------------------------------------------------------------------- #
# The score                                                                   #
# --------------------------------------------------------------------------- #


def percentiles(values: Mapping[str, Optional[float]]) -> dict[str, float]:
    """Each key's share of the keys with the same figure or less, times 100.

    Nothing (None, zero or less) is 0 whoever else has nothing.
    """
    n = len(values)
    snapped = {k: round(v, 9) if v and v > 0 else 0.0 for k, v in values.items()}
    ordered = sorted(snapped.values())
    return {k: (100.0 * bisect_right(ordered, v) / n if v > 0 else 0.0) for k, v in snapped.items()}


def metrics(
    *, tally: Mapping[str, Any], now_papers: list, all_papers: list, mentored: list, anchor: date, uid: str,
) -> dict[str, Optional[float]]:
    """One person's figure on each factor.

    `tally` is the period's count (honours_board._tally); `now_papers` the
    Scopus-linked papers in the period; `all_papers` everything of theirs up to
    the end of the period, for the three factors that look at dates.
    """
    dated = [p.when for p in all_papers if p.when is not None and p.when <= anchor]
    span_years = (max(dated) - min(dated)).days / YEAR_DAYS if len(dated) > 1 else 0.0

    first_month = (anchor.year * 12 + anchor.month - 1) - (CONSISTENCY_MONTHS - 1)
    months = {d.year * 12 + d.month - 1 for d in dated if d.year * 12 + d.month - 1 >= first_month}
    recent_from = anchor - timedelta(days=RECENT_DAYS)

    known = [p for p in now_papers if p.members.get(uid) is not None or uid in p.corresponding]
    hits = sum(1 for p in known if p.members.get(uid) == 1 or uid in p.corresponding)

    return {
        "snip": sum(p.snip for p in now_papers if p.snip),
        "papers": tally["papers"],
        "q1q2": tally["breakdown"]["q1"] + tally["breakdown"]["q2"],
        "citations": tally["cited"],
        "h_index": tally["h_index"],
        "span": span_years,
        "consistency": len(months) / CONSISTENCY_MONTHS,
        "recent": sum(1 for d in dated if d > recent_from),
        "author_role": (hits / len(known)) if known else None,
        "fyp": len(mentored),
    }


def score_all(
    figures: Mapping[str, Mapping[str, Optional[float]]], weights: Mapping[str, int]
) -> dict[str, dict[str, Any]]:
    """uid -> {"score", "parts": {factor: points}} for everybody in the scope."""
    active = [k for k in KEYS if weights.get(k)]
    pct = {k: percentiles({u: figures[u].get(k) for u in figures}) for k in active}
    out: dict[str, dict[str, Any]] = {}
    for uid in figures:
        parts = {k: round(weights[k] / 100 * pct[k][uid], 2) for k in active}
        out[uid] = {"score": round(sum(parts.values()), 2), "parts": parts}
    return out


def contributions(parts: Mapping[str, float]) -> list[dict[str, Any]]:
    return [{"factor": k, "points": parts[k]} for k in KEYS if k in parts]


def fingerprint(weights: Mapping[str, int]) -> str:
    return ",".join(f"{k}={weights.get(k, 0)}" for k in KEYS)


__all__ = [
    "FACTORS", "KEYS", "DEFAULTS", "WeightsError", "clean", "clean_note", "current", "history", "save",
    "reset", "catalogue", "describe", "percentiles", "metrics", "score_all", "contributions", "fingerprint",
    "NORMALISATION", "SOURCE",
]
