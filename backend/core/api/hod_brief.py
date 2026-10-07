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
from core.api.common import api, rate_limit, session_auth
from core.api.hod import _require_hod
from core.models import AuditLog, DepartmentAssignment, DepartmentTarget, User
from core.services import hod_record, principal_brief
from core.services.hod_record import PersonStats

#: A mentor is asked to take on at most this many juniors at once.
MENTEES_PER_MENTOR = 2


def _elapsed(year: int, today: date) -> float:
    """How much of `year` has gone, 0..1. Pace is judged against this."""
    if year < today.year:
        return 1.0
    if year > today.year:
        return 0.0
    start = date(year, 1, 1)
    days = (date(year + 1, 1, 1) - start).days
    return round(((today - start).days + 1) / days, 4)


def _months_left(year: int, today: date) -> int:
    """Whole months still to come in `year`, after the current one."""
    if year < today.year:
        return 0
    if year > today.year:
        return 12
    return 12 - today.month


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


def _draft(year: int, kind: str, s: PersonStats) -> str:
    """A kind, specific reminder the head can edit before it is sent."""
    if kind == "slipped":
        why = (
            f"you had {s.last_year} paper{'s' if s.last_year != 1 else ''} in {year - 1} and none on record for "
            f"{year} yet. If something is out or under review, please tell me or file it."
        )
    elif kind == "quiet":
        why = f"nothing from you is on record since {s.last_paper_year}. Is a paper on its way?"
    elif kind == "never":
        why = (
            "the college record has no paper under your name. If you have published, please make sure your "
            "Scopus ID is on your profile so it can be matched."
        )
    elif kind == "no_q1":
        why = "the department is aiming for more Q1 papers, and your next one could be it."
    else:
        why = "the department is credited with the papers it leads; please consider leading your next one."
    return f"A reminder from your head of department: {why} If you are stuck, come and talk to me."


#: The order a head works the list in: who slipped, then who is silent, then
#: quality. A person shows once, under the first reason that applies.
_KIND_RANK = {"slipped": 0, "quiet": 1, "never": 2, "no_q1": 3, "never_led": 4}

_NEXT_STEP = {
    "slipped": "Ask what is in progress and remind them to file it.",
    "quiet": "Ask what is in progress, and pair them with a colleague.",
    "never": "Ask for their Scopus ID, then talk about a first paper.",
    "no_q1": "Pair them with a colleague who publishes in Q1 journals.",
    "never_led": "Ask them to lead their next paper.",
}


def build_brief(user: User, year: Optional[int] = None) -> dict[str, Any]:
    today = timezone.localdate()
    year = year or today.year
    department = hod.department_of(user)
    if not department:
        raise HttpError(400, "This account has no department set, so there is nothing to show. "
                             "Ask the research office to set it.")
    snap = hod_record.snapshot(department, year, today)
    elapsed = _elapsed(year, today)
    months_left = _months_left(year, today)

    # ---- are we on track ----
    targets = []
    for t in DepartmentTarget.objects.filter(
        department__iexact=department, year=year, person__isnull=True
    ).order_by("metric"):
        d = hod_record.metric_done(snap, t.metric)
        expected = round(t.target * elapsed, 1)
        to_go = max(0, t.target - d)
        targets.append({
            "metric": t.metric,
            "label": DepartmentTarget.Metric(t.metric).label,
            "target": t.target,
            "done": d,
            "expected_by_now": expected,
            "verdict": _verdict(d, expected, t.target),
            "due_date": t.due_date.isoformat() if t.due_date else None,
            "to_go": to_go,
            "months_left": months_left,
            "per_month_needed": round(to_go / months_left, 1) if months_left and to_go else None,
        })

    # ---- output over time ----
    years = list(range(year - hod_record.YEARS_SHOWN + 1, year + 1))
    by_year = [
        {"year": y, "publications": snap.per_year.get(y, 0), "q1": snap.q1_year.get(y, 0),
         "partial": y == today.year}
        for y in years
    ]

    # ---- people ----
    nudged: dict[str, str] = {}
    ids = [s.user.id for s in snap.people]
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
    by_stats = {s.user.id: s for s in snap.people}
    people = []
    for s in snap.people:
        m = s.user
        area = s.areas.most_common(1)[0][0] if s.areas else None
        people.append({
            "id": m.id,
            "name": m.name,
            "designation": m.designation,
            "photo_url": _photo(m),
            "is_you": m.id == user.id,
            "this_year": s.this_year,
            "last_year": s.last_year,
            "q1_this_year": s.q1_this_year,
            "led_this_year": s.led_this_year,
            "total": s.total,
            "last_year_published": s.last_paper_year,
            "area": area,
            "has_scopus_id": s.has_scopus_id,
            "target": personal.get((m.id, DepartmentTarget.Metric.PUBLICATIONS)),
            "last_reminded_at": nudged.get(m.id),
        })

    # ---- who needs a push ----
    push = []
    for p in people:
        if p["is_you"]:
            continue
        s = by_stats[p["id"]]
        reasons: list[str] = []
        kind = None
        if p["this_year"] == 0:
            if p["last_year"]:
                kind = "slipped"
                reasons.append(f"No paper in {year}; {p['last_year']} in {year - 1}")
            elif s.last_paper_year:
                kind = "quiet"
                reasons.append(f"No paper since {s.last_paper_year}")
            else:
                kind = "never"
                reasons.append(
                    "No paper on record" + ("" if s.has_scopus_id else ", and no Scopus ID on file")
                )
        elif p["target"] and p["this_year"] < p["target"] * elapsed:
            kind = "slipped"
            reasons.append(f"{p['this_year']} of a personal target of {p['target']}")
        if s.q_known_recent and not s.q1_recent:
            kind = kind or "no_q1"
            reasons.append(f"No Q1 paper since {year - 3} or earlier")
        if s.total >= 3 and not s.led_ever:
            kind = kind or "never_led"
            reasons.append("Has never led a paper")
        if reasons and kind:
            push.append({
                "person": p, "reasons": reasons, "kind": kind,
                "next_step": _NEXT_STEP[kind], "draft": _draft(year, kind, s),
                "_rank": (_KIND_RANK[kind], -(s.last_paper_year or 0), -s.total, p["name"]),
            })
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
        (p for p in people if by_stats[p["id"]].q1_recent >= 2),
        key=lambda p: (-by_stats[p["id"]].q1_recent, p["name"]),
    )
    load: Counter = Counter()
    pairs = []
    for r in push:
        mentee = r["person"]
        if by_stats[mentee["id"]].q1_recent:
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
                f"Both work on {match['area']}. {by_stats[match['id']].q1_recent} Q1 papers since "
                f"{year - 2} against "
                + ("nothing this year." if mentee["this_year"] == 0 else "no recent Q1.")
            ),
        })

    published = sum(1 for p in people if p["this_year"])

    # ---- where the department sits: its own place, no other department named ----
    college: dict[str, Any] | None = None
    try:
        pb = principal_brief.cached_brief(year)
        ranked = [
            d for d in pb["departments"]
            if d["teachers"] >= principal_brief.MIN_TEACHERS and d["per_teacher"] is not None
        ]
        place = next(
            (i + 1 for i, d in enumerate(ranked) if d["department"].casefold() == snap.department.casefold()),
            None,
        )
        college = {
            "per_teacher": pb["totals"]["per_teacher"],
            "papers": pb["totals"]["papers"],
            "top_quartile_share": pb["totals"]["top_quartile_share"],
            "rank": place,
            "of": len(ranked),
        }
    except Exception:  # the comparison is a nicety; the brief must not fail without it
        college = None

    return hod.without_money({
        "department": department,
        "year": year,
        "as_of": today.isoformat(),
        "elapsed": elapsed,
        "months_left": months_left,
        "totals": {
            "publications": snap.papers_year,
            "q1": snap.q1_year_count,
            "quartile_known": snap.quartile_known,
            "first_author": snap.led_year,
            "faculty": len(people),
            "faculty_published": published,
            "silent": len(people) - published,
            "per_teacher": round(snap.papers_year / len(people), 2) if people else None,
            "last_year_full": snap.last_year_full,
            "last_year_to_date": snap.last_to_date,
            "this_year_to_date": snap.this_to_date,
            "missing_doi": snap.missing_doi,
            "missing_issn": snap.missing_issn,
            "missing_issn_or_doi": snap.missing_either,
            "record_papers": snap.record_papers_year,
            "record_papers_window": snap.record_papers_window,
            "scopus_indexed": snap.scopus_indexed,
            "without_scopus_id": sum(1 for p in people if not p["has_scopus_id"]),
        },
        "college": college,
        "targets": targets,
        "by_year": by_year,
        "people": people,
        "push": push,
        "pairs": pairs,
        "years": sorted({y for y in snap.per_year} | {today.year}, reverse=True),
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
    """The one sentence a Principal can read and stop at."""
    t = b["totals"]
    pubs = next((x for x in b["targets"] if x["metric"] == "PUBLICATIONS"), None)
    if pubs:
        left = (
            f" {pubs['to_go']} to go in {b['months_left']} month{'s' if b['months_left'] != 1 else ''}"
            + (f", about {pubs['per_month_needed']:g} a month." if pubs["per_month_needed"] else ".")
            if pubs["to_go"] and b["months_left"] else ""
        )
        return (
            f"{t['publications']} of a target of {pubs['target']} papers, "
            f"{round(100 * b['elapsed'])}% of the year gone ({pubs['expected_by_now']:g} expected by now): "
            f"{_VERDICT_TEXT[pubs['verdict']].lower()}.{left}"
        )
    ahead = t["this_year_to_date"] >= t["last_year_to_date"]
    return (
        f"{t['this_year_to_date']} papers so far in {b['year']}, against "
        f"{t['last_year_to_date']} by the same date in {b['year'] - 1} "
        f"({t['last_year_full']} in all of {b['year'] - 1}): "
        f"{'ahead of' if ahead else 'behind'} last year's pace. No department target is set."
    )


#: The people with no paper this year; the others on the push list are about quality.
_SILENT = ("slipped", "quiet", "never")


def _silent(b: dict[str, Any]) -> list[dict[str, Any]]:
    return [r for r in b["push"] if r["kind"] in _SILENT]


def _summary(b: dict[str, Any]) -> str:
    """One paragraph a Principal can read and stop: output, pace, who needs help."""
    t = b["totals"]
    n_push, n_pairs = len(_silent(b)), len(b["pairs"])
    q_base = (
        f", {t['q1']} of the {t['quartile_known']} with a quartile recorded in Q1 journals"
        if t["quartile_known"] else ""
    )
    parts = [
        f"The Department of {b['department']} has {t['publications']} "
        f"{'paper' if t['publications'] == 1 else 'papers'} on record for {b['year']} so far{q_base}, "
        f"from {t['faculty_published']} of its {t['faculty']} faculty members."
    ]
    parts.append(_headline(b))
    if n_push:
        parts.append(
            f"{n_push} faculty {'member has' if n_push == 1 else 'members have'} no paper on record for {b['year']} and "
            f"{'needs' if n_push == 1 else 'need'} a push"
            + (f"; {n_pairs} writing {'pair is' if n_pairs == 1 else 'pairs are'} suggested to help." if n_pairs else ".")
        )
    else:
        parts.append("Every faculty member has published this year.")
    return " ".join(parts)


def _person_years(department: str, years: list[int]) -> dict[str, Counter]:
    """{user id: {year: papers}} over `years`, by the count a person's card shows."""
    from core.services.person_record import papers_of

    users = hod_record.teachers(department)
    out: dict[str, Counter] = {}
    for uid, papers in papers_of(users).items():
        out[uid] = Counter(p.year for p in papers if p.year in years)
    return out


def _report_pdf(user: User, b: dict[str, Any]) -> bytes:
    from xml.sax.saxutils import escape

    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

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
        Paragraph(f"Research note for the Principal, {b['year']}", h1),
        Paragraph(f"Department of {escape(b['department'])}, as of {as_of}", sub),
        Spacer(1, 1.5 * mm),
        Paragraph(
            f"Prepared by {escape(user.name)}, Head of Department, on {as_of}. Papers are counted from the publication record; "
            "it is the record the Principal's reports use. No money figures appear in this note.",
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
        pace.append(Paragraph(
            f"{elapsed} {b['months_left']} month{'s' if b['months_left'] != 1 else ''} to go."
            + "".join(
                f" {x['label']}: {x['to_go']} more, about {x['per_month_needed']:g} a month."
                for x in b["targets"] if x["to_go"] and x["per_month_needed"]
            ), small))
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
    d = Drawing(width, 40 * mm)
    ch = VerticalBarChart()
    ch.x, ch.y, ch.width, ch.height = 10 * mm, 9 * mm, width - 14 * mm, 26 * mm
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
    story.append(Paragraph(f"Who needs a push: no paper on record in {b['year']}", h2))
    silent = _silent(b)
    quality = len(b["push"]) - len(silent)
    if silent:
        rows = [["Faculty", "Why", "Next step"]] + [
            [r["person"]["name"], "; ".join(r["reasons"]), r["next_step"]]
            for r in silent[:4]
        ]
        story.append(table(rows, [46, 62, 62]))
        more = []
        if len(silent) > 4:
            more.append(f"{len(silent) - 4} more with no paper")
        if quality:
            more.append(f"{quality} with a paper but no recent Q1 paper, or who have never led one")
        if more:
            story.append(Paragraph(f"And {', and '.join(more)}; the Excel workbook lists everyone with a next step.", small))
    else:
        story.append(Paragraph(f"Nobody: every faculty member has a paper on record for {b['year']}.", base))

    if b["pairs"]:
        story.append(Paragraph("Suggested writing pairs", h2))
        story.append(Paragraph(escape("; ".join(
            f"{x['mentee']['name']} with {x['mentor']['name']}" + (f" ({x['area']})" if x["area"] else "")
            for x in b["pairs"][:6]
        ) + "."), base))

    # ---- what an assessor would send back ----
    fixes = []
    span = f"{b['by_year'][0]['year']} to {b['year']}"
    if t["missing_doi"]:
        fixes.append(f"{t['missing_doi']:,} of {t['record_papers_window']:,} papers of {span} have no DOI")
    if t["missing_issn"]:
        fixes.append(f"{t['missing_issn']:,} journal {'article has' if t['missing_issn'] == 1 else 'articles have'} no ISSN")
    if t["without_scopus_id"]:
        fixes.append(f"{t['without_scopus_id']} of {t['faculty']} faculty have no Scopus ID on file")
    story.append(Paragraph("Records to fix before the next accreditation return", h2))
    story.append(Paragraph(escape("; ".join(fixes) + ".") if fixes else "Nothing: every paper has a DOI and every journal article an ISSN.", base))

    # ---- per teacher: an appendix on its own page, so pages 1 and 2 stand alone ----
    story.append(PageBreak())
    story.append(Paragraph(f"Per teacher, {b['year']}", h2))
    rows = [["Faculty", "Designation", str(b["year"]), str(b["year"] - 1), "Q1", "Led", "All years"]] + [
        [x["name"], x["designation"] or "", x["this_year"], x["last_year"], x["q1_this_year"],
         x["led_this_year"], x["total"]]
        for x in sorted(b["people"], key=lambda x: (-x["this_year"], x["name"]))
    ]
    story.append(table(rows, [54, 40, 15, 15, 12, 12, 18], numeric_from=2))
    story.append(Spacer(1, 2 * mm))
    story.append(Paragraph(
        f"{b['year']} counts papers on the college record with a publication year of {b['year']}; Q1 and Led are for "
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
            self.drawString(left, 10 * mm, f"Research note {year}, {department}, as of {as_of}")
            self.drawRightString(A4[0] - right, 10 * mm, f"Page {self._pageNumber} of {total}")

    buf = io.BytesIO()
    SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=left, rightMargin=right, topMargin=22 * mm, bottomMargin=18 * mm,
        title=f"{department} research note {year}", author=user.name,
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
           ["Papers with no DOI", t["missing_doi"]], ["Papers with no ISSN", t["missing_issn"]],
           ["Faculty with no Scopus ID on file", t["without_scopus_id"]]]
          + [[f"Target: {x['label']}", f"{x['done']} of {x['target']} ({_VERDICT_TEXT[x['verdict']]})"]
             for x in b["targets"]]
          + [[f"Papers in {r['year']}{' (so far)' if r['partial'] else ''}", r["publications"]] for r in b["by_year"]],
          [44, 40])

    years = [r["year"] for r in b["by_year"]]
    papers = hod_record.paper_rows(b["department"], years)
    per_teacher: dict[str, Counter] = defaultdict(Counter)
    people_years = _person_years(b["department"], years)
    for uid, counts in people_years.items():
        per_teacher[uid].update(counts)
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
          [[c["title"], "; ".join(c["authors"]), b["department"], c["journal"], c["year"], c["issn"],
            c["quartile"] or "", c["indexed"], f"https://doi.org/{c['doi']}" if c["doi"] else "",
            (f"https://www.scopus.com/record/display.uri?eid={c['eid']}&origin=resultslist" if c["eid"] else ""),
            c["position"] if c["position"] not in (None, 999) else ""] for c in papers],
          [50, 26, 12, 34, 10, 12, 9, 16, 34, 30, 10])

    def gaps(c: dict[str, Any]) -> list[str]:
        out = []
        if hod_record.needs_issn(c["type"]) and not (c["issn"] or "").strip():
            out.append("ISSN")
        if not (c["doi"] or "").strip():
            out.append("DOI")
        return out

    missing = [c for c in papers if gaps(c)]
    sheet(wb.create_sheet("Missing data"),
          ["Papers an assessor would send back: missing ISSN or DOI", stamp],
          ["Faculty", "Title of paper", "Journal", "Year", "Missing"],
          [["; ".join(c["authors"]), c["title"], c["journal"], c["year"], ", ".join(gaps(c))]
           for c in missing],
          [26, 50, 34, 8, 14])

    sheet(wb.create_sheet("Who needs a push"),
          [f"Who needs a push, {b['year']}", stamp],
          ["Faculty", "Designation", "Why", "Next step"],
          [[r["person"]["name"], r["person"]["designation"], "; ".join(r["reasons"]), r["next_step"]] for r in b["push"]],
          [30, 22, 60, 50])
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
    stem = f"{b['department'].replace(' ', '-').lower()}-research-note-{b['year']}"
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


# ---------- the papers behind every figure ----------


def _own_department(user: User) -> str:
    department = hod.department_of(user)
    if not department:
        raise HttpError(400, "This account has no department set, so there is nothing to show. "
                             "Ask the research office to set it.")
    return department


@api.get("/hod/department/papers", auth=session_auth)
def hod_department_papers(
    request: HttpRequest,
    year: Optional[int] = None,
    quartile: Optional[str] = None,
    q: Optional[str] = None,
    person: Optional[str] = None,
    missing: Optional[str] = None,
    limit: int = 25,
    offset: int = 0,
):
    """The department's papers, from the college record: what every figure on the
    head's pages opens. The department comes from the account, never a parameter."""
    user = _require_hod(request)
    if person:
        who = User.objects.filter(pk=person).first()
        if who is None or hod_record.department_name(who.department or "") != hod_record.department_name(
            _own_department(user)
        ):
            raise HttpError(403, "A head sees their own department.")
    return hod.without_money(hod_record.department_papers(
        _own_department(user), year=year, quartile=(quartile or "").strip() or None, q=q,
        person=person, missing=missing if missing in ("doi", "issn") else None,
        limit=max(1, min(limit, 100)), offset=max(0, offset),
    ))


@api.get("/hod/department/papers/export", auth=session_auth)
def hod_department_papers_export(
    request: HttpRequest,
    year: Optional[int] = None,
    quartile: Optional[str] = None,
    q: Optional[str] = None,
    person: Optional[str] = None,
    missing: Optional[str] = None,
):
    """The list on screen as an Excel sheet, with the college and the filter on top."""
    from core.services import institution, principal_reports

    user = _require_hod(request)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    dept = _own_department(user)
    if person:
        who = User.objects.filter(pk=person).first()
        if who is None or hod_record.department_name(who.department or "") != hod_record.department_name(dept):
            raise HttpError(403, "A head sees their own department.")
    data = hod_record.department_papers(
        dept, year=year, quartile=(quartile or "").strip() or None, q=q, person=person,
        missing=missing if missing in ("doi", "issn") else None, limit=20000, offset=0,
    )
    rows = [{**r, "departments": [data["department"]]} for r in data["results"]]
    bits = [f"Department of {data['department']}", str(year) if year else "all years"]
    if quartile:
        bits.append({"top": "Q1 or Q2 journals", "none": "no quartile recorded"}.get(quartile.lower(), quartile.upper()))
    if missing:
        bits.append(f"missing the {missing.upper()}")
    if q:
        bits.append(f'matching "{q}"')
    college = institution.get("college_name") or "Research office"
    body = principal_reports.papers_xlsx(college, ", ".join(bits), rows)
    AuditLog.objects.create(
        actor=user, action="HOD_EXPORT", entity="Department", entity_id=dept,
        detail_json=json.dumps({"rows": len(rows), "format": "xlsx", "source": "record"}),
    )
    res = HttpResponse(body, content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    res["Content-Disposition"] = f'attachment; filename="{dept.replace(" ", "-").lower()}-papers-{year or "all"}.xlsx"'
    return res


@api.get("/hod/department/records", auth=session_auth)
def hod_department_records(request: HttpRequest, year: Optional[int] = None):
    """What an assessor would send back, with names: papers with no DOI or ISSN over the
    five years NAAC looks at, and the faculty whose Scopus ID is not on file."""
    user = _require_hod(request)
    year = year or timezone.localdate().year
    years = list(range(year - hod_record.YEARS_SHOWN + 1, year + 1))
    return hod.without_money(hod_record.records_to_fix(_own_department(user), years))


__all__ = ["build_brief", "hod_brief", "hod_report", "hod_department_papers",
           "hod_department_papers_export", "hod_department_records"]
