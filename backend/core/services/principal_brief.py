"""The year on one page: what the Principal takes to the governing council.

The questions, in the order she asks them (docs/jtbd/principal.md):

1. Did the college publish more or less than last year, and per teacher?
2. Which departments carry it, and which lag, measured per teacher so a big
   department does not win by size alone?
3. What did the scheme cost, against the budget, and per paper?
4. Is the quality moving (share of papers in Q1/Q2 journals)?
5. Where does NAAC metric 3.3.1 (papers per teacher over five years) stand?

Sources are the two truths `college_totals` already defines: papers from the
publication record (plus recognised claim papers it does not hold), money
from the ledger. Papers are counted by calendar publication year, money by
India's April-March financial year, because that is how each is reported:
NAAC/NIRF count publications by year, the budget is set per financial year.

Teachers are today's active faculty and heads on the roll, per department.
No history of headcount is stored, so earlier years are divided by today's
roll; the brief says so rather than presenting it as exact.
"""
from __future__ import annotations

import io
from collections import defaultdict
from datetime import date
from typing import Any, Optional

from django.db.models import Q

from core.models import Authorship, Budget, Role, User
from core.services import college_totals
from core.services.college_totals import NO_DEPARTMENT

TEACHER_ROLES = (Role.FACULTY, Role.HOD)
TOP_QUARTILES = {"Q1", "Q2"}


def fy_label(year: int) -> str:
    """The financial year that starts in April of `year`: 2025 -> "2025-26"."""
    return f"{year}-{str(year + 1)[-2:]}"


def _fy_start(d: date) -> int:
    return d.year if d.month >= 4 else d.year - 1


def _ratio(a: float, b: float, places: int = 2) -> Optional[float]:
    return round(a / b, places) if b else None


def _change(now: float, before: float) -> Optional[float]:
    """Percentage change, or None when there is no base to compare against."""
    return round((now - before) * 100 / before, 1) if before else None


def naac_331_band(per_teacher: Optional[float]) -> int:
    """NAAC 3.3.1's scale for papers per teacher over five years."""
    if not per_teacher:
        return 0
    if per_teacher >= 10:
        return 4
    if per_teacher >= 5:
        return 3
    if per_teacher >= 3:
        return 2
    return 1


def teachers_by_department() -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for d in User.objects.filter(active=True, role__in=TEACHER_ROLES).values_list("department", flat=True):
        out[(d or "").strip() or NO_DEPARTMENT] += 1
    return dict(out)


def _quartiles_by_year() -> dict[int, tuple[int, int]]:
    """{year: (papers with a quartile recorded, of which Q1/Q2)} from the record."""
    seen: dict[str, tuple[Optional[int], str]] = {}
    for pid, y, q in Authorship.objects.filter(
        Q(is_college=True) | Q(user__isnull=False)
    ).values_list("publication_id", "publication__year", "publication__quartile"):
        seen[pid] = (y, (q or "").strip().upper())
    out: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for y, q in seen.values():
        if y and q in {"Q1", "Q2", "Q3", "Q4"}:
            out[y][0] += 1
            out[y][1] += q in TOP_QUARTILES
    return {y: (v[0], v[1]) for y, v in out.items()}


def brief(year: Optional[int] = None) -> dict[str, Any]:
    today = date.today()
    year = year or (today.year - 1 if today.month < 7 else today.year)
    years = list(range(year - 4, year + 1))
    fy = fy_label(year)

    teachers = teachers_by_department()
    college_teachers = sum(v for k, v in teachers.items() if k != NO_DEPARTMENT) or sum(teachers.values())

    record = college_totals.papers()
    by_year: dict[int, int] = defaultdict(int)
    by_dept_year: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for p in record:
        if not p["year"]:
            continue
        by_year[p["year"]] += 1
        for d in p["departments"]:
            by_dept_year[d][p["year"]] += 1

    pays = college_totals.payments()
    paid_fy: dict[int, float] = defaultdict(float)
    paid_dept_fy: dict[str, dict[int, float]] = defaultdict(lambda: defaultdict(float))
    for p in pays:
        if not p["month"]:
            continue
        s = _fy_start(p["month"])
        paid_fy[s] += p["amount"]
        paid_dept_fy[p["department"]][s] += p["amount"]

    budgets: dict[tuple[str, Optional[str]], float] = {
        (b.financial_year, (b.department or "").strip() or None): b.amount
        for b in Budget.objects.all()
    }
    quart = _quartiles_by_year()

    trend = []
    for y in years:
        qn, qt = quart.get(y, (0, 0))
        trend.append({
            "year": y,
            "papers": by_year.get(y, 0),
            "per_teacher": _ratio(by_year.get(y, 0), college_teachers),
            "top_quartile_share": _ratio(qt * 100, qn, 0),
            "financial_year": fy_label(y),
            "paid": round(paid_fy.get(y, 0), 2),
            "budget": budgets.get((fy_label(y), None)),
        })

    now, prev = trend[-1], trend[-2]
    five_year = sum(t["papers"] for t in trend)

    dept_names = {d for d in teachers if d != NO_DEPARTMENT}
    dept_names |= {d for d in by_dept_year if d != NO_DEPARTMENT}
    departments = []
    for d in dept_names:
        n_t = teachers.get(d, 0)
        ys = by_dept_year.get(d, {})
        papers_now, papers_prev = ys.get(year, 0), ys.get(year - 1, 0)
        paid = round(paid_dept_fy.get(d, {}).get(year, 0), 2)
        five = sum(ys.get(y, 0) for y in years)
        departments.append({
            "department": d,
            "teachers": n_t,
            "papers": papers_now,
            "papers_prev": papers_prev,
            "change": _change(papers_now, papers_prev),
            "per_teacher": _ratio(papers_now, n_t),
            "five_year": five,
            "five_year_per_teacher": _ratio(five, n_t),
            "paid": paid,
            "budget": budgets.get((fy, d)),
            "cost_per_paper": _ratio(paid, papers_now, 0),
        })
    departments.sort(key=lambda r: (-(r["per_teacher"] or 0), -r["papers"], r["department"]))

    unassigned = by_dept_year.get(NO_DEPARTMENT, {}).get(year, 0)
    per5 = _ratio(five_year, college_teachers)
    totals = {
        "papers": now["papers"],
        "papers_prev": prev["papers"],
        "change": _change(now["papers"], prev["papers"]),
        "teachers": college_teachers,
        "per_teacher": now["per_teacher"],
        "per_teacher_prev": prev["per_teacher"],
        "top_quartile_share": now["top_quartile_share"],
        "top_quartile_share_prev": prev["top_quartile_share"],
        "paid": now["paid"],
        "paid_prev": prev["paid"],
        "budget": now["budget"],
        "budget_used": _ratio(now["paid"] * 100, now["budget"] or 0, 0),
        "cost_per_paper": _ratio(now["paid"], now["papers"], 0),
    }
    brief = {
        "year": year,
        "financial_year": fy,
        "years_available": sorted({y for y in by_year if y} | {today.year}, reverse=True),
        "totals": totals,
        "trend": trend,
        "departments": departments,
        "naac_331": {
            "from": years[0], "to": years[-1], "papers": five_year,
            "teachers": college_teachers, "per_teacher": per5, "band": naac_331_band(per5),
        },
        "unassigned_papers": unassigned,
        "notes": [
            "Papers: the publication record plus recognised claim papers it does not hold, "
            "counted once per paper by calendar publication year. A paper shared by two "
            "departments counts in each department, once for the college.",
            f"Money: every payment on the ledger, by financial year (April to March); "
            f"{year} is read with FY {fy}.",
            "Teachers: today's active faculty and heads on the roll. Earlier years are "
            "divided by today's roll; no headcount history is stored.",
            "NAAC 3.3.1 counts only UGC-CARE journals. This figure counts every paper on "
            "record, so it is an upper bound until the UGC-CARE list is checked.",
            "Q1/Q2 share: of the papers whose journal quartile is recorded.",
        ],
    }
    brief["headline"] = headline(brief)
    return brief


def _inr(n: Optional[float], sign: str = "₹") -> str:
    """Indian grouping: 3250610 -> "₹32,50,610"."""
    if n is None:
        return "not set"
    s = str(int(round(n)))
    neg = s.startswith("-")
    s = s.lstrip("-")
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts + [tail])
    return ("-" if neg else "") + sign + s


def headline(b: dict[str, Any]) -> str:
    t, y = b["totals"], b["year"]
    parts = [f"In {y} the college published {t['papers']} papers"]
    if t["change"] is not None:
        word = "up" if t["change"] > 0 else "down" if t["change"] < 0 else "level"
        parts.append(
            f", {word} {abs(t['change']):g}% on {y - 1}" if word != "level" else f", the same as {y - 1}"
        )
    if t["per_teacher"] is not None:
        parts.append(f": {t['per_teacher']:g} per teacher across {t['teachers']} teachers")
    s = "".join(parts) + "."
    if t["budget"]:
        s += f" It paid {_inr(t['paid'])} in incentives in FY {b['financial_year']}, {t['budget_used']:g}% of the {_inr(t['budget'])} budget."
    else:
        s += f" It paid {_inr(t['paid'])} in incentives in FY {b['financial_year']}; no budget is set for that year."
    ranked = [d for d in b["departments"] if d["teachers"] and d["per_teacher"] is not None]
    if len(ranked) >= 2:
        top, low = ranked[0], ranked[-1]
        s += (f" {top['department']} leads with {top['per_teacher']:g} papers per teacher;"
              f" {low['department']} is lowest at {low['per_teacher']:g}.")
    return s


# ------------------------------------------------------------ downloads ----

def xlsx(b: dict[str, Any], college: str) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = Workbook()
    head = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="1F2430")

    def sheet(ws, title: str, columns: list[str], rows: list[list[Any]], money_cols=(), widths=None):
        ws.title = title
        ws.append([college])
        ws["A1"].font = Font(bold=True, size=13)
        ws.append([f"Research publications and incentive spend, {b['year']} (FY {b['financial_year']})"])
        ws.append([])
        ws.append(columns)
        for c in ws[4]:
            c.font, c.fill = head, fill
            c.alignment = Alignment(wrap_text=True, vertical="top")
        for r in rows:
            ws.append(r)
        for col in money_cols:
            for row in ws.iter_rows(min_row=5, min_col=col, max_col=col):
                for c in row:
                    c.number_format = "#,##,##0"
        for i, w in enumerate(widths or [], start=1):
            ws.column_dimensions[chr(64 + i)].width = w
        ws.freeze_panes = "A5"

    t = b["totals"]
    sheet(wb.active, "Summary", ["Measure", str(b["year"]), str(b["year"] - 1)], [
        ["Papers published", t["papers"], t["papers_prev"]],
        ["Teachers on roll (today)", t["teachers"], t["teachers"]],
        ["Papers per teacher", t["per_teacher"], t["per_teacher_prev"]],
        ["Share of papers in Q1/Q2 journals (%)", t["top_quartile_share"], t["top_quartile_share_prev"]],
        [f"Incentives paid, FY (Rs)", t["paid"], t["paid_prev"]],
        ["Budget, FY (Rs)", t["budget"], b["trend"][-2]["budget"]],
        ["Budget used (%)", t["budget_used"], None],
        ["Cost per paper (Rs)", t["cost_per_paper"], None],
        [],
        ["Headline", b["headline"]],
    ], widths=[40, 18, 18])
    sheet(wb.create_sheet(), "Five years", [
        "Year", "Papers", "Papers per teacher", "Q1/Q2 share (%)", "Financial year",
        "Incentives paid (Rs)", "Budget (Rs)",
    ], [[r["year"], r["papers"], r["per_teacher"], r["top_quartile_share"], r["financial_year"],
         r["paid"], r["budget"]] for r in b["trend"]], money_cols=(6, 7), widths=[8, 10, 12, 12, 12, 16, 16])
    sheet(wb.create_sheet(), "Departments", [
        "Department", "Teachers", f"Papers {b['year']}", f"Papers {b['year'] - 1}", "Change (%)",
        "Papers per teacher", "Papers, five years", "Five-year papers per teacher",
        f"Paid FY {b['financial_year']} (Rs)", "Budget (Rs)", "Cost per paper (Rs)",
    ], [[d["department"], d["teachers"], d["papers"], d["papers_prev"], d["change"], d["per_teacher"],
         d["five_year"], d["five_year_per_teacher"], d["paid"], d["budget"], d["cost_per_paper"]]
        for d in b["departments"]], money_cols=(9, 10, 11), widths=[16, 9, 10, 10, 10, 11, 11, 12, 16, 14, 14])
    n = b["naac_331"]
    sheet(wb.create_sheet(), "NAAC 3.3.1", [
        "Year", "Number of research papers", "Full-time teachers",
    ], [[r["year"], r["papers"], b["totals"]["teachers"]] for r in b["trend"]] + [
        [], ["Five-year total", n["papers"], n["teachers"]],
        ["Papers per teacher", n["per_teacher"]], ["NAAC band (0-4)", n["band"]],
    ], widths=[20, 24, 18])
    ws = wb.create_sheet("Notes")
    for line in b["notes"]:
        ws.append([line])
    ws.column_dimensions["A"].width = 120
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def pdf(b: dict[str, Any], college: str) -> bytes:
    """One A4 page (two at most) for the governing council."""
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=9, leading=12)
    small = ParagraphStyle("s", parent=body, fontSize=7, leading=9, textColor=colors.HexColor("#555555"))
    lead = ParagraphStyle("l", parent=body, fontName="Times-Roman", fontSize=12.5, leading=16)
    h2 = ParagraphStyle("h", parent=body, fontName="Helvetica-Bold", fontSize=10, spaceBefore=6, spaceAfter=3)
    ink, accent, rule = colors.HexColor("#1F2430"), colors.HexColor("#C2410C"), colors.HexColor("#D9DCE1")
    t, y = b["totals"], b["year"]

    def header(canvas, doc):
        canvas.saveState()
        w, h = A4
        canvas.setFont("Times-Bold", 14)
        canvas.setFillColor(ink)
        canvas.drawString(15 * mm, h - 15 * mm, college)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(15 * mm, h - 20 * mm, "Research publications and incentive spend: brief for the Governing Council")
        canvas.drawRightString(w - 15 * mm, h - 15 * mm, f"Calendar year {y} · FY {b['financial_year']}")
        canvas.drawRightString(w - 15 * mm, h - 20 * mm, f"Prepared {date.today():%d %B %Y}")
        canvas.setStrokeColor(ink)
        canvas.line(15 * mm, h - 22.5 * mm, w - 15 * mm, h - 22.5 * mm)
        canvas.setFont("Helvetica", 7)
        canvas.drawString(15 * mm, 9 * mm, "Papers from the publication record; money from the payment ledger. See the notes at the end.")
        canvas.drawRightString(w - 15 * mm, 9 * mm, f"Page {doc.page}")
        canvas.restoreState()

    def fmt(v, money=False, pct=False):
        if v is None:
            return "–"
        if money:
            return _inr(v, "Rs ")
        return f"{v:g}%" if pct else f"{v:g}" if isinstance(v, float) else str(v)

    def table(data, widths, align_right_from=1):
        tb = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
        tb.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7.5),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 7.5),
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, ink),
            ("LINEBELOW", (0, 1), (-1, -1), 0.25, rule),
            ("ALIGN", (align_right_from, 0), (-1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        return tb

    # The base PDF fonts carry no rupee glyph; "Rs" is what a printed return uses.
    story: list[Any] = [Paragraph(b["headline"].replace("₹", "Rs "), lead), Spacer(1, 4 * mm)]
    story.append(Paragraph("The year against the last", h2))
    story.append(table([
        ["", str(y), str(y - 1), "Change"],
        ["Papers published", fmt(t["papers"]), fmt(t["papers_prev"]), fmt(t["change"], pct=True)],
        ["Papers per teacher", fmt(t["per_teacher"]), fmt(t["per_teacher_prev"]), ""],
        ["Share in Q1/Q2 journals", fmt(t["top_quartile_share"], pct=True), fmt(t["top_quartile_share_prev"], pct=True), ""],
        ["Incentives paid (FY)", fmt(t["paid"], money=True), fmt(t["paid_prev"], money=True),
         fmt(_change(t["paid"], t["paid_prev"]), pct=True)],
        ["Budget (FY) and used", fmt(t["budget"], money=True), "", fmt(t["budget_used"], pct=True)],
        ["Cost per paper", fmt(t["cost_per_paper"], money=True), "", ""],
    ], [60 * mm, 32 * mm, 32 * mm, 24 * mm]))

    # Five years: papers as bars, labelled with their value.
    story.append(Paragraph("Five years: papers published and incentives paid", h2))
    d = Drawing(180 * mm, 42 * mm)
    for i, (key, label, color) in enumerate((("papers", "Papers", accent), ("paid", "Paid (Rs lakh)", ink))):
        ch = VerticalBarChart()
        ch.x, ch.y, ch.width, ch.height = 12 * mm + i * 92 * mm, 8 * mm, 76 * mm, 28 * mm
        vals = [r[key] / (100000 if key == "paid" else 1) for r in b["trend"]]
        ch.data = [vals]
        ch.categoryAxis.categoryNames = [str(r["year"]) if key == "papers" else r["financial_year"] for r in b["trend"]]
        ch.categoryAxis.labels.fontSize = 6.5
        ch.valueAxis.valueMin = 0
        ch.valueAxis.labels.fontSize = 6.5
        ch.bars[0].fillColor = color
        ch.bars[0].strokeColor = None
        ch.barLabelFormat = "%.0f" if key == "papers" else "%.1f"
        ch.barLabels.fontSize = 6.5
        ch.barLabels.nudge = 5
        d.add(ch)
        d.add(String(ch.x, 38 * mm, label, fontName="Helvetica-Bold", fontSize=7.5))
    story.append(d)

    story.append(Paragraph(f"Departments, ranked by papers per teacher ({y})", h2))
    hs = ParagraphStyle("th", parent=small, fontName="Helvetica-Bold", textColor=ink, alignment=2)
    rows = [[Paragraph(h, hs) for h in (
        "Department", "Teachers", f"Papers {y}", f"Papers {y - 1}", "Change", "Papers per teacher",
        "Five-year per teacher", f"Paid FY {b['financial_year']}", "Paid per paper")]]
    rows[0][0] = Paragraph("Department", ParagraphStyle("thl", parent=hs, alignment=0))
    for r in b["departments"]:
        rows.append([r["department"], fmt(r["teachers"]), fmt(r["papers"]), fmt(r["papers_prev"]),
                     fmt(r["change"], pct=True), fmt(r["per_teacher"]), fmt(r["five_year_per_teacher"]),
                     fmt(r["paid"], money=True), fmt(r["cost_per_paper"], money=True)])
    story.append(table(rows, [34 * mm, 15 * mm, 16 * mm, 13 * mm, 16 * mm, 18 * mm, 20 * mm, 24 * mm, 20 * mm]))
    if b["unassigned_papers"]:
        story.append(Paragraph(f"{b['unassigned_papers']} papers of {y} carry no department and are not in this table.", small))

    n = b["naac_331"]
    story.append(Paragraph("NAAC metric 3.3.1", h2))
    story.append(Paragraph(
        f"{n['papers']} papers from {n['from']} to {n['to']} over {n['teachers']} teachers: "
        f"<b>{fmt(n['per_teacher'])} per teacher</b>, band {n['band']} of 4 on NAAC's scale "
        "(10 or more = 4; 5-10 = 3; 3-5 = 2; under 3 = 1). Upper bound until UGC-CARE listing is checked.", body))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph("Notes", h2))
    for line in b["notes"]:
        story.append(Paragraph(line, small))

    out = io.BytesIO()
    SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=27 * mm,
                      bottomMargin=14 * mm, title=f"{college}: research brief {y}").build(
        story, onFirstPage=header, onLaterPages=header)
    return out.getvalue()
