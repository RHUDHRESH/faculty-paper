"""A person's research impact, as a card they can be proud to share.

docs/ux/15-impact-card.md, "The Certificate": the person is the main character
(photo or monogram, name in Fraunces), there is **one** surprising, true stat
on a plate, the college's emblem and a gold ribbon make it a keepsake, and a QR
code points at the public link so a stranger can check it.

The card is drawn here, with Pillow, because the places it goes -- LinkedIn,
WhatsApp, Instagram -- show a picture and nothing else, and an OpenGraph
preview needs an image a crawler can fetch without JavaScript. The app's
preview shows this same image, so what the person sees is what they post.

What is on it is chosen for being shareable by the person and by nobody else:
no money, no staff id, no email or phone. A department place is offered as a
headline only when it is #1 to #3, a college place only in the top 10%.

Paper counts come from `core.services.person_record`, the same count Home and
My research show.

Fonts: Fraunces and Inter, bundled in `core/assets/fonts` under the SIL Open
Font License (the licences are next to them) -- the same faces the app loads
from @fontsource, so the card and the page match.
"""
from __future__ import annotations

import io
import math
import os
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from functools import lru_cache
from typing import Any, Callable, Optional

from django.core.cache import cache
from django.utils import timezone
from PIL import Image, ImageDraw, ImageFont

from core.models import Role, User
from core.services import institution
from core.services.person_record import Paper, department_of, papers_of, rank_in
from core.services.records import QUARTILES

# --------------------------------------------------------------------------- facts

#: Format name -> pixel size. `wide` is the old name of `linkedin`.
FORMATS = {
    "portrait": (1080, 1350),
    "story": (1080, 1920),
    "linkedin": (1200, 627),
    "square": (1080, 1080),
}
ALIASES = {"wide": "linkedin"}
THEMES = ("navy", "cream", "midnight")
#: Kept for callers that still say `SIZES`.
SIZES = {**FORMATS, "wide": FORMATS["linkedin"]}

#: A place in the department is a headline only in the top three...
DEPT_RANK_HEADLINE = 3
#: ...and is printed anywhere only in the top ten (the old rule).
RANK_SHOWN_UP_TO = 10
#: A college place is a headline only in the top 10%.
COLLEGE_TOP_SHARE = 0.10
MAX_HEADLINES = 4
STRIP_YEARS = 10

_COLLEGE_SCORES_KEY = "impact-college-scores:v1"
_COLLEGE_SCORES_SECONDS = 600


def _plural(n: int, word: str, many: Optional[str] = None) -> str:
    return word if n == 1 else (many or word + "s")


def _college_scores() -> dict[str, int]:
    scores = cache.get(_COLLEGE_SCORES_KEY)
    if scores is None:
        people = User.objects.filter(active=True, role__in=(Role.FACULTY, Role.HOD))
        scores = {uid: sum(p.points for p in ps) for uid, ps in papers_of(people).items() if ps}
        cache.set(_COLLEGE_SCORES_KEY, scores, _COLLEGE_SCORES_SECONDS)
    return scores


def _topics_line(mine: list[Paper]) -> Optional[str]:
    """ "Writes about X and Y." from the topics of the person's recent papers."""
    from core.models import Publication
    from core.services.research_picture import _fold, _topics

    ids = [p.publication_id for p in mine if p.publication_id]
    if not ids:
        return None
    count: Counter = Counter()
    spelled: dict[str, str] = {}
    for year, raw in Publication.objects.filter(id__in=ids).values_list("year", "topics_json"):
        for t in _topics(raw):
            k = _fold(t)
            spelled.setdefault(k, t)
            count[k] += 2 if (year or 0) >= timezone.localdate().year - 2 else 1
    if not count:
        return None
    names = [spelled[k] for k, _ in count.most_common(2)]
    return "Writes about " + (f"{names[0]} and {names[1]}." if len(names) > 1 else f"{names[0]}.")


def _headlines(user: User, mine: list[Paper], rank: Optional[int], of: int, department: str,
               college: str, today: date) -> list[dict[str, Any]]:
    """Every true, flattering headline, best first (docs/ux/15 priority order)."""
    out: list[dict[str, Any]] = []
    if rank and rank <= DEPT_RANK_HEADLINE and department and of > 1:
        out.append({"key": "dept_rank", "big": f"#{rank}", "priority": 1,
                    "label": f"in {department}, of {of} publishing colleagues"})
    if mine:
        scores = _college_scores()
        if user.id in scores and len(scores) >= 10:
            place = 1 + sum(1 for s in scores.values() if s > scores[user.id])
            share = place / len(scores)
            if share <= COLLEGE_TOP_SHARE:
                pct = max(1, math.ceil(share * 100))
                out.append({"key": "college_rank", "big": f"Top {pct}%", "priority": 2,
                            "label": f"of {len(scores)} researchers at {college}"})
    q1s = [p for p in mine if p.quartile == "Q1" and p.year]
    if q1s and q1s[0].year == today.year:
        out.append({"key": "first_q1", "big": "Q1", "priority": 3,
                    "label": f"First Q1 paper, {today.year}" + (f" · {q1s[0].venue}" if q1s[0].venue else "")})
    by_year = Counter(p.year for p in mine if p.year)
    if len(by_year) >= 2:
        best_year, best = max(by_year.items(), key=lambda kv: (kv[1], kv[0]))
        earlier = [n for y, n in by_year.items() if y < best_year]
        if best_year >= today.year - 1 and best >= 2 and earlier and best > max(earlier):
            out.append({"key": "best_year", "big": str(best), "priority": 5,
                        "label": f"papers in {best_year} — a personal best"})
    cites = sum(p.citations or 0 for p in mine)
    if cites:
        out.append({"key": "citations", "big": f"{cites:,}", "priority": 6,
                    "label": f"{_plural(cites, 'citation')} of your work"})
    q1 = sum(1 for p in mine if p.quartile == "Q1")
    if q1:
        out.append({"key": "q1", "big": str(q1), "priority": 7,
                    "label": f"{_plural(q1, 'paper')} in Q1 journals"})
    out.append({"key": "papers", "big": f"{len(mine):,}", "priority": 8,
                "label": f"{_plural(len(mine), 'paper')} published"})
    best = out[:MAX_HEADLINES]
    if best[-1]["key"] != "papers" and not any(h["key"] == "papers" for h in best):
        best[-1] = out[-1]
    return best


def _strip(mine: list[Paper], today: date) -> list[dict[str, int]]:
    by_year = Counter(p.year for p in mine if p.year)
    return [{"year": y, "papers": by_year.get(y, 0)} for y in range(today.year - STRIP_YEARS + 1, today.year + 1)]


def _initials(name: str) -> str:
    words = [w for w in (name or "").replace(".", " ").split() if w[:1].isalpha()]
    skip = {"dr", "prof", "mr", "mrs", "ms"}
    words = [w for w in words if w.lower() not in skip] or words
    if not words:
        return "?"
    return (words[0][0] + (words[-1][0] if len(words) > 1 else "")).upper()


def summary(user: User) -> dict:
    """The facts on the card. No money, no contact details, no staff id."""
    from core.social import photo_url

    today = timezone.localdate()
    department = (user.department or "").strip()
    mine, everyone = department_of(user)
    rank, of = rank_in(everyone, user.id) if department else (None, 0)
    college = institution.get("college_name")
    known = [p.citations for p in mine if p.citations is not None]
    years = [p.year for p in mine if p.year]
    return {
        "name": user.name,
        "initials": _initials(user.name),
        "designation": (user.designation or "").strip(),
        "department": department,
        "college": college,
        "papers": len(mine),
        "papers_source": "record",
        "q1": sum(1 for p in mine if p.quartile == "Q1"),
        "first_author": sum(1 for p in mine if p.first_author),
        "citations": sum(known) if known else None,
        "rank": rank,
        "ranked_among": of if department else None,
        "rank_on_card": bool(rank and rank <= RANK_SHOWN_UP_TO),
        "top_journal": _top_journal(mine),
        "since": min(years) if years else None,
        "as_of": today.isoformat(),
        "headlines": _headlines(user, mine, rank, of, department, college, today) if mine else [],
        "headline_text": _topics_line(mine),
        "strip": _strip(mine, today),
        "photo_url": photo_url(user),
        "photo": user.photo or None,
    }


def _top_journal(mine: list[Paper]) -> Optional[str]:
    """Where the person is best published: best quartile first, then most papers."""
    counts: Counter = Counter()
    best: dict[str, int] = defaultdict(lambda: len(QUARTILES))
    names: dict[str, str] = {}
    for p in mine:
        journal = (p.venue or "").strip()
        if not journal:
            continue
        k = journal.lower()
        names.setdefault(k, journal)
        counts[k] += 1
        if p.quartile in QUARTILES:
            best[k] = min(best[k], QUARTILES.index(p.quartile))
    if not counts:
        return None
    k = min(counts, key=lambda j: (best[j], -counts[j], j))
    return names[k]


def public_facts(facts: dict) -> dict:
    """What an API response may carry: the storage name of the photo stays here."""
    return {k: v for k, v in facts.items() if k != "photo"}


# --------------------------------------------------------------------------- options


def normalise_options(
    *, format: Optional[str] = None, size: Optional[str] = None, theme: Optional[str] = None,
    headline: Optional[str] = None, photo: Optional[str] = None, strip: Optional[str] = None,
    qr: Optional[str] = None, quote: Optional[str] = None,
) -> dict[str, Any]:
    """Query parameters -> drawing options, every unknown value to its default."""
    fmt = format or size or "portrait"
    fmt = ALIASES.get(fmt, fmt)
    if fmt not in FORMATS:
        fmt = "portrait"

    def on(v: Optional[str]) -> bool:
        return v is None or str(v).lower() not in ("0", "false", "off", "no")

    return {
        "format": fmt,
        "theme": theme if theme in THEMES else "navy",
        "headline": headline or None,
        "photo": on(photo),
        "strip": on(strip),
        "qr": on(qr),
        "quote": on(quote),
    }


# --------------------------------------------------------------------------- drawing

_ASSETS = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets")
_FACES = {
    "serif": "fraunces-latin-wght-normal.woff2",
    "sans": "inter-latin-wght-normal.woff2",
    "italic": "inter-latin-wght-italic.woff2",
}

NAVY = (43, 57, 143)
NAVY_DEEP = (22, 29, 82)
INK = (27, 36, 102)
GOLD = (224, 168, 46)
GOLD_LIGHT = (245, 210, 122)
CREAM = (251, 248, 241)
WHITE = (255, 255, 255)

#: Per theme: ground top/bottom, ink, muted ink, plate fill, plate ink,
#: plate label, line tint for the guilloche, gold used for type.
THEME = {
    "navy": dict(top=(47, 62, 152), bottom=(20, 27, 78), ink=WHITE, muted=(214, 220, 248),
                 plate=CREAM, plate_ink=INK, plate_label=(74, 80, 112), line=WHITE, line_a=11,
                 gold=GOLD_LIGHT, foil=False, mark_a=14),
    "cream": dict(top=CREAM, bottom=(244, 237, 220), ink=INK, muted=(74, 80, 112),
                  plate=NAVY, plate_ink=WHITE, plate_label=(214, 220, 248), line=NAVY, line_a=13,
                  gold=(138, 100, 16), foil=False, mark_a=16),
    "midnight": dict(top=(16, 21, 52), bottom=(5, 7, 22), ink=(246, 240, 224), muted=(196, 190, 170),
                     plate=(22, 28, 66), plate_ink=GOLD_LIGHT, plate_label=(214, 206, 180),
                     line=GOLD, line_a=12, gold=GOLD_LIGHT, foil=True, mark_a=12),
}


def _printable(text: str) -> str:
    """What the bundled latin faces can draw: Latin-1 and general punctuation."""
    text = unicodedata.normalize("NFKC", text or "")
    return "".join(c for c in text if ord(c) < 0x250 or 0x2000 <= ord(c) <= 0x206F).strip()


@lru_cache(maxsize=128)
def _font(face: str, size: int, weight: int = 400):
    path = os.path.join(_ASSETS, "fonts", _FACES[face])
    try:
        font = ImageFont.truetype(path, size)
        try:
            font.set_variation_by_axes([weight])
        except (OSError, ValueError):  # a build without variation support
            pass
        return font
    except OSError:  # pragma: no cover - the files ship with the code
        return ImageFont.load_default(size)


def _w(draw: ImageDraw.ImageDraw, text: str, font) -> float:
    return draw.textlength(text, font=font)


def _fit(draw, text: str, width: float, face: str, size: int, weight: int = 400, smallest: int = 18):
    """The largest face up to `size` the text fits in, ellipsised if even the smallest will not."""
    text = _printable(text)
    s = size
    while s >= smallest:
        font = _font(face, s, weight)
        if _w(draw, text, font) <= width:
            return text, font
        s -= 2
    font = _font(face, smallest, weight)
    while text and _w(draw, text + "…", font) > width:
        text = text[:-1]
    return (text.rstrip() + "…") if text else "", font


def _wrap(draw, text: str, width: float, font, lines: int) -> list[str]:
    words, out, cur = _printable(text).split(), [], ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if _w(draw, trial, font) <= width:
            cur = trial
        else:
            if cur:
                out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    if len(out) > lines:
        out = out[:lines]
        last = out[-1]
        while last and _w(draw, last + "…", font) > width:
            last = last[:-1]
        out[-1] = last.rstrip() + "…"
    return out


def _ground(size: tuple[int, int], t: dict) -> Image.Image:
    w, h = size
    col = Image.new("RGB", (1, h))
    for y in range(h):
        k = y / max(1, h - 1)
        col.putpixel((0, y), tuple(int(t["top"][i] + (t["bottom"][i] - t["top"][i]) * k) for i in range(3)))
    return col.resize((w, h)).convert("RGBA")


def _guilloche(size: tuple[int, int], t: dict, s: float) -> Image.Image:
    """Fine engraved rosette lines, the pattern on a banknote or a degree."""
    w, h = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    colour = (*t["line"], t["line_a"])
    cx, cy = w * 0.92, h * 0.88
    R = max(w, h) * 0.62
    for ring in range(18):
        base = R * (0.25 + ring * 0.045)
        pts = []
        for i in range(0, 721):
            a = i / 720 * 2 * math.pi
            r = base + 10 * s * math.sin(24 * a + ring * 0.6)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        d.line(pts, fill=colour, width=max(1, round(1.2 * s)))
    return layer


@lru_cache(maxsize=16)
def _emblem(px: int, alpha: int = 255, mono: Optional[tuple] = None) -> Image.Image:
    im = Image.open(os.path.join(_ASSETS, "brand", "emblem.png")).convert("RGBA")
    im = im.resize((px, px), Image.LANCZOS)
    if mono is not None:
        a = im.getchannel("A")
        im = Image.new("RGBA", im.size, (*mono, 255))
        im.putalpha(a)
    if alpha < 255:
        a = im.getchannel("A").point(lambda v: v * alpha // 255)
        im.putalpha(a)
    return im


def _foil(size: tuple[int, int]) -> Image.Image:
    """A gold foil gradient to fill type with (midnight theme)."""
    w, h = size
    row = Image.new("RGB", (max(1, w), 1))
    stops = [(0.0, (201, 146, 34)), (0.45, (250, 222, 146)), (0.6, (236, 190, 84)), (1.0, (196, 140, 30))]
    for x in range(max(1, w)):
        k = x / max(1, w - 1)
        for (a, ca), (b, cb) in zip(stops, stops[1:]):
            if a <= k <= b:
                u = (k - a) / (b - a)
                row.putpixel((x, 0), tuple(int(ca[i] + (cb[i] - ca[i]) * u) for i in range(3)))
                break
    return row.resize((max(1, w), max(1, h)))


def _text(img: Image.Image, xy, text: str, font, fill, foil: bool = False, anchor: str = "la"):
    """Draw text; with `foil`, fill the glyphs with the gold gradient."""
    draw = ImageDraw.Draw(img)
    if not foil:
        draw.text(xy, text, font=font, fill=fill, anchor=anchor)
        return
    box = draw.textbbox(xy, text, font=font, anchor=anchor)
    bw, bh = box[2] - box[0], box[3] - box[1]
    if bw <= 0 or bh <= 0:
        return
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).text(xy, text, font=font, fill=255, anchor=anchor)
    fill_img = Image.new("RGB", img.size)
    fill_img.paste(_foil((bw, bh)), (box[0], box[1]))
    img.paste(fill_img, (0, 0), mask)


def _ribbon(img: Image.Image, y: int, height: int):
    w = img.size[0]
    band = _foil((w, 1)).resize((w, height))
    img.paste(band, (0, y))


def _photo(facts: dict) -> Optional[Image.Image]:
    name = facts.get("photo")
    if not name:
        return None
    try:
        from django.core.files.storage import default_storage

        with default_storage.open(name, "rb") as fh:
            im = Image.open(io.BytesIO(fh.read()))
            im.load()
        return im.convert("RGB")
    except Exception:  # a missing or unreadable photo falls back to the monogram
        return None


def _portrait(img: Image.Image, facts: dict, t: dict, cx: int, cy: int, d: int, use_photo: bool):
    """Photo (or monogram) in a gold double ring, centred on (cx, cy)."""
    draw = ImageDraw.Draw(img)
    ring = max(3, d // 40)
    gap = max(4, d // 28)
    outer = d // 2 + gap + ring * 2
    draw.ellipse([cx - outer, cy - outer, cx + outer, cy + outer], outline=GOLD, width=ring)
    inner = d // 2 + ring
    draw.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], outline=GOLD_LIGHT, width=max(2, ring // 2))
    face = _photo(facts) if use_photo else None
    mask = Image.new("L", (d * 4, d * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, d * 4 - 1, d * 4 - 1], fill=255)
    mask = mask.resize((d, d), Image.LANCZOS)
    if face is not None:
        side = min(face.size)
        face = face.crop(((face.width - side) // 2, (face.height - side) // 2,
                          (face.width + side) // 2, (face.height + side) // 2)).resize((d, d), Image.LANCZOS)
        img.paste(face, (cx - d // 2, cy - d // 2), mask)
        return
    wash = Image.new("RGB", (d, d), (34, 46, 122) if t is not THEME["cream"] else (223, 229, 247))
    img.paste(wash, (cx - d // 2, cy - d // 2), mask)
    initials = _printable(facts.get("initials") or "?")
    font = _font("serif", int(d * 0.42), 600)
    _text(img, (cx, cy), initials, font, t["gold"] if t is not THEME["cream"] else INK,
          foil=t["foil"], anchor="mm")


def _qr_image(url: str, px: int, dark=(20, 27, 78)) -> Image.Image:
    import segno

    q = segno.make(url, error="m")
    matrix = q.matrix
    n = len(matrix)
    quiet = 2
    cell = max(1, px // (n + 2 * quiet))
    side = cell * (n + 2 * quiet)
    im = Image.new("RGB", (side, side), WHITE)
    d = ImageDraw.Draw(im)
    for y, row in enumerate(matrix):
        for x, v in enumerate(row):
            if v:
                d.rectangle([(x + quiet) * cell, (y + quiet) * cell,
                             (x + quiet + 1) * cell - 1, (y + quiet + 1) * cell - 1], fill=dark)
    return im.resize((px, px), Image.NEAREST)


def _chosen(facts: dict, key: Optional[str]) -> Optional[dict]:
    heads = facts.get("headlines") or []
    for h in heads:
        if h["key"] == key:
            return h
    return heads[0] if heads else None


def _stats_line(facts: dict) -> list[tuple[str, str]]:
    out = [(f"{facts['papers']:,}", _plural(facts["papers"], "paper"))]
    if facts.get("q1"):
        out.append((f"{facts['q1']:,}", "in Q1"))
    else:
        out.append((f"{facts['first_author']:,}", "first-author"))
    if facts.get("citations"):
        out.append((f"{facts['citations']:,}", _plural(facts["citations"], "citation")))
    elif facts.get("since"):
        out.append((str(facts["since"]), "first paper"))
    return out


def _as_of(facts: dict) -> str:
    try:
        return date.fromisoformat(facts["as_of"]).strftime("%B %Y")
    except (KeyError, TypeError, ValueError):
        return ""


# One block of the vertical layout: (height, draw(img, top)).
Block = tuple[int, Callable[[Image.Image, int], None]]


def render(facts: dict, size: str = "portrait", *, options: Optional[dict] = None,
           share_url: Optional[str] = None) -> bytes:
    """The card as PNG bytes. `options` from `normalise_options`; `size` is the
    format when no options are given (kept for older callers)."""
    opts = options or normalise_options(format=size)
    fmt, theme = opts["format"], THEME[opts["theme"]]
    w, h = FORMATS[fmt]
    s = w / 1080 if fmt != "linkedin" else 627 / 1080 * 1.35
    sample = not facts.get("papers")
    if sample:
        facts = {**facts, "papers": 12, "q1": 3, "first_author": 5, "citations": 148, "since": 2016,
                 "headlines": [{"key": "sample", "big": "#2", "label": "in your department", "priority": 1}],
                 "strip": [{"year": y, "papers": n} for y, n in
                           zip(range(date.today().year - 9, date.today().year + 1), (0, 1, 0, 1, 2, 1, 2, 3, 2, 1))]}
    img = _ground((w, h), theme)
    img.alpha_composite(_guilloche((w, h), theme, s))
    mark = int(min(w, h) * 0.78)
    img.alpha_composite(_emblem(mark, theme["mark_a"], theme["line"]), (w - int(mark * 0.8), h - int(mark * 0.82)))
    img = img.convert("RGB")

    ribbon = max(8, round(12 * s))
    _ribbon(img, 0, ribbon)
    _ribbon(img, h - ribbon, ribbon)

    url = share_url if (opts["qr"] and share_url) else None
    if fmt == "linkedin":
        _render_wide(img, facts, theme, opts, url, ribbon)
    else:
        _render_tall(img, facts, theme, opts, url, ribbon, fmt)

    if sample:
        _sample(img)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _sample(img: Image.Image):
    w, h = img.size
    grey = img.convert("L").convert("RGB")
    img.paste(Image.blend(img, grey, 0.7))
    layer = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
    font = _font("sans", int(min(w, h) * 0.22), 800)
    ImageDraw.Draw(layer).text((w, h), "SAMPLE", font=font, fill=(255, 255, 255, 90), anchor="mm")
    layer = layer.rotate(28, resample=Image.BICUBIC).crop((w // 2, h // 2, w // 2 + w, h // 2 + h))
    base = img.convert("RGBA")
    base.alpha_composite(layer)
    img.paste(base.convert("RGB"))


def _header(img, facts, t, x, y, s, width, centred=False, cx=0):
    """Emblem, college name in caps, 'Research Impact · year'."""
    draw = ImageDraw.Draw(img)
    e = round(72 * s)
    img.paste(_emblem(e), (x, y), _emblem(e))
    tx = x + e + round(20 * s)
    college, cf = _fit(draw, (facts.get("college") or "").upper(), width - e - 20 * s, "sans", round(26 * s), 700,
                       smallest=round(16 * s))
    draw.text((tx, y + round(8 * s)), college, font=cf, fill=t["ink"])
    year = date.fromisoformat(facts["as_of"]).year if facts.get("as_of") else date.today().year
    sub = _font("sans", round(22 * s), 500)
    draw.text((tx, y + round(8 * s) + cf.size + round(8 * s)), f"Research Impact · {year}", font=sub, fill=t["gold"])
    return e


def _plate(img, facts, t, opts, x, y, width, s, height=None, centred=False) -> int:
    """The one headline stat on its plate. Returns the plate's height."""
    head = _chosen(facts, opts.get("headline"))
    if head is None:
        return 0
    draw = ImageDraw.Draw(img)
    pad = round(36 * s)
    big, bf = _fit(draw, head["big"], width - 2 * pad, "serif", round(150 * s), 600, smallest=round(60 * s))
    lf = _font("sans", round(34 * s), 500)
    lines = _wrap(draw, head["label"], width - 2 * pad, lf, 2)
    ph = height or pad * 2 + bf.size + round(14 * s) + len(lines) * round(lf.size * 1.3)
    draw.rounded_rectangle([x, y, x + width, y + ph], radius=round(28 * s), fill=t["plate"])
    draw.rounded_rectangle([x, y, x + width, y + ph], radius=round(28 * s), outline=GOLD, width=max(2, round(3 * s)))
    top = y + (ph - (bf.size + round(14 * s) + len(lines) * round(lf.size * 1.3))) // 2
    if centred:
        _text(img, (x + width // 2, top - round(bf.size * 0.12)), big, bf, t["plate_ink"], foil=t["foil"], anchor="ma")
    else:
        _text(img, (x + pad, top - round(bf.size * 0.12)), big, bf, t["plate_ink"], foil=t["foil"])
    ly = top + bf.size + round(14 * s)
    for line in lines:
        if centred:
            draw.text((x + width // 2, ly), line, font=lf, fill=t["plate_label"], anchor="ma")
        else:
            draw.text((x + pad, ly), line, font=lf, fill=t["plate_label"])
        ly += round(lf.size * 1.3)
    return ph


def _stats(img, facts, t, x, y, width, s, centred=True) -> int:
    draw = ImageDraw.Draw(img)
    parts = _stats_line(facts)
    size = round(40 * s)
    while size > 18:
        nf, lf = _font("sans", size, 700), _font("sans", round(size * 0.7), 500)
        dot = round(size * 0.9)
        total = sum(_w(draw, n, nf) + size * 0.25 + _w(draw, l, lf) for n, l in parts) + dot * (len(parts) - 1)
        if total <= width:
            break
        size -= 2
    cur = x + (width - total) / 2 if centred else x
    base = y + size
    for i, (n, l) in enumerate(parts):
        draw.text((cur, base), n, font=nf, fill=t["ink"], anchor="ls")
        cur += _w(draw, n, nf) + size * 0.25
        draw.text((cur, base), l, font=lf, fill=t["muted"], anchor="ls")
        cur += _w(draw, l, lf)
        if i < len(parts) - 1:
            r = max(3, round(size * 0.1))
            cxd = cur + dot / 2
            draw.ellipse([cxd - r, base - size * 0.32 - r, cxd + r, base - size * 0.32 + r], fill=GOLD)
            cur += dot
    return round(size * 1.25)


def _strip_draw(img, facts, t, x, y, width, height, s) -> None:
    """Papers per year, the last ten years, as gold bars over year labels."""
    draw = ImageDraw.Draw(img)
    data = facts.get("strip") or []
    if not data:
        return
    n = len(data)
    lf = _font("sans", round(18 * s), 500)
    head = lf.size + round(8 * s)
    y += head
    height -= head
    bars_h = height - lf.size - round(8 * s)
    gap = round(10 * s)
    bw = (width - gap * (n - 1)) / n
    peak = max((d["papers"] for d in data), default=0) or 1
    for i, d in enumerate(data):
        bx = x + i * (bw + gap)
        v = d["papers"]
        bh = max(round(4 * s), round(bars_h * v / peak)) if v else round(3 * s)
        colour = GOLD if v else (*t["muted"],)
        top = y + bars_h - bh
        draw.rounded_rectangle([bx, top, bx + bw, y + bars_h], radius=round(4 * s),
                               fill=colour if v else None, outline=None if v else colour)
        if v:
            draw.text((bx + bw / 2, top - round(6 * s)), str(v), font=lf, fill=t["ink"], anchor="ms")
        draw.text((bx + bw / 2, y + height), f"'{str(d['year'])[2:]}", font=lf, fill=t["muted"], anchor="ms")


def _footer(img, facts, t, x, y, width, s, url) -> int:
    """Verify line, and the QR code pointing at the public link."""
    draw = ImageDraw.Draw(img)
    q = round(120 * s)
    ff = _font("sans", round(22 * s), 600)
    mf = _font("sans", round(20 * s), 400)
    college = facts.get("college") or "the college"
    text_w = width - (q + round(24 * s) if url else 0)
    line1, f1 = _fit(draw, f"Verified by {college}", text_w, "sans", round(22 * s), 600, smallest=round(14 * s))
    since = f"Publishing since {facts['since']} · " if facts.get("since") else ""
    line2 = f"{since}As of {_as_of(facts)}"
    if url:
        qr = _qr_image(url, q)
        img.paste(qr, (x + width - q, y))
        short = url.split("://", 1)[-1]
        line3, f3 = _fit(draw, short, text_w, "sans", round(18 * s), 400, smallest=round(12 * s))
        top = y + (q - (f1.size + mf.size + f3.size + round(16 * s))) // 2
    else:
        line3, f3 = "", mf
        top = y + (q - (f1.size + mf.size + round(8 * s))) // 2
    draw.text((x, top), line1, font=f1, fill=t["gold"])
    draw.text((x, top + f1.size + round(8 * s)), _printable(line2), font=mf, fill=t["muted"])
    if line3:
        draw.text((x, top + f1.size + mf.size + round(16 * s)), line3, font=f3, fill=t["muted"])
    return q


def _render_tall(img, facts, t, opts, url, ribbon, fmt):
    w, h = img.size
    s = w / 1080
    m = round(72 * s)
    inner = w - 2 * m
    draw = ImageDraw.Draw(img)
    photo_d = {"portrait": 260, "story": 320, "square": 190}[fmt]
    photo_d = round(photo_d * s)
    blocks: list[Block] = []

    blocks.append((round(72 * s), lambda im, y: _header(im, facts, t, m, y, s, inner)))
    if opts["photo"] or True:  # the monogram stands in when the photo is off
        ring = photo_d // 2 + max(4, photo_d // 28) + max(3, photo_d // 40) * 2
        blocks.append((ring * 2, lambda im, y: _portrait(im, facts, t, w // 2, y + ring, photo_d, opts["photo"])))

    name_size = {"portrait": 76, "story": 88, "square": 64}[fmt]
    name, nf = _fit(draw, facts.get("name") or "", inner, "serif", round(name_size * s), 600, smallest=round(36 * s))
    role = " · ".join(p for p in (facts.get("designation"), facts.get("department")) if p)
    role, rf = _fit(draw, role, inner, "sans", round(32 * s), 400, smallest=round(18 * s))

    def who(im, y):
        _text(im, (w // 2, y), name, nf, t["ink"], foil=t["foil"], anchor="mt")
        if role:
            ImageDraw.Draw(im).text((w // 2, y + nf.size + round(14 * s)), role, font=rf, fill=t["muted"], anchor="mt")
    blocks.append((nf.size + (round(14 * s) + rf.size if role else 0), who))

    if facts.get("headlines"):
        probe = Image.new("RGB", (w, 10))
        ph = _plate(probe, facts, t, opts, m, 0, inner, s, centred=True)
        blocks.append((ph, lambda im, y: _plate(im, facts, t, opts, m, y, inner, s, centred=True)))

    blocks.append((round(50 * s), lambda im, y: _stats(im, facts, t, m, y, inner, s)))

    if opts["strip"] and fmt != "square":
        sh = round((110 if fmt == "portrait" else 150) * s)
        blocks.append((sh, lambda im, y: _strip_draw(im, facts, t, m + inner // 8, y, inner * 3 // 4, sh, s)))

    if opts["quote"] and facts.get("headline_text") and fmt != "square":
        qf = _font("italic", round(30 * s), 400)
        lines = _wrap(draw, f"“{facts['headline_text']}”", inner, qf, 2)
        lh = round(qf.size * 1.35)

        def quote(im, y):
            d = ImageDraw.Draw(im)
            for i, line in enumerate(lines):
                d.text((w // 2, y + i * lh), line, font=qf, fill=t["muted"], anchor="mt")
        blocks.append((lh * len(lines), quote))

    blocks.append((round(120 * s), lambda im, y: _footer(im, facts, t, m, y, inner, s, url)))

    top, bottom = ribbon + round(56 * s), h - ribbon - round(52 * s)
    used = sum(b[0] for b in blocks)
    gap = max(round(12 * s), (bottom - top - used) / max(1, len(blocks) - 1))
    y = float(top)
    for height, fn in blocks:
        fn(img, round(y))
        y += height + gap


def _render_wide(img, facts, t, opts, url, ribbon):
    w, h = img.size
    s = 0.9
    m = round(56 * s)
    draw = ImageDraw.Draw(img)
    top = ribbon + round(34 * s)
    _header(img, facts, t, m, top, s * 0.9, w // 2)

    # Left: the person.
    left_w = round(w * 0.46)
    photo_d = round(190 * s)
    cy = top + round(80 * s) + photo_d // 2 + 24
    _portrait(img, facts, t, m + photo_d // 2 + 14, cy, photo_d, opts["photo"])
    tx = m + photo_d + round(56 * s)
    tw = left_w - (tx - m)
    name_lines_font = _font("serif", round(54 * s), 600)
    lines = _wrap(draw, facts.get("name") or "", tw, name_lines_font, 2)
    ny = cy - (len(lines) * round(name_lines_font.size * 1.1) + round(60 * s)) // 2
    for line in lines:
        _text(img, (tx, ny), line, name_lines_font, t["ink"], foil=t["foil"])
        ny += round(name_lines_font.size * 1.1)
    role_font = _font("sans", round(24 * s), 400)
    for line in _wrap(draw, " · ".join(p for p in (facts.get("designation"), facts.get("department")) if p),
                      tw, role_font, 2):
        draw.text((tx, ny + round(8 * s)), line, font=role_font, fill=t["muted"])
        ny += round(role_font.size * 1.3)

    # Right: the headline plate, the stats, the strip.
    rx = left_w + m
    rw = w - rx - m
    ry = top
    if facts.get("headlines"):
        ph = _plate(img, facts, t, opts, rx, ry, rw, s * 0.78)
        ry += ph + round(22 * s)
    ry += _stats(img, facts, t, rx, ry, rw, s * 0.85, centred=False) + round(12 * s)
    bottom = h - ribbon - round(30 * s)
    footer_h = round(120 * s * 0.8)
    if opts["strip"]:
        sh = bottom - footer_h - round(24 * s) - ry
        if sh >= round(60 * s):
            _strip_draw(img, facts, t, rx, ry, rw, min(sh, round(170 * s)), s * 0.8)

    _footer(img, facts, t, m, bottom - footer_h, left_w - m if not url else w - 2 * m, s * 0.8, url)
