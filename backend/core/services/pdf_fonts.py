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


#: The college's own faces (docs/design, DESIGN.md "Typography"), cut as static
#: instances of the variable fonts the web app serves, with the rupee sign
#: merged in and lining, tabular figures set as the default digits (reportlab
#: does not run OpenType features, so a column of money has to align in the
#: font itself). Both are SIL Open Font Licence; the licences sit beside them.
BRYGADA = "Brygada"
BRYGADA_MEDIUM = "Brygada-Medium"
BRYGADA_ITALIC = "Brygada-Italic"
INTER = "Inter"
INTER_MEDIUM = "Inter-Medium"
INTER_SEMI = "Inter-SemiBold"

_brand_done = False


def register_brand() -> None:
    """Register Brygada 1918 and Inter with reportlab (idempotent)."""
    global _brand_done
    if _brand_done:
        return
    from reportlab.lib.fonts import addMapping
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for name, file in (
        (BRYGADA, "Brygada-Regular.ttf"),
        (BRYGADA_MEDIUM, "Brygada-Medium.ttf"),
        (BRYGADA_ITALIC, "Brygada-Italic.ttf"),
        (INTER, "Inter-Regular.ttf"),
        (INTER_MEDIUM, "Inter-Medium.ttf"),
        (INTER_SEMI, "Inter-SemiBold.ttf"),
    ):
        pdfmetrics.registerFont(TTFont(name, str(FONT_DIR / file)))
    # <b> and <i> inside a Paragraph look the face up through these.
    addMapping(INTER, 0, 0, INTER)
    addMapping(INTER, 1, 0, INTER_SEMI)
    addMapping(INTER, 0, 1, INTER)
    addMapping(INTER, 1, 1, INTER_SEMI)
    addMapping(BRYGADA, 0, 0, BRYGADA)
    addMapping(BRYGADA, 1, 0, BRYGADA_MEDIUM)
    addMapping(BRYGADA, 0, 1, BRYGADA_ITALIC)
    addMapping(BRYGADA, 1, 1, BRYGADA_MEDIUM)
    _brand_done = True


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


#: The college's own type for documents it hands over: Brygada 1918 for the
#: headline and figures, Inter for everything else (the same two faces as the
#: app, instanced from the variable fonts to static TrueType so reportlab can
#: embed them). They carry no rupee sign, so a rupee is set in DejaVu Sans:
#: see `rupee_markup`.
HOUSE = {
    "Brygada": "Brygada1918-Regular.ttf",
    "Brygada-SemiBold": "Brygada1918-SemiBold.ttf",
    "Brygada-Italic": "Brygada1918-Italic.ttf",
    "InterH": "Inter-Regular.ttf",
    "InterH-SemiBold": "Inter-SemiBold.ttf",
}
_house_done = False


def register_house() -> None:
    """Register Brygada 1918 and Inter (idempotent), plus DejaVu for the rupee sign."""
    global _house_done
    register()
    if _house_done:
        return
    from reportlab.lib.fonts import addMapping
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for name, file in HOUSE.items():
        pdfmetrics.registerFont(TTFont(name, str(FONT_DIR / file)))
    addMapping("InterH", 0, 0, "InterH")
    addMapping("InterH", 1, 0, "InterH-SemiBold")
    addMapping("InterH", 0, 1, "InterH")
    addMapping("InterH", 1, 1, "InterH-SemiBold")
    addMapping("Brygada", 0, 0, "Brygada")
    addMapping("Brygada", 1, 0, "Brygada-SemiBold")
    addMapping("Brygada", 0, 1, "Brygada-Italic")
    addMapping("Brygada", 1, 1, "Brygada-SemiBold")
    _house_done = True


def rupee_markup(text: str) -> str:
    """Paragraph markup with every rupee sign set in the face that has one."""
    return text.replace("₹", f'<font name="{SANS}">₹</font>')
