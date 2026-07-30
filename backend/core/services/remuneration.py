from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

DEFAULT_AUTHOR_POINTS: dict[str, Any] = {
    "1": 1,
    "2": [0.7, 0.3],
    "3": [0.5, 0.3, 0.2],
    "4": [0.4, 0.3, 0.2, 0.1],
    "5": [0.35, 0.25, 0.2, 0.1, 0.1],
    "default": 1,
}


@dataclass
class FormulaConfigInput:
    snip_multiplier: float = 55000
    qf_q1: float = 50000
    qf_q2: float = 30000
    qf_q3: float = 15000
    qf_q4: float = 5000
    qf_no_snip: float = 0
    qf_snip_only: float = 0
    qf_others: float = 4000
    author_points: dict[str, Any] | None = None

    def __post_init__(self):
        if self.author_points is None:
            self.author_points = dict(DEFAULT_AUTHOR_POINTS)


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


def calculate_remuneration(
    snip: float | None,
    quartile: str | None,
    total_authors: int,
    author_position: int,
    cfg: FormulaConfigInput | None = None,
    *,
    is_student_publication: bool = False,
) -> CalcResult:
    cfg = cfg or FormulaConfigInput()
    if is_student_publication:
        qf = qf_for(quartile or "Others", cfg)
        return CalcResult(round2(qf), 0.0, 0.0, qf, None)

    if not quartile:
        return CalcResult(None, None, None, None, "Quartile is required")

    qf = qf_for(quartile, cfg)
    point, point_error = author_point(total_authors, author_position, cfg)
    if point_error or point is None:
        return CalcResult(None, None, None, qf, point_error)

    if quartile in ("NO_SNIP", "Others", "OTHERS", "No Quartile"):
        # Accounts sheet: conferences often use QF only (SNIP N/A)
        if quartile == "NO_SNIP" or snip is None:
            base = qf
            return CalcResult(round2(base), point, round2(base * point), qf, None)

    if snip is None:
        if quartile == "SNIP_ONLY":
            return CalcResult(None, point, None, qf, "SNIP is required for SNIP Only mode")
        # Others with no SNIP
        base = qf
        return CalcResult(round2(base), point, round2(base * point), qf, None)

    snip_num = float(snip)
    if snip_num < 0:
        return CalcResult(None, point, None, qf, "SNIP cannot be negative")
    # Hard cap — real SNIP values are typically well under 20
    if snip_num > 30:
        return CalcResult(None, point, None, qf, "SNIP value looks invalid (max 30)")

    base = snip_num * cfg.snip_multiplier + qf
    return CalcResult(round2(base), point, round2(base * point), qf, None)


def formula_from_model(obj) -> FormulaConfigInput:
    try:
        points = json.loads(obj.author_point_json)
    except Exception:
        points = DEFAULT_AUTHOR_POINTS
    return FormulaConfigInput(
        snip_multiplier=obj.snip_multiplier,
        qf_q1=obj.qf_q1,
        qf_q2=obj.qf_q2,
        qf_q3=obj.qf_q3,
        qf_q4=obj.qf_q4,
        qf_no_snip=obj.qf_no_snip,
        qf_snip_only=obj.qf_snip_only,
        qf_others=getattr(obj, "qf_others", 4000) or 4000,
        author_points=points,
    )


def format_inr(amount: float | None) -> str:
    if amount is None:
        return "—"
    return f"₹{amount:,.2f}"
