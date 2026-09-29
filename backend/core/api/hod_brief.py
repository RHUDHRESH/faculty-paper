"""The head of department's brief, and the report built from it.

A head's jobs (docs/jtbd/hod.md) come down to three questions asked every
month: are we on track, who needs a push, and who should write with whom.
`/hod/brief` answers all three for one year in one call, and `/hod/report`
turns the same answer into the A4 PDF a head takes to the Principal and the
workbook that goes into the NBA / NAAC files. One function builds both, so the
screen and the paper cannot disagree.

Two rules, both enforced here rather than trusted to the screen:

- **No money.** Every figure is a count of work; every response passes
  through `hod.without_money`, and the files carry no amount column.
- **Only papers that count, count.** A paper the chain rejected outright is
  not output a target or an accreditation file can use. It is excluded from
  every figure and reported as its own number, so the head sees it went.
"""

from __future__ import annotations

from core.services.cell_safe import safe_append
import io
import json
from collections import Counter, defaultdict
from datetime import date
from typing import Any, Optional

from django.conf import settings
from django.db.models import Q
from django.http import HttpRequest, HttpResponse
from django.utils import timezone
from ninja.errors import HttpError

from core import hod
from core.api.common import _hod_scope, api, rate_limit, session_auth
from core.api.hod import _require_hod
from core.models import AuditLog, DepartmentAssignment, DepartmentTarget, User
from core.services import rbac

#: How many years the output chart and the report look back over.
YEARS_SHOWN = 5
#: A mentor is asked to take on at most this many juniors at once.
MENTEES_PER_MENTOR = 2


def _counted(user: User):
    """Filed papers from the department that the chain has not rejected outright."""
    return _hod_scope(user).exclude(rejected_outright=True)


def _elapsed(year: int, today: date) -> float:
    """How much of `year` has gone, 0..1. Pace is judged against this."""
    if year < today.year:
        return 1.0
    if year > today.year:
        return 0.0
    start = date(year, 1, 1)
    days = (date(year + 1, 1, 1) - start).days
    return round(((today - start).days + 1) / days, 4)


def _verdict(done: int, expected: float, target: int) -> str:
    if done >= target:
        return "met"
    if done >= expected:
        return "on_track"
    if done >= expected * 0.85:
        return "close"
    return "behind"


def _photo(u: User) -> str | None:
    return f"{settings.MEDIA_URL}{u.photo}" if u.photo else None


def build_brief(user: User, year: Optional[int] = None) -> dict[str, Any]:
    today = timezone.localdate()
    year = year or today.year
    department = hod.department_of(user)
    counted = _counted(user)
    this_year = counted.filter(publication_year=year)
    last_year = counted.filter(publication_year=year - 1)
    elapsed = _elapsed(year, today)

    # ---- are we on track ----
    done = {
        DepartmentTarget.Metric.PUBLICATIONS: this_year.count(),
        DepartmentTarget.Metric.Q1: this_year.filter(quartile__iexact="Q1").count(),
        DepartmentTarget.Metric.FIRST_AUTHOR: this_year.filter(author_position=1).count(),
    }
    # Last year to the same point in the year: the honest comparison when no
    # target is set. Papers without a usable date are left out of both sides
    # of that one comparison, and the full-year figure is given beside it.
    cutoff = f"{year - 1}-{today.month:02d}-{today.day:02d}" if year == today.year else None
    if cutoff:
        last_to_date = last_year.filter(publication_date__lte=cutoff, publication_date__gte=f"{year - 1}-01-01").count()
        this_to_date = this_year.filter(publication_date__gte=f"{year}-01-01").count()
    else:
        last_to_date = last_year.count()
        this_to_date = this_year.count()

    targets = []
    for t in DepartmentTarget.objects.filter(
        department__iexact=department, year=year, person__isnull=True
    ).order_by("metric"):
        d = done.get(t.metric, 0)
        expected = round(t.target * elapsed, 1)
        targets.append({
            "metric": t.metric,
            "label": DepartmentTarget.Metric(t.metric).label,
            "target": t.target,
            "done": d,
            "expected_by_now": expected,
            "verdict": _verdict(d, expected, t.target),
            "due_date": t.due_date.isoformat() if t.due_date else None,
        })

    # ---- output over time ----
    years = list(range(year - YEARS_SHOWN + 1, year + 1))
    per_year = Counter(counted.filter(publication_year__in=years).values_list("publication_year", flat=True))
    q1_year = Counter(
        counted.filter(publication_year__in=years, quartile__iexact="Q1").values_list("publication_year", flat=True)
    )
    by_year = [
        {"year": y, "publications": per_year.get(y, 0), "q1": q1_year.get(y, 0),
         "partial": y == today.year}
        for y in years
    ]

    # ---- people ----
    members = list(
        User.objects.filter(
            role__in=rbac.CLAIMANT_ROLES, department__iexact=department, active=True
        ).order_by("name")
    )
    ids = [m.id for m in members]
    rows = list(
        counted.filter(owner_id__in=ids).values(
            "owner_id", "publication_year", "quartile", "author_position",
            "subject_category", "publication_date",
        )
    )
    stats: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "this_year": 0, "last_year": 0, "q1_this_year": 0, "led_this_year": 0,
        "total": 0, "q1_recent": 0, "led_ever": 0, "last_year_published": None,
        "areas": Counter(),
    })
    for r in rows:
        s = stats[r["owner_id"]]
        y = r["publication_year"]
        q1 = (r["quartile"] or "").upper() == "Q1"
        led = r["author_position"] == 1
        s["total"] += 1
        s["led_ever"] += led
        if y == year:
            s["this_year"] += 1
            s["q1_this_year"] += q1
            s["led_this_year"] += led
        elif y == year - 1:
            s["last_year"] += 1
        if y and year - 2 <= y <= year and q1:
            s["q1_recent"] += 1
        if y and y <= year and (s["last_year_published"] is None or y > s["last_year_published"]):
            s["last_year_published"] = y
        if r["subject_category"]:
            s["areas"][r["subject_category"]] += 1

    nudged: dict[str, str] = {}
    for row in AuditLog.objects.filter(
        action="HOD_NUDGE", entity="User", entity_id__in=ids
    ).order_by("created_at").values("entity_id", "created_at"):
        nudged[row["entity_id"]] = row["created_at"].isoformat()

    personal = {
        (t.person_id, t.metric): t.target
        for t in DepartmentTarget.objects.filter(
            department__iexact=department, year=year, person__isnull=False
        )
    }

    people = []
    for m in members:
        s = stats[m.id]
        area = s["areas"].most_common(1)[0][0] if s["areas"] else None
        people.append({
            "id": m.id,
            "name": m.name,
            "designation": m.designation,
            "photo_url": _photo(m),
            "is_you": m.id == user.id,
            "this_year": s["this_year"],
            "last_year": s["last_year"],
            "q1_this_year": s["q1_this_year"],
            "led_this_year": s["led_this_year"],
            "total": s["total"],
            "last_year_published": s["last_year_published"],
            "area": area,
            "target": personal.get((m.id, DepartmentTarget.Metric.PUBLICATIONS)),
            "last_reminded_at": nudged.get(m.id),
        })

    # ---- who needs a push ----
    push = []
    for p in people:
        if p["is_you"]:
            continue
        s = stats[p["id"]]
        reasons = []
        if p["this_year"] == 0:
            if p["last_year"]:
                reasons.append(f"Nothing in {year}; {p['last_year']} in {year - 1}")
            elif p["last_year_published"]:
                reasons.append(f"Nothing filed since {p['last_year_published']}")
            else:
                reasons.append("Has never filed a paper here")
        elif p["target"] and p["this_year"] < p["target"] * elapsed:
            reasons.append(f"{p['this_year']} of a personal target of {p['target']}")
        if s["total"] and not s["q1_recent"]:
            reasons.append(f"No Q1 paper since {year - 3} or earlier")
        if s["total"] >= 3 and not s["led_ever"]:
            reasons.append("Has never led a paper")
        if reasons:
            # Silence this year first; among the silent, the longest silent.
            rank = (0 if p["this_year"] == 0 else 1, p["last_year_published"] or 0, p["name"])
            push.append({"person": p, "reasons": reasons, "_rank": rank})
    push.sort(key=lambda r: r["_rank"])
    for r in push:
        r.pop("_rank")

    # ---- who should write with whom ----
    already = set()
    for a in DepartmentAssignment.objects.filter(
        department__iexact=department, kind=DepartmentAssignment.Kind.PAIRING
    ).exclude(status="DONE").values("assignee_id", "partner_id"):
        already.add(frozenset((a["assignee_id"], a["partner_id"])))
    by_id = {p["id"]: p for p in people}
    mentors = sorted(
        (p for p in people if stats[p["id"]]["q1_recent"] >= 2),
        key=lambda p: (-stats[p["id"]]["q1_recent"], p["name"]),
    )
    load: Counter = Counter()
    pairs = []
    for r in push:
        mentee = r["person"]
        if stats[mentee["id"]]["q1_recent"]:
            continue
        match = None
        for m in mentors:
            if m["id"] == mentee["id"] or load[m["id"]] >= MENTEES_PER_MENTOR:
                continue
            if frozenset((m["id"], mentee["id"])) in already:
                continue
            if mentee["area"] and m["area"] == mentee["area"]:
                match = m
                break
        if match is None:
            continue
        load[match["id"]] += 1
        pairs.append({
            "mentee": mentee,
            "mentor": by_id[match["id"]],
            "area": match["area"],
            "why": (
                f"Both in {match['area']}. {stats[match['id']]['q1_recent']} Q1 papers since "
                f"{year - 2} against "
                + ("nothing this year." if mentee["this_year"] == 0 else "no recent Q1.")
            ),
        })

    published = sum(1 for p in people if p["this_year"])
    return hod.without_money({
        "department": department,
        "year": year,
        "as_of": today.isoformat(),
        "elapsed": elapsed,
        "totals": {
            "publications": done[DepartmentTarget.Metric.PUBLICATIONS],
            "q1": done[DepartmentTarget.Metric.Q1],
            "first_author": done[DepartmentTarget.Metric.FIRST_AUTHOR],
            "faculty": len(people),
            "faculty_published": published,
            "per_teacher": round(done[DepartmentTarget.Metric.PUBLICATIONS] / len(people), 2) if people else None,
            "last_year_full": last_year.count(),
            "last_year_to_date": last_to_date,
            "this_year_to_date": this_to_date,
            "rejected_outright": _hod_scope(user).filter(
                publication_year=year, rejected_outright=True
            ).count(),
            "missing_issn_or_doi": this_year.filter(
                Q(issn__isnull=True) | Q(issn="") | Q(doi__isnull=True) | Q(doi="")
            ).count(),
        },
        "targets": targets,
        "by_year": by_year,
        "people": people,
        "push": push,
        "pairs": pairs,
        "years": sorted(
            {y for y in _hod_scope(user).values_list("publication_year", flat=True) if y}
            | {today.year},
            reverse=True,
        ),
    })


@api.get("/hod/brief", auth=session_auth)
def hod_brief(request: HttpRequest, year: Optional[int] = None):
    """Are we on track, who needs a push, who should write with whom."""
    return build_brief(_require_hod(request), year)


# ---------- the report ----------

_VERDICT_TEXT = {
    "met": "Met", "on_track": "On track", "close": "Slightly behind", "behind": "Behind",
}


def _headline(b: dict[str, Any]) -> str:
    t = b["totals"]
    pubs = next((x for x in b["targets"] if x["metric"] == "PUBLICATIONS"), None)
    if pubs:
        return (
            f"{t['publications']} of a target of {pubs['target']} papers "
            f"({round(100 * b['elapsed'])}% of the year gone, {pubs['expected_by_now']:g} expected by now): "
            f"{_VERDICT_TEXT[pubs['verdict']].lower()}."
        )
    return (
        f"{t['this_year_to_date']} papers so far in {b['year']}, against "
        f"{t['last_year_to_date']} by the same date in {b['year'] - 1} "
        f"({t['last_year_full']} in all of {b['year'] - 1}). No department target is set."
    )


def _papers_for_files(user: User, years: list[int]):
    return (
        _counted(user).filter(publication_year__in=years)
        .select_related("owner").order_by("owner__name", "-publication_year")
    )


def _summary(b: dict[str, Any]) -> str:
    """One paragraph a Principal can read and stop: output, pace, who needs help."""
    t = b["totals"]
    n_push, n_pairs = len(b["push"]), len(b["pairs"])
    parts = [
        f"The Department of {b['department']} has {t['publications']} "
        f"{'paper' if t['publications'] == 1 else 'papers'} on record for {b['year']} so far, "
        f"{t['q1']} of them in Q1 journals and {t['first_author']} led by the department's own faculty, "
        f"from {t['faculty_published']} of its {t['faculty']} faculty members."
    ]
    if b["targets"]:
        parts.append(_headline(b))
    else:
        ahead = t["this_year_to_date"] >= t["last_year_to_date"]
        parts.append(
            f"That is {'ahead of' if ahead else 'behind'} last year's pace: {t['last_year_to_date']} by the same "
            f"date in {b['year'] - 1} ({t['last_year_full']} in all of {b['year'] - 1}). No department target is set."
        )
    if n_push:
        parts.append(
            f"{n_push} faculty {'member needs' if n_push == 1 else 'members need'} a push"
            + (f", and {n_pairs} writing {'pair is' if n_pairs == 1 else 'pairs are'} suggested to help." if n_pairs else ".")
        )
    else:
        parts.append("Every faculty member has published this year.")
    return " ".join(parts)


def _report_pdf(user: User, b: dict[str, Any]) -> bytes:
    from xml.sax.saxutils import escape

    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    ink = colors.HexColor("#1F2430")
    muted = colors.HexColor("#6B7280")
    accent = colors.HexColor("#C2410C")
    grey = colors.HexColor("#9CA3AF")
    rule = colors.HexColor("#D9DCE1")
    wash = colors.HexColor("#F4F5F7")
    styles = getSampleStyleSheet()
    base = styles["BodyText"].clone("base", fontName="Helvetica", fontSize=9, leading=12, textColor=ink)
    h1 = base.clone("h1", fontName="Helvetica-Bold", fontSize=17, leading=21)
    sub = base.clone("sub", fontSize=10, leading=13, textColor=muted)
    h2 = base.clone("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=14, spaceBefore=10, spaceAfter=4)
    lead = base.clone("lead", fontSize=10, leading=14.5)
    small = base.clone("small", fontSize=7.5, leading=9.5, textColor=muted)
    cell = base.clone("cell", fontSize=8, leading=10)
    cell_r = cell.clone("cell_r", alignment=2)
    head = cell.clone("head", fontName="Helvetica-Bold")
    head_r = head.clone("head_r", alignment=2)

    left, right, width = 18 * mm, 18 * mm, A4[0] - 36 * mm
    t = b["totals"]
    as_of = date.fromisoformat(b["as_of"]).strftime("%d %B %Y")

    def p(text: Any, style=cell) -> Paragraph:
        return Paragraph(escape(str(text)), style)

    def table(rows: list[list[Any]], widths_mm: list[float], numeric_from: int | None = None) -> Table:
        """Header row plus rows, every cell a Paragraph so nothing overflows."""
        out = []
        for i, row in enumerate(rows):
            styled = []
            for j, v in enumerate(row):
                num = numeric_from is not None and j >= numeric_from
                styled.append(v if isinstance(v, Paragraph) else p(v, (head_r if num else head) if i == 0 else (cell_r if num else cell)))
            out.append(styled)
        scale = width / (sum(widths_mm) * mm)
        tb = Table(out, colWidths=[w * mm * scale for w in widths_mm], repeatRows=1)
        tb.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, 0), 0.6, ink), ("LINEBELOW", (0, 1), (-1, -1), 0.25, rule),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ]))
        return tb

    story: list[Any] = [
        Paragraph(f"Research publication report, {b['year']}", h1),
        Paragraph(f"Department of {escape(b['department'])}, prepared for the Principal", sub),
        Spacer(1, 1.5 * mm),
        Paragraph(
            f"Prepared by {escape(user.name)}, Head of Department, on {as_of}. Counts of filed papers; "
            "papers the review chain did not accept are left out. No money figures appear in this report.",
            small,
        ),
        Spacer(1, 4 * mm),
        Paragraph("Summary", h2),
        Paragraph(escape(_summary(b)), lead),
    ]

    # ---- pace ----
    pace: list[Any] = [Paragraph("Pace", h2)]
    figures = Table(
        [
            [p("Papers", small), p("Q1 papers", small), p("Led from here", small),
             p("Faculty who published", small), p("Papers per teacher", small)],
            [p(t["publications"], h2), p(t["q1"], h2), p(t["first_author"], h2),
             p(f"{t['faculty_published']} of {t['faculty']}", h2),
             p(t["per_teacher"] if t["per_teacher"] is not None else "-", h2)],
        ],
        colWidths=[width / 5] * 5,
    )
    figures.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), wash),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 1), (-1, 1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ]))
    pace.append(figures)
    pace.append(Spacer(1, 3 * mm))
    elapsed = f"{round(100 * b['elapsed'])}% of {b['year']} has gone."
    if b["targets"]:
        rows = [["Target", "Set", "Done", "Expected by now", "Status"]] + [
            [x["label"], x["target"], x["done"], f"{x['expected_by_now']:g}", _VERDICT_TEXT[x["verdict"]]]
            for x in b["targets"]
        ]
        pace.append(table(rows, [60, 22, 22, 34, 32], numeric_from=1))
        pace.append(Paragraph(elapsed, small))
    else:
        rows = [
            ["", str(b["year"]), str(b["year"] - 1)],
            [f"Papers by {date.fromisoformat(b['as_of']).strftime('%d %B')}", t["this_year_to_date"], t["last_year_to_date"]],
            ["Papers in the whole year", "year not over", t["last_year_full"]],
        ]
        pace.append(table(rows, [90, 40, 40], numeric_from=1))
        pace.append(Paragraph(f"No department target is set for {b['year']}, so pace is judged against last year. {elapsed}", small))
    story.append(KeepTogether(pace))

    # One chart, both series labelled on the bars, legend below, partial year said in words.
    chart: list[Any] = [Paragraph(f"Papers per year, {b['by_year'][0]['year']} to {b['year']}", h2)]
    d = Drawing(width, 50 * mm)
    ch = VerticalBarChart()
    ch.x, ch.y, ch.width, ch.height = 10 * mm, 10 * mm, width - 14 * mm, 36 * mm
    ch.data = [[r["publications"] for r in b["by_year"]], [r["q1"] for r in b["by_year"]]]
    ch.categoryAxis.categoryNames = [f"{r['year']}{' (so far)' if r['partial'] else ''}" for r in b["by_year"]]
    ch.categoryAxis.labels.fontName = "Helvetica"
    ch.categoryAxis.labels.fontSize = 7.5
    ch.categoryAxis.strokeColor = rule
    ch.valueAxis.valueMin = 0
    ch.valueAxis.valueMax = max([1] + ch.data[0]) * 1.18
    ch.valueAxis.labels.fontName = "Helvetica"
    ch.valueAxis.labels.fontSize = 7
    ch.valueAxis.strokeColor = colors.white
    ch.valueAxis.visibleGrid = True
    ch.valueAxis.gridStrokeColor = rule
    ch.bars[0].fillColor = grey
    ch.bars[1].fillColor = accent
    ch.bars.strokeColor = None
    ch.barLabelFormat = "%d"
    ch.barLabels.fontName = "Helvetica"
    ch.barLabels.fontSize = 7
    ch.barLabels.nudge = 5
    d.add(ch)
    d.add(Rect(10 * mm, 1.5 * mm, 2.5 * mm, 2.5 * mm, fillColor=grey, strokeColor=None))
    d.add(String(14 * mm, 2 * mm, "All papers", fontName="Helvetica", fontSize=7.5, fillColor=muted))
    d.add(Rect(34 * mm, 1.5 * mm, 2.5 * mm, 2.5 * mm, fillColor=accent, strokeColor=None))
    d.add(String(38 * mm, 2 * mm, "Q1 papers", fontName="Helvetica", fontSize=7.5, fillColor=muted))
    chart.append(d)
    story.append(KeepTogether(chart))

    # ---- push list ----
    story.append(Paragraph("Who needs a push", h2))
    if b["push"]:
        rows = [["Faculty", "Designation", "Why"]] + [
            [r["person"]["name"], r["person"]["designation"] or "", "; ".join(r["reasons"])]
            for r in b["push"][:25]
        ]
        story.append(table(rows, [48, 36, 86]))
        if len(b["push"]) > 25:
            story.append(Paragraph(f"And {len(b['push']) - 25} more; the Excel workbook lists everyone.", small))
    else:
        story.append(Paragraph("Nobody: everyone has published this year.", base))

    if b["pairs"]:
        story.append(Paragraph("Suggested writing pairs", h2))
        rows = [["Faculty", "To write with", "Area"]] + [
            [x["mentee"]["name"], x["mentor"]["name"], x["area"] or ""] for x in b["pairs"]
        ]
        story.append(table(rows, [55, 55, 60]))

    # ---- per teacher ----
    story.append(Paragraph(f"Per teacher, {b['year']}", h2))
    rows = [["Faculty", "Designation", str(b["year"]), str(b["year"] - 1), "Q1", "Led", "All years"]] + [
        [x["name"], x["designation"] or "", x["this_year"], x["last_year"], x["q1_this_year"],
         x["led_this_year"], x["total"]]
        for x in sorted(b["people"], key=lambda x: (-x["this_year"], x["name"]))
    ]
    story.append(table(rows, [54, 40, 15, 15, 12, 12, 18], numeric_from=2))
    story.append(Spacer(1, 2 * mm))
    story.append(Paragraph(
        f"{b['year']} counts papers filed with a publication year of {b['year']}; Q1 and Led are for "
        f"{b['year']}. All years is everything on record.", small,
    ))

    department, year = b["department"], b["year"]

    class Numbered(rl_canvas.Canvas):
        """Letterhead on every page and "Page n of N", which needs the total first."""

        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._pages: list[dict] = []

        def showPage(self):
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self._chrome(total)
                super().showPage()
            super().save()

        def _chrome(self, total: int):
            top = A4[1] - 12 * mm
            self.setFillColor(ink)
            self.setFont("Helvetica-Bold", 10)
            self.drawString(left, top, "Saveetha Engineering College")
            self.setFont("Helvetica", 8)
            self.setFillColor(muted)
            self.drawRightString(A4[0] - right, top, f"Department of {department}")
            self.setStrokeColor(accent)
            self.setLineWidth(1.2)
            self.line(left, top - 3 * mm, A4[0] - right, top - 3 * mm)
            self.setFont("Helvetica", 7)
            self.drawString(left, 10 * mm, f"Research publication report {year}, {department}, as of {as_of}")
            self.drawRightString(A4[0] - right, 10 * mm, f"Page {self._pageNumber} of {total}")

    buf = io.BytesIO()
    SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=left, rightMargin=right, topMargin=22 * mm, bottomMargin=18 * mm,
        title=f"{department} research publication report {year}", author=user.name,
    ).build(story, canvasmaker=Numbered)
    return buf.getvalue()


def _report_xlsx(user: User, b: dict[str, Any]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    head_font = Font(bold=True, color="FFFFFFFF")
    head_fill = PatternFill("solid", fgColor="FF1F2430")

    def sheet(ws, title_lines: list[str], header: list[str], rows: list[list[Any]], widths: list[int]):
        for line in title_lines:
            safe_append(ws, [line])
        ws["A1"].font = Font(bold=True, size=13)
        safe_append(ws, [])
        safe_append(ws, header)
        hr = ws.max_row
        for c in ws[hr]:
            c.font, c.fill = head_font, head_fill
            c.alignment = Alignment(wrap_text=True, vertical="top")
        for r in rows:
            safe_append(ws, ["" if v is None else v for v in r])
        ws.freeze_panes = ws.cell(row=hr + 1, column=1)
        ws.auto_filter.ref = f"A{hr}:{get_column_letter(len(header))}{ws.max_row}"
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

    t = b["totals"]
    stamp = f"{b['department']}, Saveetha Engineering College. Prepared by {user.name} on {b['as_of']}. No money figures."
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    sheet(ws, [f"{b['department']}: research output {b['year']}", stamp, _headline(b)],
          ["Measure", "Value"],
          [["Papers", t["publications"]], ["Q1 papers", t["q1"]], ["Papers led from here", t["first_author"]],
           ["Faculty", t["faculty"]], ["Faculty who published", t["faculty_published"]],
           ["Papers per teacher", t["per_teacher"]], [f"Papers in {b['year'] - 1}", t["last_year_full"]],
           ["Not accepted by the review chain (excluded)", t["rejected_outright"]],
           ["Missing ISSN or DOI", t["missing_issn_or_doi"]]]
          + [[f"Target: {x['label']}", f"{x['done']} of {x['target']} ({_VERDICT_TEXT[x['verdict']]})"]
             for x in b["targets"]]
          + [[f"Papers in {r['year']}{' (so far)' if r['partial'] else ''}", r["publications"]] for r in b["by_year"]],
          [44, 40])

    years = [r["year"] for r in b["by_year"]]
    papers = list(_papers_for_files(user, years))
    per_teacher: dict[str, Counter] = defaultdict(Counter)
    for c in papers:
        per_teacher[c.owner_id][c.publication_year] += 1
    sheet(wb.create_sheet("Per teacher"),
          [f"Papers per teacher, {years[0]}-{years[-1]} (NBA Criterion 5, NAAC 3.3)", stamp],
          ["Faculty", "Designation", *[str(y) for y in years], "Total", f"Q1 in {b['year']}", f"Led in {b['year']}"],
          [[p["name"], p["designation"], *[per_teacher[p["id"]].get(y, 0) for y in years],
            sum(per_teacher[p["id"]].values()), p["q1_this_year"], p["led_this_year"]]
           for p in b["people"]],
          [30, 22, *[8] * len(years), 8, 10, 10])

    sheet(wb.create_sheet("NAAC 3.3 papers"),
          [f"Research papers, {years[0]}-{years[-1]}, one row per paper (NAAC 3.3 data template)", stamp],
          ["Title of paper", "Name of the author/s", "Department of the teacher", "Name of journal",
           "Year of publication", "ISSN number", "Quartile", "Indexed in", "Link to article (DOI)",
           "Link to journal / Scopus", "Author position"],
          [[c.paper_title, c.owner.name, b["department"], c.journal_title, c.publication_year, c.issn,
            c.quartile, c.indexing_level, f"https://doi.org/{c.doi}" if c.doi else "", c.scopus_url or "",
            f"{c.author_position} of {c.total_authors}"] for c in papers],
          [50, 26, 12, 34, 10, 12, 9, 16, 34, 30, 10])

    missing = [c for c in papers if not (c.issn or "").strip() or not (c.doi or "").strip()]
    sheet(wb.create_sheet("Missing data"),
          ["Papers an assessor would send back: missing ISSN or DOI", stamp],
          ["Faculty", "Title of paper", "Journal", "Year", "Missing"],
          [[c.owner.name, c.paper_title, c.journal_title, c.publication_year,
            ", ".join(k for k, v in (("ISSN", c.issn), ("DOI", c.doi)) if not (v or "").strip())]
           for c in missing],
          [26, 50, 34, 8, 14])

    sheet(wb.create_sheet("Who needs a push"),
          [f"Who needs a push, {b['year']}", stamp],
          ["Faculty", "Designation", "Why"],
          [[r["person"]["name"], r["person"]["designation"], "; ".join(r["reasons"])] for r in b["push"]],
          [30, 22, 70])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


@api.get("/hod/report", auth=session_auth)
def hod_report(request: HttpRequest, year: Optional[int] = None, fmt: str = "pdf"):
    """The department report: A4 PDF for the Principal, Excel for NBA / NAAC files."""
    user = _require_hod(request)
    if fmt not in ("pdf", "xlsx"):
        raise HttpError(400, "Format must be pdf or xlsx.")
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    b = build_brief(user, year)
    stem = f"{b['department'].replace(' ', '-').lower()}-research-{b['year']}"
    AuditLog.objects.create(
        actor=user, action="HOD_REPORT", entity="Department", entity_id=b["department"],
        detail_json=json.dumps({"year": b["year"], "format": fmt}),
    )
    if fmt == "pdf":
        res = HttpResponse(_report_pdf(user, b), content_type="application/pdf")
    else:
        res = HttpResponse(
            _report_xlsx(user, b),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    res["Content-Disposition"] = f'attachment; filename="{stem}.{fmt}"'
    return res


__all__ = ["build_brief", "hod_brief", "hod_report"]
