"""Fill the gaps in the record from what the college has already given.

Screens say "Department not recorded", "Not found" and "Not recorded" where
the college's own files hold the answer: the faculty list (department,
designation, staff id, Scopus id), the settled-claims sheet (journal, ISSN,
quartile, SNIP, DOI, who was paid for which paper) and the journal tables
(SCImago, SNIP). Each gap is closed by one named fix here.

The rules every fix follows:

* A fix only fills. A value that is blank or a stand-in ("Not Found", "-",
  "N/A") is replaced; a value that is there is never changed to a different
  one. Where a source disagrees with what is there, the row is listed as a
  conflict for a person and left alone. Re-spelling a value to the college's
  own spelling ("Civil" to "CIVIL") is not a different value.
* Money is never touched: no amount, no remuneration, no quartile or SNIP on
  a claim that is still open (those are priced from verified figures only).
* Idempotent: a second run finds nothing to fill.
* A dry run computes the same plan as an apply and writes nothing at all.
  An apply writes each fix in one transaction, with one AuditLog row.

The sources are the database only: FacultyMaster (written by the faculty-list
import, `raw_json` holds every column), PaidLedger and PriorPayment `raw_json`
(written by the settled-claims import: ISSN, SNIP Value, SJR Quartile,
Engineering Classification, Document Type, DOI, Subject Area, Department), the
journal tables and the accounts. The server has no Excel files, so nothing here
opens one.
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable, Optional

from django.db import transaction
from django.utils import timezone

from core.models import (
    AuditLog, Authorship, Claim, ClaimStatus, FacultyMaster, PaidLedger, PaperCandidate, PriorPayment, Publication,
    ScimagoJournal, SnipSource, SystemSetting, User,
)
from core.services.normalize import clean_venue, normalize_doi, normalize_issn, normalize_title

REPORT_KEY = "data_fill_report"
DEPLOY_KEY = "data_fill_deploy"
SAMPLE_CAP = 8
CONFLICT_CAP = 50

# ------------------------------------------------------------ placeholders --

#: Text that says "nothing here" rather than naming something. Replaceable.
PLACEHOLDERS = frozenset({
    "", "-", "--", "—", "–", ".", "n/a", "na", "n.a", "nil", "none", "null", "nan", "unknown", "0",
    "not found", "notfound", "not recorded", "not stated", "not set", "department not recorded",
    "department not set on the account", "no department",
})


def clean(value: Any) -> str:
    return " ".join(str(value if value is not None else "").split())


def is_empty(value: Any) -> bool:
    text = clean(value).lower()
    return text in PLACEHOLDERS or text.rstrip(".") in PLACEHOLDERS


# -------------------------------------------------------------- departments --

#: The college's own department codes: the roster's spelling (FacultyMaster,
#: the website slugs in college_site.SLUG_TO_DEPT, author_names.DEPARTMENT_WORDS).
CANONICAL_DEPARTMENTS: tuple[str, ...] = (
    "AGRI", "AI&DS", "AI&ML", "BME", "CHEMICAL", "CIVIL", "CSE", "CSE - CS", "CSE - IoT", "ECE", "EEE", "EIE",
    "IT", "MBA", "MECH", "MED", "PED", "S&H-CHY", "S&H-ENGLISH", "S&H-MATHS", "S&H-PHY", "TRAINING",
)

#: Spellings the workbooks use, by the code each means. Case, spaces, dots and
#: hyphens do not matter ("S&H - Maths" is "S&H-MATHS"); a trailing "- R&D"
#: (research staff of a department) is removed before the lookup. Reviewed by
#: test_data_fill.DepartmentMapTests: every code maps to itself, no spelling
#: means two codes, and each line below is pinned.
DEPARTMENT_ALIASES: dict[str, tuple[str, ...]] = {
    "AGRI": ("Agri", "Agriculture", "Agricultural Engineering"),
    "AI&DS": ("AIDS", "AI and DS", "Artificial Intelligence and Data Science"),
    "AI&ML": ("AIML", "AI and ML", "Artificial Intelligence and Machine Learning"),
    "BME": ("Biomedical", "Bio-Medical Engineering"),
    "CHEMICAL": ("Chemical", "Chemical Engineering"),
    "CIVIL": ("Civil", "Civil Engineering"),
    "CSE": ("Computer Science", "M.E. CSE", "Computer Science and Engineering"),
    "CSE - CS": ("CSE (CS)", "CSE Cyber Security"),
    "CSE - IoT": ("CSE (IoT)", "CSE Internet of Things"),
    "ECE": ("Electronics and Communication",),
    "EEE": ("Electrical and Electronics",),
    "EIE": ("E&I", "EI", "Electronics and Instrumentation"),
    "IT": ("Information Technology",),
    "MBA": ("Management Studies",),
    "MECH": ("Mech", "Mechanical", "Mechanical Engineering"),
    "MED": ("MED ELE", "Medical Electronics"),
    "PED": ("PDE", "Physical Education", "Physical Director"),
    "S&H-CHY": ("Chemistry", "S&H-Chemistry"),
    "S&H-ENGLISH": ("English", "S&H-English", "FL", "Foreign Language"),
    "S&H-MATHS": ("Maths", "Mathematics", "S&H-Mathematics"),
    "S&H-PHY": ("Physics", "S&H-Physics"),
    "TRAINING": ("TRG", "Training"),
}

_RND = re.compile(r"\s*[-–—]?\s*R\s*&\s*D\s*$", re.IGNORECASE)


def _dept_key(value: str) -> str:
    return re.sub(r"[^a-z0-9&]+", "", value.casefold())


def _build_lookup() -> dict[str, str]:
    table: dict[str, str] = {}
    for code in CANONICAL_DEPARTMENTS:
        table[_dept_key(code)] = code
    for code, spellings in DEPARTMENT_ALIASES.items():
        for s in spellings:
            table.setdefault(_dept_key(s), code)
    return table


_DEPT_LOOKUP = _build_lookup()


def canonical_department(value: Any) -> Optional[str]:
    """The college's code for any spelling of a department; None when blank,
    a stand-in, or a spelling not in the map (it is then left as it is)."""
    text = clean(value)
    if is_empty(text):
        return None
    for candidate in (text, clean(_RND.sub("", text))):
        hit = _DEPT_LOOKUP.get(_dept_key(candidate))
        if hit:
            return hit
    return None


# ------------------------------------------------------------ journal bits --

QUARTILES = ("Q1", "Q2", "Q3", "Q4")
_ISSN_OK = re.compile(r"^\d{4}-\d{3}[\dX]$")


def valid_issn(value: Any) -> str:
    """The hyphenated ISSN a cell holds ("13861425.0" is 1386-1425), or "" when
    it holds anything else (an ISBN, two ISSNs, text)."""
    text = clean(value)
    if not text or is_empty(text):
        return ""
    got = normalize_issn(text) or ""
    return got if _ISSN_OK.match(got) else ""


def _bare(issn: str) -> str:
    return issn.replace("-", "")


def _quartile(value: Any) -> str:
    q = clean(value).upper()[:2]
    return q if q in QUARTILES else ""


def _float(value: Any) -> Optional[float]:
    try:
        text = clean(value).replace(",", "")
        return float(text) if text and not is_empty(text) else None
    except ValueError:
        return None


def _year_of(value: Any) -> Optional[int]:
    if isinstance(value, (datetime, date)):
        return value.year
    text = clean(value)
    if re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return int(text[:4])
    n = _float(text)
    if n is not None and 20000 < n < 80000:
        return (date(1899, 12, 30) + timedelta(days=int(n))).year
    if n is not None and 1900 < n < 2100:
        return int(n)
    return None


def _staff_key(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).upper()


def _same_text(a: Any, b: Any) -> bool:
    return normalize_title(clean(a)) == normalize_title(clean(b))


# ------------------------------------------------------------------ results --

@dataclass
class FixResult:
    key: str
    label: str
    kind: str = "write"            # write | derived | review
    gap_rows: int = 0              # rows with the gap today
    rows: int = 0                  # rows this fix fills (would, on a dry run)
    fields: Counter = field(default_factory=Counter)
    conflicts: list = field(default_factory=list)
    conflict_count: int = 0
    reasons: Counter = field(default_factory=Counter)   # why a gap row stays open
    samples: list = field(default_factory=list)
    detail: dict = field(default_factory=dict)
    applied: bool = False

    @property
    def unresolved(self) -> int:
        return max(self.gap_rows - self.rows, 0)

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "label": self.label, "kind": self.kind, "applied": self.applied,
            "gap_rows": self.gap_rows, "rows": self.rows, "unresolved": self.unresolved,
            "fields": dict(self.fields), "conflict_count": self.conflict_count, "conflicts": self.conflicts,
            "reasons": dict(self.reasons), "samples": self.samples, "detail": self.detail,
        }


class Plan:
    """What one fix would change, collected row by row. `apply` writes it."""

    def __init__(self, result: FixResult, model, *, touch: Optional[str] = "updated_at") -> None:
        self.result = result
        self.model = model
        self.touch = touch
        self.objs: dict[Any, Any] = {}
        self.cols: set[str] = set()

    def gap(self, n: int = 1) -> None:
        self.result.gap_rows += n

    def set(self, obj, column: str, value: Any, *, label: str = "") -> None:
        before = getattr(obj, column)
        setattr(obj, column, value)
        self.objs[obj.pk] = obj
        self.cols.add(column)
        self.result.fields[column] += 1
        if len(self.result.samples) < SAMPLE_CAP:
            self.result.samples.append({"row": label or str(obj.pk), "field": column,
                                        "from": None if before in (None, "") else str(before)[:80],
                                        "to": str(value)[:80]})

    def conflict(self, label: str, column: str, current: Any, incoming: Any, row_id: str = "") -> None:
        self.result.conflict_count += 1
        if len(self.result.conflicts) < CONFLICT_CAP:
            self.result.conflicts.append({"row": label, "id": row_id, "field": column,
                                          "current": str(current)[:100], "incoming": str(incoming)[:100]})

    def skip(self, reason: str) -> None:
        self.result.reasons[reason] += 1

    def finish(self, apply: bool) -> FixResult:
        self.result.rows = len(self.objs)
        if apply and self.objs:
            cols = set(self.cols)
            if self.touch and hasattr(self.model, self.touch):
                now = timezone.now()
                for o in self.objs.values():
                    setattr(o, self.touch, now)
                cols.add(self.touch)
            self.model.objects.bulk_update(list(self.objs.values()), sorted(cols), batch_size=500)
        self.result.applied = apply
        return self.result


# --------------------------------------------------------- the sources, once --

class Directory:
    """Everyone the college lists, by Staff-ID and by email: the FacultyMaster rows."""

    def __init__(self) -> None:
        self.by_staff: dict[str, dict[str, Any]] = {}
        self.by_email: dict[str, dict[str, Any]] = {}
        for m in FacultyMaster.objects.all():
            sheets: list = []
            try:
                sheets = json.loads(m.raw_json or "{}").get("sheets") or []
            except (ValueError, AttributeError):
                pass
            self._add({
                "staff_id": m.staff_id or "", "name": m.name or "", "email": (m.email or "").strip().lower(),
                "department": m.department or "", "designation": m.designation or "",
                "scopus_id": m.scopus_author_id or "", "research": "Research" in sheets, "source": "master",
            })

    def _add(self, person: dict[str, Any]) -> None:
        k = _staff_key(person["staff_id"])
        if k:
            self.by_staff.setdefault(k, person)
        if person["email"]:
            self.by_email.setdefault(person["email"], person)

    def of(self, user: User) -> Optional[dict[str, Any]]:
        """The list's entry for an account: by Staff ID, else by email when the
        account has no Staff ID of its own (a different one is somebody else)."""
        mine = _staff_key(user.staff_id)
        if mine:
            return self.by_staff.get(mine)
        return self.by_email.get((user.email or "").strip().lower())


def fact_from_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """The journal facts one settled-claims row carries (a ledger or prior-payment raw_json)."""
    def cell(key: str) -> str:
        v = clean(raw.get(key))
        return "" if is_empty(v) else v

    doi = normalize_doi(cell("DOI")) or ""
    eid = cell("Scopus EID")
    eng = cell("Engineering Classification")
    return {
        "journal": clean_venue(raw.get("Source Title")),
        "issn": valid_issn(raw.get("ISSN")),
        "doc_type": cell("Document Type"),
        "quartile": _quartile(raw.get("SJR Quartile")),
        "snip": _float(raw.get("SNIP Value")),
        "eng_class": eng if eng in ("Engineering", "Non-Engineering") else "",
        "subject": cell("Subject Area"),
        "eid": eid if eid.startswith("2-s2.0-") else "",
        "doi": doi if doi.startswith("10.") else "",
        "year": _year_of(raw.get("Publication Date")),
    }


FACT_KEYS = ("journal", "issn", "doc_type", "quartile", "snip", "eng_class", "subject", "eid", "doi", "year")


class Facts:
    """Journal facts from the settled-claims rows (the ledger's and the prior
    payments' own copy of them) and from claims, found by DOI, by person and
    title, and by title alone when the title is long and every row agrees."""

    def __init__(self) -> None:
        self.by_doi: dict[str, list[dict]] = defaultdict(list)
        self.by_person_title: dict[tuple[str, str], list[dict]] = defaultdict(list)
        self.by_title: dict[str, list[dict]] = defaultdict(list)
        self.by_ledger: dict[str, dict] = {}
        self.by_claim: dict[str, dict] = {}
        #: (staff key, doi, normalised title): who was paid for which paper.
        self.paid: list[dict[str, Any]] = []
        for pk, staff, title, raw_json in PaidLedger.objects.values_list(
            "id", "staff_id", "paper_title", "raw_json"
        ).iterator(chunk_size=2000):
            try:
                raw = json.loads(raw_json or "{}")
            except ValueError:
                raw = {}
            if not isinstance(raw, dict):
                raw = {}
            fact = fact_from_raw(raw)
            self.by_ledger[pk] = fact
            self._add(fact, staff=staff, title=title or raw.get("Scopus Article Title") or "", source="ledger")
        for pk, staff, title, doi, issn, journal, raw_json in PriorPayment.objects.values_list(
            "id", "employee_id", "paper_title", "doi", "issn", "journal_title", "raw_json"
        ).iterator(chunk_size=2000):
            try:
                raw = json.loads(raw_json or "{}")
            except ValueError:
                raw = {}
            fact = fact_from_raw(raw if isinstance(raw, dict) else {})
            fact["journal"] = fact["journal"] or clean_venue(journal)
            fact["issn"] = fact["issn"] or valid_issn(issn)
            if not fact["doi"]:
                d = normalize_doi(doi) or ""
                fact["doi"] = d if d.startswith("10.") else ""
            self._add(fact, staff=staff, title=title or "", source="prior")
        for c in Claim.objects.select_related("owner").only(
            "id", "paper_title", "journal_title", "issn", "quartile", "snip", "engineering_class",
            "subject_category", "eid", "doi", "publication_year", "aggregation_type", "owner__staff_id",
        ).iterator(chunk_size=500):
            doi = normalize_doi(c.doi) or ""
            fact = {
                "journal": clean_venue(c.journal_title), "issn": valid_issn(c.issn),
                "doc_type": clean(c.aggregation_type), "quartile": _quartile(c.quartile), "snip": c.snip,
                "eng_class": c.engineering_class if c.engineering_class in ("Engineering", "Non-Engineering") else "",
                "subject": clean(c.subject_category), "eid": clean(c.eid) if clean(c.eid).startswith("2-s2.0-") else "",
                "doi": doi if doi.startswith("10.") else "", "year": c.publication_year,
            }
            self.by_claim[c.id] = fact
            self._add(fact, staff=c.owner.staff_id if c.owner_id else "", title=c.paper_title or "", source="claim")

    def _add(self, fact: dict, *, staff: Any, title: str, source: str, doi: str = "") -> None:
        fact["source"] = source
        d = fact.get("doi") or normalize_doi(doi) or ""
        if d:
            self.by_doi[d].append(fact)
        nt = normalize_title(title)[:512]
        if nt:
            self.by_person_title[(_staff_key(staff), nt)].append(fact)
            self.by_title[nt].append(fact)
        if staff and (d or nt):
            self.paid.append({"staff": _staff_key(staff), "doi": d, "ntitle": nt, "source": source, "title": clean(title)[:160]})

    def title_facts(self, ntitle: str) -> list[dict]:
        rows = self.by_title.get(ntitle) or []
        if len(ntitle) < 25 or not rows:
            return []
        ids = {r["issn"] or normalize_title(r["journal"]) for r in rows if r["issn"] or r["journal"]}
        return rows if len(ids) <= 1 else []

    @staticmethod
    def merge(facts: Iterable[dict]) -> dict[str, Any]:
        out: dict[str, Any] = {k: ("" if k not in ("snip", "year") else None) for k in FACT_KEYS}
        for f in facts:
            for k in FACT_KEYS:
                if out[k] in ("", None) and f.get(k) not in ("", None):
                    out[k] = f[k]
        return out


class JournalTables:
    """SCImago and SNIP by ISSN (any spelling the tables hold) and year."""

    def __init__(self) -> None:
        self.sjr: dict[str, dict[int, str]] = defaultdict(dict)     # bare issn -> year -> categories_json
        self.snips: dict[str, dict[int, float]] = defaultdict(dict)
        self.titles: dict[str, set[str]] = defaultdict(set)         # normalised title -> {journal's own issn}
        self.own: dict[str, str] = {}                               # bare issn -> hyphenated, the journal's print ISSN
        for issn, eissn, year, cats, title in ScimagoJournal.objects.values_list(
            "issn", "eissn", "year", "categories_json", "title"
        ).iterator(chunk_size=5000):
            ids = [valid_issn(issn), valid_issn(eissn)]
            ids = [i for i in ids if i]
            if not ids:
                continue
            for i in ids:
                self.sjr[_bare(i)][year] = cats
            self.own[_bare(ids[0])] = ids[0]
            nt = normalize_title(title)
            if nt:
                self.titles[nt].add(ids[0])
        for p, e, year, snip, title in SnipSource.objects.values_list(
            "print_issn", "e_issn", "year", "snip", "title"
        ).iterator(chunk_size=5000):
            ids = [i for i in (valid_issn(p), valid_issn(e)) if i]
            if snip is None:
                continue
            for i in ids:
                self.snips[_bare(i)][year] = snip
            if ids:
                nt = normalize_title(title)
                if nt:
                    self.titles[nt].add(ids[0])

    @staticmethod
    def _nearest(years: Iterable[int], want: Optional[int]) -> Optional[int]:
        ys = sorted(years)
        if not ys:
            return None
        if want is None:
            return ys[-1]
        return min(ys, key=lambda y: (abs(y - want), -y))

    def quartile(self, issn: str, year: Optional[int]) -> Optional[tuple[str, int]]:
        by_year = self.sjr.get(_bare(issn))
        if not by_year:
            return None
        y = self._nearest(by_year, year)
        try:
            cats = json.loads(by_year[y])
            if isinstance(cats, str):
                from core.services.scimago import parse_categories_field

                cats = parse_categories_field(cats)
        except (ValueError, TypeError):
            return None
        qs = [c.get("quartile") for c in cats if isinstance(c, dict) and c.get("quartile") in QUARTILES]
        return (min(qs), y) if qs else None

    def snip(self, issn: str, year: Optional[int]) -> Optional[tuple[float, int]]:
        by_year = self.snips.get(_bare(issn))
        if not by_year:
            return None
        y = self._nearest(by_year, year)
        return by_year[y], y

    def issn_for_title(self, venue: str) -> str:
        """The one journal with this exact (normalised) name, else ""."""
        found = {i for i in self.titles.get(normalize_title(venue), ()) if i}
        bares = {_bare(i) for i in found}
        return next(iter(found)) if len(bares) == 1 else ""


class Context:
    """Everything the fixes read, built once per run and only when asked for."""

    def __init__(self, keep: Optional["Context"] = None) -> None:
        # The journal tables never change under a fix, so a later fix keeps them.
        self._d: dict[str, Any] = {"tables": keep._d["tables"]} if keep and "tables" in keep._d else {}

    def _lazy(self, name: str, build: Callable[[], Any]) -> Any:
        if name not in self._d:
            self._d[name] = build()
        return self._d[name]

    @property
    def directory(self) -> Directory:
        return self._lazy("dir", lambda: Directory())

    @property
    def facts(self) -> Facts:
        return self._lazy("facts", lambda: Facts())

    @property
    def tables(self) -> JournalTables:
        return self._lazy("tables", JournalTables)

    @property
    def users_by_staff(self) -> dict[str, User]:
        def build():
            out: dict[str, User] = {}
            for u in User.objects.exclude(staff_id__isnull=True).exclude(staff_id=""):
                out.setdefault(_staff_key(u.staff_id), u)
            return out
        return self._lazy("ubs", build)

    @property
    def publication_links(self) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        def build():
            claims: dict[str, list[str]] = defaultdict(list)
            ledger: dict[str, list[str]] = defaultdict(list)
            for pid, cid in Publication.claims.through.objects.values_list("publication_id", "claim_id"):
                claims[pid].append(cid)
            for pid, lid in Publication.ledger_rows.through.objects.values_list("publication_id", "paidledger_id"):
                ledger[pid].append(lid)
            return claims, ledger
        return self._lazy("plinks", build)

    def publication_facts(self, pub: Publication) -> dict[str, Any]:
        claims, ledger = self.publication_links
        f = self.facts
        found = [f.by_ledger[i] for i in ledger.get(pub.id, ()) if i in f.by_ledger]
        found += [f.by_claim[i] for i in claims.get(pub.id, ()) if i in f.by_claim]
        d = normalize_doi(pub.doi) or ""
        if d:
            found += f.by_doi.get(d, [])
        found += f.title_facts((pub.normalized_title or normalize_title(pub.title))[:512])
        return f.merge(found)

    def effective_issn(self, pub: Publication, facts: dict[str, Any]) -> str:
        """The ISSN a paper has or would be given, in the order the fixes fill it."""
        return valid_issn(pub.issn) or facts["issn"] or (self.tables.issn_for_title(pub.venue) if pub.venue else "")


# ============================================================== the fixes ==

def _label_user(u: User) -> str:
    return f"{u.name} ({u.staff_id or u.email})"


def fix_department_spelling(ctx: Context, apply: bool) -> FixResult:
    """"Civil", "S&H - Maths", "E&I", "Agri" become CIVIL, S&H-MATHS, EIE, AGRI."""
    res = FixResult("department_spelling", "Spell departments the college's way")
    unmapped: Counter = Counter()
    for model in (User, FacultyMaster, PaidLedger):
        plan = Plan(res, model, touch="updated_at" if model is User else None)
        for obj in model.objects.exclude(department__isnull=True).exclude(department="").only("id", "department"):
            if is_empty(obj.department):
                continue
            want = canonical_department(obj.department)
            if want is None:
                unmapped[clean(obj.department)] += 1
                continue
            if obj.department != want:
                plan.gap()
                plan.set(obj, "department", want, label=f"{model.__name__} {obj.pk}")
        # Counted per model so the table says where.
        before = res.rows
        plan.finish(apply)
        res.rows += before
        res.detail[model.__name__] = len(plan.objs)
    res.detail["not_in_the_map"] = dict(unmapped.most_common(20))
    return res


def fix_user_department(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("user_department", "Department on accounts, from the faculty list")
    plan = Plan(res, User)
    for u in User.objects.all():
        if not is_empty(u.department):
            person = ctx.directory.of(u)
            want = canonical_department(person["department"]) if person else None
            have = canonical_department(u.department)
            if want and have and want != have:
                plan.conflict(_label_user(u), "department", u.department, person["department"], u.id)
            continue
        plan.gap()
        person = ctx.directory.of(u)
        if not person:
            plan.skip("not on the faculty list")
            continue
        want = canonical_department(person["department"])
        if not want:
            plan.skip("the list's department is not in the college's set" if person["department"] else "the list has no department")
            continue
        plan.set(u, "department", want, label=_label_user(u))
    return plan.finish(apply)


def fix_user_designation(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("user_designation", "Designation on accounts, from the faculty list")
    plan = Plan(res, User)
    key = lambda s: re.sub(r"[^a-z0-9]+", "", clean(s).lower())  # noqa: E731
    for u in User.objects.all():
        person = ctx.directory.of(u)
        if not is_empty(u.designation):
            if person and not is_empty(person["designation"]) and key(person["designation"]) != key(u.designation):
                plan.conflict(_label_user(u), "designation", u.designation, person["designation"], u.id)
            continue
        plan.gap()
        if not person:
            plan.skip("not on the faculty list")
        elif is_empty(person["designation"]):
            plan.skip("the list has no designation")
        else:
            plan.set(u, "designation", clean(person["designation"])[:128], label=_label_user(u))
    return plan.finish(apply)


def fix_user_staff_id(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("user_staff_id", "Staff ID on accounts, found by email on the faculty list")
    plan = Plan(res, User)
    taken = {_staff_key(u.staff_id) for u in User.objects.exclude(staff_id__isnull=True).exclude(staff_id="")}
    for u in User.objects.filter(active=True):
        if not is_empty(u.staff_id):
            continue
        plan.gap()
        person = ctx.directory.by_email.get((u.email or "").strip().lower())
        if not person or not person["staff_id"]:
            plan.skip("the email is not on the faculty list")
        elif _staff_key(person["staff_id"]) in taken:
            plan.conflict(_label_user(u), "staff_id", "", person["staff_id"], u.id)
            plan.skip("the list's Staff ID belongs to another account")
        else:
            taken.add(_staff_key(person["staff_id"]))
            plan.set(u, "staff_id", person["staff_id"][:64], label=_label_user(u))
    return plan.finish(apply)


def fix_user_placeholder_name(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("user_placeholder_name", 'Names that read "Not Found", from the faculty list')
    plan = Plan(res, User)
    for u in User.objects.all():
        if not is_empty(u.name):
            continue
        plan.gap()
        person = ctx.directory.of(u)
        if person and not is_empty(person["name"]):
            plan.set(u, "name", clean(person["name"])[:255], label=_label_user(u))
        else:
            plan.skip("not on the faculty list")
    return plan.finish(apply)


def fix_ledger_department(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("ledger_department", "Department on payment rows, from the person's account")
    plan = Plan(res, PaidLedger, touch=None)
    for row in PaidLedger.objects.only("id", "department", "staff_id", "faculty_name", "raw_json").iterator(chunk_size=1000):
        u = ctx.users_by_staff.get(_staff_key(row.staff_id))
        person = ctx.directory.by_staff.get(_staff_key(row.staff_id))
        if not is_empty(row.department):
            have = canonical_department(row.department)
            now = canonical_department(u.department) if u and not is_empty(u.department) else None
            if have and now and have != now:
                plan.conflict(f"{row.faculty_name} ({row.staff_id})", "department", row.department, u.department, row.id)
            continue
        plan.gap()
        want = None
        if u and not is_empty(u.department):
            want = canonical_department(u.department)
        if not want and person:
            want = canonical_department(person["department"])
        if not want:
            try:
                want = canonical_department((json.loads(row.raw_json or "{}") or {}).get("Department"))
            except (ValueError, AttributeError):
                want = None
        if want:
            plan.set(row, "department", want, label=f"{row.faculty_name} ({row.staff_id})")
        else:
            plan.skip("no account, list entry or sheet row names a department")
    return plan.finish(apply)


def fix_ledger_journal_title(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("ledger_journal_title", "Journal on payment rows, from the same paper elsewhere")
    plan = Plan(res, PaidLedger, touch=None)
    f = ctx.facts
    for row in PaidLedger.objects.only("id", "journal_title", "staff_id", "paper_title", "faculty_name").iterator(chunk_size=1000):
        if clean_venue(row.journal_title):
            continue
        plan.gap()
        found = []
        own = f.by_ledger.get(row.id)
        if own:
            found.append(own)
        nt = normalize_title(row.paper_title)[:512]
        found += f.by_person_title.get((_staff_key(row.staff_id), nt), [])
        d = (own or {}).get("doi")
        if d:
            found += f.by_doi.get(d, [])
        journal = f.merge(found)["journal"]
        if journal:
            plan.set(row, "journal_title", journal[:512], label=f"{row.faculty_name} ({row.staff_id})")
        else:
            plan.skip("no other record of the paper names a journal")
    return plan.finish(apply)


def fix_claim_designation(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("claim_designation", "Designation on claims, from the claimant's account")
    plan = Plan(res, Claim)
    for c in Claim.objects.select_related("owner").only("id", "designation", "ticket_number", "owner__designation", "owner__staff_id", "owner__email"):
        if not is_empty(c.designation):
            continue
        plan.gap()
        want = c.owner.designation if c.owner_id and not is_empty(c.owner.designation) else ""
        if not want and c.owner_id:
            person = ctx.directory.of(c.owner)
            want = person["designation"] if person and not is_empty(person["designation"]) else ""
        if want:
            plan.set(c, "designation", clean(want)[:128], label=c.ticket_number or c.id)
        else:
            plan.skip("the claimant has no designation anywhere")
    return plan.finish(apply)


def fix_claim_journal_fields(ctx: Context, apply: bool) -> FixResult:
    """ISSN, DOI, EID and subject on any claim; quartile, SNIP and engineering
    class only on a claim already paid (an open claim is priced from verified
    figures, which this never supplies)."""
    res = FixResult("claim_journal_fields", "Journal fields on claims, from the settled-claims sheet and journal tables")
    plan = Plan(res, Claim)
    f, tables = ctx.facts, ctx.tables
    for c in Claim.objects.select_related("owner"):
        paid = c.status == ClaimStatus.PAID
        wants: dict[str, Any] = {}
        nt = normalize_title(c.paper_title)[:512]
        found = []
        d = normalize_doi(c.doi) or ""
        if d:
            found += f.by_doi.get(d, [])
        found += f.by_person_title.get((_staff_key(c.owner.staff_id), nt), []) if c.owner_id else []
        # What other records say about this paper; the claim's own copy is what is being compared.
        own = f.by_claim.get(c.id)
        m = f.merge(x for x in found if x is not own)
        pairs = [("issn", "issn", is_empty(c.issn)), ("doi", "doi", is_empty(c.doi)),
                 ("eid", "eid", is_empty(c.eid)), ("subject_category", "subject", is_empty(c.subject_category))]
        if paid:
            pairs += [("quartile", "quartile", is_empty(c.quartile)), ("snip", "snip", c.snip is None),
                      ("engineering_class", "eng_class", is_empty(c.engineering_class))]
        gap_here = False
        for column, key, blank in pairs:
            incoming, have = m.get(key), getattr(c, column)
            if blank:
                gap_here = True
                if incoming not in ("", None):
                    wants[column] = incoming
            elif incoming not in ("", None) and column != "subject_category":
                if column == "issn":
                    differs = bool(valid_issn(have)) and valid_issn(have) != incoming
                elif column == "doi":
                    differs = normalize_doi(have) != incoming
                elif column == "snip":
                    differs = abs(float(have) - float(incoming)) > 0.0005
                else:
                    differs = str(have).strip().upper() != str(incoming).strip().upper()
                if differs:
                    plan.conflict(c.ticket_number or c.id, column, have, incoming, c.id)
        # Journal tables: quartile and SNIP from the ISSN and the paper's year.
        issn = valid_issn(c.issn) or wants.get("issn") or ""
        year = c.publication_year or m.get("year")
        sources: dict[str, str] = {}
        if paid and issn:
            if is_empty(c.quartile) and "quartile" not in wants:
                got = tables.quartile(issn, year)
                if got:
                    wants["quartile"], sources["quartile_source"] = got[0], "SCIMAGO"
            if c.snip is None and "snip" not in wants:
                got = tables.snip(issn, year)
                if got:
                    wants["snip"], sources["snip_source"] = got[0], "SNIP_DUMP"
                    wants["snip_year"] = got[1]
        if gap_here:
            plan.gap()
        if not wants:
            if gap_here:
                plan.skip("no sheet row or journal table has it")
            continue
        for column, value in wants.items():
            plan.set(c, column, value, label=c.ticket_number or c.id)
        for column, value in sources.items():
            setattr(c, column, value)
            plan.cols.add(column)
    return plan.finish(apply)


def fix_issn_form(ctx: Context, apply: bool) -> FixResult:
    """"2196220", "20452322.0" on claims and papers become 0219-6220, 2045-2322. Same ISSN, written the standard way."""
    res = FixResult("issn_form", "Write ISSNs the standard way (1234-5678)")
    for model, touch in ((Claim, "updated_at"), (Publication, "updated_at")):
        plan = Plan(res, model, touch=touch)
        for obj in model.objects.exclude(issn__isnull=True).exclude(issn="").only("id", "issn"):
            good = valid_issn(obj.issn)
            if good and good != obj.issn:
                plan.gap()
                plan.set(obj, "issn", good, label=f"{model.__name__} {obj.pk}")
        before = res.rows
        plan.finish(apply)
        res.rows += before
        res.detail[model.__name__] = len(plan.objs)
    return res


def fix_publication_journal_fields(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("publication_journal_fields", "Journal, ISSN, quartile and DOI on papers, from the college's own records")
    plan = Plan(res, Publication)
    holders: dict[str, str] = {}
    for pid, d in Publication.objects.exclude(doi__isnull=True).exclude(doi="").values_list("id", "doi"):
        holders.setdefault(normalize_doi(d) or d, pid)
    for pub in Publication.objects.all().iterator(chunk_size=1000):
        m = ctx.publication_facts(pub)
        gap = False
        label = (pub.title or pub.id)[:70]
        blanks = {"venue": not clean_venue(pub.venue), "issn": is_empty(pub.issn),
                  "type": is_empty(pub.type), "quartile": not _quartile(pub.quartile), "doi": is_empty(pub.doi),
                  "eid": is_empty(pub.eid)}
        got = {"venue": m["journal"], "issn": m["issn"], "type": m["doc_type"], "quartile": m["quartile"],
               "doi": m["doi"], "eid": m["eid"]}
        for column, blank in blanks.items():
            if blank:
                gap = gap or column in ("venue", "issn", "quartile")
                value = got[column]
                if not value:
                    continue
                if column == "doi" and holders.get(value, pub.id) != pub.id:
                    plan.conflict(label, "doi", "", value, pub.id)
                    continue
                if column == "doi":
                    holders[value] = pub.id
                plan.set(pub, column, value[:512] if column == "venue" else value[:64] if column in ("issn", "type") else value, label=label)
            elif column in ("issn", "quartile") and got[column]:
                current = valid_issn(pub.issn) if column == "issn" else _quartile(pub.quartile)
                if current and current != got[column]:
                    plan.conflict(label, column, getattr(pub, column), got[column], pub.id)
        if gap:
            plan.gap()
            if pub.id not in plan.objs:
                plan.skip("no claim, payment row or settled sheet row for the paper")
    return plan.finish(apply)


def fix_publication_issn_from_journals(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("publication_issn_from_journals", "ISSN on papers, from the journal's name in the SCImago and SNIP tables")
    plan = Plan(res, Publication)
    for pub in Publication.objects.filter(issn="").exclude(venue="").iterator(chunk_size=1000):
        if valid_issn(pub.issn) or not clean_venue(pub.venue):
            continue
        plan.gap()
        m = ctx.publication_facts(pub)
        if m["issn"]:
            plan.skip("the record fix gives it")
            continue
        issn = ctx.tables.issn_for_title(pub.venue)
        if issn:
            plan.set(pub, "issn", issn, label=(pub.title or pub.id)[:70])
        else:
            plan.skip("the journal's name matches no journal, or more than one")
    return plan.finish(apply)


def fix_publication_quartile_from_journals(ctx: Context, apply: bool) -> FixResult:
    res = FixResult("publication_quartile_from_journals", "Quartile on papers, from the SCImago table by ISSN and year")
    plan = Plan(res, Publication)
    for pub in Publication.objects.filter(quartile="").iterator(chunk_size=1000):
        plan.gap()
        m = ctx.publication_facts(pub)
        if m["quartile"]:
            plan.skip("the record fix gives it")
            continue
        issn = ctx.effective_issn(pub, m)
        if not issn:
            plan.skip("the paper has no ISSN and no journal name that matches one")
            continue
        got = ctx.tables.quartile(issn, pub.year or m["year"])
        if got:
            plan.set(pub, "quartile", got[0], label=(pub.title or pub.id)[:70])
            res.detail.setdefault("table_year_matches_paper", 0)
            if got[1] == pub.year:
                res.detail["table_year_matches_paper"] += 1
        else:
            plan.skip("the journal has no quartile in the SCImago table")
    return plan.finish(apply)


# ----------------------------------------------- unknown authors' departments --

_COLLEGE_SEGMENT = re.compile(r"saveetha\s+eng", re.I)


def _dept_patterns() -> list[tuple[str, re.Pattern]]:
    from core.services.author_names import DEPARTMENT_WORDS

    out = []
    for code, words in DEPARTMENT_WORDS.items():
        alt = "|".join(r"\b" + re.escape(w.strip()) for w in words if w.strip())
        out.append((code, re.compile(alt, re.I)))
    return out


_PATTERNS: Optional[list[tuple[str, re.Pattern]]] = None


def department_from_affiliation(raw: Optional[str]) -> Optional[str]:
    """The one department an author's own affiliation line names for the college.

    Only a part of the line (they are separated by ";") that names the college
    counts. "Computer science" inside a cyber-security or IoT name is the more
    specific one. Two different departments means nobody is named: None.
    """
    global _PATTERNS
    if _PATTERNS is None:
        _PATTERNS = _dept_patterns()
    found: set[str] = set()
    for part in (raw or "").split(";"):
        if not _COLLEGE_SEGMENT.search(part):
            continue
        found |= {code for code, pat in _PATTERNS if pat.search(part)}
    if {"CSE", "CSE - CS"} <= found or {"CSE", "CSE - IoT"} <= found:
        found.discard("CSE")
    return next(iter(found)) if len(found) == 1 else None


class UnlinkedAuthors:
    """Departments for college authors no account claims: a listed person with
    no account (by name, exactly one fits) or the author's own affiliation."""

    def __init__(self) -> None:
        from core.services.author_names import name_parts

        self._name_parts = name_parts
        accounts = {_staff_key(s) for s in User.objects.exclude(staff_id__isnull=True).values_list("staff_id", flat=True)}
        self.people: list[tuple[str, str]] = []
        self.by_token: dict[str, list[int]] = defaultdict(list)
        for m in FacultyMaster.objects.all():
            dept = canonical_department(m.department)
            if _staff_key(m.staff_id) in accounts or not dept or not m.name:
                continue
            idx = len(self.people)
            self.people.append((m.name, dept))
            full, _ = name_parts(m.name)
            for t in set(full) | {"".join(full)}:
                self.by_token[t].append(idx)

    def department(self, display_name: str, raw_affiliation: str) -> Optional[str]:
        from core.services.author_names import name_score, surname_and_initial_agree

        full, _ = self._name_parts(display_name)
        seen = {i for t in set(full) | {"".join(full)} for i in self.by_token.get(t, ())}
        hits = [i for i in seen if name_score(display_name, self.people[i][0]) >= 0.85
                and surname_and_initial_agree(display_name, self.people[i][0])]
        if hits:
            depts = {self.people[i][1] for i in hits}
            return next(iter(depts)) if len(depts) == 1 else None
        return department_from_affiliation(raw_affiliation)


def derive_author_departments() -> UnlinkedAuthors:
    return UnlinkedAuthors()


def fix_authorship_department(ctx: Context, apply: bool) -> FixResult:
    """Read-time: reports give a paper the department of an author no account
    claims. There is no column to write, so there is nothing to apply."""
    res = FixResult("authorship_department", "Department of college authors with no account", kind="derived")
    ua = UnlinkedAuthors()
    papers_gap: set[str] = set()
    papers_filled: set[str] = set()
    by_dept: Counter = Counter()
    for pid, display, raw, udept in Authorship.objects.filter(is_college=True).values_list(
        "publication_id", "display_name", "raw_affiliation", "user__department"
    ):
        if udept and not is_empty(udept):
            continue
        res.gap_rows += 1
        papers_gap.add(pid)
        d = ua.department(display, raw)
        if d:
            res.rows += 1
            papers_filled.add(pid)
            by_dept[d] += 1
        else:
            res.reasons["no listed person fits the name and the affiliation line names no one department"] += 1
    res.detail.update(papers_with_the_gap=len(papers_gap), papers_given_a_department=len(papers_filled),
                      by_department=dict(by_dept.most_common(30)))
    return res


def fix_faculty_type_review(ctx: Context, apply: bool) -> FixResult:
    """The list's "Research" sheet people whose account says Regular. It changes
    how an incentive is paid, so a person decides; nothing is written."""
    res = FixResult("faculty_type_review", "Research faculty still marked Regular (a person decides)", kind="review")
    for u in User.objects.filter(active=True, faculty_type="REGULAR"):
        person = ctx.directory.of(u)
        if person and person["research"]:
            res.rows += 1
            res.gap_rows += 1
            if len(res.samples) < SAMPLE_CAP:
                res.samples.append({"row": _label_user(u), "field": "faculty_type", "from": "REGULAR", "to": "RESEARCH"})
    return res


# ------------------------------------------------ author matches from files --

def open_name_queue() -> int:
    """The Author matches queue: names with a college authorship nobody has placed."""
    from core.services import author_review
    from core.models import AuthorAlias

    decided = set(AuthorAlias.objects.values_list("name_key", flat=True))
    return sum(1 for k in author_review._groups() if k not in decided)


def _rejected_scopus_ids() -> set[str]:
    """Ids a person said are not theirs, or the office kept the app's value over."""
    out: set[str] = set()
    for detail in AuditLog.objects.filter(action="SCOPUS_PROFILE_DISPUTED").values_list("detail_json", flat=True):
        try:
            sid = str((json.loads(detail or "{}") or {}).get("scopus_author_id") or "").strip()
        except (ValueError, AttributeError):
            continue
        if sid:
            out.add(sid)
    from core.models import ImportConflict

    for c in ImportConflict.objects.filter(kind="faculty", key__endswith=":scopus_author_id").exclude(status="open"):
        if c.status == "dismissed" or c.resolution == "keep_app":
            inc = str((c.payload or {}).get("incoming") or "").strip()
            if inc:
                out.add(inc)
    return out


def fix_author_matches_from_files(ctx: Context, apply: bool) -> FixResult:
    """Who wrote what, from the files the college gave.

    1. Each settled-claims row names the Faculty ID that was paid for a paper
       (DOI and title). That person's account is put on the paper's matching
       unlinked author name ("record", 0.95), when exactly one name on the
       paper plausibly is theirs; any pending suggestion for it is closed. A
       paper with no such name is listed, never guessed.
    2. After the links, the app's own matcher runs again, so names the links
       answer leave the queue (an apply only).
    3. The list's Scopus ID goes on a person who has none, unless another
       active account holds it or it was rejected before.

    Never relinks a paper somebody reported as not theirs, never touches a row
    a person locked, never removes a link.
    """
    from core.services import publications as pubs

    res = FixResult("author_matches_from_files", "Author matches, from the settled claims and the faculty list")
    res.detail.update(links_by_source=Counter(), scopus_ids_set=0, queue_before=open_name_queue(), left=[])
    f = ctx.facts
    index = pubs._Index()
    blocked = pubs.disputed_pairs()
    seen_pairs: set[tuple[str, str]] = set()
    planned: list[tuple[Authorship, User, str]] = []
    claimed_rows: set[str] = set()
    left: list[dict[str, Any]] = res.detail["left"]

    told: set[tuple[str, str, str]] = set()

    def leave(reason: str, rec: dict[str, Any], person: Optional[User] = None) -> None:
        once = (reason, rec["staff"], rec["doi"] or rec["ntitle"])
        if once in told:
            return
        told.add(once)
        res.reasons[reason] += 1
        if len(left) < 200:
            left.append({"reason": reason, "staff_id": rec["staff"], "person": person.name if person else "",
                         "paper": rec["title"], "doi": rec["doi"]})

    pub_rows: dict[str, list[Authorship]] = {}

    def rows_of(pid: str) -> list[Authorship]:
        if pid not in pub_rows:
            pub_rows[pid] = list(Authorship.objects.filter(publication_id=pid))
        return pub_rows[pid]

    for rec in f.paid:
        if rec["source"] == "claim":
            continue
        user = ctx.users_by_staff.get(rec["staff"])
        pid = index.find(rec["doi"] or None, None, rec["ntitle"])
        if pid is None:
            res.reasons["the paper is not in the publication record"] += 1
            continue
        if user is None:
            leave("the Faculty ID has no account", rec)
            continue
        if not user.active:
            leave("the account is switched off", rec, user)
            continue
        if (user.id, pid) in seen_pairs:
            continue
        seen_pairs.add((user.id, pid))
        res.gap_rows += 1
        if (user.id, pid) in blocked:
            leave("the person reported the paper as not theirs", rec, user)
            continue
        rows = rows_of(pid)
        if any(r.user_id == user.id for r in rows):
            res.gap_rows -= 1
            res.reasons["already linked"] += 1
            continue
        free = [r for r in rows if not r.user_id and not r.match_locked and r.pk not in claimed_rows]
        best = pubs._best_row(free, user.name, require_free=True, floor=0.8)
        if best is None or not pubs.surname_and_initial_agree(best.display_name, user.name):
            locked = [r for r in rows if r.match_locked and not r.user_id]
            if locked and pubs._best_row(locked, user.name, require_free=True, floor=0.8):
                leave("the matching author name was locked by a person", rec, user)
            else:
                leave("no unlinked author name on the paper plausibly matches", rec, user)
            continue
        claimed_rows.add(best.pk)
        planned.append((best, user, rec["source"]))
        res.detail["links_by_source"]["payment records" if rec["source"] == "ledger" else "prior payments"] += 1

    # 3. Scopus ids
    scopus: list[tuple[User, str]] = []
    rejected = _rejected_scopus_ids()
    from core.services.scopus_profiles import normalize_scopus_id

    held: dict[str, str] = {}
    for sid, uid in User.objects.filter(active=True).exclude(scopus_author_id__isnull=True).exclude(scopus_author_id="").values_list("scopus_author_id", "id"):
        held[normalize_scopus_id(sid) or sid] = uid
    scopus_gap = 0
    for u in User.objects.filter(active=True):
        if normalize_scopus_id(u.scopus_author_id) or normalize_scopus_id(u.scopus_author_url):
            continue
        person = ctx.directory.of(u)
        sid = normalize_scopus_id(person["scopus_id"]) if person else None
        if not sid:
            continue
        scopus_gap += 1
        if sid in rejected:
            res.reasons["the Scopus id was rejected before"] += 1
        elif sid in held and held[sid] != u.id:
            res.reasons["another active account holds that Scopus id"] += 1
        else:
            held[sid] = u.id
            scopus.append((u, sid))
    res.gap_rows += scopus_gap

    res.rows = len(planned) + len(scopus)
    res.fields["authorship_user"] = len(planned)
    res.fields["scopus_author_id"] = len(scopus)
    for row, user, _src in planned[:SAMPLE_CAP]:
        res.samples.append({"row": row.display_name, "field": "authorship_user", "from": None, "to": user.name})
    res.detail["links_by_source"] = dict(res.detail["links_by_source"])
    res.detail["scopus_ids_to_set"] = len(scopus)

    if apply:
        from core.services.aggregate_cache import bump
        from core.services.scopus import author_profile_url

        closed = 0
        for row, user, _src in planned:
            row.user, row.match_confidence, row.match_method, row.is_college = user, 0.95, "record", True
            row.save(update_fields=["user", "match_confidence", "match_method", "is_college"])
            closed += PaperCandidate.objects.filter(
                user=user, publication_id=row.publication_id, status=PaperCandidate.Status.PENDING
            ).update(status=PaperCandidate.Status.CONFIRMED, decided_at=timezone.now())
        res.detail["suggestions_closed"] = closed
        bump()
        # 2. the app's own matcher, so the names these links answer leave the queue.
        # The matcher starts by clearing the links it inferred and then derives
        # them again under today's gate. Nothing here is ever unlinked, so a
        # link it cleared and did not make again is put back (unless the person
        # reported the paper as not theirs, or they now hold another row on it).
        links = {pk: (uid, conf, method, pid) for pk, uid, conf, method, pid in Authorship.objects.filter(
            user__isnull=False).values_list("id", "user_id", "match_confidence", "match_method", "publication_id")}
        pubs.match_authors()
        held = {(pid, uid) for pid, uid in Authorship.objects.filter(user__isnull=False).values_list("publication_id", "user_id")}
        back = []
        for row in Authorship.objects.filter(id__in=list(links), user__isnull=True):
            uid, conf, method, pid = links[row.pk]
            if (uid, pid) in blocked or (pid, uid) in held:
                continue
            row.user_id, row.match_confidence, row.match_method = uid, conf, method
            held.add((pid, uid))
            back.append(row)
        if back:
            Authorship.objects.bulk_update(back, ["user", "match_confidence", "match_method"], batch_size=500)
        pubs.refresh_metrics()
        res.detail["matcher_links_after"] = Authorship.objects.filter(user__isnull=False).count() - len(links)
        res.detail["matcher_unlinks_put_back"] = len(back)
        for u, sid in scopus:
            u.scopus_author_id = sid
            if not (u.scopus_author_url or "").strip():
                u.scopus_author_url = author_profile_url(sid)
            u.save(update_fields=["scopus_author_id", "scopus_author_url", "updated_at"])
        res.detail["scopus_ids_set"] = len(scopus)
        bump()
        res.detail["queue_after"] = open_name_queue()
        res.applied = True
    res.detail["left_for_a_person"] = sum(
        n for r, n in res.reasons.items() if not r.startswith(("already", "the paper is not")))
    return res


# ------------------------------------------------------------------ registry --

@dataclass(frozen=True)
class Fix:
    key: str
    label: str
    help: str
    kind: str                       # write | derived | review
    fn: Callable[[Context, bool], FixResult]
    safe: bool = True


FIXES: tuple[Fix, ...] = (
    Fix("department_spelling", "Spell departments the college's way",
        'Civil, S&H - Maths, E&I and Agri become CIVIL, S&H-MATHS, EIE and AGRI on accounts, the faculty list and payment rows.',
        "write", fix_department_spelling),
    Fix("user_department", "Department on accounts, from the faculty list",
        "An account with no department, or one that says Not Found, takes the one the faculty list gives.",
        "write", fix_user_department),
    Fix("user_designation", "Designation on accounts, from the faculty list",
        "An account with no designation takes the list's.", "write", fix_user_designation),
    Fix("user_staff_id", "Staff ID on accounts, found by email",
        "An account with no Staff ID takes the one the list gives for the same email, if nobody else has it.",
        "write", fix_user_staff_id),
    Fix("user_placeholder_name", 'Names that read "Not Found"',
        "An account created from an old payment row takes the name the faculty list gives.",
        "write", fix_user_placeholder_name),
    Fix("ledger_department", "Department on payment rows",
        "A payment row with no department takes the department of the person's account, else the list's.",
        "write", fix_ledger_department),
    Fix("ledger_journal_title", "Journal on payment rows",
        "A payment row with no journal takes it from another record of the same paper. No amount changes.",
        "write", fix_ledger_journal_title),
    Fix("claim_designation", "Designation on claims",
        "A claim with no designation takes the claimant's.", "write", fix_claim_designation),
    Fix("claim_journal_fields", "Journal fields on claims",
        "ISSN, DOI, EID and subject from the settled-claims sheet; quartile, SNIP and class only on paid claims.",
        "write", fix_claim_journal_fields),
    Fix("issn_form", "Write ISSNs the standard way",
        "20452322.0 and 2196220 become 2045-2322 and 0219-6220. The same ISSN, written once.",
        "write", fix_issn_form),
    Fix("publication_journal_fields", "Journal, ISSN, quartile and DOI on papers",
        "From the claims and payment rows that are the paper, found by DOI, then by exact title.",
        "write", fix_publication_journal_fields),
    Fix("publication_issn_from_journals", "ISSN on papers, from the journal's name",
        "Only when exactly one journal in the SCImago and SNIP tables has that name.",
        "write", fix_publication_issn_from_journals),
    Fix("publication_quartile_from_journals", "Quartile on papers, from SCImago",
        "From the paper's ISSN and year (the nearest year the table holds).",
        "write", fix_publication_quartile_from_journals),
    Fix("author_matches_from_files", "Author matches, from the college's files",
        "Puts the person paid for a paper on its matching author name, re-runs the matcher, and gives a Scopus ID to "
        "people with none. Never relinks a paper reported as not theirs.",
        "write", fix_author_matches_from_files),
    Fix("authorship_department", "Department of authors with no account",
        "Reports give such a paper the department the list or the author's own affiliation names. Nothing to apply.",
        "derived", fix_authorship_department),
    Fix("faculty_type_review", "Research faculty still marked Regular",
        "Changes how an incentive is paid, so a person sets it. Listed here, never changed.",
        "review", fix_faculty_type_review, safe=False),
)
BY_KEY = {f.key: f for f in FIXES}
WRITE_KEYS = tuple(f.key for f in FIXES if f.kind == "write" and f.safe)


class UnknownFix(KeyError):
    pass


def _chosen(keys: Optional[Iterable[str]]) -> list[Fix]:
    if not keys:
        return list(FIXES)
    bad = [k for k in keys if k not in BY_KEY]
    if bad:
        raise UnknownFix(", ".join(bad))
    wanted = set(keys)
    return [f for f in FIXES if f.key in wanted]


def run(keys: Optional[Iterable[str]] = None, *, apply: bool = False, actor: Optional[User] = None,
        context: Optional[Context] = None) -> list[FixResult]:
    """Dry run (default) or apply. An apply is one transaction and one AuditLog
    row per fix, in the registry's order, each seeing what the earlier ones wrote."""
    fixes = _chosen(keys)
    results: list[FixResult] = []
    shared = context or Context()
    for fix in fixes:
        if fix.kind != "write" or not apply:
            results.append(fix.fn(shared, False))
            continue
        # What an earlier fix wrote is what this one reads, so the sources are read again.
        ctx = Context(keep=shared)
        with transaction.atomic():
            res = fix.fn(ctx, True)
            AuditLog.objects.create(
                actor=actor, action="DATA_FILL", entity="DataFill", entity_id=fix.key,
                detail_json=json.dumps({
                    "fix": fix.key, "label": fix.label, "rows_filled": res.rows, "fields": dict(res.fields),
                    "conflicts": res.conflict_count, "unresolved": res.unresolved,
                    "detail": res.detail if fix.key == "author_matches_from_files" else {},
                }, default=str),
            )
        from core.services.aggregate_cache import bump

        bump()
        results.append(res)
    return results


def store_report(results: list[FixResult]) -> dict[str, Any]:
    """Keep the latest dry-run figures so the Data health page opens instantly."""
    old = (SystemSetting.objects.filter(key=REPORT_KEY).first() or SystemSetting(key=REPORT_KEY, value={})).value or {}
    by_key = {r["key"]: r for r in old.get("fixes", [])}
    now = timezone.now().isoformat()
    for r in results:
        d = r.as_dict()
        d["checked_at"] = now
        d["conflicts"] = d["conflicts"][:10]
        by_key[r.key] = d
    report = {"fixes": [by_key[f.key] for f in FIXES if f.key in by_key], "updated_at": now}
    SystemSetting.objects.update_or_create(key=REPORT_KEY, defaults={"value": report})
    return report


def last_report() -> Optional[dict[str, Any]]:
    row = SystemSetting.objects.filter(key=REPORT_KEY).first()
    return row.value if row else None


def accounts_without_department(limit: int = 500) -> list[dict[str, Any]]:
    """Active accounts whose department is blank or a stand-in: the list to fix."""
    out = []
    for u in User.objects.filter(active=True).order_by("name"):
        if is_empty(u.department):
            out.append({"id": u.id, "name": u.name, "email": u.email, "role": u.role,
                        "staff_id": u.staff_id or "", "designation": u.designation or ""})
    return out[:limit]


# ------------------------------------------------- the safe fills, as one job --

#: The column a fix wrote -> the words the import result and the report use.
_WORDS = {
    "department": "departments", "designation": "designations", "venue": "journals", "journal_title": "journals",
    "issn": "ISSNs", "quartile": "quartiles", "snip": "SNIP figures", "doi": "DOIs", "eid": "Scopus EIDs",
    "authorship_user": "author links", "scopus_author_id": "Scopus IDs", "staff_id": "Staff IDs", "name": "names",
    "subject_category": "journal details", "engineering_class": "journal details",
    "type": "journal details", "snip_year": None,
}


def summarise(results: list[FixResult]) -> dict[str, Any]:
    """The counts of an apply, in the order a person reads them."""
    counts: Counter = Counter()
    for r in results:
        if r.kind != "write":
            continue
        for column, n in r.fields.items():
            word = _WORDS.get(column, "other details")
            if word:
                counts[word] += n
    order = ["departments", "designations", "journals", "ISSNs", "quartiles", "SNIP figures", "DOIs",
             "Scopus EIDs", "journal details", "author links", "Scopus IDs", "Staff IDs", "names", "other details"]
    parts = [f"{counts[w]:,} {w}" for w in order if counts[w]]
    return {
        "counts": {w: counts[w] for w in order if counts[w]},
        "text": ("Filled: " + ", ".join(parts)) if parts else "Nothing left to fill from the college's files.",
        "conflicts": sum(r.conflict_count for r in results),
        "fixes": [{"key": r.key, "rows": r.rows, "fields": dict(r.fields), "conflicts": r.conflict_count,
                   "left": r.unresolved} for r in results if r.kind == "write"],
    }


def run_safe_fills(actor: Optional[User] = None, source: str = "",
                   keys: Optional[Iterable[str]] = None) -> dict[str, Any]:
    """Every safe fix, applied one after another. One failing fix is reported
    and the rest still run: an import must not lose its fills to one bad row."""
    results: list[FixResult] = []
    errors: dict[str, str] = {}
    for key in (list(keys) if keys else WRITE_KEYS):
        if key not in WRITE_KEYS:
            errors[key] = "not a fix that can be applied"
            continue
        try:
            results.extend(run([key], apply=True, actor=actor))
        except Exception as exc:  # noqa: BLE001
            errors[key] = f"{type(exc).__name__}: {exc}"[:300]
    store_report(results)
    out = summarise(results)
    out["errors"] = errors
    out["source"] = source
    return out


def queue_fills(actor: Optional[User], source: str, keys: Optional[list[str]] = None) -> dict[str, Any]:
    """Queue the safe fills on the job queue and say which job. In tests and
    wherever the queue runs inline (Q_SYNC), the job has finished on return."""
    from django_q.tasks import async_task

    job_id = async_task("core.tasks.run_data_fill", actor.id if actor else None, source, keys, timeout=3300)
    return {"queued": True, "job_id": job_id}


def queue_once_after_deploy() -> str:
    """Called from the container's start-up. With DATA_FILL_ON_DEPLOY set to a
    run id ("2026-11-17"), the fills are queued once for that id: the id is
    kept, so a restart or the next deploy with the same value does nothing.
    Returns what happened, in a word."""
    from django.conf import settings

    run_id = str(getattr(settings, "DATA_FILL_ON_DEPLOY", "") or "").strip()
    if not run_id:
        return "off"
    row = SystemSetting.objects.filter(key=DEPLOY_KEY).first()
    if row and (row.value or {}).get("run_id") == run_id:
        return "already queued"
    out = queue_fills(None, f"deploy:{run_id}")
    SystemSetting.objects.update_or_create(
        key=DEPLOY_KEY, defaults={"value": {"run_id": run_id, "state": "queued", **out}}
    )
    return "queued"
