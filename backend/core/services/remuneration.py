from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

DEFAULT_AUTHOR_POINTS: dict[str, Any] = {
    "1": 1,
    "2": [0.7, 0.3],
    "3": [0.5, 0.3, 0.2],
    "4": [0.4, 0.3, 0.2, 0.1],
    "5": [0.35, 0.25, 0.2, 0.1, 0.1],
    "default": 1,
}

DEFAULT_PUB_TYPE_MULTIPLIERS: dict[str, float] = {
    "Journal": 1.0,
    "Conference Proceeding": 1.0,
    "Book Series": 1.0,
    "Other": 1.0,
}


@dataclass
class FormulaConfigInput:
    snip_multiplier: float = 55000
    snip_cap: float = 30
    qf_q1: float = 50000
    qf_q2: float = 30000
    qf_q3: float = 15000
    qf_q4: float = 5000
    qf_no_snip: float = 0
    qf_snip_only: float = 0
    qf_others: float = 4000
    author_points: dict[str, Any] | None = None
    publication_type_multipliers: dict[str, float] = field(
        default_factory=lambda: dict(DEFAULT_PUB_TYPE_MULTIPLIERS)
    )
    student_remuneration_zero: bool = True
    qf_only_for_no_snip: bool = True
    name: str = "Policy v1"
    version: int = 1

    def __post_init__(self):
        if self.author_points is None:
            self.author_points = dict(DEFAULT_AUTHOR_POINTS)
        if not self.publication_type_multipliers:
            self.publication_type_multipliers = dict(DEFAULT_PUB_TYPE_MULTIPLIERS)


@dataclass
class CalcResult:
    base: float | None
    point: float | None
    remuneration: float | None
    qf: float | None
    error: str | None


def round2(n: float) -> float:
    return round(n * 100) / 100


def qf_for(quartile: str, cfg: FormulaConfigInput) -> float:
    q = (quartile or "").strip()
    mapping = {
        "Q1": cfg.qf_q1,
        "Q2": cfg.qf_q2,
        "Q3": cfg.qf_q3,
        "Q4": cfg.qf_q4,
        "NO_SNIP": cfg.qf_no_snip,
        "SNIP_ONLY": cfg.qf_snip_only,
        "Others": cfg.qf_others,
        "OTHERS": cfg.qf_others,
        "No Quartile": cfg.qf_others,
    }
    return mapping.get(q, cfg.qf_others if q else 0)


def author_point(
    total_authors: int, author_position: int, cfg: FormulaConfigInput | None = None
) -> tuple[float | None, str | None]:
    cfg = cfg or FormulaConfigInput()
    if not isinstance(total_authors, int) or total_authors < 1:
        return None, "Total authors must be an integer >= 1"
    if not isinstance(author_position, int) or author_position < 1:
        return None, "Author position must be an integer >= 1"
    if author_position > total_authors:
        return None, "Author position cannot exceed total authors"

    points = cfg.author_points or DEFAULT_AUTHOR_POINTS
    key = str(total_authors)
    rule = points.get(key, points.get("default", 1))

    if isinstance(rule, (int, float)):
        if key not in points and total_authors > 1:
            return 1 / total_authors, None
        return float(rule), None

    idx = author_position - 1
    if idx >= len(rule):
        return None, f"No author-point rule for position {author_position} of {total_authors}"
    return float(rule[idx]), None


def _pub_multiplier(publication_type: str | None, cfg: FormulaConfigInput) -> float:
    if not publication_type:
        return 1.0
    key = publication_type.strip()
    mults = cfg.publication_type_multipliers or DEFAULT_PUB_TYPE_MULTIPLIERS
    if key in mults:
        return float(mults[key])
    # fuzzy: conference
    lower = key.lower()
    for k, v in mults.items():
        if k.lower() == lower:
            return float(v)
    if "conference" in lower:
        return float(mults.get("Conference Proceeding", 1.0))
    return 1.0


def calculate_remuneration(
    snip: float | None,
    quartile: str | None,
    total_authors: int,
    author_position: int,
    cfg: FormulaConfigInput | None = None,
    *,
    is_student_publication: bool = False,
    publication_type: str | None = None,
) -> CalcResult:
    cfg = cfg or FormulaConfigInput()
    if is_student_publication and cfg.student_remuneration_zero:
        qf = qf_for(quartile or "Others", cfg)
        return CalcResult(round2(qf), 0.0, 0.0, qf, None)

    if not quartile:
        return CalcResult(None, None, None, None, "Quartile is required")

    qf = qf_for(quartile, cfg)
    point, point_error = author_point(total_authors, author_position, cfg)
    if point_error or point is None:
        return CalcResult(None, None, None, qf, point_error)

    pub_m = _pub_multiplier(publication_type, cfg)

    if quartile in ("NO_SNIP", "Others", "OTHERS", "No Quartile"):
        if cfg.qf_only_for_no_snip and (quartile == "NO_SNIP" or snip is None):
            base = qf * pub_m
            return CalcResult(round2(base), point, round2(base * point), qf, None)

    if snip is None:
        if quartile == "SNIP_ONLY":
            return CalcResult(None, point, None, qf, "SNIP is required for SNIP Only mode")
        base = qf * pub_m
        return CalcResult(round2(base), point, round2(base * point), qf, None)

    snip_num = float(snip)
    if snip_num < 0:
        return CalcResult(None, point, None, qf, "SNIP cannot be negative")
    cap = float(cfg.snip_cap or 30)
    if snip_num > cap:
        return CalcResult(None, point, None, qf, f"SNIP value looks invalid (max {cap:g})")

    base = (snip_num * cfg.snip_multiplier + qf) * pub_m
    return CalcResult(round2(base), point, round2(base * point), qf, None)


def formula_from_model(obj) -> FormulaConfigInput:
    try:
        points = json.loads(obj.author_point_json)
    except Exception:
        points = DEFAULT_AUTHOR_POINTS
    try:
        pub_m = json.loads(
            getattr(obj, "publication_type_multipliers_json", None)
            or json.dumps(DEFAULT_PUB_TYPE_MULTIPLIERS)
        )
    except Exception:
        pub_m = dict(DEFAULT_PUB_TYPE_MULTIPLIERS)
    return FormulaConfigInput(
        snip_multiplier=obj.snip_multiplier,
        snip_cap=float(getattr(obj, "snip_cap", 30) or 30),
        qf_q1=obj.qf_q1,
        qf_q2=obj.qf_q2,
        qf_q3=obj.qf_q3,
        qf_q4=obj.qf_q4,
        qf_no_snip=obj.qf_no_snip,
        qf_snip_only=obj.qf_snip_only,
        qf_others=getattr(obj, "qf_others", 4000) or 4000,
        author_points=points,
        publication_type_multipliers={k: float(v) for k, v in (pub_m or {}).items()},
        student_remuneration_zero=bool(getattr(obj, "student_remuneration_zero", True)),
        qf_only_for_no_snip=bool(getattr(obj, "qf_only_for_no_snip", True)),
        name=getattr(obj, "name", None) or "Policy v1",
        version=int(getattr(obj, "version", 1) or 1),
    )


def snapshot_formula(cfg: FormulaConfigInput) -> dict[str, Any]:
    return {
        "name": cfg.name,
        "version": cfg.version,
        "snip_multiplier": cfg.snip_multiplier,
        "snip_cap": cfg.snip_cap,
        "qf_q1": cfg.qf_q1,
        "qf_q2": cfg.qf_q2,
        "qf_q3": cfg.qf_q3,
        "qf_q4": cfg.qf_q4,
        "qf_no_snip": cfg.qf_no_snip,
        "qf_snip_only": cfg.qf_snip_only,
        "qf_others": cfg.qf_others,
        "author_points": cfg.author_points,
        "publication_type_multipliers": cfg.publication_type_multipliers,
        "student_remuneration_zero": cfg.student_remuneration_zero,
        "qf_only_for_no_snip": cfg.qf_only_for_no_snip,
    }


def format_inr(amount: float | None) -> str:
    if amount is None:
        return "—"
    return f"₹{amount:,.2f}"
