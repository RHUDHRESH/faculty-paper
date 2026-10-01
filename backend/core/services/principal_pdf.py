"""The year brief as a document the Principal can hand over.

Two A4 pages, each with the college header and a page number:

1. The answer: the year in one sentence, this year against last, five years,
   the departments to look at (behind, and rising), and NAAC 3.3.1.
2. The detail: every department, ranked per teacher, and the notes that say
   where each figure comes from.

The figures are the ones on screen and in the Excel, taken from the same
`principal_brief.brief()` dict, so the three cannot disagree.
"""
from __future__ import annotations

import io
from datetime import date
from xml.sax.saxutils import escape
from typing import Any

from core.services import pdf_fonts


def build(b: dict[str, Any], college: str, inr, change_pct) -> bytes:
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    SANS, SANS_BOLD = pdf_fonts.register()
    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["BodyText"], fontName=SANS, fontSize=9, leading=12)
    small = ParagraphStyle("s", parent=body, fontSize=7, leading=9, textColor=colors.HexColor("#555555"))
    cell = ParagraphStyle("c", parent=body, fontSize=7.5, leading=9.5)
    lead = ParagraphStyle("l", parent=body, fontSize=11.5, leading=15.5)
    h2 = ParagraphStyle("h", parent=body, fontName=SANS_BOLD, fontSize=10, spaceBefore=7, spaceAfter=3, keepWithNext=1)
    ink, accent, rule = colors.HexColor("#1F2430"), colors.HexColor("#C2410C"), colors.HexColor("#D9DCE1")
    t, y = b["totals"], b["year"]
    g = pdf_fonts.group_in

    def header(canvas, doc):
        canvas.saveState()
        w, h = A4
        canvas.setFont("Times-Bold", 14)
        canvas.setFillColor(ink)
        canvas.drawString(15 * mm, h - 15 * mm, college)
        canvas.setFont(SANS, 8)
        canvas.drawString(15 * mm, h - 20 * mm, "Research publications and incentive spend: brief for the Governing Council")
        canvas.drawRightString(w - 15 * mm, h - 15 * mm, f"Calendar year {y} · FY {b['financial_year']}")
        canvas.drawRightString(w - 15 * mm, h - 20 * mm, f"Prepared {date.today():%d %B %Y}")
        canvas.setStrokeColor(ink)
        canvas.line(15 * mm, h - 22.5 * mm, w - 15 * mm, h - 22.5 * mm)
        canvas.setFont(SANS, 7)
        canvas.setFillColor(colors.HexColor("#555555"))
        canvas.drawString(
            15 * mm, 9 * mm,
            "Papers from the publication record; money from the payment ledger. Sources are on page 2.",
        )
        canvas.drawRightString(w - 15 * mm, 9 * mm, f"Page {doc.page}")
        canvas.restoreState()

    def num(v):
        if v is None:
            return "Not recorded"
        return f"{v:g}" if isinstance(v, float) and v != int(v) else g(v)

    def pct(v):
        return "Not recorded" if v is None else f"{v:g}%"

    def signed(v):
        return "New this year" if v is None else f"{'+' if v > 0 else ''}{v:g}%"

    def table(data, widths, right_from=1, style_extra=()):
        tb = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
        tb.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), SANS_BOLD, 7.5),
            ("FONT", (0, 1), (-1, -1), SANS, 7.5),
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, ink),
            ("LINEBELOW", (0, 1), (-1, -1), 0.25, rule),
            ("ALIGN", (right_from, 0), (-1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            *style_extra,
        ]))
        return tb

    # ---- page 1: the answer -------------------------------------------------
    story: list[Any] = [Paragraph(b["headline"], lead), Spacer(1, 3 * mm)]
    story.append(Paragraph("The year against the last", h2))
    q_known = t.get("quartile_known") or 0
    story.append(table([
        ["", str(y) + (" to date" if b["partial"] else ""), str(y - 1), "Change"],
        ["Papers published", num(t["papers"]), num(t["papers_prev"]), "" if b["partial"] else signed(t["change"])],
        ["Papers per teacher", num(t["per_teacher"]), num(t["per_teacher_prev"]), ""],
        [f"In Q1 or Q2 journals (of the {g(q_known)} papers with a quartile recorded)", pct(t["top_quartile_share"]),
         pct(t["top_quartile_share_prev"]), ""],
        ["Incentives paid (FY)", inr(t["paid"]), inr(t["paid_prev"]), signed(change_pct(t["paid"], t["paid_prev"]))],
        ["Budget (FY) and share used", inr(t["budget"]) if t["budget"] is not None else "Not set", "",
         pct(t["budget_used"]) if t["budget"] is not None else ""],
        ["Cost per paper", inr(t["cost_per_paper"]) if t["cost_per_paper"] else "None", "", ""],
    ], [86 * mm, 30 * mm, 30 * mm, 24 * mm]))

    story.append(Paragraph("Five years: papers published and incentives paid", h2))
    d = Drawing(180 * mm, 42 * mm)
    for i, (key, label, color) in enumerate((("papers", "Papers", accent), ("paid", "Paid (₹ lakh)", ink))):
        ch = VerticalBarChart()
        ch.x, ch.y, ch.width, ch.height = 12 * mm + i * 92 * mm, 8 * mm, 76 * mm, 28 * mm
        ch.data = [[r[key] / (100000 if key == "paid" else 1) for r in b["trend"]]]
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
        d.add(String(ch.x, 38 * mm, label, fontName=SANS_BOLD, fontSize=7.5))
    story.append(d)

    # Where to look: behind on the left, rising on the right.
    story.append(Paragraph("Where to look", h2))
    push = [[Paragraph(f"<b>{escape(r['department'])}</b><br/>{escape('. '.join(r['reasons']))}", cell)] for r in b['push']] or [
        [Paragraph("No department stands out as behind.", cell)]]
    rise = [[Paragraph(f"<b>{escape(r['department'])}</b><br/>Up {r['change']:g}%: {r['papers_prev']} papers in {y - 1}, "
                       f"{r['papers']} in {y}", cell)] for r in b["rising"]] or [
        [Paragraph("No department has grown enough to name.", cell)]]

    def column(title, rows):
        tb = Table([[Paragraph(f"<b>{title}</b>", cell)]] + rows, colWidths=[86 * mm])
        tb.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, ink), ("LINEBELOW", (0, 1), (-1, -1), 0.25, rule),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]))
        return tb

    both = Table([[column("Needs a push (three teachers or more)", push), column("Rising (five papers or more last year)", rise)]],
                 colWidths=[93 * mm, 93 * mm], hAlign="LEFT")
    both.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(both)

    n = b["naac_331"]
    story.append(Paragraph("NAAC metric 3.3.1", h2))
    story.append(Paragraph(
        f"{g(n['papers'])} papers from {n['from']} to {n['to']} over {n['teachers']} teachers: "
        f"<b>{num(n['per_teacher'])} per teacher</b>, band {n['band']} of 4 on NAAC's scale "
        "(10 or more is 4; 5 to 10 is 3; 3 to 5 is 2; under 3 is 1). NAAC counts UGC-CARE journals only, "
        "so this is the ceiling until that list is checked.", body))

    # ---- page 2: the detail -----------------------------------------------------
    story.append(PageBreak())
    story.append(Paragraph(f"Every department, ranked by papers per teacher ({y})", h2))
    hs = ParagraphStyle("th", parent=small, fontName=SANS_BOLD, textColor=ink, alignment=2)
    any_budget = any(r["budget"] is not None for r in b["departments"])
    heads = ["Department", "Teachers", f"Papers {y}", f"Papers {y - 1}", "Change", "Papers per teacher",
             "Five-year per teacher", f"Paid FY {b['financial_year']}"] + (["Budget"] if any_budget else []) + [
        "Paid per paper"]
    rows: list[list[Any]] = [[Paragraph(h, hs) for h in heads]]
    rows[0][0] = Paragraph("Department", ParagraphStyle("thl", parent=hs, alignment=0))
    for r in b["departments"]:
        has = bool(r["teachers"])
        rows.append([
            r["department"], num(r["teachers"]), num(r["papers"]) if r["papers"] else "None",
            num(r["papers_prev"]) if r["papers_prev"] else "None",
            signed(r["change"]) if r["change"] is not None else ("None" if not r["papers"] else "New this year"),
            num(r["per_teacher"]) if has else "No teachers", num(r["five_year_per_teacher"]) if has else "None",
            inr(r["paid"]),
            *([inr(r["budget"]) if r["budget"] is not None else "Not set"] if any_budget else []),
            inr(r["cost_per_paper"]) if r["cost_per_paper"] else "None",
        ])
    widths = ([26 * mm, 15 * mm, 14 * mm, 14 * mm, 20 * mm, 15 * mm, 17 * mm, 23 * mm, 19 * mm, 17 * mm] if any_budget else [28 * mm, 17 * mm, 15 * mm, 15 * mm, 22 * mm, 17 * mm, 19 * mm, 25 * mm, 20 * mm])
    story.append(table(rows, widths))
    if b["unassigned_papers"]:
        story.append(Paragraph(
            f"{g(b['unassigned_papers'])} papers of {y} carry no department and are not in this table.", small))

    story.append(Paragraph("Where the figures come from", h2))
    for line in b["notes"]:
        story.append(Paragraph(line, small))
        story.append(Spacer(1, 1 * mm))

    out = io.BytesIO()
    SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=27 * mm,
                      bottomMargin=14 * mm, title=f"{college}: research brief {y}",
                      author=college).build(story, onFirstPage=header, onLaterPages=header)
    return out.getvalue()
