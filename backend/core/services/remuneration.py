"""Faculty publication remuneration, per the Publication Processing Workflow.

Step 8 of that document defines four mutually exclusive categories:

  I    Scopus-indexed, valid SNIP        [(SNIP x 55000) + QFA] x APP
  II   Scopus journal, no SNIP           5000 x APP
  III  Scopus conference/book, no SNIP   4000 x APP
  IV   Web of Science (SCIE/ESCI), not in Scopus   [5000 + QFA] x APP

QFA is the additional quartile incentive, payable only on Engineering journals.
APP is the author-position weightage; nine authors is the ceiling and a
publication with more is not eligible at all.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

#: Author Position Points. Row = total authors, column = position (1-indexed).
#: Straight from the policy's Author Position Weightage Table.
DEFAULT_AUTHOR_POINTS: dict[str, Any] = {
    "1": [1],
    "2": [0.6, 0.4],
    "3": [0.5, 0.3, 0.2],
    "4": [0.4, 0.3, 0.2, 0.1],
    "5": [0.3, 0.25, 0.2, 0.15, 0.1],
    "6": [0.275, 0.225, 0.2, 0.15, 0.1, 0.05],
    "7": [0.275, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05],
    "8": [0.25, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05, 0.025],
    "9": [0.225, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05, 0.03, 0.01],
}

#: "Publications with more than nine authors shall not be eligible."
MAX_ELIGIBLE_AUTHORS = 9

#: "a minimum of two (2) SEC-affiliated references ... to be considered eligible"
MIN_SEC_REFERENCES = 2

DEFAULT_PUB_TYPE_MULTIPLIERS: dict[str, float] = {
    "Journal": 1.0,
    "Conference Proceeding": 1.0,
    "Book Series": 1.0,
    "Other": 1.0,
}

#: Indexing labels that mean "in Scopus" / "in Web of Science Core Collection".
SCOPUS_LABELS = {"scopus"}
WOS_LABELS = {"sci", "scie", "esci", "web of science", "wos"}

#: Types the policy pays a book-chapter/conference rate for when SNIP is absent.
_CONFERENCE_OR_BOOK = ("conference", "book", "proceeding", "chapter")

ENGINEERING = "Engineering"
NON_ENGINEERING = "Non-Engineering"


class Category:
    SNIP = "I"
    JOURNAL_NO_SNIP = "II"
    OTHER_NO_SNIP = "III"
    WEB_OF_SCIENCE = "IV"
    NONE = "—"


CATEGORY_LABELS = {
    Category.SNIP: "Category I — Scopus indexed, with SNIP",
    Category.JOURNAL_NO_SNIP: "Category II — Scopus journal without SNIP",
    Category.OTHER_NO_SNIP: "Category III — Scopus conference or book chapter without SNIP",
    Category.WEB_OF_SCIENCE: "Category IV — Web of Science (SCIE/ESCI), not in Scopus",
    Category.NONE: "Not eligible for remuneration",
}


@dataclass
class FormulaConfigInput:
    snip_multiplier: float = 55000
    snip_cap: float = 30
    qf_q1: float = 50000
    qf_q2: float = 30000
    qf_q3: float = 15000
    #: The policy table says Q4 is 7,000.
    qf_q4: float = 7000
    qf_no_snip: float = 0
    qf_snip_only: float = 0
    qf_others: float = 4000
    #: Category II — a Scopus journal article with no SNIP.
    fixed_journal_no_snip: float = 5000
    #: Category III — a Scopus conference proceeding or book chapter, no SNIP.
    fixed_other_no_snip: float = 4000
    #: Category IV — the Web of Science base before QFA.
    fixed_web_of_science: float = 5000
    max_authors: int = MAX_ELIGIBLE_AUTHORS
    min_sec_references: int = MIN_SEC_REFERENCES
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
    #: Which of the policy's four categories was applied.
    category: str | None = None
    #: Plain reason the amount is what it is — especially when it is zero.
    note: str | None = None


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
    return mapping.get(q, 0.0)


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

    limit = int(cfg.max_authors or MAX_ELIGIBLE_AUTHORS)
    if total_authors > limit:
        return None, (
            f"Publications with more than {limit} authors are not eligible for remuneration"
        )

    points = cfg.author_points or DEFAULT_AUTHOR_POINTS
    rule = points.get(str(total_authors))
    if rule is None:
        return None, f"No author-point rule for {total_authors} authors"
    if isinstance(rule, (int, float)):
        return float(rule), None
    idx = author_position - 1
    if idx >= len(rule):
        return None, f"No author-point rule for position {author_position} of {total_authors}"
    return float(rule[idx]), None


def _labels(raw: str | None) -> set[str]:
    return {p.strip().lower() for p in str(raw or "").split(",") if p.strip()}


def is_scopus_indexed(indexing_level: str | None) -> bool:
    return bool(_labels(indexing_level) & SCOPUS_LABELS)


def is_web_of_science(indexing_level: str | None) -> bool:
    return bool(_labels(indexing_level) & WOS_LABELS)


def _is_conference_or_book(publication_type: str | None) -> bool:
    types = _labels(publication_type)
    return any(any(k in t for k in _CONFERENCE_OR_BOOK) for t in types)


def _is_journal(publication_type: str | None) -> bool:
    types = _labels(publication_type)
    return any("journal" in t for t in types) or not types


def _one_multiplier(key: str, cfg: FormulaConfigInput) -> float:
    mults = cfg.publication_type_multipliers or DEFAULT_PUB_TYPE_MULTIPLIERS
    if key in mults:
        return float(mults[key])
    lower = key.lower()
    for k, v in mults.items():
        if k.lower() == lower:
            return float(v)
    if "conference" in lower:
        return float(mults.get("Conference Proceeding", 1.0))
    return 1.0


def _pub_multiplier(publication_type: str | None, cfg: FormulaConfigInput) -> float:
    """Multiplier for the article's type, or types.

    An article can be filed under more than one type — a book chapter that is
    also a conference proceeding, say — so the field holds a comma-separated
    set. The best-qualifying one applies: the claimant should not lose money for
    describing their work more fully.
    """
    if not publication_type:
        return 1.0
    keys = [p.strip() for p in str(publication_type).split(",") if p.strip()]
    if not keys:
        return 1.0
    return max(_one_multiplier(k, cfg) for k in keys)


def calculate_remuneration(
    snip: float | None,
    quartile: str | None,
    total_authors: int,
    author_position: int,
    cfg: FormulaConfigInput | None = None,
    *,
    is_student_publication: bool = False,
    publication_type: str | None = None,
    indexing_level: str | None = None,
    engineering_class: str | None = None,
    sec_reference_count: int | None = None,
) -> CalcResult:
    """Apply the policy's Step 8 to one publication.

    `indexing_level` and `engineering_class` decide the category and whether the
    quartile incentive applies. `sec_reference_count` gates eligibility — pass
    None when it has not been checked yet so a draft estimate is still shown.
    """
    cfg = cfg or FormulaConfigInput()

    # Count-only and student-scheme filings are recorded, never paid.
    if is_student_publication and cfg.student_remuneration_zero:
        return CalcResult(
            0.0,
            0.0,
            0.0,
            0.0,
            None,
            Category.NONE,
            "Recorded for publication count only — no remuneration is payable.",
        )

    point, point_error = author_point(total_authors, author_position, cfg)
    if point_error or point is None:
        return CalcResult(None, None, None, None, point_error, Category.NONE, point_error)

    # Fewer than two SEC-affiliated references: counted, not paid.
    min_refs = int(cfg.min_sec_references or 0)
    if sec_reference_count is not None and min_refs and sec_reference_count < min_refs:
        return CalcResult(
            0.0,
            point,
            0.0,
            0.0,
            None,
            Category.NONE,
            f"Only {sec_reference_count} SEC-affiliated reference"
            f"{'' if sec_reference_count == 1 else 's'} cited; the policy requires "
            f"{min_refs}. The publication is counted but carries no remuneration.",
        )

    scopus = is_scopus_indexed(indexing_level)
    wos = is_web_of_science(indexing_level)
    # Nothing said about indexing at all: assume Scopus, which is what the
    # scheme is built around, rather than refusing to show an estimate.
    if not scopus and not wos:
        scopus = True

    has_snip = snip is not None and float(snip) > 0
    if snip is not None:
        snip_num = float(snip)
        if snip_num < 0:
            return CalcResult(None, point, None, None, "SNIP cannot be negative", None, None)
        cap = float(cfg.snip_cap or 30)
        if snip_num > cap:
            return CalcResult(
                None, point, None, None, f"SNIP value looks invalid (max {cap:g})", None, None
            )

    # The quartile incentive is for Engineering journals only.
    engineering = (engineering_class or ENGINEERING) != NON_ENGINEERING
    pub_m = _pub_multiplier(publication_type, cfg)

    if scopus and has_snip:
        qf = qf_for(quartile or "", cfg) if engineering else 0.0
        base = (float(snip) * cfg.snip_multiplier + qf) * pub_m
        note = None if engineering else "Non-Engineering: no quartile incentive is added."
        return CalcResult(round2(base), point, round2(base * point), qf, None, Category.SNIP, note)

    if scopus and not has_snip:
        if _is_conference_or_book(publication_type):
            base = float(cfg.fixed_other_no_snip) * pub_m
            return CalcResult(
                round2(base),
                point,
                round2(base * point),
                0.0,
                None,
                Category.OTHER_NO_SNIP,
                "No SNIP on record, so the fixed conference/book-chapter rate applies.",
            )
        if _is_journal(publication_type):
            base = float(cfg.fixed_journal_no_snip) * pub_m
            return CalcResult(
                round2(base),
                point,
                round2(base * point),
                0.0,
                None,
                Category.JOURNAL_NO_SNIP,
                "No SNIP on record, so the fixed journal rate applies.",
            )

    if wos:
        # The policy writes Category IV as [5000 + QFA] x APP. QFA still only
        # applies to Engineering journals.
        qf = qf_for(quartile or "", cfg) if engineering else 0.0
        base = (float(cfg.fixed_web_of_science) + qf) * pub_m
        return CalcResult(
            round2(base), point, round2(base * point), qf, None, Category.WEB_OF_SCIENCE, None
        )

    return CalcResult(
        0.0,
        point,
        0.0,
        0.0,
        None,
        Category.NONE,
        "This combination of indexing and publication type is not covered by the scheme.",
    )


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
        fixed_journal_no_snip=float(getattr(obj, "fixed_journal_no_snip", 5000) or 5000),
        fixed_other_no_snip=float(getattr(obj, "fixed_other_no_snip", 4000) or 4000),
        fixed_web_of_science=float(getattr(obj, "fixed_web_of_science", 5000) or 5000),
        max_authors=int(getattr(obj, "max_authors", MAX_ELIGIBLE_AUTHORS) or MAX_ELIGIBLE_AUTHORS),
        min_sec_references=int(
            getattr(obj, "min_sec_references", MIN_SEC_REFERENCES)
            if getattr(obj, "min_sec_references", None) is not None
            else MIN_SEC_REFERENCES
        ),
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
        "fixed_journal_no_snip": cfg.fixed_journal_no_snip,
        "fixed_other_no_snip": cfg.fixed_other_no_snip,
        "fixed_web_of_science": cfg.fixed_web_of_science,
        "max_authors": cfg.max_authors,
        "min_sec_references": cfg.min_sec_references,
        "author_points": cfg.author_points,
        "publication_type_multipliers": cfg.publication_type_multipliers,
        "student_remuneration_zero": cfg.student_remuneration_zero,
        "qf_only_for_no_snip": cfg.qf_only_for_no_snip,
    }


def format_inr(amount: float | None) -> str:
    if amount is None:
        return "—"
    return f"₹{amount:,.2f}"
