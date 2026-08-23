"""One table, five ways out.

Every export in this system was a fresh piece of openpyxl code, and every one
of them could produce a workbook and a CSV and nothing else. That is fine for
somebody who is going to do more arithmetic, and wrong for everybody else:
a principal signing a submission wants a page she can read and initial, an
office assembling a NAAC file wants something that pastes into a document with
a covering paragraph, and another system wants JSON.

A "sheet" here is the smallest thing worth exporting: a name, an ordered list
of column headings, and rows of plain values. A "pack" is an ordered mapping
of those. Both the accreditation tables and the ordinary reports reduce to
that shape, so neither has to know anything about file formats.

What each format is for, and what it costs:

- xlsx  every sheet, live column widths, one tab each. The working format.
- csv   one sheet only, because a CSV has no concept of a second one. Asking
        for CSV over a multi-sheet pack takes the first sheet and says so.
- json  the same structure the API returns, for another system to read.
- pdf   laid out for reading and signing, not for re-importing. Wide tables
        are truncated by column, and the page says which columns it dropped
        rather than silently losing them.
- docx  a heading and a real Word table per sheet, so it can be pasted into a
        submission and restyled.
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any, Iterable

#: What a caller may ask for.
FORMATS = ("xlsx", "csv", "json", "pdf", "docx")

CONTENT_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv; charset=utf-8",
    "json": "application/json",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return str(value)


def render(
    pack: dict[str, dict[str, Any]],
    fmt: str,
    *,
    title: str = "Report",
    subtitle: str = "",
) -> bytes:
    """One pack, in the asked-for shape.

    `pack` maps a sheet name to `{"columns": [...], "rows": [[...], ...]}`.
    """
    if fmt not in FORMATS:
        raise ValueError(f"Unknown format {fmt!r}")
    return {
        "xlsx": _xlsx,
        "csv": _csv,
        "json": _json,
        "pdf": _pdf,
        "docx": _docx,
    }[fmt](pack, title, subtitle)


# ---------------------------------------------------------------- xlsx ----


def _xlsx(pack: dict[str, dict[str, Any]], title: str, subtitle: str) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    wb.remove(wb.active)
    for name, sheet in pack.items():
        # Excel refuses a tab name over 31 characters or containing []:*?/\.
        safe = name[:31]
        for bad in "[]:*?/\\":
            safe = safe.replace(bad, "-")
        ws = wb.create_sheet(safe)
        ws.append(list(sheet["columns"]))
        for cell in ws[1]:
            cell.font = Font(bold=True)
            cell.alignment = Alignment(vertical="center", wrap_text=True)
        for row in sheet["rows"]:
            ws.append(list(row))
        for i, column in enumerate(sheet["columns"], start=1):
            # Wide enough to read without being adjusted, capped so one long
            # paper title does not push everything else off the screen.
            widest = max(
                [len(_text(column))]
                + [len(_text(r[i - 1])) for r in sheet["rows"][:200] if len(r) >= i]
            )
            ws.column_dimensions[get_column_letter(i)].width = min(max(widest + 2, 10), 60)
        ws.freeze_panes = "A2"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# ----------------------------------------------------------------- csv ----


def _csv(pack: dict[str, dict[str, Any]], title: str, subtitle: str) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    names = list(pack)
    first = pack[names[0]]
    if len(names) > 1:
        # Said out loud, in the file. A CSV that silently contained one of
        # five tables is how the wrong table gets submitted.
        writer.writerow([f"{names[0]} — CSV holds one table; this pack has {len(names)}."])
        writer.writerow([f"Other tables in this pack: {', '.join(names[1:])}. Use Excel for all of them."])
        writer.writerow([])
    writer.writerow(list(first["columns"]))
    for row in first["rows"]:
        writer.writerow([_text(v) for v in row])
    # Excel on Windows needs the BOM to read UTF-8 in a .csv.
    return buf.getvalue().encode("utf-8-sig")


# ---------------------------------------------------------------- json ----


def _json(pack: dict[str, dict[str, Any]], title: str, subtitle: str) -> bytes:
    payload = {
        "title": title,
        "subtitle": subtitle,
        "tables": [
            {
                "name": name,
                "columns": list(sheet["columns"]),
                # Objects rather than positional arrays: a consumer reading
                # row[7] has to be told what column seven is, and will be
                # wrong the first time a column is inserted.
                "rows": [
                    {str(c): v for c, v in zip(sheet["columns"], row)}
                    for row in sheet["rows"]
                ],
                "row_count": len(sheet["rows"]),
            }
            for name, sheet in pack.items()
        ],
    }
    return json.dumps(payload, indent=2, default=str).encode("utf-8")


# ----------------------------------------------------------------- pdf ----

#: Past this many columns a landscape A4 page stops being readable.
_PDF_MAX_COLUMNS = 8
#: Rows past this are summarised rather than printed — a 3,000-row PDF is
#: not a document anybody reads, and it is a file nobody can email.
_PDF_MAX_ROWS = 400


def _pdf(pack: dict[str, dict[str, Any]], title: str, subtitle: str) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    styles = getSampleStyleSheet()
    cell_style = ParagraphStyle(
        "cell", parent=styles["BodyText"], fontSize=7, leading=8.5, alignment=TA_LEFT
    )
    head_style = ParagraphStyle(
        "head", parent=cell_style, fontName="Helvetica-Bold", textColor=colors.white
    )
    note_style = ParagraphStyle(
        "note", parent=styles["BodyText"], fontSize=8, textColor=colors.HexColor("#666666")
    )

    out = io.BytesIO()
    doc = SimpleDocTemplate(
        out,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title=title,
    )
    story: list[Any] = [Paragraph(title, styles["Title"])]
    if subtitle:
        story.append(Paragraph(subtitle, note_style))
    story.append(Spacer(1, 6 * mm))

    for i, (name, sheet) in enumerate(pack.items()):
        if i:
            story.append(PageBreak())
        story.append(Paragraph(name, styles["Heading2"]))

        columns = list(sheet["columns"])
        dropped = columns[_PDF_MAX_COLUMNS:]
        columns = columns[:_PDF_MAX_COLUMNS]
        rows = sheet["rows"]
        shown = rows[:_PDF_MAX_ROWS]

        caveats = []
        if dropped:
            caveats.append(
                f"{len(dropped)} column{'s' if len(dropped) > 1 else ''} not shown here "
                f"({', '.join(_text(c) for c in dropped)}) — the Excel copy has them."
            )
        if len(rows) > len(shown):
            caveats.append(
                f"Showing the first {len(shown):,} of {len(rows):,} rows. "
                "The Excel and CSV copies have every one."
            )
        if caveats:
            story.append(Paragraph(" ".join(caveats), note_style))
        story.append(Spacer(1, 3 * mm))

        if not shown:
            story.append(Paragraph("No rows.", note_style))
            continue

        data = [[Paragraph(_text(c), head_style) for c in columns]]
        for row in shown:
            data.append(
                [Paragraph(_text(v)[:300], cell_style) for v in list(row)[: len(columns)]]
            )
        table = Table(data, repeatRows=1, hAlign="LEFT")
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#334155")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                    ("LEFTPADDING", (0, 0), (-1, -1), 3),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ]
            )
        )
        story.append(table)

    doc.build(story)
    return out.getvalue()


# ---------------------------------------------------------------- docx ----

#: Word tables past this get slow to open and impossible to page through.
_DOCX_MAX_ROWS = 1000


def _docx(pack: dict[str, dict[str, Any]], title: str, subtitle: str) -> bytes:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    doc = Document()
    doc.add_heading(title, level=0)
    if subtitle:
        p = doc.add_paragraph(subtitle)
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        for run in p.runs:
            run.font.size = Pt(9)

    for name, sheet in pack.items():
        doc.add_heading(name, level=1)
        columns = list(sheet["columns"])
        rows = sheet["rows"][:_DOCX_MAX_ROWS]
        if len(sheet["rows"]) > len(rows):
            note = doc.add_paragraph(
                f"Showing the first {len(rows):,} of {len(sheet['rows']):,} rows. "
                "The Excel copy has every one."
            )
            for run in note.runs:
                run.font.size = Pt(8)

        table = doc.add_table(rows=1, cols=len(columns))
        table.style = "Light Grid Accent 1"
        for cell, column in zip(table.rows[0].cells, columns):
            cell.text = _text(column)
            for p in cell.paragraphs:
                for run in p.runs:
                    run.bold = True
                    run.font.size = Pt(8)
        for row in rows:
            cells = table.add_row().cells
            for cell, value in zip(cells, list(row)[: len(columns)]):
                cell.text = _text(value)[:500]
                for p in cell.paragraphs:
                    for run in p.runs:
                        run.font.size = Pt(8)

    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def filename(stem: str, fmt: str) -> str:
    return f"{stem}.{fmt}"


def as_pack(name: str, columns: Iterable[Any], rows: Iterable[Iterable[Any]]) -> dict:
    """A one-table pack, for the many callers that only have one."""
    return {name: {"columns": list(columns), "rows": [list(r) for r in rows]}}
