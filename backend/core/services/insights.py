"""Ask the data in plain English: a fixed catalogue of questions, counted in code.

Heads of department and the offices ask things like "how many Q1 papers did
ECE publish this year against last?" or "which claims are waiting longest?".
The rule is the research compass's, one step further: **the model never writes
a query and never produces a number.** It picks one entry of `CATALOGUE` and
fills in its settings; which records are read, what is counted and every figure
in the sentence are this module's. A sentence the model offers is a template
with placeholders, filled from the counts, and thrown away (`fill`) the moment
it says anything of its own: a digit, a name, an amount, a direction, a link.

Each entry is a read-only question over counts the rest of the app already
makes, so an answer here and the report it summarises cannot disagree:

- papers are `college_totals.papers`, the one definition of a college paper
  that the Principal's reports and the head's department page share;
- a person's papers are `person_record.papers_of`, the count every profile shows;
- topics are the publication record's own, through `research_picture`;
- claims are counted stage by stage as Track counts them (`core.api.track`),
  and a head sees the stages, and the clock, that Track gives a head;
- money is the ledger, through `college_totals.payments`, by India's April to
  March financial year, as the year brief and the Money pages read it.

Who may ask what is decided here, per question, from `rbac`, never widened:

- a faculty member is refused (`Forbidden`): they have My research and the compass;
- a head of department asks about their own department only, read from their
  account and never from the question, and never about money: a money
  question is refused in a sentence, and no rupee key or figure is built;
- everybody who may read the reports (`rbac.can_view_reports`: the office,
  the coordinator, the Principal, the Director, Finance) sees the college,
  money included, as `/reports` already shows them.

With the AI off, failing or over its limit, a typed question is matched to an
entry by its words (`match`), and each role has suggested questions that run
an entry directly (`suggestions`). The page never needs the model.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from types import SimpleNamespace
from typing import Any, Callable, Iterable

from django.utils import timezone

from core import hod
from core.models import AuditLog, Claim, ClaimStatus, Publication, Role, User
from core.services import ai, college_totals, hod_record, principal_reports, rbac
from core.services import ai_harness as harness
from core.services import research_picture as picture
from core.services.college_totals import NO_DEPARTMENT
from core.services.normalize import clean_venue
from core.services.pdf_fonts import group_in
from core.services.person_record import papers_of
from core.services.principal_brief import _change, _fy_start, _inr, fy_label, teachers_by_department
from core.services.trends import _norm_person

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Words and limits                                                            #
# --------------------------------------------------------------------------- #

MAX_QUESTION = 300
#: The audit keeps this much of a question, and no more.
LOGGED_QUESTION = 200
DEFAULT_LIMIT = 10
MAX_LIMIT = 50
#: Rows shown under a list that takes no `limit` (papers, claims).
LIST_ROWS = 25
#: Rows a CSV carries: everything behind the answer, up to here.
CSV_ROWS = 10000
ACTION_ASK = "INSIGHTS_ASK"
NONE = "none"

FACULTY_TEXT = "Ask the data is for heads of department and the offices. Your own record is under My research."
NO_DEPARTMENT_TEXT = (
    "This account has no department set, so there is nothing to show. Ask the research office to set it."
)
MONEY_REFUSED = (
    "Amounts are not shown to a head of department, so this cannot be answered here. "
    "Your department's papers, people and claims can be."
)
OFF_TOPIC = "I can answer questions about papers, journals, people, claims and payouts."
OFF_TOPIC_HEAD = "I can answer questions about your department's papers, journals, people and claims."
OFF_TEXT = "AI is off right now, so your question was matched by its words to the nearest question that can be counted."
FAILED_TEXT = "The AI did not answer this time, so your question was matched by its words instead."

_LIMIT_CODES = ("person_limit", "feature_limit", "college_cap")

QUARTILE_CHOICES = ("Q1", "Q2", "Q3", "Q4", "top")
TYPES = ("journal", "conference", "book", "preprint")
METRICS = ("papers", "q1", "first_author", "citations")
BREAKDOWNS = ("department", "month", "person")
#: Track's stage keys, the office's and a head's (`core.api.track`). Which of
#: them a reader may filter by is decided per reader in `clean`.
STAGES = ("submitted", "checked", "approved", "authorised", "paid", "sent_back", "on_hold", "not_accepted",
          "review", "completed")
NOT_RECORDED = "Not recorded"

#: `research_picture._kind_label`'s words, as the filter's own.
_TYPE_OF_KIND = {"Journal article": "journal", "Review": "journal", "Conference": "conference",
                 "Book / chapter": "book", "Preprint": "preprint"}
_METRIC_WORDS = {"papers": "papers", "q1": "Q1 papers", "first_author": "first-author papers",
                 "citations": "citations"}
_METRIC_LABEL = {"papers": "Papers", "q1": "Q1 papers", "first_author": "First-author papers",
                 "citations": "Citations"}

PAPERS_HOW = (
    "Papers are the publication record plus recognised claim papers it does not hold, counted once per paper "
    "by calendar year of publication, as the Principal's reports count them. A paper shared by two departments "
    "counts in each, and once for the college."
)
QUARTILE_HOW = " The quartile is the journal's recorded SJR quartile; a paper without one is not counted under any."
TYPE_HOW = " The type is the record's own document type; a claim-only paper takes its claim's."
PEOPLE_HOW = (
    "A person's papers are counted as on their profile: the publication record plus recognised claim papers it "
    "does not hold. Only today's faculty and heads are ranked. First author is author position 1, where the "
    "record knows the order; citations are OpenAlex's count for record papers."
)
CITATIONS_HOW = (
    "Citations are OpenAlex's current count for each paper on the publication record, added up by the year the "
    "paper came out. Claim-only papers carry no citation count, so they are left out."
)
TOPICS_HOW = (
    "Topics are the ones the publication record gives each paper, counted over the last 12 months against the "
    "12 before. A topic is rising with at least {least} papers in the last 12 months and more than in the 12 "
    "before. Claim-only papers carry no topics."
)
CLAIMS_HOW = (
    "Claims are every filed claim (not drafts), at the stage Track shows them, with days counted from when the "
    "claim reached its current stage."
)
CLAIMS_HOW_HEAD = (
    "Claims are your department's filed claims (not drafts), at the stages Track shows a head, with days "
    "counted from when each was filed. Which desk holds a claim is not shown."
)
FLOW_HOW = " A claim counts in the month it was filed; cleared counts the month the research office cleared it."
MONEY_HOW = (
    "Money is every payment on the ledger, and any paid claim the ledger does not hold, by India's April to "
    "March financial year, as the year brief counts it. A reversal cancels the payment it reverses. The "
    "department is the claimant's account department, else the one the ledger row was filed under."
)
AVERAGE_HOW = (
    " Only payments above zero are averaged. The median is the typical payment; the mean is pulled up by the "
    "few large ones."
)


class Forbidden(PermissionError):
    """This reader may not use Ask the data at all."""


class Refused(PermissionError):
    """This reader may not have this answer; the message says so plainly."""


class InputError(ValueError):
    """The request cannot be used, with a sentence to show."""


def _today() -> date:
    return timezone.localdate()


# --------------------------------------------------------------------------- #
# Who is asking                                                               #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Viewer:
    """What the person asking may see, decided once from their account."""

    role: str
    user_id: str | None = None
    #: A head's own department, on the roll's spelling; None means the college.
    department: str | None = None

    @property
    def head(self) -> bool:
        return self.role == Role.HOD

    @property
    def money(self) -> bool:
        """The reports' rule: whoever may read `/reports` may read its money."""
        return rbac.can_view_reports(self.role)


def may_ask(role: str | None) -> bool:
    """Everybody who reads the college's reports, and a head for their department."""
    return rbac.can_view_reports(role) or role == Role.HOD


def viewer_for(user) -> Viewer:
    if not may_ask(getattr(user, "role", None)):
        raise Forbidden(FACULTY_TEXT)
    department = None
    if user.role == Role.HOD:
        own = hod.department_of(user)
        if not own:
            raise InputError(NO_DEPARTMENT_TEXT)
        department = college_totals.canonical_departments()(own)
    return Viewer(user.role, user.pk, department)


def _departments() -> list[str]:
    """The roll's departments: where today's faculty and heads sit."""
    return sorted((d for d in teachers_by_department() if d != NO_DEPARTMENT), key=str.casefold)


def _departments_for(v: Viewer) -> list[str]:
    return [v.department] if v.head and v.department else _departments()


def _dept(v: Viewer, p: dict[str, Any]) -> str | None:
    """The department an answer is about: a head's own, whatever was asked."""
    return v.department if v.head else p.get("department")


# --------------------------------------------------------------------------- #
# The catalogue                                                               #
# --------------------------------------------------------------------------- #


@dataclass
class Result:
    answer: str
    facts: dict[str, str]
    series: list[dict[str, Any]]
    rows: list[dict[str, Any]]
    counted_how: str
    total: int = 0
    #: What a series value counts, and what a row's value is.
    series_label: str = "Papers"
    value_label: str = "Papers"
    notices: list[str] = field(default_factory=list)
    #: In place of the query's own chart, when a setting changes its shape
    #: (payouts by month are a line, by department a ranking).
    chart: str = ""


@dataclass(frozen=True)
class Query:
    key: str
    #: The question, in the reader's words.
    title: str
    #: What it answers, for the model choosing among them.
    asks: str
    params: tuple[str, ...]
    #: The placeholders an answer template may use.
    facts: tuple[str, ...]
    #: "bar" (ranked), "columns" (in their own order) or "line" (over time).
    chart: str
    run: Callable[[Viewer, dict[str, Any], int], Result]
    unit: str = "count"
    money: bool = False
    #: Settings filled in when the question leaves them out.
    defaults: tuple[tuple[str, str], ...] = ()


CATALOGUE: dict[str, Query] = {}


def _query(key: str, title: str, asks: str, *, params: Iterable[str], facts: Iterable[str], chart: str,
           unit: str = "count", money: bool = False, defaults: dict[str, str] | None = None):
    def wrap(fn: Callable[[Viewer, dict[str, Any], int], Result]):
        CATALOGUE[key] = Query(key, title, asks, tuple(params), tuple(facts), chart, fn, unit, money,
                               tuple((defaults or {}).items()))
        return fn

    return wrap


# --------------------------------------------------------------------------- #
# Settings, checked                                                           #
# --------------------------------------------------------------------------- #

_STOP = {"and", "of", "the", "in", "for", "&"}
_ANYWHERE = {"", "all", "any", "college", "the college", "whole college", "everyone", "none", "all departments",
             "every department", "we", "us"}


def _acronym(name: str) -> str:
    return "".join(w[0] for w in re.findall(r"[a-z0-9]+", name.lower()) if w not in _STOP)


def resolve_department(text: Any, departments: Iterable[str]) -> str | None | bool:
    """The roll's department a reader named: its name, any spelling, or its initials.

    None for the whole college, False for a name that is no department.
    """
    words = " ".join(re.findall(r"[a-z0-9&]+", str(text or "").lower()))
    if words in _ANYWHERE:
        return None
    key = college_totals._dept_key(words)
    names = list(departments)
    for d in names:
        if college_totals._dept_key(d) == key:
            return d
    for d in names:
        initials = _acronym(d)
        if len(initials) >= 2 and initials == key:
            return d
    for d in names:
        if len(key) >= 4 and key in college_totals._dept_key(d):
            return d
    return False


def _int(value: Any, low: int, high: int) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if number != number or number != int(number):
        return None
    number = int(number)
    return number if low <= number <= high else None


def _limit(value: Any) -> int:
    if isinstance(value, bool):
        return DEFAULT_LIMIT
    try:
        number = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, number))


def _track():
    """`core.api.track`, whose stage rules Track and this module share.

    Imported by name at call time: `from core.api import track` hands back the
    endpoint function, which the API package's star import puts over the
    module, and importing it at load time would be a service importing the
    API package, a cycle.
    """
    import importlib

    return importlib.import_module("core.api.track")


def _stages_for(v: Viewer) -> tuple[str, ...]:
    track = _track()

    keys = track.HOD_STAGES if v.head else (*track.MAIN_STAGES, *track.SIDE_STAGES)
    return tuple(k for k, _label, _what in keys)


def clean(key: str, raw: Any, v: Viewer, departments: Iterable[str]) -> tuple[dict[str, Any], list[str]]:
    """The settings one query takes, every value checked against what it may be.

    Whatever a model or a request sends, only these come out: a department on
    the roll (a head's own, always), years in range, the quartiles, types,
    metrics and breakdowns there are, and a limit inside its bounds.
    """
    q = CATALOGUE[key]
    raw = raw if isinstance(raw, dict) else {}
    today = _today()
    notices: list[str] = []
    out: dict[str, Any] = {}
    names = list(departments)
    for name in q.params:
        value = raw.get(name)
        if name == "department":
            asked = resolve_department(value, names)
            if asked is False and v.head:
                # A head is given their own department only, so any other name
                # fails to resolve: say what is counted instead.
                asked = "another"
            elif asked is False:
                text = " ".join(str(value).split())[:60]
                notices.append(f"There is no department called “{text}” on the roll, so this counts the whole college.")
                asked = None
            out[name] = asked
        elif name in ("year", "year_to"):
            out[name] = _int(value, 1990, today.year + 1)
        elif name == "financial_year":
            out[name] = _int(value, 2000, today.year + 1)
        elif name == "quartile":
            text = str(value or "").strip()
            out[name] = "top" if text.lower() == "top" else (text.upper() if text.upper() in QUARTILE_CHOICES else None)
        elif name == "type":
            text = str(value or "").strip().lower()
            out[name] = text if text in TYPES else None
        elif name == "person":
            text = " ".join(str(value or "").split())[:120]
            out[name] = text or None
        elif name == "stage":
            text = str(value or "").strip().lower()
            out[name] = text if text in _stages_for(v) else None
        elif name == "metric":
            text = str(value or "").strip().lower()
            out[name] = text if text in METRICS else "papers"
        elif name == "by":
            text = str(value or "").strip().lower()
            out[name] = text if text in BREAKDOWNS else "department"
        elif name == "limit":
            out[name] = _limit(value) if value is not None else DEFAULT_LIMIT
    if out.get("year_to") is not None:
        if out.get("year") is None:
            out["year"], out["year_to"] = out["year_to"], None
        elif out["year_to"] < out["year"]:
            out["year"], out["year_to"] = out["year_to"], out["year"]
        if out["year_to"] == out["year"]:
            out["year_to"] = None
    for name, rule in q.defaults:
        if out.get(name) is None:
            out[name] = today.year if rule == "this_year" else _fy_start(today)
    if v.head:
        asked = out.get("department")
        if asked and asked != v.department:
            notices.append(f"As head of {v.department} you see {v.department} only, so this counts {v.department}.")
        out["department"] = v.department
    return out, notices


@dataclass
class Choice:
    """Which query, with which settings, or why not."""

    query: str | None
    params: dict[str, Any] = field(default_factory=dict)
    notices: list[str] = field(default_factory=list)
    #: The plain sentence when this reader may not have this answer.
    refused: str = ""

    @property
    def off_topic(self) -> bool:
        return self.query is None


def choose(data: Any, v: Viewer, departments: Iterable[str]) -> Choice:
    """A model's (or a request's) pick, checked: the query must be in the
    catalogue, its settings are `clean`, and the reader's role decides whether
    it may be answered at all. No database is read here."""
    data = data if isinstance(data, dict) else {}
    key = str(data.get("query") or "").strip()
    if key not in CATALOGUE:
        return Choice(None)
    params, notices = clean(key, data.get("params"), v, departments)
    if CATALOGUE[key].money and not v.money:
        return Choice(key, params, notices, refused=MONEY_REFUSED)
    return Choice(key, params, notices)


# --------------------------------------------------------------------------- #
# Saying it                                                                   #
# --------------------------------------------------------------------------- #


def _n(n: float, word: str, many: str | None = None) -> str:
    return f"{group_in(n)} {word if n == 1 else (many or word + 's')}"


def _sentence(text: str) -> str:
    text = " ".join(text.split())
    return text[:1].upper() + text[1:] if text else text


def _scope(v: Viewer, p: dict[str, Any]) -> str:
    return _dept(v, p) or "the college"


def _of(v: Viewer, p: dict[str, Any]) -> str:
    return f"{_scope(v, p)}'s"


def _years(p: dict[str, Any]) -> tuple[int | None, int | None]:
    y0 = p.get("year")
    return (y0, p.get("year_to") or y0) if y0 else (None, None)


def _period(p: dict[str, Any]) -> str:
    y0, y1 = _years(p)
    if not y0:
        return "on record"
    return f"in {y0}" if y0 == y1 else f"from {y0} to {y1}"


def _when(p: dict[str, Any]) -> str:
    """" in 2025", " from 2022 to 2025", or nothing for all years."""
    return "" if not p.get("year") else " " + _period(p)


def _what(p: dict[str, Any], n: int) -> str:
    quartile = p.get("quartile")
    lead = "Q1 or Q2 " if quartile == "top" else (f"{quartile} " if quartile else "")
    nouns = {"journal": ("journal paper", "journal papers"), "conference": ("conference paper", "conference papers"),
             "book": ("book or chapter", "books or chapters"), "preprint": ("preprint", "preprints")}
    one, many = nouns.get(p.get("type") or "", ("paper", "papers"))
    return lead + (one if n == 1 else many)


def _published(v: Viewer, p: dict[str, Any], n: int) -> str:
    y0, y1 = _years(p)
    scope, what = _scope(v, p), _what(p, n)
    if not y0:
        return _sentence(f"{scope} has {group_in(n)} {what} on record.")
    if y0 == y1 and y0 >= _today().year:
        return f"So far in {y0} {scope} has published {group_in(n)} {what}."
    return _sentence(f"{scope} published {group_in(n)} {what} {_period(p)}.")


def _clip(text: str, limit: int = 90) -> str:
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:-") + "…"


def _names(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


# --------------------------------------------------------------------------- #
# Papers                                                                      #
# --------------------------------------------------------------------------- #


def _chunks(ids: Iterable[str], size: int = 500):
    ids = list(ids)
    for i in range(0, len(ids), size):
        yield ids[i:i + size]


def _publications(ids: Iterable[str], *fields: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for part in _chunks(ids):
        for r in Publication.objects.filter(id__in=part).values("id", *fields):
            out[r["id"]] = r
    return out


def _kind_label(raw: str | None) -> str:
    text = (raw or "").strip()
    return picture._kind_label(text) if text else NOT_RECORDED


def _kinds(rows: list[dict[str, Any]]) -> dict[str, str]:
    """Each paper's type in `research_picture`'s words: the record's own
    document type, or the claim's for a claim-only paper."""
    record = [r["id"] for r in rows if r["source"] == "record"]
    out = {pid: _kind_label(r["type"]) for pid, r in _publications(record, "type").items()}
    claims = {r["claim_id"]: r["id"] for r in rows if r["source"] != "record" and r.get("claim_id")}
    for part in _chunks(claims):
        for cid, agg, pub in Claim.objects.filter(id__in=part).values_list("id", "aggregation_type", "publication_type"):
            out[claims[cid]] = _kind_label(agg or pub)
    for r in rows:
        out.setdefault(r["id"], NOT_RECORDED)
    return out


def _college_papers(v: Viewer, p: dict[str, Any], *, years: bool = True) -> list[dict[str, Any]]:
    """`college_totals.papers` for this reader and these settings."""
    rows = college_totals.papers(None, _dept(v, p))
    if years:
        rows = _within(rows, p)
    if p.get("quartile"):
        rows = [r for r in rows if principal_reports._match_quartile(r, p["quartile"])]
    if p.get("type"):
        kinds = _kinds(rows)
        rows = [r for r in rows if _TYPE_OF_KIND.get(kinds[r["id"]]) == p["type"]]
    return rows


def _within(rows: list[dict[str, Any]], p: dict[str, Any]) -> list[dict[str, Any]]:
    y0, y1 = _years(p)
    if not y0:
        return list(rows)
    return [r for r in rows if r["year"] and y0 <= r["year"] <= y1]


def _newest_first(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order = principal_reports.QUARTILE_ORDER
    return sorted(rows, key=lambda r: (-(r["year"] or 0), order.get(r.get("quartile") or "", 4), r["id"]))


def _paper(pid: str, title: Any, journal: Any, year: Any, quartile: Any, doi: Any, claim_id: Any,
           source: str, value: Any = None) -> dict[str, Any]:
    detail = " · ".join(str(x) for x in (clean_venue(journal), year, quartile) if x)
    return {"kind": "paper", "id": pid, "label": " ".join(str(title or "").split()) or "Untitled", "value": value,
            "detail": detail, "doi": doi or None, "claim_id": claim_id or None, "source": source}


def _paper_rows(rows: list[dict[str, Any]], cap: int,
                value: Callable[[dict[str, Any]], Any] | None = None) -> list[dict[str, Any]]:
    """The first `cap` papers as list rows, each carrying what opens it: the
    claim behind it, or its DOI."""
    shown = rows[:cap]
    record = [r["id"] for r in shown if r["source"] == "record"]
    pubs = _publications(record, "title", "venue", "doi")
    claim_of: dict[str, str] = {}
    for part in _chunks(record):
        for pid, cid in Publication.claims.through.objects.filter(publication_id__in=part).values_list(
            "publication_id", "claim_id"
        ):
            claim_of.setdefault(pid, cid)
    out = []
    for r in shown:
        if r["source"] == "record":
            pub = pubs.get(r["id"], {})
            out.append(_paper(r["id"], pub.get("title"), pub.get("venue"), r["year"], r.get("quartile"),
                              pub.get("doi"), claim_of.get(r["id"]), "record", value(r) if value else None))
        else:
            out.append(_paper(r["id"], r.get("title"), r.get("journal"), r["year"], r.get("quartile"), r.get("doi"),
                              r.get("claim_id"), "claims", value(r) if value else None))
    return out


def _year_span(p: dict[str, Any]) -> range:
    y0, y1 = _years(p)
    end = y1 or _today().year
    start = y0 if (y0 and y1 and y1 > y0) else end - 4
    return range(start, end + 1)


def _per_year(rows: list[dict[str, Any]], span: range) -> list[dict[str, Any]]:
    counts = Counter(r["year"] for r in rows if r["year"])
    return [{"label": str(y), "value": counts.get(y, 0)} for y in span]


def _how(p: dict[str, Any]) -> str:
    return PAPERS_HOW + (QUARTILE_HOW if p.get("quartile") else "") + (TYPE_HOW if p.get("type") else "")


def _find_person(v: Viewer, name: str | None) -> User | None:
    """The one person a name fits, among those this reader may ask about."""
    want = set(_norm_person(name or "").split())
    if not want:
        return None
    people = hod_record.teachers(v.department) if v.head else User.objects.filter(
        active=True, role__in=rbac.CLAIMANT_ROLES)
    best, score = None, 0
    for u in people:
        have = set(_norm_person(u.name or "").split())
        if want <= have and (best is None or len(have) < score):
            best, score = u, len(have)
    return best


@_query("papers_count", "How many papers", "How many papers were published, optionally for one department, "
        "years, quartile, type or person.",
        params=("department", "year", "year_to", "quartile", "type", "person"),
        facts=("count", "scope", "what", "period"), chart="line")
def _papers_count(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    if p.get("person"):
        return _person_papers(v, p, cap)
    base = _college_papers(v, p, years=False)
    rows = _within(base, p)
    n = len(rows)
    facts = {"count": group_in(n), "scope": _scope(v, p), "what": _what(p, n), "period": _period(p)}
    return Result(_published(v, p, n), facts, _per_year(base, _year_span(p)),
                  _paper_rows(_newest_first(rows), cap), _how(p), total=n)


def _person_papers(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    user = _find_person(v, p["person"])
    if user is None:
        where = f" in {v.department}" if v.head else ""
        return Result(f"Nobody called {p['person']} is on the roll{where}.", {}, [], [], PEOPLE_HOW)
    y0, y1 = _years(p)
    mine = [x for x in papers_of([user])[user.id]
            if (not y0 or (x.year and y0 <= x.year <= y1))
            and (not p.get("quartile") or (x.quartile in ("Q1", "Q2") if p["quartile"] == "top"
                                           else x.quartile == p["quartile"]))]
    mine.sort(key=lambda x: (-(x.year or 0), x.title))
    n = len(mine)
    what = _what({**p, "type": None}, n)
    if not y0:
        answer = f"{user.name} has {group_in(n)} {what} on record."
    else:
        answer = f"{user.name} published {group_in(n)} {what} {_period(p)}."
    rows = [_paper(x.publication_id or x.claim_id or f"paper:{i}", x.title, x.venue, x.year, x.quartile, x.doi,
                   x.claim_id, x.source) for i, x in enumerate(mine[:cap])]
    counts = Counter(x.year for x in mine if x.year)
    series = [{"label": str(y), "value": counts.get(y, 0)} for y in _year_span(p)]
    facts = {"count": group_in(n), "scope": user.name, "what": what, "period": _period(p)}
    return Result(answer, facts, series, rows, PEOPLE_HOW, total=n)


@_query("papers_by_department", "Papers by department", "Papers published, broken down by department, for "
        "years, quartile or type.",
        params=("year", "year_to", "quartile", "type"), facts=("top", "top_count", "count", "period"), chart="bar")
def _papers_by_department(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    rows = _college_papers(v, p)
    counts = Counter(d for r in rows for d in r["departments"] if not v.head or d == v.department)
    series = [{"label": d, "value": n, "key": d}
              for d, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].casefold()))]
    n = len(rows)
    y0, y1 = _years(p)
    lead = "" if not y0 else (f"In {y0} " if y0 == y1 else f"From {y0} to {y1} ")
    what = _what(p, n)
    if not series:
        answer = _sentence(f"{lead}no {_what(p, 2)} are on record" + ("." if lead else " for these settings."))
        top, top_n = "", 0
    elif v.head:
        top, top_n = series[0]["label"], series[0]["value"]
        answer = (_sentence(f"{lead}{top} published {group_in(top_n)} {_what(p, top_n)}.") if lead
                  else f"{top} has {group_in(top_n)} {_what(p, top_n)} on record.")
    else:
        top, top_n = series[0]["label"], series[0]["value"]
        tied = [s["label"] for s in series if s["value"] == top_n]
        who = _names(tied[:3])
        answer = _sentence(f"{lead}{who} published the most {_what(p, 2)}, {group_in(top_n)}"
                           + (" each" if len(tied) > 1 else "") + f", of {group_in(n)} for the college.")
    facts = {"top": top, "top_count": group_in(top_n), "count": group_in(n), "period": _period(p)}
    return Result(answer, facts, series, _paper_rows(_newest_first(rows), cap), _how(p), total=n)


@_query("papers_by_quartile", "Papers by quartile", "How the papers split across journal quartiles Q1 to Q4.",
        params=("department", "year", "year_to", "type"), facts=("count", "q1", "share", "known", "scope", "period"),
        chart="columns")
def _papers_by_quartile(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    rows = _college_papers(v, p)
    counts = Counter(r.get("quartile") or "" for r in rows)
    series = [{"label": q, "value": counts.get(q, 0)} for q in ("Q1", "Q2", "Q3", "Q4")]
    series.append({"label": NOT_RECORDED, "value": counts.get("", 0)})
    n, q1 = len(rows), counts.get("Q1", 0)
    known = n - counts.get("", 0)
    share = round(100 * q1 / known) if known else 0
    if not n:
        answer = _sentence(f"{_of(v, p)} record holds no papers {_period(p)}.")
    elif not known:
        answer = _sentence(f"None of {_of(v, p)} {_n(n, 'paper')} {_period(p)} has a recorded quartile.")
    else:
        verb = "is" if q1 == 1 else "are"
        answer = _sentence(f"Of {_of(v, p)} {_n(n, 'paper')} {_period(p)}, {group_in(q1)} {verb} in Q1 journals "
                           f"({share}% of the {group_in(known)} with a recorded quartile).")
    facts = {"count": group_in(n), "q1": group_in(q1), "share": f"{share}%", "known": group_in(known),
             "scope": _scope(v, p), "period": _period(p)}
    return Result(answer, facts, series, _paper_rows(_newest_first(rows), cap), _how(p) + QUARTILE_HOW, total=n)


_KIND_PLURAL = {"Journal article": "journal articles", "Conference": "conference papers",
                "Book / chapter": "books or chapters", "Review": "reviews", "Preprint": "preprints",
                NOT_RECORDED: "of a type not recorded"}


@_query("papers_by_type", "Papers by type", "How the papers split by type: journal articles, conference papers, "
        "books and chapters, preprints.",
        params=("department", "year", "year_to", "quartile"), facts=("count", "top", "top_count", "scope", "period"),
        chart="bar")
def _papers_by_type(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    rows = _college_papers(v, p)
    kinds = _kinds(rows)
    counts = Counter(kinds[r["id"]] for r in rows)
    series = [{"label": k, "value": n} for k, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    n = len(rows)
    if not series:
        answer = _sentence(f"{_of(v, p)} record holds no papers {_period(p)}.")
        top, top_n = "", 0
    else:
        top, top_n = series[0]["label"], series[0]["value"]
        parts = [f"{group_in(s['value'])} {_KIND_PLURAL.get(s['label'], s['label'].lower())}" for s in series[:3]]
        answer = _sentence(f"Of {_of(v, p)} {_n(n, 'paper')} {_period(p)}, {_names(parts)}.")
    facts = {"count": group_in(n), "top": _KIND_PLURAL.get(top, top.lower()), "top_count": group_in(top_n),
             "scope": _scope(v, p), "period": _period(p)}
    return Result(answer, facts, series, _paper_rows(_newest_first(rows), cap), _how(p) + TYPE_HOW, total=n)


@_query("papers_compare", "This year against last", "Papers in one year against the year before (year over "
        "year), optionally for one department, quartile or type. The year defaults to this year.",
        params=("department", "year", "quartile", "type"),
        facts=("scope", "count", "what", "period", "before", "before_period", "change"), chart="columns",
        defaults={"year": "this_year"})
def _papers_compare(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    year = p["year"]
    base = _college_papers(v, {**p, "year": None}, years=False)
    now = [r for r in base if r["year"] == year]
    then = sum(1 for r in base if r["year"] == year - 1)
    n = len(now)
    what = _what(p, n)
    change = _change(n, then)
    scope = _scope(v, p)
    if year >= _today().year:
        answer = _sentence(f"So far in {year} {scope} has published {group_in(n)} {what}, "
                           f"against {group_in(then)} in all of {year - 1}.")
        said = ""
    else:
        said = "" if change is None else ("the same" if change == 0 else
                                          f"{'up' if change > 0 else 'down'} {abs(change):g}%")
        answer = _sentence(f"{scope} published {group_in(n)} {what} in {year}, against {group_in(then)} in {year - 1}"
                           + (f", {said}" if said else "") + ".")
    series = [{"label": str(year - 1), "value": then}, {"label": str(year), "value": n}]
    facts = {"scope": scope, "count": group_in(n), "what": what, "period": f"in {year}", "before": group_in(then),
             "before_period": f"in {year - 1}", "change": said}
    how = _how(p) + (f" {year} is not over, so it is counted to date and not given a percentage."
                     if year >= _today().year else "")
    return Result(answer, facts, series, _paper_rows(_newest_first(now), cap), how, total=n)


@_query("top_journals", "Where we publish most", "The journals (venues) with the most papers, optionally for one "
        "department, years, quartile or type.",
        params=("department", "year", "year_to", "quartile", "type", "limit"),
        facts=("scope", "top", "top_count", "period"), chart="bar")
def _top_journals(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    rows = _college_papers(v, p)
    pubs = _publications([r["id"] for r in rows if r["source"] == "record"], "venue")
    counts: Counter[str] = Counter()
    spelled: dict[str, Counter[str]] = defaultdict(Counter)
    for r in rows:
        name = clean_venue(pubs.get(r["id"], {}).get("venue") if r["source"] == "record" else r.get("journal"))
        if name:
            counts[name.casefold()] += 1
            spelled[name.casefold()][name] += 1
    ranked = sorted(((spelled[k].most_common(1)[0][0], n) for k, n in counts.items()),
                    key=lambda t: (-t[1], t[0].casefold()))
    limit = p.get("limit") or DEFAULT_LIMIT
    series = [{"label": name, "value": n} for name, n in ranked[:limit]]
    out_rows = [{"kind": "journal", "id": name, "label": name, "value": n, "detail": ""} for name, n in ranked[:cap]]
    scope = _sentence(_scope(v, p))
    if not ranked:
        answer = _sentence(f"No journal is recorded for {_of(v, p)} papers{_when(p)}.")
        top, top_n = "", 0
    else:
        top_n = ranked[0][1]
        tied = [name for name, n in ranked if n == top_n]
        top = _names(tied[:3])
        answer = (f"{scope} published most in {top}{_when(p)}: {_n(top_n, 'paper')}"
                  + (" each" if len(tied) > 1 else "") + ".")
    facts = {"scope": _scope(v, p), "top": top, "top_count": group_in(top_n), "period": _period(p)}
    return Result(answer, facts, series, out_rows, _how(p) + " A journal is named as the record names it.",
                  total=len(ranked), value_label="Papers")


@_query("top_people", "Who publishes most", "The people with the most papers, Q1 papers, first-author papers or "
        "citations, optionally for one department and years.",
        params=("department", "year", "year_to", "metric", "limit"),
        facts=("top", "top_count", "metric", "scope", "period"), chart="bar")
def _top_people(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    dept = _dept(v, p)
    people = hod_record.teachers(dept) if dept else list(
        User.objects.filter(active=True, role__in=hod_record.TEACHER_ROLES).order_by("name"))
    papers = papers_of(people)
    y0, y1 = _years(p)
    metric = p.get("metric") or "papers"

    def score(uid: str) -> int:
        mine = [x for x in papers.get(uid, []) if not y0 or (x.year and y0 <= x.year <= y1)]
        if metric == "q1":
            return sum(1 for x in mine if x.quartile == "Q1")
        if metric == "first_author":
            return sum(1 for x in mine if x.first_author)
        if metric == "citations":
            return sum(x.citations or 0 for x in mine)
        return len(mine)

    ranked = sorted(((score(u.id), u) for u in people), key=lambda t: (-t[0], (t[1].name or "").casefold()))
    ranked = [(n, u) for n, u in ranked if n > 0]
    limit = p.get("limit") or DEFAULT_LIMIT
    words = _METRIC_WORDS[metric]
    series = [{"label": u.name, "value": n, "key": u.id} for n, u in ranked[:limit]]
    rows = [{"kind": "person", "id": u.id, "label": u.name, "value": n,
             "detail": " · ".join(x for x in (u.department, u.designation) if x),
             "user_id": u.id, "name": u.name} for n, u in ranked[:cap]]
    where = f"in {dept}" if dept else "in the college"
    if not ranked:
        answer = f"Nobody {where} has {words} on record{_when(p)}."
        top, top_n = "", 0
    else:
        top_n = ranked[0][0]
        tied = [u.name for n, u in ranked if n == top_n]
        top = _names(tied[:3])
        verb = "have" if len(tied) > 1 else "has"
        answer = (f"{top} {verb} the most {words} {where}{_when(p)}: {group_in(top_n)}"
                  + (" each" if len(tied) > 1 else "") + ".")
    facts = {"top": top, "top_count": group_in(top_n), "metric": words, "scope": dept or "the college",
             "period": _period(p)}
    return Result(answer, facts, series, rows, PEOPLE_HOW, total=len(ranked), series_label=_METRIC_LABEL[metric],
                  value_label=_METRIC_LABEL[metric])


@_query("citations", "Citations", "How often the papers are cited, and the most cited ones, optionally for one "
        "department and years.",
        params=("department", "year", "year_to", "limit"), facts=("scope", "total", "period", "top", "top_title"),
        chart="line")
def _citations(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    base = [r for r in _college_papers(v, p, years=False) if r["source"] == "record"]
    cites = {pid: r["citations"] or 0 for pid, r in _publications([r["id"] for r in base], "citations").items()}
    rows = _within(base, p)
    total = sum(cites.get(r["id"], 0) for r in rows)
    by_year: Counter[int] = Counter()
    for r in base:
        if r["year"]:
            by_year[r["year"]] += cites.get(r["id"], 0)
    series = [{"label": str(y), "value": by_year.get(y, 0)} for y in _year_span(p)]
    ranked = sorted(rows, key=lambda r: (-cites.get(r["id"], 0), -(r["year"] or 0), r["id"]))
    ranked = [r for r in ranked if cites.get(r["id"], 0) > 0] or ranked
    out_rows = _paper_rows(ranked, cap, value=lambda r: cites.get(r["id"], 0))
    period = _period(p)
    if not total:
        answer = _sentence(f"No citations are recorded for {_of(v, p)} papers {period}.")
        top_title, top_n = "", 0
    else:
        top_title, top_n = out_rows[0]["label"], out_rows[0]["value"]
        answer = _sentence(f"{_of(v, p)} papers {period} have {_n(total, 'citation')}; the most cited, "
                           f"“{_clip(top_title)}”, has {group_in(top_n)}.")
    facts = {"scope": _scope(v, p), "total": group_in(total), "period": period, "top": group_in(top_n),
             "top_title": _clip(top_title)}
    return Result(answer, facts, series, out_rows, CITATIONS_HOW, total=len(rows), series_label="Citations",
                  value_label="Citations")


@_query("topics_rising", "Topics rising", "Research topics or areas growing fastest over the last 12 months, "
        "optionally for one department.",
        params=("department", "limit"), facts=("scope", "top", "top_now", "top_before"), chart="bar")
def _topics_rising(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    college = picture.shared_college()
    dept = _dept(v, p)
    pubs = college.pubs
    if dept:
        canon = college_totals.canonical_departments()
        pubs = {pid: pub for pid, pub in pubs.items()
                if any(m in college.users and canon(college.users[m].department) == dept for m in pub["members"])}
    now, before, spelled = picture._topic_growth(SimpleNamespace(pubs=pubs), _today())
    # The college page's rule (three papers) for the college; the compass's
    # (two) for a department, which is a tenth of the size.
    least = 2 if dept else 3
    rising = sorted((k for k in now if now[k] >= least and now[k] > before.get(k, 0)),
                    key=lambda k: (-(now[k] - before.get(k, 0)), -now[k], k))
    limit = p.get("limit") or DEFAULT_LIMIT
    series = [{"label": spelled[k], "value": now[k]} for k in rising[:limit]]
    rows = [{"kind": "topic", "id": k, "label": spelled[k], "value": now[k], "detail": f"up from {before.get(k, 0)}"}
            for k in rising[:cap]]
    where = f"in {dept}" if dept else "in the college"
    if not rising:
        answer = f"No topic {where} has grown over the last 12 months by this rule."
        top, top_now, top_before = "", 0, 0
    else:
        k = rising[0]
        top, top_now, top_before = spelled[k], now[k], before.get(k, 0)
        answer = (f"The fastest-rising topic {where} is {top}: {_n(top_now, 'paper')} in the last 12 months, "
                  f"up from {group_in(top_before)}.")
    facts = {"scope": dept or "the college", "top": top, "top_now": group_in(top_now),
             "top_before": group_in(top_before)}
    return Result(answer, facts, series, rows, TOPICS_HOW.format(least=least), total=len(rising),
                  value_label="Papers in the last 12 months")


# --------------------------------------------------------------------------- #
# Claims, counted as Track counts them                                        #
# --------------------------------------------------------------------------- #


def _claims(v: Viewer, p: dict[str, Any]) -> list[dict[str, Any]]:
    """Every filed claim this reader may count, with Track's stage and clock."""
    track = _track()

    qs = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    dept = _dept(v, p)
    if dept:
        canon = college_totals.canonical_departments()
        spellings = {d for d in qs.values_list("owner__department", flat=True).distinct() if d and canon(d) == dept}
        qs = qs.filter(owner__department__in=spellings)
    now = timezone.now()
    labels = track.HOD_LABEL if v.head else track.STAGE_LABEL
    out = []
    for r in qs.values(*track._LIGHT, "paper_title", "ticket_number", "owner__name", "owner_id"):
        stage = track._stage_of(r["status"], r["on_hold"], r["rejected_outright"], r["status_note"])
        since = track._since(stage, r)
        if v.head:
            # A head is told how long since filing, never how long at a desk.
            stage = track._HOD_OF_STAGE[stage]
            since = r["submitted_at"] or r["created_at"]
        out.append({**r, "_stage": stage, "_label": labels[stage], "_days": track._days(since, now),
                    "_moving": stage not in track._NOT_MOVING})
    return out


def _claim_row(v: Viewer, c: dict[str, Any], value: Any) -> dict[str, Any]:
    detail = " · ".join(x for x in (c["_label"], c["owner__name"], c["ticket_number"]) if x)
    return {"kind": "claim", "id": c["id"], "label": " ".join((c["paper_title"] or "").split()) or "Untitled",
            "value": value, "detail": detail, "stage": c["_label"], "is_mine": c["owner_id"] == v.user_id}


def _claims_how(v: Viewer) -> str:
    return CLAIMS_HOW_HEAD if v.head else CLAIMS_HOW


@_query("claims_by_stage", "Claims at each stage", "How many claims are at each stage of the approval chain.",
        params=("department", "stage"), facts=("total", "scope", "moving", "top_stage", "top_count"), chart="columns")
def _claims_by_stage(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    track = _track()

    claims = _claims(v, p)
    counts = Counter(c["_stage"] for c in claims)
    order = track.HOD_STAGES if v.head else (*track.MAIN_STAGES, *track.SIDE_STAGES)
    main = {k for k, _l, _w in (track.HOD_STAGES[:3] if v.head else track.MAIN_STAGES)}
    series = [{"label": label, "value": counts.get(k, 0), "key": k} for k, label, _w in order
              if k in main or counts.get(k)]
    moving = [c for c in claims if c["_moving"]]
    picked = [c for c in claims if c["_stage"] == p["stage"]] if p.get("stage") else moving
    picked.sort(key=lambda c: -(c["_days"] if c["_days"] is not None else -1))
    where = f" in {_dept(v, p)}" if _dept(v, p) else ""
    total = len(claims)
    busiest = max((s for s in series if s["key"] not in track._NOT_MOVING), key=lambda s: s["value"], default=None)
    if not total:
        answer = f"No claims are on file{where}."
    else:
        verb = "is" if total == 1 else "are"
        answer = f"{_n(total, 'claim')} {verb} on file{where}; {group_in(len(moving))} still moving"
        if busiest and busiest["value"]:
            answer += f", the most at “{busiest['label']}” ({group_in(busiest['value'])})"
        answer += "."
    facts = {"total": group_in(total), "scope": _scope(v, p), "moving": group_in(len(moving)),
             "top_stage": busiest["label"] if busiest else "", "top_count": group_in(busiest["value"] if busiest else 0)}
    return Result(answer, facts, series, [_claim_row(v, c, c["_days"]) for c in picked[:cap]], _claims_how(v),
                  total=len(picked), series_label="Claims", value_label="Days at this stage")


@_query("claims_waiting", "Claims waiting longest", "Which claims have waited longest, and how long, optionally "
        "for one department or stage.",
        params=("department", "stage", "limit"),
        facts=("count", "top_days", "top_title", "top_owner", "top_stage", "over_month"), chart="columns")
def _claims_waiting(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    track = _track()

    waiting = [c for c in _claims(v, p) if c["_moving"] and (not p.get("stage") or c["_stage"] == p["stage"])]
    waiting.sort(key=lambda c: (-(c["_days"] if c["_days"] is not None else -1), c["id"]))
    buckets = Counter(track._bucket(c["_days"]) for c in waiting)
    series = [{"label": label, "value": buckets.get(key, 0), "key": key} for key, label, _top in track.AGE_BUCKETS]
    over = buckets.get("older", 0)
    where = f" in {_dept(v, p)}" if _dept(v, p) else ""
    if not waiting:
        answer = f"Nothing is waiting{where}."
        top = {"_days": 0, "paper_title": "", "owner__name": "", "_label": ""}
    else:
        top = waiting[0]
        answer = (f"The longest wait{where} is {_n(top['_days'] or 0, 'day')}: “{_clip(top['paper_title'] or 'Untitled')}” "
                  f"by {top['owner__name']}, at “{top['_label']}”. {_n(len(waiting), 'claim')} "
                  f"{'is' if len(waiting) == 1 else 'are'} waiting, {group_in(over)} of them over 30 days.")
    facts = {"count": group_in(len(waiting)), "top_days": group_in(top["_days"] or 0),
             "top_title": _clip(top["paper_title"] or ""), "top_owner": top["owner__name"] or "",
             "top_stage": top["_label"], "over_month": group_in(over)}
    # `cap` is the page's `limit`, or the whole list for a download.
    return Result(answer, facts, series, [_claim_row(v, c, c["_days"]) for c in waiting[:cap]], _claims_how(v),
                  total=len(waiting), series_label="Claims", value_label="Days waiting")


def _month_starts(p: dict[str, Any]) -> list[date]:
    today = _today()
    if p.get("year"):
        last = 12 if p["year"] < today.year else today.month
        return [date(p["year"], m, 1) for m in range(1, last + 1)]
    out = []
    y, m = today.year, today.month
    for _ in range(12):
        out.append(date(y, m, 1))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


@_query("claims_per_month", "Claims filed and cleared each month", "How many claims were filed, and cleared, each "
        "month over the last 12 months or one year.",
        params=("department", "year"), facts=("filed", "cleared", "scope", "busiest", "busiest_count"), chart="line")
def _claims_per_month(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    months = _month_starts(p)
    keys = {(d.year, d.month) for d in months}
    claims = _claims(v, p)

    def month_of(moment) -> tuple[int, int] | None:
        if not moment:
            return None
        local = timezone.localtime(moment) if timezone.is_aware(moment) else moment
        return (local.year, local.month)

    filed = [c for c in claims if month_of(c["submitted_at"] or c["created_at"]) in keys]
    counts = Counter(month_of(c["submitted_at"] or c["created_at"]) for c in filed)
    cleared = sum(1 for c in claims if month_of(c["cleared_at"]) in keys)
    series = [{"label": d.strftime("%b %Y"), "value": counts.get((d.year, d.month), 0)} for d in months]
    filed.sort(key=lambda c: (c["submitted_at"] or c["created_at"]), reverse=True)
    rows = []
    for c in filed[:cap]:
        row = _claim_row(v, c, None)
        on = timezone.localtime(c["submitted_at"] or c["created_at"]).date()
        row["detail"] = f"Filed {on.day} {on.strftime('%b %Y')} · " + row["detail"]
        rows.append(row)
    where = f" in {_dept(v, p)}" if _dept(v, p) else ""
    span = f"In {p['year']}" if p.get("year") else "In the last 12 months"
    busiest = max(series, key=lambda s: s["value"]) if series else {"label": "", "value": 0}
    answer = f"{span} {_n(len(filed), 'claim')} {'was' if len(filed) == 1 else 'were'} filed{where}"
    # Clearing is the research office's step: a head is not told when a desk acted.
    answer += "" if v.head else f" and {group_in(cleared)} cleared"
    if busiest["value"]:
        answer += f"; the busiest month was {busiest['label']}, with {group_in(busiest['value'])}"
    answer += "."
    facts = {"filed": group_in(len(filed)), "cleared": "" if v.head else group_in(cleared), "scope": _scope(v, p),
             "busiest": busiest["label"], "busiest_count": group_in(busiest["value"])}
    return Result(answer, facts, series, rows, _claims_how(v) + ("" if v.head else FLOW_HOW), total=len(filed),
                  series_label="Claims filed", value_label="")


# --------------------------------------------------------------------------- #
# Money: never for a head, refused before any of this runs                    #
# --------------------------------------------------------------------------- #


def _who_was_paid() -> tuple[dict[str, User], dict[str, User]]:
    """Accounts by id, and by staff id (case-insensitive, unique only): how a
    historic ledger row with no claim finds its person, as `paper_facts` does."""
    by_id: dict[str, User] = {}
    by_staff: dict[str, User | None] = {}
    for u in User.objects.filter(active=True).only("id", "name", "department", "staff_id"):
        by_id[u.id] = u
        sid = (u.staff_id or "").strip().casefold()
        if sid:
            by_staff[sid] = None if sid in by_staff else u
    return by_id, {k: u for k, u in by_staff.items() if u is not None}


def _payments(v: Viewer, p: dict[str, Any]) -> list[dict[str, Any]]:
    if not v.money:  # pragma: no cover - `choose` refuses first; this is the net under it
        raise Refused(MONEY_REFUSED)
    fy, dept = p["financial_year"], _dept(v, p)
    by_id, by_staff = _who_was_paid()
    out = []
    for x in college_totals.payments():
        if not x["month"] or _fy_start(x["month"]) != fy or (dept and x["department"] != dept):
            continue
        u = by_id.get(x.get("owner_id") or "") or by_staff.get((x.get("staff_id") or "").strip().casefold())
        out.append({**x, "user_id": u.id if u else None, "who": (u.name if u else x.get("name")) or "Not recorded"})
    if p.get("person"):
        person = _find_person(v, p["person"])
        out = [x for x in out if person and x["user_id"] == person.id]
    return out


def _fy_words(fy: int) -> str:
    running = _fy_start(_today()) == fy
    return f"In FY {fy_label(fy)}" + (" so far" if running else "")


def _net(pays: list[dict[str, Any]]) -> int:
    return sum(1 if x["amount"] > 0 else -1 if x["amount"] < 0 else 0 for x in pays)


def _paid_people(pays: list[dict[str, Any]]) -> list[dict[str, Any]]:
    people: dict[str, dict[str, Any]] = {}
    for x in pays:
        key = x["user_id"] or f"name:{x['who'].casefold()}"
        slot = people.setdefault(key, {"id": x["user_id"], "name": x["who"], "department": x["department"],
                                       "amount": 0.0, "n": 0})
        slot["amount"] += x["amount"]
        slot["n"] += 1 if x["amount"] > 0 else -1 if x["amount"] < 0 else 0
    return sorted(people.values(), key=lambda r: (-r["amount"], r["name"].casefold()))


def _person_row(r: dict[str, Any]) -> dict[str, Any]:
    row = {"kind": "person", "id": r["id"], "label": r["name"], "value": round(r["amount"], 2),
           "detail": r["department"] if r["department"] != NO_DEPARTMENT else ""}
    if r["id"]:
        row.update(user_id=r["id"], name=r["name"])
    return row


@_query("payouts_by", "What we paid out", "How much was paid out in incentives in a financial year, broken down "
        "by department, month or person.",
        params=("department", "financial_year", "by", "person", "limit"),
        facts=("total", "count", "fy", "scope", "top", "top_amount"), chart="bar", unit="money", money=True,
        defaults={"financial_year": "this_fy"})
def _payouts_by(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    pays = _payments(v, p)
    fy, by = p["financial_year"], p.get("by") or "department"
    total, count = sum(x["amount"] for x in pays), _net(pays)
    people = _paid_people(pays)
    limit = p.get("limit") or DEFAULT_LIMIT
    if by == "month":
        months = [date(fy, m, 1) for m in range(4, 13)] + [date(fy + 1, m, 1) for m in range(1, 4)]
        today = _today()
        months = [m for m in months if (m.year, m.month) <= (today.year, today.month)] or months[:1]
        slots: dict[tuple[int, int], list[float]] = defaultdict(list)
        unrecorded = 0
        for x in pays:
            if x.get("month_recorded", True):
                slots[(x["month"].year, x["month"].month)].append(x["amount"])
            else:
                unrecorded += 1
        series = [{"label": m.strftime("%b %Y"), "value": round(sum(slots.get((m.year, m.month), [])), 2),
                   "count": len(slots.get((m.year, m.month), []))} for m in months]
        best = max(series, key=lambda s: s["value"], default=None)
        top, top_amount = (best["label"], best["value"]) if best and best["value"] else ("", 0.0)
        tail = f"; the largest month was {top}, {_inr(top_amount)}" if top else ""
        extra = (f" {group_in(unrecorded)} payments whose month nobody recorded are in the total and not in any month."
                 if unrecorded else "")
    elif by == "person":
        series = [{"label": r["name"], "value": round(r["amount"], 2), "count": r["n"], "key": r["id"]}
                  for r in people[:limit]]
        top, top_amount = (people[0]["name"], people[0]["amount"]) if people else ("", 0.0)
        tail = f"; {top} was paid the most, {_inr(top_amount)}" if top else ""
        extra = ""
    else:
        by_dept: dict[str, list[float]] = defaultdict(list)
        for x in pays:
            by_dept[x["department"]].append(x["amount"])
        series = sorted(({"label": d, "value": round(sum(a), 2), "count": _net([{"amount": n} for n in a]), "key": d}
                         for d, a in by_dept.items()), key=lambda s: (-s["value"], s["label"].casefold()))
        top, top_amount = (series[0]["label"], series[0]["value"]) if series else ("", 0.0)
        tail = f"; {top} received the most, {_inr(top_amount)}" if top and not _dept(v, p) else ""
        extra = ""
    where = f" to {_dept(v, p)}" if _dept(v, p) else ""
    if not pays:
        answer = f"No payments{where} are on the ledger for FY {fy_label(fy)}."
    else:
        answer = (f"{_fy_words(fy)} the college paid {_inr(total)}{where} over {_n(count, 'payment')}{tail}.")
    facts = {"total": _inr(total), "count": group_in(count), "fy": fy_label(fy), "scope": _scope(v, p),
             "top": top, "top_amount": _inr(top_amount)}
    return Result(answer, facts, series, [_person_row(r) for r in people[:cap]], MONEY_HOW + extra,
                  total=len(people), series_label="Payments", value_label="Paid",
                  chart="line" if by == "month" else "")


@_query("payout_average", "A typical payment", "The average (mean) and typical (median) incentive payment per "
        "paper in a financial year, by department.",
        params=("department", "financial_year"),
        facts=("median", "mean", "count", "fy", "scope", "low", "high"), chart="bar", unit="money", money=True,
        defaults={"financial_year": "this_fy"})
def _payout_average(v: Viewer, p: dict[str, Any], cap: int) -> Result:
    from core.api.dashboard import _per_paper

    pays = [x for x in _payments(v, p) if x["amount"] > 0]
    fy = p["financial_year"]
    overall = _per_paper([x["amount"] for x in pays])
    by_dept: dict[str, list[float]] = defaultdict(list)
    for x in pays:
        by_dept[x["department"]].append(x["amount"])
    series = []
    for d, amounts in by_dept.items():
        stats = _per_paper(amounts)
        series.append({"label": d, "value": stats["median"], "count": stats["count"], "key": d})
    series.sort(key=lambda s: (-s["value"], s["label"].casefold()))
    where = f" in {_dept(v, p)}" if _dept(v, p) else ""
    if not pays:
        answer = f"No payments{where} are on the ledger for FY {fy_label(fy)}."
    else:
        answer = (f"{_fy_words(fy)} a typical payment{where} was {_inr(overall['median'])} (the median) and the "
                  f"average {_inr(overall['mean'])}, across {_n(overall['count'], 'payment')}; they ran from "
                  f"{_inr(overall['min'])} to {_inr(overall['max'])}.")
    rows = [_person_row({"id": x["user_id"], "name": x["who"], "department": x["department"], "amount": x["amount"]})
            for x in sorted(pays, key=lambda x: -x["amount"])[:cap]]
    facts = {"median": _inr(overall["median"]), "mean": _inr(overall["mean"]), "count": group_in(overall["count"]),
             "fy": fy_label(fy), "scope": _scope(v, p), "low": _inr(overall["min"]), "high": _inr(overall["max"])}
    return Result(answer, facts, series, rows, MONEY_HOW + AVERAGE_HOW, total=len(pays),
                  series_label="Payments", value_label="Paid")


# --------------------------------------------------------------------------- #
# A model's sentence, only where it says nothing of its own                   #
# --------------------------------------------------------------------------- #

_SLOT = re.compile(r"\{([a-z_]+)\}")
_DIRECTION = re.compile(
    r"\b(?:more|fewer|less|up|down|rose|risen|rise|rising|fell|fallen|fall|falling|grew|grown|grow\w*|increas\w*|"
    r"decreas\w*|drop\w*|higher|lower|doubl\w*|halv\w*|declin\w*|improv\w*|wors\w*|better|gain\w*|lost|loss)\b",
    re.IGNORECASE,
)
#: Words a sentence may open with in capitals: a name never comes from the
#: model, only from a placeholder.
_OPENERS = {"the", "in", "of", "so", "from", "across", "this", "these", "there", "over", "during", "since", "at",
            "for", "by", "on", "a", "an", "no", "nobody", "every", "each", "among", "with", "between", "your",
            "our", "we", "it", "its", "nothing"}


def fill(template: Any, facts: dict[str, str]) -> str:
    """The model's sentence with the counted facts in its placeholders, or "".

    Everything a reader could take for a fact must come from `facts`: the
    template is refused for a digit, a capitalised name, an amount, a link,
    markup, a direction ("up", "fewer") or a placeholder the facts do not
    hold, and for having no placeholder at all.
    """
    if not isinstance(template, str):
        return ""
    text = " ".join(template.split())
    if not text or len(text) > 220:
        return ""
    slots = _SLOT.findall(text)
    if not slots or any(s not in facts for s in slots):
        return ""
    bare = _SLOT.sub(" ", text)
    if (re.search(r"\d", bare) or re.search(r"[{}<>`\[\]*₹$]", bare) or harness._MONEY.search(bare)
            or harness._URL.search(bare) or _DIRECTION.search(bare) or re.search(r"\b[A-Z]{2,}", bare)):
        return ""
    words = re.findall(r"[A-Za-z][A-Za-z'’-]*", bare)
    for i, w in enumerate(words):
        if w[0].isupper() and (i > 0 or w.lower() not in _OPENERS):
            return ""
    out = _SLOT.sub(lambda m: facts[m.group(1)], text)
    out = re.sub(r"\s+([,.;:!?])", r"\1", " ".join(out.split()))
    out = re.sub(r",\s*([.;])", r"\1", out).strip(" ,;")
    # "In {period}" with a period of "in 2025" reads "In in 2025": a template
    # that does not fit its facts is not shown at all.
    if not out or re.search(r"\b(\w+)\s+\1\b", out, re.IGNORECASE):
        return ""
    if out[-1] not in ".!?":
        out += "."
    return _sentence(out)


# --------------------------------------------------------------------------- #
# Answering                                                                   #
# --------------------------------------------------------------------------- #


def _cap_for(choice: Choice) -> int:
    return choice.params.get("limit") or LIST_ROWS


def _empty(choice: Choice, answer: str, notices: list[str], **extra: Any) -> dict[str, Any]:
    q = CATALOGUE.get(choice.query or "")
    return {
        "answer": answer, "query": choice.query, "title": q.title if q else "", "params": choice.params,
        "param_keys": [], "chart": "", "unit": "count", "series_label": "", "value_label": "",
        "series": [], "rows": [], "total_rows": 0, "counted_how": "", "counted": True, "refused": False,
        "off_topic": False, "notices": notices, **extra,
    }


def _off_topic(v: Viewer, notices: list[str]) -> dict[str, Any]:
    return _empty(Choice(None), (OFF_TOPIC_HEAD if v.head else OFF_TOPIC) + " Try one of these.", notices,
                  off_topic=True, suggestions=suggestions(v)["chips"][:6])


def answer(v: Viewer, choice: Choice, *, template: str = "", notices: Iterable[str] = (),
           cap: int | None = None) -> dict[str, Any]:
    """What the page shows for one choice: the sentence, the chart, the list."""
    said = [*notices, *choice.notices]
    if choice.off_topic:
        return _off_topic(v, said)
    if choice.refused:
        return _empty(choice, choice.refused, said, refused=True)
    q = CATALOGUE[choice.query]
    result = q.run(v, choice.params, cap or _cap_for(choice))
    sentence = fill(template, result.facts) if template else ""
    return {
        "answer": sentence or result.answer,
        "query": q.key,
        "title": q.title,
        "params": choice.params,
        "param_keys": list(choice.params),
        "chart": (result.chart or q.chart) if result.series else "",
        "unit": q.unit,
        "series_label": result.series_label,
        "value_label": result.value_label,
        "series": result.series,
        "rows": result.rows,
        "total_rows": result.total,
        "counted_how": result.counted_how,
        "counted": not sentence,
        "refused": False,
        "off_topic": False,
        "notices": [*said, *result.notices],
    }


def run(v: Viewer, key: str, params: Any = None, *, cap: int | None = None) -> dict[str, Any]:
    """One catalogue entry, run directly: a suggestion chip, or a refined setting."""
    if key not in CATALOGUE:
        raise InputError("There is no such question. Choose one of the suggestions.")
    return answer(v, choose({"query": key, "params": params or {}}, v, _departments_for(v)), cap=cap)


def csv_rows(v: Viewer, key: str, params: Any = None) -> tuple[dict[str, Any], list[list[Any]]]:
    """Everything behind one answer, for a spreadsheet. A refusal is raised,
    not written into a file."""
    if key not in CATALOGUE:
        raise InputError("There is no such question. Choose one of the suggestions.")
    choice = choose({"query": key, "params": params or {}}, v, _departments_for(v))
    if choice.refused:
        raise Refused(choice.refused)
    out = answer(v, choice, cap=CSV_ROWS)
    head = ["What", "Name", out["value_label"] or "Value", "Detail"]
    rows: list[list[Any]] = [head]
    for r in out["rows"]:
        rows.append([r["kind"], r["label"], r["value"], r.get("detail") or ""])
    if not out["rows"]:
        rows = [["Label", out["series_label"] or "Value"]] + [[s["label"], s["value"]] for s in out["series"]]
    rows += [[], ["Answer", out["answer"]], ["How this was counted", out["counted_how"]]]
    return out, rows


# --------------------------------------------------------------------------- #
# Suggested questions: the page without the model                             #
# --------------------------------------------------------------------------- #


def suggestions(v: Viewer) -> dict[str, Any]:
    today = _today()
    this, last, fy = today.year, today.year - 1, _fy_start(today)

    def chip(label: str, query: str, **params: Any) -> dict[str, Any]:
        return {"label": label, "query": query, "params": params}

    if v.head:
        d = v.department
        chips = [
            chip(f"How many papers did {d} publish this year against last?", "papers_compare", year=this),
            chip(f"Who in {d} has the most Q1 papers?", "top_people", metric="q1"),
            chip(f"Which journals did {d} publish in most in {last}?", "top_journals", year=last),
            chip(f"Which topics are rising in {d}?", "topics_rising"),
            chip(f"Which of {d}'s claims are waiting longest?", "claims_waiting"),
            chip(f"Most cited {d} papers from {last}", "citations", year=last),
        ]
    else:
        chips = [
            chip("How many Q1 papers did we publish this year against last?", "papers_compare", quartile="Q1",
                 year=this),
            chip(f"Which journals did we publish in most in {last}?", "top_journals", year=last),
            chip("Who has the most first-author papers?", "top_people", metric="first_author"),
            chip(f"Papers by department in {last}", "papers_by_department", year=last),
            chip("Which research topics are rising?", "topics_rising"),
            chip("Which claims are waiting longest?", "claims_waiting"),
            chip("How many claims are at each stage?", "claims_by_stage"),
        ]
        if v.money:
            chips[2:2] = [
                chip("How much did we pay out per department this financial year?", "payouts_by",
                     by="department", financial_year=fy),
                chip("What is a typical payment per paper this financial year?", "payout_average",
                     financial_year=fy),
            ]
    years = sorted({p["year"] for p in college_totals.papers(None, v.department) if p["year"]
                    and p["year"] <= this + 1}, reverse=True)[:12]
    return {
        "chips": chips,
        "departments": _departments_for(v),
        "department": v.department,
        "years": years or [this, last],
        "financial_years": [{"value": y, "label": f"FY {fy_label(y)}"} for y in range(fy, fy - 5, -1)],
        "queries": [{"key": q.key, "title": q.title, "params": list(q.params), "money": q.money}
                    for q in CATALOGUE.values() if v.money or not q.money],
        "ai": _ai_ready(),
    }


# --------------------------------------------------------------------------- #
# A question typed with AI off: matched by its words                          #
# --------------------------------------------------------------------------- #

_W = re.IGNORECASE
_MONEY_WORDS = re.compile(r"₹|\b(?:pay|pays|paid|paying|payout|payouts|payment|payments|spend|spent|spending|money|"
                          r"incentives?|rupees?|amounts?|disburs\w*|cost)\b", _W)
_AVERAGE = re.compile(r"\b(?:average|typical|mean|median|per paper)\b", _W)
_WAITING = re.compile(r"\b(?:waiting|wait|waited|longest|oldest|stuck|pending|delayed|overdue)\b", _W)
_CLAIM = re.compile(r"\bclaims?\b", _W)
_FLOW = re.compile(r"\b(?:filed|submitted|cleared|per month|each month|every month|monthly|by month)\b", _W)
_TOPIC = re.compile(r"\b(?:topics?|areas?|fields?|themes?|trends?|trending|rising|growing|emerging)\b", _W)
_CITE = re.compile(r"\bcit(?:e|ed|es|ing|ation|ations)\b", _W)
_JOURNAL = re.compile(r"\b(?:journals?|venues?)\b", _W)
_WHO = re.compile(r"\b(?:who|whom|people|person|faculty|authors?|researchers?|staff|colleagues?)\b", _W)
_COMPARE = re.compile(r"\b(?:vs\.?|versus|compared?|comparison|against|than last|year on year|year over year)\b", _W)
_QUARTILE_SPLIT = re.compile(r"\b(?:by quartile|quartiles|per quartile|each quartile)\b", _W)
_TYPE_SPLIT = re.compile(r"\b(?:by type|types|kinds? of|conferences? (?:vs|or|and|against) journals?)\b", _W)
_DEPT_SPLIT = re.compile(r"\b(?:by department|per department|each department|every department|departments|"
                         r"which department)\b", _W)
_PAPERS = re.compile(r"\b(?:papers?|publications?|publish\w*|articles?|output|how many)\b", _W)


def match(question: str, v: Viewer, departments: Iterable[str]) -> dict[str, Any] | None:
    """The catalogue entry a question's words point at, with its settings, or
    None when they point at nothing. Deliberately plain: it serves when the AI
    is not there, and a wrong guess is shown as the question it answered."""
    text = " ".join((question or "").split())
    low = text.lower()
    today = _today()
    params: dict[str, Any] = {}

    years = sorted({int(y) for y in re.findall(r"\b(199\d|20\d\d)\b(?!\s*[-–/]\s*\d\d\b)", text)})
    if "this year" in low or "so far" in low:
        params["year"] = today.year
    elif "last year" in low:
        params["year"] = today.year - 1
    if years:
        params["year"] = years[-1] if _COMPARE.search(text) else years[0]
        if len(years) > 1 and not _COMPARE.search(text):
            params["year_to"] = years[-1]
    fy = re.search(r"\b(20\d\d)\s*[-–/]\s*(\d\d)\b", text)
    if fy:
        params["financial_year"] = int(fy.group(1))
    elif "last financial year" in low or "previous financial year" in low:
        params["financial_year"] = _fy_start(today) - 1
    elif years and re.search(r"\bfinancial year|\bfy\b", low):
        params["financial_year"] = years[0]
    quartile = re.search(r"\bq([1-4])\b", low)
    if re.search(r"\bq1 or q2\b|\btop quartile", low):
        params["quartile"] = "top"
    elif quartile:
        params["quartile"] = f"Q{quartile.group(1)}"
    for word, kind in (("conference", "conference"), ("book", "book"), ("chapter", "book"), ("preprint", "preprint")):
        if word in low:
            params["type"] = kind
            break
    if re.search(r"\bjournal (?:papers|articles)\b", low):
        params["type"] = "journal"
    for d in departments:
        pattern = rf"(?<![\w&]){re.escape(d)}(?![\w&])"
        hit = re.search(pattern, text) if d.isupper() else re.search(pattern, text, _W)
        initials = _acronym(d)
        if not hit and len(initials) >= 3:
            hit = re.search(rf"\b{initials}\b", text, _W)
        if hit:
            params["department"] = d
            break
    top = re.search(r"\btop (\d{1,2})\b", low)
    if top:
        params["limit"] = int(top.group(1))

    if _MONEY_WORDS.search(text):
        if _AVERAGE.search(text):
            return {"query": "payout_average", "params": params}
        by = "month" if re.search(r"\bmonths?\b|\bmonthly\b", low) else "person" if _WHO.search(text) else "department"
        return {"query": "payouts_by", "params": {**params, "by": by}}
    if _WAITING.search(text):
        return {"query": "claims_waiting", "params": params}
    if _CLAIM.search(text):
        if _FLOW.search(text):
            return {"query": "claims_per_month", "params": params}
        return {"query": "claims_by_stage", "params": params}
    if _TOPIC.search(text):
        return {"query": "topics_rising", "params": params}
    if _CITE.search(text):
        if _WHO.search(text):
            return {"query": "top_people", "params": {**params, "metric": "citations"}}
        return {"query": "citations", "params": params}
    if _JOURNAL.search(text) and not params.get("type"):
        return {"query": "top_journals", "params": params}
    if _WHO.search(text):
        metric = ("first_author" if re.search(r"first[- ]author|\blead author", low)
                  else "q1" if params.get("quartile") == "Q1" else "papers")
        return {"query": "top_people", "params": {**params, "metric": metric}}
    if _COMPARE.search(text):
        return {"query": "papers_compare", "params": params}
    if _QUARTILE_SPLIT.search(text):
        return {"query": "papers_by_quartile", "params": params}
    if _TYPE_SPLIT.search(text):
        return {"query": "papers_by_type", "params": params}
    if _DEPT_SPLIT.search(text) and "department" not in params:
        return {"query": "papers_by_department", "params": params}
    if _PAPERS.search(text):
        return {"query": "papers_count", "params": params}
    return None


# --------------------------------------------------------------------------- #
# The harness feature                                                         #
# --------------------------------------------------------------------------- #

DEPARTMENTS_LABEL = "the college's departments"
QUESTION_LABEL = "the question"


def _catalogue_text() -> str:
    return "\n".join(
        f"- {q.key}: {q.asks} Settings: {', '.join(q.params)}. Facts: {', '.join('{' + f + '}' for f in q.facts)}."
        for q in CATALOGUE.values()
    )


_ASK_RULES = (
    "You help the leaders and office of an engineering college in India ask questions of the college's research "
    "record. You never answer the question yourself and you never work out a number: you choose the one query "
    "from the catalogue below that answers it, and fill in its settings from the question. The server then counts "
    "everything. If no query fits, or the question is not about papers, journals, people, topics, claims or "
    f"payouts, choose \"{NONE}\".\n"
    "Settings, all optional, left out when the question does not say: department is one of the departments in "
    "the data, or \"all\"; year is a calendar year of publication (year_to with it for a range); financial_year is "
    "the year an April to March financial year starts; quartile is Q1, Q2, Q3, Q4 or top (Q1 or Q2); type is "
    "journal, conference, book or preprint; person is a name the question gives; stage is submitted, checked, "
    "approved, authorised, paid or sent_back; metric is papers, q1, first_author or citations; by is department, "
    "month or person; limit is how many to list, 1 to 50. \"We\" and \"the college\" mean all departments.\n"
    "answer_template is one plain sentence of at most 200 characters that reads the answer back. Every figure, "
    "name, year and direction in it must be one of the chosen query's facts, written as its placeholder in "
    "braces, such as {count}. Facts are phrases: {scope} reads like ECE or the college, {period} like in 2025, "
    "{what} like Q1 papers. Never write a digit, an amount, a name, a link, or a word like more, fewer, up or "
    "down yourself. Leave it empty if unsure.\n"
    "Catalogue:\n"
)


def _feature_guards(user: Any) -> list[harness.Guard]:
    """The reader's role guards (a head loses any sentence with an amount), no
    claim of acting, no contact details and no links at all."""
    return [
        *harness.role_guards(user, strip_keys=False),
        harness.NoDecisions(),
        harness.no_pii(),
        harness.no_urls_except([]),
    ]


_OPTIONAL_TEXT = dict(truncate=True, required=False, default="")

ASK = harness.register(harness.Feature(
    name="insights.ask",
    model="fast",
    system=_ASK_RULES + _catalogue_text(),
    schema=harness.Obj({
        "query": harness.Enum(*CATALOGUE, NONE),
        "params": harness.Obj({
            "department": harness.Str(80, **_OPTIONAL_TEXT),
            "year": harness.Num(1990, 2100, integer=True, required=False, default=None),
            "year_to": harness.Num(1990, 2100, integer=True, required=False, default=None),
            "financial_year": harness.Num(2000, 2100, integer=True, required=False, default=None),
            "quartile": harness.Enum("any", *QUARTILE_CHOICES, required=False, default="any"),
            "type": harness.Enum("any", *TYPES, required=False, default="any"),
            "person": harness.Str(120, **_OPTIONAL_TEXT),
            "stage": harness.Enum("any", *STAGES, required=False, default="any"),
            "metric": harness.Enum(*METRICS, required=False, default="papers"),
            "by": harness.Enum(*BREAKDOWNS, required=False, default="department"),
            "limit": harness.Num(1, MAX_LIMIT, integer=True, clamp=True, required=False, default=DEFAULT_LIMIT),
        }, required=False, default={}),
        "answer_template": harness.Str(200, **_OPTIONAL_TEXT),
    }),
    guards=_feature_guards,
    limits=harness.Limits(timeout=20, reasks=1, transient_retries=1, person_daily=40, ttl=12 * 60 * 60),
    temperature=0.1,
))


def _ai_ready() -> bool:
    return ai.available(fast=True)


def _today_line() -> str:
    today = _today()
    fy = _fy_start(today)
    return (f"Today is {today.day} {today.strftime('%B %Y')}. This calendar year is {today.year} and is not over; "
            f"last year is {today.year - 1}. The financial year running now is {fy_label(fy)} "
            f"(financial_year {fy}); the last one was {fy_label(fy - 1)} (financial_year {fy - 1}).")


def ask(v: Viewer, user: Any, question: str) -> dict[str, Any]:
    """A typed question: the model chooses an entry where it can, its words
    are matched where it cannot, and the code counts either way.

    Raises `InputError` for an empty or overlong question. Every question is
    written to the audit trail, cut at `LOGGED_QUESTION` characters.
    """
    q = " ".join((question or "").split())
    if not q:
        raise InputError("Type a question, or choose one of the suggestions.")
    if len(q) > MAX_QUESTION:
        raise InputError(f"Keep the question under {MAX_QUESTION} characters.")
    departments = _departments_for(v)
    notices: list[str] = []
    choice: Choice | None = None
    template = ""
    how = "matched"
    if _ai_ready():
        key = hashlib.sha1(f"{v.role}|{v.department}|{_today()}|{q}".encode("utf-8")).hexdigest()[:20]
        got = ASK.run(
            user=user,
            data_blocks=[harness.DataBlock(DEPARTMENTS_LABEL, ", ".join(departments), 3000),
                         harness.DataBlock(QUESTION_LABEL, q, MAX_QUESTION + 20)],
            system_extra=_today_line(),
            cache_key=key,
        )
        if got.ok:
            data = got.data if isinstance(got.data, dict) else {}
            picked = choose(data, v, departments)
            if not picked.off_topic:
                choice, template, how = picked, str(data.get("answer_template") or ""), "ai"
        else:
            logger.info("insights_ask_counted code=%s", got.code)
            notices.append(got.message if got.code in _LIMIT_CODES else FAILED_TEXT)
    else:
        notices.append(OFF_TEXT)
    if choice is None:
        choice = choose(match(q, v, departments) or {"query": NONE}, v, departments)
        if choice.off_topic:
            notices = []
    out = answer(v, choice, template=template, notices=notices)
    AuditLog.objects.create(
        actor=user if getattr(user, "pk", None) else None, action=ACTION_ASK, entity="Insights", entity_id=None,
        detail_json=json.dumps({"question": q[:LOGGED_QUESTION], "query": choice.query, "how": how,
                                "refused": bool(choice.refused), "counted": out["counted"]}),
    )
    return out


__all__ = [
    "ASK", "CATALOGUE", "Choice", "Forbidden", "InputError", "Query", "Refused", "Result", "Viewer", "answer", "ask",
    "choose", "clean", "csv_rows", "fill", "match", "may_ask", "resolve_department", "run", "suggestions",
    "viewer_for",
]
