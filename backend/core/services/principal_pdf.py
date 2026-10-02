"""The council pack: the year as a document the Principal can sign and hand over.

Three A4 pages in the college's own type (Brygada 1918 for the finding and the
section titles, Inter for the rest), each with the college's emblem and name
over a rule, and "page n of 3" under it:

1. The year: the finding, this year against last (every base stated), five years
   as columns (the running year drawn hollow, never compared), and where to
   look, each department with the person to call.
2. The departments: every one, ranked per teacher, with the college rate.
3. Money and accreditation: spend against the budget, NAAC 3.3.1 year by year,
   what is left to settle before it goes, and where each figure comes from.

The figures are the ones on screen and in the Excel, taken from the same
`principal_brief.brief()` dict, so the three cannot disagree (docs/ux/27).
"""
from __future__ import annotations

import io
from datetime import date
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from core.services import pdf_fonts

EMBLEM = Path(__file__).resolve().parent.parent / "assets" / "brand" / "emblem.png"

INK = "#1B1F2E"
MUTED = "#55596B"
NAVY = "#34406A"
RULE = "#DAD3C2"
LINE = "#E7E1D3"
AMBER = "#82560A"


def build(b: dict[str, Any], college: str, inr, change_pct) -> bytes:
    from reportlab.graphics.shapes import Drawing, Line, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    pdf_fonts.register_house()
    rs = pdf_fonts.rupee_markup
    g = pdf_fonts.group_in
    ink, navy, muted = colors.HexColor(INK), colors.HexColor(NAVY), colors.HexColor(MUTED)
    rule, line = colors.HexColor(RULE), colors.HexColor(LINE)
    t, y = b["totals"], b["year"]
    partial = bool(b["partial"])
    year_label = f"{y} to date" if partial else str(y)

    body = ParagraphStyle("body", fontName="InterH", fontSize=9, leading=13, textColor=ink)
    lead = ParagraphStyle("lead", parent=body, fontSize=10.5, leading=15.5, textColor=muted)
    small = ParagraphStyle("small", parent=body, fontSize=7.5, leading=10, textColor=muted)
    cell = ParagraphStyle("cell", parent=body, fontSize=8, leading=10.5)
    cellr = ParagraphStyle("cellr", parent=cell, alignment=2)
    headr = ParagraphStyle("headr", parent=cell, fontName="InterH-SemiBold", alignment=2, textColor=muted)
    headl = ParagraphStyle("headl", parent=headr, alignment=0)
    finding = ParagraphStyle("finding", fontName="Brygada", fontSize=27, leading=29, textColor=ink, spaceAfter=11)
    h2 = ParagraphStyle("h2", fontName="Brygada-SemiBold", fontSize=13, leading=16, textColor=ink, spaceBefore=15, spaceAfter=5, keepWithNext=1)

    def P(text: str, style=body) -> Paragraph:
        return Paragraph(rs(escape(str(text))), style)

    def PM(markup: str, style=body) -> Paragraph:
        """Markup the caller has already escaped."""
        return Paragraph(rs(markup), style)

    def num(v):
        if v is None:
            return "Not recorded"
        return f"{v:g}" if isinstance(v, float) and v != int(v) else g(v)

    def pct(v):
        return "Not recorded" if v is None else f"{v:g}%"

    def signed(v):
        return "New this year" if v is None else f"{'+' if v > 0 else '-' if v < 0 else ''}{abs(v):g}%"

    # ---- furniture ------------------------------------------------------------
    total_pages = 3

    def furniture(canvas, doc):
        canvas.saveState()
        w, h = A4
        left, right = 18 * mm, w - 18 * mm
        if EMBLEM.exists():
            canvas.drawImage(str(EMBLEM), left, h - 22 * mm, width=11 * mm, height=11 * mm, mask="auto", preserveAspectRatio=True)
        canvas.setFillColor(ink)
        canvas.setFont("Brygada-SemiBold", 14)
        canvas.drawString(left + 14 * mm, h - 16.5 * mm, college)
        canvas.setFont("InterH", 8)
        canvas.setFillColor(muted)
        canvas.drawString(left + 14 * mm, h - 21 * mm, "Research publications and incentive spend: pack for the Governing Council")
        canvas.setFillColor(ink)
        canvas.drawRightString(right, h - 16.5 * mm, f"Calendar year {year_label} · FY {b['financial_year']}")
        canvas.setFillColor(muted)
        canvas.drawRightString(right, h - 21 * mm, f"Prepared {date.today().day} {date.today():%B %Y}")
        canvas.setStrokeColor(ink)
        canvas.setLineWidth(0.8)
        canvas.line(left, h - 24.5 * mm, right, h - 24.5 * mm)
        canvas.setLineWidth(0.25)
        canvas.setStrokeColor(rule)
        canvas.line(left, 13 * mm, right, 13 * mm)
        canvas.setFont("InterH", 7)
        canvas.setFillColor(muted)
        canvas.drawString(left, 9 * mm, "Papers from the publication record; money from the payment ledger. Sources are on page 3.")
        canvas.drawRightString(right, 9 * mm, f"Page {doc.page} of {total_pages}")
        canvas.restoreState()

    def ledger(data, widths, right_from=1, extra=()):
        tb = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
        tb.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, ink),
            ("LINEBELOW", (0, 1), (-1, -1), 0.25, line),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (0, -1), 0),
            *extra,
        ]))
        return tb

    # ---- page 1: the year ---------------------------------------------------------
    story: list[Any] = []
    if b.get("caveat"):
        story += [P(b["caveat"], small), Spacer(1, 2 * mm)]
    story.append(P(b.get("finding") or b["headline"], finding))
    story.append(P(" ".join(x for x in (b.get("context"), b.get("detail")) if x), lead))

    story.append(Paragraph("This year against last", h2))
    q_known = t.get("quartile_known") or 0
    rows: list[list[Any]] = [
        [P("", headl), P(year_label, headr), P(str(y - 1), headr), P("Change", headr)],
        [P("Papers published"), P(num(t["papers"]), cellr), P(num(t["papers_prev"]), cellr),
         P("Not compared" if partial else signed(t["change"]), cellr)],
        [P("Papers per teacher"), P(num(t["per_teacher"]), cellr), P(num(t["per_teacher_prev"]), cellr),
         P("Not compared" if partial else "", cellr)],
        [PM(f"In Q1 or Q2 journals<br/><font size=7 color='{MUTED}'>of the {g(q_known)} papers with a quartile recorded</font>"),
         P(pct(t["top_quartile_share"]), cellr), P(pct(t["top_quartile_share_prev"]), cellr), P("", cellr)],
        [P(f"Incentives paid, FY {b['financial_year']}"), P(inr(t["paid"]), cellr), P(inr(t["paid_prev"]), cellr),
         P("Part year" if partial else signed(change_pct(t["paid"], t["paid_prev"])), cellr)],
        [P("Budget and share used"), P(inr(t["budget"]) if t["budget"] is not None else "Not set", cellr), P("", cellr),
         P(pct(t["budget_used"]) if t["budget"] is not None else "", cellr)],
    ]
    story.append(ledger(rows, [78 * mm, 32 * mm, 32 * mm, 32 * mm]))

    # five years, drawn by hand: a running year is hollow and hatched, never a full bar
    def columns(key: str, title: str, label_fn, axis_fn) -> Drawing:
        w, h = 56 * mm, 44 * mm
        d = Drawing(w, h)
        cols = [(r["year"], r.get(key), False) for r in b["trend"]]
        if partial and cols:
            cols[-1] = (cols[-1][0], cols[-1][1], True)
        run = b.get("running")
        if run and not partial:
            cols.append((run["year"], run.get(key), True))
        top = max([c[1] or 0 for c in cols] + [0.0001])
        n = len(cols)
        gap = 2 * mm
        bw = (w - gap * (n - 1)) / n
        base, area = 8 * mm, 26 * mm
        d.add(String(0, h - 3 * mm, title, fontName="InterH-SemiBold", fontSize=7.5, fillColor=ink))
        for i, (yr, v, running) in enumerate(cols):
            x = i * (bw + gap)
            hh = 0 if v is None else max(0.6 * mm, (v / top) * area)
            current = (yr == y) and not running
            if running:
                d.add(Rect(x, base, bw, hh, fillColor=None, strokeColor=navy, strokeWidth=0.6, strokeDashArray=[1.5, 1.2]))
                step = 1.6 * mm
                k = -hh
                while k < bw:
                    x0, y0 = x + max(k, 0), base + max(0, -k)
                    x1, y1 = x + min(k + hh, bw), base + min(hh, bw - k)
                    if x1 > x0:
                        d.add(Line(x0, y0, x1, y1, strokeColor=navy, strokeWidth=0.3))
                    k += step
            else:
                d.add(Rect(x, base, bw, hh, fillColor=navy if current else colors.HexColor("#B7BBCB"), strokeColor=None))
            label = "None" if v is None else label_fn(v)
            d.add(String(x + bw / 2, base + hh + 1.2 * mm, label, fontName="InterH-SemiBold" if current else "InterH",
                         fontSize=6.5, fillColor=ink if current else muted, textAnchor="middle"))
            d.add(String(x + bw / 2, base - 3 * mm, axis_fn(yr), fontName="InterH", fontSize=6, fillColor=muted, textAnchor="middle"))
            if running:
                d.add(String(x + bw / 2, base - 6 * mm, "to date", fontName="InterH", fontSize=5.5, fillColor=muted, textAnchor="middle"))
        d.add(Line(0, base, w, base, strokeColor=rule, strokeWidth=0.5))
        return d

    story.append(Paragraph("Five years", h2))
    run = b.get("running")
    fy_axis = {r["year"]: r["financial_year"][2:] for r in b["trend"]}
    if run:
        fy_axis[run["year"]] = run["financial_year"][2:]
    charts = Table([[
        columns("papers", "Papers published", lambda v: g(v), lambda yr: str(yr)),
        columns("per_teacher", "Papers per teacher", lambda v: f"{v:g}", lambda yr: str(yr)),
        columns("paid", "Incentives paid (lakh, by FY)", lambda v: f"{v / 100000:.1f}", lambda yr: fy_axis.get(yr, str(yr))),
    ]], colWidths=[59 * mm, 59 * mm, 56 * mm], hAlign="LEFT")
    charts.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(charts)
    if run and not partial:
        story.append(P(f"{run['year']} is to date: {g(run['papers'])} papers. It is drawn hollow and not compared with a whole year.", small))

    def head_of(d):
        h = d.get("head")
        return f"Head: {h['name']}" if h else "No head of department is set"

    def column(title, items, kind):
        out = [[Paragraph(f"<b>{escape(title)}</b>", cell)]]
        if not items:
            out.append([P("No department stands out." if kind == "push" else "No department has grown enough to name.", cell)])
        for d in items:
            if kind == "push":
                detail = ". ".join(d["reasons"]) + "."
            else:
                detail = f"Up {d['change']:g}%: {d['papers_prev']} papers in {y - 1}, {d['papers']} in {y}."
            out.append([PM(f"<b>{escape(d['department'])}</b><br/>{escape(detail)}<br/>"
                           f"<font color='{MUTED}'>{escape(head_of(d))}</font>", cell)])
        tb = Table(out, colWidths=[84 * mm])
        tb.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, ink), ("LINEBELOW", (0, 1), (-1, -1), 0.25, line),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]))
        return tb

    story.append(Paragraph("Where to look", h2))
    both = Table([[column("Needs a push (three teachers or more)", b["push"][:4], "push"),
                   column("Rising (five papers or more last year)", b["rising"], "rise")]],
                 colWidths=[89 * mm, 85 * mm], hAlign="LEFT")
    both.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(both)
    story.append(PageBreak())

    # ---- page 2: the departments ------------------------------------------------
    college_rate = t["per_teacher"] or 0
    story.append(Paragraph(f"Every department, ranked by papers per teacher ({year_label})", h2))
    any_budget = any(r["budget"] is not None for r in b["departments"])
    heads = ["Department", "Teachers", f"Papers {y}", str(y - 1), "Change", "Per teacher", "Five years, per teacher", f"Paid FY {b['financial_year']}"] \
        + (["Budget"] if any_budget else []) + ["Paid per paper"]
    data: list[list[Any]] = [[P(heads[0], headl)] + [P(h, headr) for h in heads[1:]]]
    for r in b["departments"]:
        has = bool(r["teachers"])
        hd = r.get("head")
        name = f"<b>{escape(r['department'])}</b>" + (f"<br/><font size=6.5 color='{MUTED}'>{escape(hd['name'])}</font>" if hd else "")
        data.append([
            PM(name, cell), P(num(r["teachers"]), cellr), P(num(r["papers"]) if r["papers"] else "None", cellr),
            P(num(r["papers_prev"]) if r["papers_prev"] else "None", cellr),
            P(signed(r["change"]) if r["change"] is not None else ("None" if not r["papers"] else "New this year"), cellr),
            P(num(r["per_teacher"]) if has else "No teachers", cellr),
            P(num(r["five_year_per_teacher"]) if has else "None", cellr), P(inr(r["paid"]), cellr),
            *([P(inr(r["budget"]) if r["budget"] is not None else "Not set", cellr)] if any_budget else []),
            P(inr(r["cost_per_paper"]) if r["cost_per_paper"] else "None", cellr),
        ])
    widths = ([29, 14, 14, 13, 19, 15, 18, 22, 18, 16] if any_budget else [31, 15, 15, 14, 20, 16, 19, 24, 20])
    widths = [w * mm for w in widths]
    under = [i + 1 for i, r in enumerate(b["departments"])
             if r["teachers"] >= 3 and college_rate and (r["per_teacher"] or 0) < college_rate / 2]
    extra = [("BACKGROUND", (5, i), (5, i), colors.HexColor("#F8EFD9")) for i in under]
    story.append(ledger(data, widths, extra=extra))
    story.append(P(f"The college's rate is {num(t['per_teacher'])} papers per teacher. A shaded figure is under half of it.", small))
    if b["unassigned_papers"]:
        story.append(P(f"{g(b['unassigned_papers'])} papers of {y} carry no department and are not in this table.", small))
    story.append(PageBreak())

    # ---- page 3: money and accreditation ---------------------------------------------
    story.append(Paragraph("Money", h2))
    money_rows: list[list[Any]] = [[P("Financial year", headl), P("Papers", headr), P("Paid", headr), P("Budget", headr)]]
    for r in b["trend"]:
        money_rows.append([P(f"FY {r['financial_year']}"), P(g(r["papers"]), cellr), P(inr(r["paid"]), cellr),
                           P(inr(r["budget"]) if r["budget"] is not None else "Not set", cellr)])
    if run and not partial:
        money_rows.append([P(f"FY {run['financial_year']} to date"), P(g(run["papers"]), cellr), P(inr(run["paid"]), cellr), P("Not set", cellr)])
    story.append(ledger(money_rows, [60 * mm, 30 * mm, 42 * mm, 42 * mm]))
    story.append(P(
        "Budget and share used: " + (f"{inr(t['budget'])}, {t['budget_used']:g}% used." if t["budget"] is not None
                                    else "no budget is set for this year, so spend cannot be weighed against one.")
        + f" Paid per paper in {y}: {inr(t['cost_per_paper']) if t['cost_per_paper'] else 'none'}.", small))

    n = b["naac_331"]
    story.append(Paragraph("NAAC metric 3.3.1", h2))
    naac_rows: list[list[Any]] = [[P("Year", headl), P("Papers", headr), P("Teachers", headr), P("Papers per teacher", headr)]]
    for r in b["trend"]:
        naac_rows.append([P(str(r["year"])), P(g(r["papers"]), cellr), P(g(t["teachers"]), cellr), P(num(r["per_teacher"]), cellr)])
    bold = ParagraphStyle("bold", parent=cell, fontName="InterH-SemiBold")
    boldr = ParagraphStyle("boldr", parent=bold, alignment=2)
    naac_rows.append([P("Five years", bold), P(g(n["papers"]), boldr), P(g(n["teachers"]), boldr), P(num(n["per_teacher"]), boldr)])
    story.append(ledger(naac_rows, [60 * mm, 38 * mm, 38 * mm, 38 * mm]))
    story.append(PM(
        f"<b>{num(n['per_teacher'])} per teacher</b>, band {n['band']} of 4 on NAAC's scale (10 or more is 4; 5 to 10 is 3; 3 to 5 is 2; "
        "under 3 is 1). NAAC counts UGC-CARE journals only, so this is the ceiling until that list is checked.", body))

    open_checks = [c for c in b["pack"] if not c["ok"]]
    story.append(Paragraph("Before this goes to the council", h2))
    if open_checks:
        for c in open_checks:
            story.append(P(c["detail"], cell))
            story.append(Spacer(1, 1.2 * mm))
    else:
        story.append(P("Nothing is left to settle.", cell))

    story.append(Paragraph("Where the figures come from", h2))
    for line_ in b["notes"]:
        story.append(P(line_, small))
        story.append(Spacer(1, 1 * mm))

    out = io.BytesIO()
    SimpleDocTemplate(out, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=30 * mm,
                      bottomMargin=17 * mm, title=f"{college}: council pack {y}",
                      author=college).build(story, onFirstPage=furniture, onLaterPages=furniture)
    return out.getvalue()
