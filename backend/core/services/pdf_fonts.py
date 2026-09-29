"""Fonts and number formats shared by every PDF and workbook the server writes.

The fourteen base PDF fonts (Helvetica, Times) have no rupee sign, so a PDF
drawn with them prints "Rs" or an empty box. DejaVu Sans (bundled under
core/assets/fonts, Bitstream Vera licence) carries U+20B9, so registering it
once lets every document print a real ₹.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"
SANS = "DejaVuSans"
SANS_BOLD = "DejaVuSans-Bold"

#: Excel number format with Indian digit grouping (12,34,56,789).
INR_XLSX = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0'
#: The same with two decimals, for paise.
INR_XLSX_2 = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00'

_done = False


def register() -> tuple[str, str]:
    """Register DejaVu Sans with reportlab (idempotent); return (regular, bold)."""
    global _done
    if not _done:
        from reportlab.lib.fonts import addMapping
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont

        pdfmetrics.registerFont(TTFont(SANS, str(FONT_DIR / "DejaVuSans.ttf")))
        pdfmetrics.registerFont(TTFont(SANS_BOLD, str(FONT_DIR / "DejaVuSans-Bold.ttf")))
        # <b> inside a Paragraph looks the bold face up through this mapping.
        addMapping(SANS, 0, 0, SANS)
        addMapping(SANS, 1, 0, SANS_BOLD)
        addMapping(SANS, 0, 1, SANS)
        addMapping(SANS, 1, 1, SANS_BOLD)
        _done = True
    return SANS, SANS_BOLD


def group_in(n: Optional[float]) -> str:
    """Indian digit grouping for a whole number: 1586 -> "1,586", 3250610 -> "32,50,610"."""
    if n is None:
        return "–"
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
    return ("-" if neg else "") + s
