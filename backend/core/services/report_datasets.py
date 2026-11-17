"""The Report studio's five datasets: what each is, which fields it has and who sees which rows.

A dataset is a queryset plus a whitelist of named fields. Every field is an ORM
expression written here, so a report definition (which is only names) can never
reach a column, a join or a function that is not listed. The engine
(`report_engine`) turns names into these expressions; nothing a person types is
ever used as SQL.

Who sees what is decided once, by `viewer_for`:

- The roles that oversee the scheme (`rbac.can_view_college_wide`) see the
  whole college. Claims keep the one rule every claim list keeps: nobody's
  draft but their own (`claim_scope`).
- A head of department sees their own department, from their own account and
  never from a request, and no money: every money field, and the dates that
  say a payment happened, are not in their field list at all, and the payments
  dataset is not offered to them (`search.money.may_see_money`). A claim's
  status reaches them as the progress word `hod.PROGRESS` gives, never the
  desk it sits at.
- Everyone else sees only their own rows, with the words a claimant is given
  (`visibility.faculty_stage`): the step, never the desk or the person.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Optional

from django.db.models import (
    BooleanField,
    Case,
    CharField,
    Count,
    DateField,
    Exists,
    ExpressionWrapper,
    F,
    FloatField,
    Func,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Cast, Coalesce, Concat, ExtractMonth, ExtractYear, Substr, TruncDate
from django.db.models.lookups import IsNull, LessThan
from django.utils import timezone

from core import hod
from core.models import (
    Authorship,
    Claim,
    ClaimStatus,
    FacultyMaster,
    PaidLedger,
    Role,
    SnipSource,
    Team,
    TeamMember,
    User,
)
from core.services import claim_scope, rbac
from core.services.search import money

SCOPE_COLLEGE = "college"
SCOPE_DEPARTMENT = "department"
SCOPE_OWN = "own"

TYPES = ("string", "number", "money", "date", "enum", "bool")
QUARTILES = ["Q1", "Q2", "Q3", "Q4"]


# --------------------------------------------------------------- the viewer --


@dataclass(frozen=True)
class Viewer:
    """Who is asking, reduced to what decides rows and fields."""

    user: Any
    scope: str
    department: str
    sees_money: bool
    #: First month of the academic year (6 = 1 June), a policy setting.
    year_start_month: int
    today: date

    @property
    def role(self) -> str:
        return getattr(self.user, "role", "") or ""


def viewer_for(user) -> Viewer:
    from core.services import research_threshold

    if rbac.can_view_college_wide(user.role):
        scope = SCOPE_COLLEGE
    elif user.role == Role.HOD:
        scope = SCOPE_DEPARTMENT
    else:
        scope = SCOPE_OWN
    return Viewer(
        user=user,
        scope=scope,
        department=hod.department_of(user),
        sees_money=money.may_see_money(user.role),
        year_start_month=research_threshold.year_start_month(),
        today=timezone.localdate(),
    )


# ------------------------------------------------------------ small helpers --


class DaysSince(Func):
    """Whole days from a moment to now, portable across the two databases in use."""

    arity = 1
    output_field = IntegerField()

    def as_sqlite(self, compiler, connection, **extra):
        sql, params = compiler.compile(self.source_expressions[0])
        return f"CAST(julianday('now') - julianday({sql}) AS INTEGER)", params

    def as_postgresql(self, compiler, connection, **extra):
        sql, params = compiler.compile(self.source_expressions[0])
        return f"(CURRENT_DATE - ({sql})::date)", params

    def as_sql(self, compiler, connection, **extra):  # pragma: no cover - other databases
        raise NotImplementedError("DaysSince is written for SQLite and PostgreSQL only")


def academic_year_expr(date_expr, start_month: int):
    """A date's academic year as text ("2025-26"); null for a null date.

    With a start month of 1 the year is the calendar year ("2025").
    """
    year = ExtractYear(date_expr)
    if start_month <= 1:
        label = Cast(year, CharField())
    else:
        start = Case(
            When(LessThan(ExtractMonth(date_expr), start_month), then=year - 1),
            default=year,
            output_field=IntegerField(),
        )
        label = Concat(
            Cast(start, CharField()),
            Value("-"),
            Substr(Cast(start + 1, CharField()), 3, 2),
            output_field=CharField(),
        )
    return Case(When(IsNull(date_expr, True), then=Value(None)), default=label, output_field=CharField())


def _labelled(path: str, labels: dict[str, str], default: str, *, extra: list | None = None):
    """A text field's values swapped for words, in one CASE."""
    whens = list(extra or [])
    whens += [When(**{path: raw}, then=Value(text)) for raw, text in labels.items()]
    return Case(*whens, default=Value(default), output_field=CharField())


def _blank_to_null(path: str):
    return Case(When(Q(**{path: ""}), then=Value(None)), default=F(path), output_field=CharField())


# ------------------------------------------------------------ field and set --


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    type: str
    #: An ORM path (str), an expression, or a function of the viewer.
    expr: Any
    groupable: bool = True
    filterable: bool = True
    #: sum, average, smallest and largest. Counting works on every field.
    aggregatable: Optional[bool] = None
    sortable: bool = True
    enum_values: Any = None  # list, or a function of the viewer
    #: A rupee figure: never offered to a head of department.
    money: bool = False
    #: Says that a payment happened, so a head must not see it either.
    reveals_payment: bool = False
    #: Names a desk of the chain: not offered to a head of department.
    desk: bool = False
    #: "year" for a calendar year, which is a number that is not a quantity.
    format: Optional[str] = None
    #: Computed after the query from other fields: (needed field keys, function
    #: of (viewer, tuple of those values per row) -> list of values). Can only
    #: be shown as a column.
    python: Optional[tuple[tuple[str, ...], Callable[[Viewer, list[tuple]], list]]] = None

    def is_aggregatable(self) -> bool:
        if self.aggregatable is not None:
            return self.aggregatable
        return self.type in ("number", "money", "date")

    def available(self, viewer: Viewer) -> bool:
        if (self.money or self.reveals_payment) and not viewer.sees_money:
            return False
        if self.desk and viewer.scope == SCOPE_DEPARTMENT:
            return False
        return True

    def expression(self, viewer: Viewer):
        e = self.expr(viewer) if callable(self.expr) else self.expr
        return F(e) if isinstance(e, str) else e

    def values(self, viewer: Viewer):
        v = self.enum_values(viewer) if callable(self.enum_values) else self.enum_values
        return list(v) if v is not None else None

    def describe(self, viewer: Viewer) -> dict[str, Any]:
        out: dict[str, Any] = {
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "groupable": self.groupable and self.python is None,
            "aggregatable": self.is_aggregatable() and self.python is None,
            "filterable": self.filterable and self.python is None,
        }
        values = self.values(viewer)
        if values is not None:
            out["enum_values"] = values
        if self.format:
            out["format"] = self.format
        return out


@dataclass(frozen=True)
class Dataset:
    key: str
    label: str
    description: str
    fields: tuple[Field, ...]
    default_columns: tuple[str, ...]
    base: Callable[[Viewer], Any]
    #: Scopes that may use it at all.
    scopes: frozenset = frozenset({SCOPE_COLLEGE, SCOPE_DEPARTMENT, SCOPE_OWN})
    #: A sentence added to the description for people who may see money.
    money_description: str = ""
    #: The date the dataset is naturally about, for the templates.
    date_field: Optional[str] = None

    def field(self, key: str) -> Optional[Field]:
        return next((f for f in self.fields if f.key == key), None)

    def offered_to(self, viewer: Viewer) -> bool:
        return viewer.scope in self.scopes and (self.key != "payments" or viewer.sees_money)

    def fields_for(self, viewer: Viewer) -> list[Field]:
        return [f for f in self.fields if f.available(viewer)]

    def describe(self, viewer: Viewer) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "description": (self.description + (" " + self.money_description if viewer.sees_money and self.money_description else "")),
            "fields": [f.describe(viewer) for f in self.fields_for(viewer)],
            "default_columns": [k for k in self.default_columns if (self.field(k) and self.field(k).available(viewer))],
        }


# ------------------------------------------------------------------- claims --

_STAFF_STATUS = {
    ClaimStatus.DRAFT: "Draft",
    ClaimStatus.SUBMITTED: "Filed",
    ClaimStatus.CLEARED: "Cleared",
    ClaimStatus.PRINCIPAL_APPROVED: "Approved",
    ClaimStatus.DIRECTOR_APPROVED: "Authorised",
    ClaimStatus.PAID: "Paid",
    ClaimStatus.REJECTED: "Sent back",
    ClaimStatus.HOD_APPROVED: "Cleared",
    ClaimStatus.RESEARCH_APPROVED: "Cleared",
    ClaimStatus.FINANCE_APPROVED: "Authorised",
}
_STAFF_STATUS_VALUES = ["Draft", "Filed", "Cleared", "Approved", "Authorised", "Paid", "Sent back", "Rejected"]

_STAFF_STAGE = {
    ClaimStatus.DRAFT: "Not filed",
    ClaimStatus.SUBMITTED: "With research cell",
    ClaimStatus.CLEARED: "With Principal",
    ClaimStatus.PRINCIPAL_APPROVED: "With Director",
    ClaimStatus.DIRECTOR_APPROVED: "With Finance",
    ClaimStatus.PAID: "Done",
    ClaimStatus.REJECTED: "Done",
    ClaimStatus.HOD_APPROVED: "With Principal",
    ClaimStatus.RESEARCH_APPROVED: "With Principal",
    ClaimStatus.FINANCE_APPROVED: "With Finance",
}
_STAFF_STAGE_VALUES = ["Not filed", "With research cell", "With Principal", "With Director", "With Finance", "Done"]

_FACULTY_STATUS = {
    ClaimStatus.SUBMITTED: "Under review",
    ClaimStatus.CLEARED: "Under review",
    ClaimStatus.PRINCIPAL_APPROVED: "Under review",
    ClaimStatus.HOD_APPROVED: "Under review",
    ClaimStatus.RESEARCH_APPROVED: "Under review",
    ClaimStatus.DIRECTOR_APPROVED: "Approved for payment",
    ClaimStatus.FINANCE_APPROVED: "Approved for payment",
    ClaimStatus.PAID: "Paid",
}
_FACULTY_STATUS_VALUES = [
    "Draft", "Under review", "Approved for payment", "Paid", "Sent back to you", "Not accepted",
    "Withdrawn", "Closed (old system)",
]
_FACULTY_STAGE = {
    ClaimStatus.DRAFT: "Not filed",
    ClaimStatus.SUBMITTED: "Being checked by the college",
    ClaimStatus.CLEARED: "Checked. Waiting to be approved",
    ClaimStatus.PRINCIPAL_APPROVED: "Approved. Waiting to be authorised",
    ClaimStatus.DIRECTOR_APPROVED: "Authorised. The payment is being made",
    ClaimStatus.PAID: "Done",
    ClaimStatus.REJECTED: "Done",
    ClaimStatus.HOD_APPROVED: "Checked. Waiting to be approved",
    ClaimStatus.RESEARCH_APPROVED: "Checked. Waiting to be approved",
    ClaimStatus.FINANCE_APPROVED: "Authorised. The payment is being made",
}
_FACULTY_STAGE_VALUES = [
    "Not filed", "Being checked by the college", "Checked. Waiting to be approved",
    "Approved. Waiting to be authorised", "Authorised. The payment is being made", "Done",
]
_HOD_STATUS_VALUES = ["Under review", "Approved", "Completed", "Sent back"]

_WAITING = (
    ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED,
    ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.HOD_APPROVED, ClaimStatus.RESEARCH_APPROVED,
    ClaimStatus.FINANCE_APPROVED,
)


def _claims_base(v: Viewer):
    claims = Claim.objects.all()
    if v.scope == SCOPE_DEPARTMENT:
        if not v.department:
            return claims.none()
        return claims.filter(owner__department__iexact=v.department).exclude(status=ClaimStatus.DRAFT)
    return claim_scope.visible_to(v.user, claims)


def _claim_status(v: Viewer):
    if v.scope == SCOPE_DEPARTMENT:
        # `hod.progress_of`, in one CASE. Drafts are not in a head's rows.
        return _labelled("status", hod.PROGRESS, "Under review")
    if v.scope == SCOPE_OWN:
        extra = [
            When(Q(status=ClaimStatus.REJECTED, status_note=_erp_note()), then=Value("Closed (old system)")),
            When(Q(status=ClaimStatus.REJECTED, rejected_outright=True), then=Value("Not accepted")),
            When(Q(status=ClaimStatus.REJECTED), then=Value("Sent back to you")),
            When(Q(status=ClaimStatus.DRAFT) & ~Q(ticket_number__isnull=True) & ~Q(ticket_number=""), then=Value("Withdrawn")),
            When(Q(status=ClaimStatus.DRAFT), then=Value("Draft")),
        ]
        return _labelled("status", {k.value: t for k, t in _FACULTY_STATUS.items()}, "Under review", extra=extra)
    extra = [When(Q(status=ClaimStatus.REJECTED, rejected_outright=True), then=Value("Rejected"))]
    return _labelled("status", {k.value: t for k, t in _STAFF_STATUS.items()}, "Filed", extra=extra)


def _erp_note() -> str:
    from core import visibility

    return visibility.ERP_CLOSED_NOTE


def _claim_stage(v: Viewer):
    table = _FACULTY_STAGE if v.scope == SCOPE_OWN else _STAFF_STAGE
    return _labelled("status", {k.value: t for k, t in table.items()}, "Done")


def _claim_status_values(v: Viewer):
    if v.scope == SCOPE_DEPARTMENT:
        return _HOD_STATUS_VALUES
    return _FACULTY_STATUS_VALUES if v.scope == SCOPE_OWN else _STAFF_STATUS_VALUES


def _claim_stage_values(v: Viewer):
    return _FACULTY_STAGE_VALUES if v.scope == SCOPE_OWN else _STAFF_STAGE_VALUES


def _days_waiting(v: Viewer):
    return Case(
        When(Q(status__in=_WAITING) & Q(submitted_at__isnull=False), then=DaysSince("submitted_at")),
        default=Value(None),
        output_field=IntegerField(),
    )


CLAIMS = Dataset(
    key="claims",
    label="Claims",
    description="One row per claim filed for the incentive: who filed it, where it stands, and the dates.",
    money_description="It also has the amount.",
    base=_claims_base,
    date_field="filed",
    default_columns=("claim_no", "paper", "claimant", "department", "status", "amount", "filed"),
    fields=(
        Field("claim_no", "Claim number", "string", "ticket_number"),
        Field("paper", "Paper", "string", "paper_title"),
        Field("journal", "Journal", "string", "journal_title"),
        Field("year", "Year published", "number", "publication_year", format="year", aggregatable=False),
        Field("claimant", "Claimant", "string", "owner__name"),
        Field("staff_id", "Staff ID", "string", "owner__staff_id"),
        Field("department", "Department", "string", "owner__department"),
        Field("status", "Status", "enum", _claim_status, enum_values=_claim_status_values),
        Field("stage", "Stage", "enum", _claim_stage, enum_values=_claim_stage_values, desk=True),
        Field("amount", "Amount", "money", "remuneration", money=True),
        Field("filed", "Filed on", "date", TruncDate("submitted_at")),
        Field("approved", "Approved on", "date", TruncDate("principal_approved_at")),
        Field("paid", "Paid on", "date", TruncDate("paid_at"), reveals_payment=True),
        Field("quartile", "Quartile", "enum", _blank_to_null("quartile"), enum_values=QUARTILES),
        Field("snip", "SNIP", "number", "snip"),
        Field("days_waiting", "Days waiting", "number", _days_waiting),
    ),
)


# ------------------------------------------------------------------- papers --


def _papers_base(v: Viewer):
    # One row per paper and person: a person matched twice to a paper (two
    # spellings of one name) counts once, the earlier row.
    duplicate = Authorship.objects.filter(
        publication=OuterRef("publication"), user=OuterRef("user"), pk__lt=OuterRef("pk")
    )
    rows = Authorship.objects.filter(user__isnull=False).exclude(Exists(duplicate))
    if v.scope == SCOPE_DEPARTMENT:
        return rows.filter(user__department__iexact=v.department) if v.department else rows.none()
    if v.scope == SCOPE_OWN:
        return rows.filter(user=v.user)
    return rows


def _snip_of(column: str):
    """The newest SNIP or SJR the dump holds for the paper's journal, by ISSN."""
    match = SnipSource.objects.filter(
        Q(print_issn=OuterRef("publication__issn")) | Q(e_issn=OuterRef("publication__issn"))
    ).exclude(**{f"{column}__isnull": True}).order_by("-year")
    return Case(
        When(Q(publication__issn__isnull=True) | Q(publication__issn=""), then=Value(None)),
        default=Subquery(match.values(column)[:1]),
        output_field=FloatField(),
    )


PAPERS = Dataset(
    key="papers",
    label="Papers",
    description="One row per paper and college author, from the publication record.",
    base=_papers_base,
    date_field="publication_date",
    default_columns=("title", "journal", "year", "quartile", "faculty", "department"),
    fields=(
        Field("title", "Title", "string", "publication__title"),
        Field("doi", "DOI", "string", _blank_to_null("publication__doi")),
        Field("journal", "Journal", "string", "publication__venue"),
        Field("issn", "ISSN", "string", "publication__issn"),
        Field("year", "Year", "number", "publication__year", format="year", aggregatable=False),
        Field("publication_date", "Publication date", "date", "publication__date"),
        Field("quartile", "Quartile", "enum", _blank_to_null("publication__quartile"), enum_values=QUARTILES),
        Field("snip", "SNIP", "number", lambda v: _snip_of("snip")),
        Field("sjr", "SJR", "number", lambda v: _snip_of("sjr")),
        Field("citations", "Citations", "number", "publication__citations"),
        Field("indexed_in_scopus", "Indexed in Scopus", "bool", "publication__scopus_indexed"),
        Field("faculty", "Faculty", "string", "user__name"),
        Field("staff_id", "Staff ID", "string", "user__staff_id"),
        Field("department", "Department", "string", "user__department"),
        Field("designation", "Designation", "string", "user__designation"),
        Field("author_position", "Author position", "number", "position"),
    ),
)


# ----------------------------------------------------------------- payments --


def _payments_base(v: Viewer):
    if v.scope == SCOPE_OWN:
        from core.api.my_payments import ledger_for

        return ledger_for(v.user).select_related(None)
    return PaidLedger.objects.all()


_LEDGER_KINDS = {"PAYMENT": "Payment", "REVERSAL": "Reversal", "ADJUSTMENT": "Correction"}

PAYMENTS = Dataset(
    key="payments",
    label="Payments",
    description=(
        "Settled payment history from the ledger: one row per payment, with reversals "
        "and corrections as their own rows, so totals are net."
    ),
    base=_payments_base,
    scopes=frozenset({SCOPE_COLLEGE, SCOPE_OWN}),
    date_field="month",
    default_columns=("month", "faculty", "department", "paper", "journal", "amount"),
    fields=(
        Field("month", "Month paid", "date", "payout_month"),
        Field(
            "academic_year", "Academic year", "string",
            lambda v: academic_year_expr(F("payout_month"), v.year_start_month),
        ),
        Field("faculty", "Faculty", "string", Coalesce("claim__owner__name", "faculty_name", output_field=CharField())),
        Field("staff_id", "Staff ID", "string", Coalesce("claim__owner__staff_id", "staff_id", output_field=CharField())),
        Field("department", "Department", "string", Coalesce("claim__owner__department", "department", output_field=CharField())),
        Field("paper", "Paper", "string", "paper_title"),
        Field("journal", "Journal", "string", "journal_title"),
        Field("snip", "SNIP", "number", "claim__snip"),
        Field("quartile", "Quartile", "enum", _blank_to_null("claim__quartile"), enum_values=QUARTILES),
        Field("amount", "Amount", "money", "amount", money=True),
        Field("voucher", "Voucher number", "string", "voucher_number"),
        Field(
            "kind", "Kind", "enum", _labelled("kind", _LEDGER_KINDS, "Payment"),
            enum_values=list(_LEDGER_KINDS.values()),
        ),
    ),
)


# ------------------------------------------------------------------ faculty --


def _count_papers(extra: Q | None = None):
    rows = Authorship.objects.filter(user=OuterRef("pk"))
    if extra is not None:
        rows = rows.filter(extra)
    counted = rows.order_by().values("user").annotate(c=Count("publication", distinct=True)).values("c")
    return Coalesce(Subquery(counted, output_field=IntegerField()), Value(0))


def _faculty_base(v: Viewer):
    people = User.objects.filter(active=True, role__in=rbac.CLAIMANT_ROLES)
    if v.scope == SCOPE_DEPARTMENT:
        return people.filter(department__iexact=v.department) if v.department else people.none()
    if v.scope == SCOPE_OWN:
        return people.filter(pk=v.user.pk)
    return people


def _last_paper(v: Viewer):
    newest = (
        Authorship.objects.filter(user=OuterRef("pk"), publication__date__isnull=False)
        .order_by("-publication__date").values("publication__date")[:1]
    )
    return Subquery(newest, output_field=DateField())


def _date_of_joining(v: Viewer, rows: list[tuple]) -> list:
    """From the faculty master's own sheet row (`doj_date`), where the office has it."""
    ids = {r[0] for r in rows if r[0]}
    found: dict[str, str] = {}
    for staff_id, raw in FacultyMaster.objects.filter(staff_id__in=ids).values_list("staff_id", "raw_json"):
        try:
            when = (json.loads(raw or "{}") or {}).get("doj_date")
        except ValueError:
            when = None
        if isinstance(when, str) and when:
            found[staff_id] = when[:10]
    return [found.get(r[0]) for r in rows]


FACULTY = Dataset(
    key="faculty",
    label="Faculty",
    description="One row per member of staff: department, Scopus link, papers, citations and h-index.",
    base=_faculty_base,
    date_field="last_paper_date",
    default_columns=("name", "staff_id", "department", "designation", "papers_total", "citations", "h_index"),
    fields=(
        Field("name", "Name", "string", "name"),
        Field("staff_id", "Staff ID", "string", "staff_id"),
        Field("department", "Department", "string", "department"),
        Field("designation", "Designation", "string", "designation"),
        Field(
            "type", "Type", "enum",
            _labelled("faculty_type", {"REGULAR": "Regular", "RESEARCH": "Research"}, "Regular"),
            enum_values=["Regular", "Research"],
        ),
        Field("scopus_id", "Scopus ID", "string", _blank_to_null("scopus_author_id")),
        Field(
            "scopus_linked", "Scopus profile linked", "bool",
            ExpressionWrapper(
                Q(scopus_author_id__isnull=False) & ~Q(scopus_author_id=""), output_field=BooleanField()
            ),
        ),
        Field("scopus_papers", "Scopus-linked papers", "number", lambda v: _count_papers(Q(publication__scopus_indexed=True))),
        Field(
            "papers_this_year", "Papers this year", "number",
            lambda v: _count_papers(Q(publication__year=v.today.year)),
        ),
        Field("papers_total", "Papers in total", "number", lambda v: _count_papers()),
        Field("citations", "Citations", "number", Coalesce("publication_metrics__total_citations", Value(0))),
        Field("h_index", "h-index", "number", Coalesce("publication_metrics__h_index", Value(0))),
        Field("last_paper_date", "Last paper", "date", _last_paper),
        Field(
            "date_of_joining", "Date of joining", "date", Value(None, output_field=DateField()), python=(("staff_id",), _date_of_joining),
        ),
    ),
)


# -------------------------------------------------------------------- teams --


def _teams_base(v: Viewer):
    teams = Team.objects.filter(active=True)
    if v.scope == SCOPE_DEPARTMENT:
        return teams.filter(department__iexact=v.department) if v.department else teams.none()
    if v.scope == SCOPE_OWN:
        return teams.filter(mentor=v.user)
    return teams


def _team_claim(column: str):
    newest = (
        Claim.objects.filter(team=OuterRef("pk")).exclude(status=ClaimStatus.DRAFT)
        .order_by("-created_at").values(column)[:1]
    )
    return Subquery(newest, output_field=CharField())


TEAMS = Dataset(
    key="teams",
    label="Final-year project teams",
    description="One row per final-year project team: mentor, students, project and the paper it produced.",
    base=_teams_base,
    default_columns=("department", "team", "mentor", "students", "project_title", "article_title", "doi"),
    fields=(
        Field("department", "Department", "string", "department"),
        Field("academic_year", "Academic year", "string", "academic_year"),
        Field("team", "Team", "string", "code"),
        Field("mentor", "Mentor", "string", Coalesce("mentor__name", "mentor_name", output_field=CharField())),
        Field(
            "students", "Students", "number",
            Coalesce(
                Subquery(
                    TeamMember.objects.filter(team=OuterRef("pk")).order_by().values("team")
                    .annotate(c=Count("pk")).values("c"),
                    output_field=IntegerField(),
                ),
                Value(0),
            ),
        ),
        Field("project_title", "Project title", "string", "title"),
        Field("article_title", "Article title", "string", lambda v: _team_claim("paper_title")),
        Field("doi", "DOI", "string", lambda v: _team_claim("doi")),
    ),
)


DATASETS: dict[str, Dataset] = {d.key: d for d in (PAPERS, CLAIMS, PAYMENTS, FACULTY, TEAMS)}


def offered(viewer: Viewer) -> list[Dataset]:
    return [d for d in DATASETS.values() if d.offered_to(viewer)]
