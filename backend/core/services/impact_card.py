"""A person's research impact, as a card they can share.

The card is a picture because the places it goes -- LinkedIn, WhatsApp,
Instagram -- show a picture and nothing else, and because an OpenGraph preview
needs an image URL a crawler can fetch without running any JavaScript. So it
is drawn here, on the server, with Pillow.

What is on it is chosen for being shareable by the person and by nobody else:
name, designation, department, college, how many papers, how many in Q1
journals, citations where Scopus has told us, the journal they are best
published in, and their place in the department -- **only when that place is
in the top ten**. A card is somebody's own boast; a card saying "38th of 41"
is not one anybody would post, so it is left off rather than printed.

Nothing on it is money, a staff id, an email or a phone number.

Fonts: Bitstream Vera, which ships inside reportlab (already a dependency for
the PDF reports), so there is no font file in this repository and the image
renders the same on every machine that can build a PDF. Pillow's own default
face is the fallback.
"""
from __future__ import annotations

import io
import os
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from functools import lru_cache
from typing import Optional

from django.utils import timezone
from PIL import Image, ImageDraw, ImageFont

from core.models import User
from core.services import institution
from core.services.records import QUARTILES, paper_records

#: LinkedIn's link-preview size, and a square for WhatsApp and Instagram.
SIZES = {"wide": (1200, 627), "square": (1080, 1080)}

#: A place in the department is printed only when it is worth printing.
RANK_SHOWN_UP_TO = 10

NAVY = (43, 57, 143)       # the college's own #2b398f
NAVY_DEEP = (24, 32, 88)
WHITE = (255, 255, 255)
SOFT = (205, 212, 250)
FAINT = (160, 170, 225)
GOLD = (246, 200, 92)


def summary(user: User) -> dict:
    """The facts on the card. No money, no contact details, no staff id."""
    department = (user.department or "").strip()
    colleagues = (
        list(User.objects.filter(department__iexact=department)) if department else [user]
    )
    if user.id not in {u.id for u in colleagues}:
        colleagues.append(user)
    records = paper_records(colleagues)
    mine = records.get(user.id, [])

    known = [r.citations for r in mine if r.citations is not None]
    scores = {uid: sum(r.points for r in recs) for uid, recs in records.items() if recs}
    rank = None
    if mine and department:
        rank = 1 + sum(1 for s in scores.values() if s > scores[user.id])

    years = [r.year for r in mine if r.year]
    return {
        "name": user.name,
        "designation": (user.designation or "").strip(),
        "department": department,
        "college": institution.get("college_name"),
        "papers": len(mine),
        "q1": sum(1 for r in mine if r.quartile == "Q1"),
        "first_author": sum(1 for r in mine if r.first_author),
        "citations": sum(known) if known else None,
        "rank": rank,
        "ranked_among": len(scores) if department else None,
        "rank_on_card": bool(rank and rank <= RANK_SHOWN_UP_TO),
        "top_journal": _top_journal(mine),
        "since": min(years) if years else None,
        "as_of": timezone.localdate().isoformat(),
    }


def _top_journal(mine) -> Optional[str]:
    """Where the person is best published: best quartile first, then most papers."""
    counts: Counter = Counter()
    best: dict[str, int] = defaultdict(lambda: len(QUARTILES))
    names: dict[str, str] = {}
    for r in mine:
        journal = (r.journal or "").strip()
        if not journal:
            continue
        k = journal.lower()
        names.setdefault(k, journal)
        counts[k] += 1
        if r.quartile in QUARTILES:
            best[k] = min(best[k], QUARTILES.index(r.quartile))
    if not counts:
        return None
    k = min(counts, key=lambda j: (best[j], -counts[j], j))
    return names[k]


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

_PUNCTUATION = str.maketrans({
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ",
})


def _printable(text: str) -> str:
    """What the bundled face can draw. It covers Latin-1; nothing else."""
    text = unicodedata.normalize("NFKC", text or "").translate(_PUNCTUATION)
    return text.encode("latin-1", "ignore").decode("latin-1").strip()


def _font_path(bold: bool) -> Optional[str]:
    try:
        import reportlab
    except ImportError:  # pragma: no cover - reportlab is a hard dependency
        return None
    path = os.path.join(
        os.path.dirname(reportlab.__file__), "fonts", "VeraBd.ttf" if bold else "Vera.ttf"
    )
    return path if os.path.exists(path) else None


@lru_cache(maxsize=64)
def _font(size: int, bold: bool = False):
    path = _font_path(bold)
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def _width(draw: ImageDraw.ImageDraw, text: str, font) -> float:
    return draw.textlength(text, font=font)


def _fit(draw, text: str, width: int, size: int, *, bold=False, smallest=18):
    """The largest face up to `size` the text fits in, ellipsised if even the smallest will not."""
    text = _printable(text)
    for s in range(size, smallest - 1, -2):
        font = _font(s, bold)
        if _width(draw, text, font) <= width:
            return text, font
    font = _font(smallest, bold)
    while text and _width(draw, text + "...", font) > width:
        text = text[:-1]
    return (text.rstrip() + "...") if text else "", font


def _gradient(size: tuple[int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size, NAVY)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        colour = tuple(int(NAVY[i] + (NAVY_DEEP[i] - NAVY[i]) * t) for i in range(3))
        draw.line([(0, y), (w, y)], fill=colour)
    return img


def _stats(facts: dict) -> list[tuple[str, str]]:
    out = [(f"{facts['papers']:,}", "Papers" if facts["papers"] != 1 else "Paper")]
    out.append((f"{facts['q1']:,}", "In Q1 journals"))
    if facts.get("citations") is not None:
        out.append((f"{facts['citations']:,}", "Citations"))
    else:
        out.append((f"{facts['first_author']:,}", "As first author"))
    return out


def _as_of(facts: dict) -> str:
    since = f"Publishing since {facts['since']}  -  " if facts.get("since") else ""
    try:
        as_of = date.fromisoformat(facts["as_of"]).strftime("%B %Y")
    except (KeyError, TypeError, ValueError):
        as_of = ""
    return f"{since}As of {as_of}" if as_of else since.rstrip(" -")


def render(facts: dict, size: str = "wide") -> bytes:
    """The card as PNG bytes, at `size` ("wide" or "square")."""
    dims = SIZES.get(size, SIZES["wide"])
    img = _gradient(dims)
    draw = ImageDraw.Draw(img)
    w, h = dims
    m = 64 if size == "wide" else 80
    inner = w - 2 * m

    # A thin gold rule down the left edge: the one decoration.
    draw.rectangle([0, 0, 10, h], fill=GOLD)

    y = m - 8
    label, font = _fit(draw, "RESEARCH IMPACT", inner // 2, 22, bold=True)
    draw.text((m, y), label, font=font, fill=GOLD)
    college, cfont = _fit(draw, facts.get("college") or "", inner // 2 - 20, 22)
    draw.text((w - m - _width(draw, college, cfont), y), college, font=cfont, fill=SOFT)

    y += 56 if size == "wide" else 90
    name, nfont = _fit(draw, facts.get("name") or "", inner, 64 if size == "wide" else 78, bold=True, smallest=30)
    draw.text((m, y), name, font=nfont, fill=WHITE)
    y += nfont.size + 18

    role = "  |  ".join(p for p in (facts.get("designation"), facts.get("department")) if p)
    if role:
        text, rfont = _fit(draw, role, inner, 30 if size == "wide" else 36, smallest=18)
        draw.text((m, y), text, font=rfont, fill=SOFT)
        y += rfont.size + 12

    if facts.get("rank_on_card") and facts.get("department"):
        pill = _printable(f"#{facts['rank']} in {facts['department']}")
        pfont = _font(26 if size == "wide" else 32, True)
        pw = _width(draw, pill, pfont) + 40
        ph = pfont.size + 22
        top = y + 10
        draw.rounded_rectangle([m, top, m + pw, top + ph], radius=ph // 2, fill=GOLD)
        draw.text((m + 20, top + 10), pill, font=pfont, fill=NAVY_DEEP)
        y = top + ph

    stats = _stats(facts)
    if size == "wide":
        y = max(y + 40, 300)
        col = inner // len(stats)
        for i, (figure, caption) in enumerate(stats):
            x = m + i * col
            draw.text((x, y), figure, font=_font(84, True), fill=WHITE)
            draw.text((x, y + 96), caption, font=_font(24), fill=SOFT)
        y += 150
    else:
        y = max(y + 60, 430)
        col = inner // len(stats)
        for i, (figure, caption) in enumerate(stats):
            x = m + i * col
            draw.text((x, y), figure, font=_font(110, True), fill=WHITE)
            draw.text((x, y + 126), caption, font=_font(28), fill=SOFT)
        y += 220

    if facts.get("top_journal"):
        draw.text((m, y), "Best published in", font=_font(22 if size == "wide" else 26), fill=FAINT)
        journal, jfont = _fit(draw, facts["top_journal"], inner, 32 if size == "wide" else 40, bold=True, smallest=18)
        draw.text((m, y + 32 if size == "wide" else y + 38), journal, font=jfont, fill=WHITE)

    footer = _printable(_as_of(facts))
    ffont = _font(20 if size == "wide" else 24)
    draw.text((m, h - m + 12 - ffont.size), footer, font=ffont, fill=FAINT)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
