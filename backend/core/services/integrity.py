"""The data-health audit: what in the database contradicts itself.

Read-only. Each check returns a count, a sample of offending rows with a link
to where a person fixes them, and -- only where the right answer is
unambiguous -- the key of a one-click fix (`FIXES`). Run nightly by
`core.tasks.run_integrity_audit`, which keeps the last report in
SystemSetting("integrity_report") for GET /api/admin/data-health.

Checks never raise: a check that fails reports itself as an error row, so one
broken query cannot hide every other finding.
"""
from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from django.apps import apps
from django.db import connection, models, transaction
from django.db.models import Count, F, Q, Sum
from django.db.models.functions import Lower, Trim
from django.utils import timezone

from core.models import (
    AuditLog,
    Authorship,
    Claim,
    ClaimAttachment,
    ClaimStatus,
    FormulaConfig,
    Notification,
    PaidLedger,
    Publication,
    StoredFile,
    SystemSetting,
    Thread,
    User,
)
from core.services.normalize import normalize_doi

logger = logging.getLogger(__name__)

SAMPLE = 25
REPORT_KEY = "integrity_report"
#: Money compared to the rupee: amounts are floats, and a paisa of rounding
#: between a claim and its ledger row is not a finding.
MONEY_TOLERANCE = 0.5

#: Statuses at or past each step. Legacy statuses came from imports that
#: never recorded the new chain's timestamps, so they are left out.
PAST_CLEARED = (
    ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID,
)
PAST_PRINCIPAL = (ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID)
PAST_DIRECTOR = (ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID)


@dataclass
class Finding:
    key: str
    group: str
    title: str
    severity: str  # error | warning | info
    count: int = 0
    rows: list[dict[str, Any]] = field(default_factory=list)
    fix: Optional[str] = None
    help: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "group": self.group, "title": self.title, "severity": self.severity,
            "count": self.count, "rows": self.rows[:SAMPLE], "fix": self.fix if self.count else None,
            "help": self.help,
        }


def _user_row(u: User, extra: str = "") -> dict[str, Any]:
    return {"id": u.pk, "label": f"{u.name} <{u.email}>{(' - ' + extra) if extra else ''}",
            "href": f"/people/{u.pk}"}


def _claim_row(c: Claim, extra: str = "") -> dict[str, Any]:
    label = c.ticket_number or c.pk
    title = (c.paper_title or "")[:80]
    return {"id": c.pk, "label": f"{label} [{c.status}] {title}{(' - ' + extra) if extra else ''}",
            "href": f"/papers/{c.pk}"}


def _pub_row(p: Publication, extra: str = "") -> dict[str, Any]:
    return {"id": p.pk, "label": f"{p.year or '?'} {(p.title or '(no title)')[:80]}{(' - ' + extra) if extra else ''}",
            "href": ""}


# ---------------------------------------------------------------- people --


def _duplicate_ids(field_name: str, title: str, key: str) -> Finding:
    f = Finding(key, "People", title, "error",
                help="Two accounts sharing an identifier make matching papers and payments to a person a guess. "
                     "Merge or correct one of them on Users.")
    norm = Lower(Trim(field_name))
    groups = (
        User.objects.exclude(**{f"{field_name}__isnull": True}).annotate(v=norm).exclude(v="")
        .values("v").annotate(n=Count("id")).filter(n__gt=1)
    )
    values = [g["v"] for g in groups]
    f.count = len(values)
    if values:
        users = User.objects.annotate(v=norm).filter(v__in=values[:SAMPLE]).order_by("v", "created_at")
        for u in users:
            f.rows.append(_user_row(u, f"{field_name} {u.v}"))
    return f


def check_people() -> list[Finding]:
    out = [
        _duplicate_ids("email", "Accounts whose emails differ only in case or spaces", "dup_email"),
        _duplicate_ids("staff_id", "Accounts sharing a staff id", "dup_staff_id"),
        _duplicate_ids("biometric_id", "Accounts sharing a biometric id", "dup_biometric_id"),
        _duplicate_ids("scopus_author_id", "Accounts sharing a Scopus author id", "dup_scopus_id"),
    ]
    untrimmed = Finding(
        "untrimmed_ids", "People", "Identifiers with stray spaces", "warning", fix="trim_user_ids",
        help="A staff id typed as ' S123' does not match 'S123' in the ledger. Trimming is safe unless it would "
             "collide with another account, and those are left alone.")
    q = Q()
    for name in ("email", "staff_id", "biometric_id", "scopus_author_id", "employee_id"):
        q |= Q(**{f"{name}__startswith": " "}) | Q(**{f"{name}__endswith": " "})
    qs = User.objects.filter(q)
    untrimmed.count = qs.count()
    untrimmed.rows = [_user_row(u) for u in qs[:SAMPLE]]
    out.append(untrimmed)
    return out


# ---------------------------------------------------------------- claims --


def check_claims() -> list[Finding]:
    out: list[Finding] = []

    inactive = Finding("claim_owner_inactive", "Claims", "Open or paid claims whose owner account is deactivated",
                       "warning", help="Reassign the claim, or reactivate the account, so payments reach a person.")
    qs = Claim.objects.filter(owner__active=False).exclude(status__in=[ClaimStatus.DRAFT, ClaimStatus.REJECTED])
    inactive.count = qs.count()
    inactive.rows = [_claim_row(c, c.owner.email) for c in qs.select_related("owner")[:SAMPLE]]
    out.append(inactive)

    paid_sum = Sum("ledger_rows__amount")
    paid = Claim.objects.filter(status=ClaimStatus.PAID).annotate(n=Count("ledger_rows"), total=paid_sum)

    no_ledger = Finding("paid_without_ledger", "Claims", "Paid claims with no ledger row", "error",
                        help="Every payment has a ledger row; a paid claim without one is money nobody can account for.")
    rows = [c for c in paid if not c.n]
    no_ledger.count = len(rows)
    no_ledger.rows = [_claim_row(c) for c in rows[:SAMPLE]]
    out.append(no_ledger)

    mismatch = Finding("ledger_amount_mismatch", "Claims", "Paid claims whose ledger total differs from the remuneration",
                       "error", help="Correct the amount through the admin claim edit, which writes the balancing ledger row.")
    rows = [c for c in paid if c.n and abs((c.total or 0) - (c.remuneration or 0)) > MONEY_TOLERANCE]
    mismatch.count = len(rows)
    mismatch.rows = [_claim_row(c, f"remuneration {c.remuneration or 0:.0f}, ledger {c.total or 0:.0f}") for c in rows[:SAMPLE]]
    out.append(mismatch)

    unpaid_ledger = Finding("ledger_on_unpaid_claim", "Claims", "Ledger rows on a claim that is not paid", "error",
                            help="Money recorded against a claim still in the chain.")
    qs = PaidLedger.objects.filter(claim__isnull=False).exclude(claim__status=ClaimStatus.PAID).select_related("claim")
    unpaid_ledger.count = qs.count()
    unpaid_ledger.rows = [_claim_row(r.claim, f"ledger {r.amount:.0f}") for r in qs[:SAMPLE]]
    out.append(unpaid_ledger)

    for key, statuses, stamp, what in (
        ("cleared_without_timestamp", PAST_CLEARED, "cleared_at", "cleared"),
        ("principal_without_timestamp", PAST_PRINCIPAL, "principal_approved_at", "approved by the Principal"),
        ("director_without_timestamp", PAST_DIRECTOR, "director_approved_at", "authorised by the Director"),
        ("paid_without_timestamp", (ClaimStatus.PAID,), "paid_at", "paid"),
    ):
        f = Finding(key, "Claims", f"Claims past '{what}' with no record of when", "info",
                    help="Usually a ticket imported from before the step existed. Harmless for money; the audit trail has a gap.")
        qs = Claim.objects.filter(status__in=statuses, **{f"{stamp}__isnull": True})
        f.count = qs.count()
        f.rows = [_claim_row(c) for c in qs[:SAMPLE]]
        out.append(f)

    bad = Finding("claim_impossible_values", "Claims", "Claims with impossible numbers", "error",
                  help="Negative money, no authors, or an author position beyond the author count.")
    qs = Claim.objects.filter(
        Q(remuneration__lt=0) | Q(total_authors__lt=1) | Q(author_position__lt=1)
        | Q(author_position__gt=F("total_authors"))
    )
    bad.count = qs.count()
    bad.rows = [_claim_row(c, f"position {c.author_position} of {c.total_authors}, remuneration {c.remuneration}") for c in qs[:SAMPLE]]
    out.append(bad)

    formula = Finding("formula_active_count", "Claims", "More than one active formula", "error",
                      help="The calculator picks one; with two active, which one is an accident.")
    active = list(FormulaConfig.objects.filter(active=True).order_by("-updated_at"))
    formula.count = len(active) if len(active) > 1 else 0
    formula.rows = [{"id": x.pk, "label": f"{x.name} v{x.version}", "href": "/policy"} for x in active]
    out.append(formula)
    return out


# ---------------------------------------------------------------- ledger --


def check_ledger() -> list[Finding]:
    f = Finding("ledger_unlinked_person", "Ledger", "Ledger rows that match no person", "warning",
                help="Neither linked to a claim nor carrying a staff or biometric id any account has. "
                     "Such payments are invisible on the person's own page.")
    staff = {s.strip().lower() for s in User.objects.exclude(staff_id__isnull=True).values_list("staff_id", flat=True) if s}
    bio = {s.strip().lower() for s in User.objects.exclude(biometric_id__isnull=True).values_list("biometric_id", flat=True) if s}
    rows = []
    for r in PaidLedger.objects.filter(claim__isnull=True).only("id", "staff_id", "biometric_id", "faculty_name", "paper_title", "amount"):
        if (r.staff_id or "").strip().lower() in staff or (r.biometric_id or "").strip().lower() in bio:
            continue
        rows.append(r)
    f.count = len(rows)
    f.rows = [{"id": r.pk, "label": f"{r.faculty_name or '?'} ({r.staff_id or 'no staff id'}) {(r.paper_title or '')[:60]} {r.amount:.0f}",
               "href": f"/ledger?q={r.staff_id or r.faculty_name or ''}"} for r in rows[:SAMPLE]]

    neg = Finding("ledger_negative", "Ledger", "Negative ledger rows", "info",
                  help="Expected only as the balancing row of a corrected amount.")
    qs = PaidLedger.objects.filter(amount__lt=0)
    neg.count = qs.count()
    neg.rows = [{"id": r.pk, "label": f"{r.faculty_name} {r.amount:.0f}", "href": "/ledger"} for r in qs[:SAMPLE]]
    return [f, neg]


# ---------------------------------------------------------- publications --


def check_publications() -> list[Finding]:
    out = []
    f = Finding("pub_missing_title_year", "Publications", "Publications with no title or no year", "warning",
                help="They cannot be listed or counted by year.")
    qs = Publication.objects.filter(Q(title="") | Q(year__isnull=True))
    f.count = qs.count()
    f.rows = [_pub_row(p) for p in qs[:SAMPLE]]
    out.append(f)

    for name in ("doi", "eid"):
        d = Finding(f"pub_duplicate_{name}", "Publications", f"Publications sharing a {name.upper()}", "error",
                    help="One paper recorded twice counts twice. Merge them (keep the one with more authors linked).")
        groups = (Publication.objects.exclude(**{f"{name}__isnull": True}).exclude(**{name: ""})
                  .annotate(v=Lower(name)).values("v").annotate(n=Count("id")).filter(n__gt=1))
        values = [g["v"] for g in groups]
        d.count = len(values)
        if values:
            for p in Publication.objects.annotate(v=Lower(name)).filter(v__in=values[:SAMPLE]).order_by("v"):
                d.rows.append(_pub_row(p, f"{name} {p.v}"))
        out.append(d)

    un = Finding("doi_not_normalised", "Publications", "DOIs stored with a URL prefix, spaces or capitals", "warning",
                 fix="normalise_dois",
                 help="Duplicate detection compares bare lowercase DOIs; a stored 'https://doi.org/10.X' is not found.")
    bad = 0
    for model in (Publication, Claim, PaidLedger):
        if not any(fl.name == "doi" for fl in model._meta.fields):
            continue
        for pk, doi in model.objects.exclude(doi__isnull=True).values_list("pk", "doi").iterator():
            if doi != (normalize_doi(doi) or ""):
                bad += 1
                if len(un.rows) < SAMPLE:
                    un.rows.append({"id": pk, "label": f"{model.__name__} {doi}", "href": ""})
    un.count = bad
    out.append(un)
    return out


# --------------------------------------------------------- dangling refs --


def check_dangling() -> list[Finding]:
    """Foreign keys whose target row is gone.

    Postgres enforces these, SQLite only when told to, and imports that ran
    with constraints deferred can leave them behind. One query per key.
    """
    f = Finding("dangling_fk", "References", "Rows pointing at something that no longer exists", "error",
                help="Usually left by a bulk delete or a partial import.")
    q = connection.ops.quote_name
    for model in apps.get_app_config("core").get_models():
        for fk in model._meta.fields:
            if not isinstance(fk, models.ForeignKey):
                continue
            target = fk.remote_field.model
            sql = (
                f"SELECT COUNT(*) FROM {q(model._meta.db_table)} t WHERE t.{q(fk.column)} IS NOT NULL "
                f"AND NOT EXISTS (SELECT 1 FROM {q(target._meta.db_table)} r "
                f"WHERE r.{q(target._meta.pk.column)} = t.{q(fk.column)})"
            )
            with connection.cursor() as cur:
                cur.execute(sql)
                n = cur.fetchone()[0]
            if n:
                f.count += n
                f.rows.append({"id": f"{model.__name__}.{fk.name}", "label": f"{n} {model.__name__}.{fk.name} -> missing {target.__name__}", "href": ""})
    out = [f]

    notes = Finding("notification_dangling_claim", "References", "Notifications about a claim that no longer exists",
                    "warning", fix="delete_dangling_notifications",
                    help="Clicking them opens an error page. Deleting them loses nothing.")
    ids = set(Notification.objects.exclude(claim_id__isnull=True).exclude(claim_id="").values_list("claim_id", flat=True).distinct())
    missing = ids - set(Claim.objects.filter(pk__in=ids).values_list("pk", flat=True))
    qs = Notification.objects.filter(claim_id__in=missing)
    notes.count = qs.count()
    notes.rows = [{"id": n.pk, "label": f"{n.title} (claim {n.claim_id})", "href": ""} for n in qs[:SAMPLE]]
    out.append(notes)

    posts = Finding("thread_post_count", "References", "Discussions whose post count disagrees with their posts",
                    "warning", fix="recount_threads", help="The list shows the stored count; recounting is safe.")
    rows = list(Thread.objects.annotate(real=Count("posts", filter=Q(posts__deleted_at__isnull=True)))
                .exclude(post_count=F("real")).only("id", "title", "post_count")[:500]) if _has_field("Post", "deleted_at") else list(
        Thread.objects.annotate(real=Count("posts")).exclude(post_count=F("real")).only("id", "title", "post_count")[:500])
    posts.count = len(rows)
    posts.rows = [{"id": t.pk, "label": f"{t.title[:60]}: stored {t.post_count}, actual {t.real}", "href": f"/discussions/{t.pk}"} for t in rows[:SAMPLE]]
    out.append(posts)
    return out


def _has_field(model_name: str, name: str) -> bool:
    try:
        apps.get_model("core", model_name)._meta.get_field(name)
        return True
    except Exception:
        return False


# ----------------------------------------------------------------- files --


def check_files() -> list[Finding]:
    from django.core.files.storage import default_storage

    referenced: set[str] = set()
    for url in ClaimAttachment.objects.values_list("url", flat=True):
        referenced.add(_storage_name(url))
    referenced |= {p for p in User.objects.exclude(photo__isnull=True).values_list("photo", flat=True) if p}
    if _has_field("FeedPost", "attachment_name"):
        referenced |= {p for p in apps.get_model("core", "FeedPost").objects.exclude(attachment_name__isnull=True)
                       .values_list("attachment_name", flat=True) if p}

    orphan = Finding("orphan_files", "Files", "Stored files nothing refers to", "info",
                     help="Space in the database that no claim, photo or post uses. Left for a person to judge.")
    rows = [(n, s) for n, s in StoredFile.objects.values_list("name", "size")
            if n not in referenced and not n.startswith(("backups/", "imports/", "exports/"))]
    orphan.count = len(rows)
    orphan.rows = [{"id": n, "label": f"{n} ({s // 1024} KB)", "href": ""} for n, s in rows[:SAMPLE]]

    missing = Finding("attachment_file_missing", "Files", "Claim attachments whose file is gone", "error",
                      help="The evidence cannot be opened. Ask the claimant to upload it again.")
    for a in ClaimAttachment.objects.select_related("claim").only("id", "url", "filename", "claim__id", "claim__ticket_number", "claim__status", "claim__paper_title"):
        name = _storage_name(a.url)
        if not name or name.startswith("http"):
            continue
        try:
            ok = default_storage.exists(name)
        except Exception:
            ok = True
        if not ok:
            missing.count += 1
            if len(missing.rows) < SAMPLE:
                missing.rows.append(_claim_row(a.claim, a.filename or name))
    return [orphan, missing]


def _storage_name(url: str | None) -> str:
    from django.conf import settings

    u = (url or "").strip()
    media = settings.MEDIA_URL or "/media/"
    if media in u:
        u = u.split(media, 1)[1]
    return u.lstrip("/")


# ---------------------------------------------------------------- counts --


def check_counts(sample: int = 12) -> list[Finding]:
    """The paper count a person sees on Home against the leaderboard's."""
    from core.models import PublicationMetrics
    from core.services import paper_facts, person_record

    f = Finding("paper_count_disagrees", "Counts", "People whose paper count differs between screens", "warning",
                help="Home and My papers read the person record; the leaderboard reads recognised papers. "
                     "A difference means one of them is missing a paper.")
    ids = list(Authorship.objects.filter(user__isnull=False, user__active=True).values("user_id")
               .annotate(n=Count("id")).order_by("-n").values_list("user_id", flat=True)[:sample])
    users = list(User.objects.filter(pk__in=ids))
    if not users:
        return [f]
    record = person_record.papers_of(users)
    facts = paper_facts.load()
    board: Counter = Counter()
    seen: dict[str, set] = defaultdict(set)
    for fact in facts.facts:
        if fact.person_id in record and fact.key not in seen[fact.person_id]:
            seen[fact.person_id].add(fact.key)
            board[fact.person_id] += 1
    metrics = dict(PublicationMetrics.objects.filter(user__in=users).values_list("user_id", "total_publications"))
    for u in users:
        home = len(record.get(u.pk, []))
        stored = metrics.get(u.pk)
        lb = board.get(u.pk, 0)
        if stored is not None and stored != home:
            f.count += 1
            f.rows.append(_user_row(u, f"home {home}, stored metrics {stored}, leaderboard {lb}"))
    f.help += f" Sampled {len(users)} people with the most authorships."
    return [f]


# ----------------------------------------------------------------- run --


CHECKS: list[Callable[[], list[Finding]]] = [
    check_people, check_claims, check_ledger, check_publications, check_dangling, check_files, check_counts,
]


def run_audit() -> dict[str, Any]:
    started = timezone.now()
    findings: list[dict[str, Any]] = []
    for check in CHECKS:
        try:
            findings += [x.as_dict() for x in check()]
        except Exception as exc:  # one broken check must not hide the rest
            logger.exception("integrity check %s failed", check.__name__)
            findings.append(Finding(check.__name__, "Audit", f"{check.__name__} could not run: {exc}", "error", count=1).as_dict())
    totals = Counter()
    for x in findings:
        if x["count"]:
            totals[x["severity"]] += 1
    return {
        "ran_at": started.isoformat(),
        "seconds": round((timezone.now() - started).total_seconds(), 2),
        "problems": {"error": totals["error"], "warning": totals["warning"], "info": totals["info"]},
        "findings": findings,
    }


def run_and_store() -> dict[str, Any]:
    report = run_audit()
    SystemSetting.objects.update_or_create(key=REPORT_KEY, defaults={"value": report})
    return report


def last_report() -> Optional[dict[str, Any]]:
    row = SystemSetting.objects.filter(key=REPORT_KEY).first()
    return row.value if row else None


# ----------------------------------------------------------------- fixes --


def _fix_normalise_dois() -> int:
    changed = 0
    for model in (Publication, Claim, PaidLedger):
        if not any(fl.name == "doi" for fl in model._meta.fields):
            continue
        for pk, doi in list(model.objects.exclude(doi__isnull=True).values_list("pk", "doi")):
            clean = normalize_doi(doi)
            if doi != (clean or ""):
                model.objects.filter(pk=pk).update(doi=clean)
                changed += 1
    return changed


def _fix_trim_user_ids() -> int:
    changed = 0
    for u in User.objects.all().only("id", "email", "staff_id", "biometric_id", "scopus_author_id", "employee_id"):
        updates = {}
        for name in ("email", "staff_id", "biometric_id", "scopus_author_id", "employee_id"):
            v = getattr(u, name)
            if v and v != v.strip():
                clean = v.strip() or None
                if clean and User.objects.exclude(pk=u.pk).filter(**{f"{name}__iexact": clean}).exists():
                    continue  # would collide: a person decides
                updates[name] = clean
        if updates:
            User.objects.filter(pk=u.pk).update(**updates)
            changed += 1
    return changed


def _fix_delete_dangling_notifications() -> int:
    ids = set(Notification.objects.exclude(claim_id__isnull=True).exclude(claim_id="").values_list("claim_id", flat=True).distinct())
    missing = ids - set(Claim.objects.filter(pk__in=ids).values_list("pk", flat=True))
    return Notification.objects.filter(claim_id__in=missing).delete()[0]


def _fix_recount_threads() -> int:
    filt = Q(posts__deleted_at__isnull=True) if _has_field("Post", "deleted_at") else Q()
    changed = 0
    for t in Thread.objects.annotate(real=Count("posts", filter=filt)).exclude(post_count=F("real")):
        Thread.objects.filter(pk=t.pk).update(post_count=t.real)
        changed += 1
    return changed


FIXES: dict[str, tuple[str, Callable[[], int]]] = {
    "normalise_dois": ("Normalise every stored DOI", _fix_normalise_dois),
    "trim_user_ids": ("Trim spaces from account identifiers", _fix_trim_user_ids),
    "delete_dangling_notifications": ("Delete notifications about deleted claims", _fix_delete_dangling_notifications),
    "recount_threads": ("Recount discussion posts", _fix_recount_threads),
}


def apply_fix(key: str, actor: Optional[User]) -> int:
    label, fn = FIXES[key]
    with transaction.atomic():
        changed = fn()
        AuditLog.objects.create(
            actor=actor, action="DATA_HEALTH_FIX", entity="Integrity", entity_id=key,
            detail_json=json.dumps({"fix": key, "label": label, "rows_changed": changed}),
        )
    return changed
