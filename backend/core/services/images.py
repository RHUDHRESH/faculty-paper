"""Uploaded pictures, made safe to show to colleagues.

A photo straight off a phone carries the phone's make, the time it was taken
and often where -- GPS coordinates in the EXIF block. A profile picture or a
poster shared in the feed is shown to the whole college, so every picture is
decoded and written back out, which keeps the pixels and drops everything
else. It also makes a 5 MB camera original into a few tens of kilobytes, which
matters where files live in the database.
"""
from __future__ import annotations

import io

from PIL import Image, ImageOps, UnidentifiedImageError

from core.services.uploads import GIF, JPEG, PNG, WEBP, FileKind, sniff

#: Kinds of upload that are pictures and can be re-encoded.
PICTURES = {PNG, JPEG, WEBP, GIF}

#: Above this many pixels a picture is refused before its pixels are decoded.
#: A few kilobytes of PNG can describe a 40,000 x 40,000 canvas that would
#: take gigabytes to hold in memory -- the byte cap alone does not stop that.
MAX_PIXELS = 40_000_000


class NotAPicture(ValueError):
    """The upload is not an image we can re-encode, said in a sentence."""


def reencode(content: bytes, *, max_side: int, square: bool = False) -> tuple[bytes, FileKind]:
    """The same picture with its metadata gone and its longest side at most `max_side`.

    Parameters
    ----------
    content : bytes
        The uploaded file.
    max_side : int
        The largest the result may be in either direction, in pixels.
    square : bool, default=False
        Crop to a centred square first -- what a profile photo is shown as.

    Returns
    -------
    tuple of (bytes, FileKind)
        The new file, and what it now is: PNG when the picture has
        transparency to keep, JPEG otherwise.

    Raises
    ------
    NotAPicture
        When the bytes are not a PNG, JPEG, WebP or GIF, or are too large a
        canvas to decode safely.
    """
    kind = sniff(content)
    if kind not in PICTURES:
        raise NotAPicture("That is not a picture. Use a PNG, JPEG, WebP or GIF.")
    try:
        img = Image.open(io.BytesIO(content))
        width, height = img.size
        if width * height > MAX_PIXELS:
            raise NotAPicture("That picture is too large to use. Try a smaller copy of it.")
        # The orientation lives in the EXIF block being dropped, so it is
        # applied to the pixels first -- or every phone portrait turns sideways.
        img = ImageOps.exif_transpose(img)
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise NotAPicture("That picture could not be read. Try saving it again.") from exc

    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    img = img.convert("RGBA" if has_alpha else "RGB")

    if square:
        img = ImageOps.fit(img, (max_side, max_side), method=Image.Resampling.LANCZOS)
    else:
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

    out = io.BytesIO()
    if has_alpha:
        img.save(out, format="PNG", optimize=True)
        return out.getvalue(), PNG
    img.save(out, format="JPEG", quality=85, optimize=True, progressive=True)
    return out.getvalue(), JPEG
