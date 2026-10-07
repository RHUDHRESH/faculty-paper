"""Put the photos and files back from a zip.

The database restore (services/restore.py) brings the rows over, including paths
such as avatars/<uuid>.jpg, but not the files those paths name: they live on the
machine the college was run from. This reads a zip of that machine's media
folders and files each one under the same name, through default_storage, so it
lands in the database, on disk or in a bucket as the host is configured.

The zip is untrusted from its first byte, and nothing in it is ever extracted to
a disk: names, the sizes it declares, and what the bytes turn out to be are all
checked here. A file that fails is listed with the reason and the rest carry on;
a zip that is not a zip, or is too big to unpack safely, is refused whole before
anything is written.
"""
from __future__ import annotations

import lzma
import re
import stat
import struct
import zipfile
import zlib
from typing import IO, NamedTuple

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage

from core.services.uploads import sniff

MB = 1024 * 1024
FOLDERS = ("avatars", "claims", "feed", "site")

MAX_ARCHIVE = 150 * MB
MAX_FILE = 20 * MB
#: What the zip may unpack to in all. Guards a zip bomb: declared sizes are
#: added up before reading, and what is really read is counted again.
MAX_UNCOMPRESSED = 300 * MB
MAX_ENTRIES = 5000
MAX_NAME = 200
#: An SVG is text a browser may run, so it gets a smaller ceiling than a photo.
MAX_SVG = 2 * MB

#: How much is read before it is written. The host has 512 MB, so a batch is
#: held to a few files and a few megabytes, never the whole zip.
BATCH_FILES = 50
BATCH_BYTES = 8 * MB
CHUNK = MB
#: The report lists this many problems; the rest are counted.
MAX_REPORTED = 200

NOT_A_ZIP = "That is not a zip file."

#: The shape of every name the app itself writes, and the only shape the media
#: views in core/views.py will serve. A name outside it could never be shown.
_NAME = re.compile(r"^[0-9a-f]{32}\.([a-z0-9]{2,5})$")
_DRIVE = re.compile(r"^[A-Za-z]:")

#: The type of bytes each extension must really hold (FileKind.extension).
_FAMILY = {"jpg": "jpg", "jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif", "pdf": "pdf"}
_PICTURES = frozenset({"jpg", "jpeg", "png", "webp", "gif"})
_ALLOWED = {
    "avatars": _PICTURES,
    "site": _PICTURES | {"svg"},
    "claims": _PICTURES | {"pdf"},
    "feed": _PICTURES | {"pdf"},
}
_EVERYTHING = frozenset().union(*_ALLOWED.values())

#: Markup a browser would run. Matched on the whole SVG, case-blind.
_ACTIVE = re.compile(
    rb"<\s*(script|foreignobject|iframe|embed|object)\b|\bon[a-z]+\s*=|javascript:|<!entity|<!doctype[^>]*\[",
    re.IGNORECASE,
)

_EOCD = struct.Struct("<4s4H2LH")  # the zip's end-of-central-directory record
_ZIP_ENCRYPTED = 0x1


class MediaImportError(Exception):
    """The whole zip is refused. The message is shown to the admin as it stands."""


class NotAccepted(ValueError):
    """One entry is refused. The message is the reason, in plain words."""


class _Item(NamedTuple):
    index: int
    raw: str
    path: str
    ext: str
    info: zipfile.ZipInfo


def _mb(n: int) -> str:
    return f"{n / MB:g} MB"


def member_path(raw: str) -> str:
    """The storage name for a zip entry, or NotAccepted saying why not.

    Backslashes are read as slashes first: Windows PowerShell's Compress-Archive
    writes "avatars\\name.jpg", and the zip is made on Windows. Straightening
    them up front means every rule below judges the path the way a filesystem
    would, so "..\\x" and "C:\\x" fail like "../x" and "C:/x".
    """
    if not raw:
        raise NotAccepted("It has no name.")
    path = raw.replace("\\", "/")
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise NotAccepted("The name has control characters in it.")
    if len(path) > MAX_NAME:
        raise NotAccepted(f"The name is longer than {MAX_NAME} characters.")
    if path.startswith("/") or _DRIVE.match(path):
        raise NotAccepted("The path starts at the root or a drive, not inside a media folder.")
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise NotAccepted("The path climbs out of its folder or has an empty part.")
    if parts[0] not in FOLDERS:
        raise NotAccepted("It is not inside the avatars, claims, feed or site folder.")
    if len(parts) != 2:
        raise NotAccepted("Folders inside those folders are not used.")
    match = _NAME.match(parts[1])
    if match is None:
        raise NotAccepted("The name is not one this app uses (32 letters and digits, then the extension).")
    ext = match.group(1)
    if ext not in _EVERYTHING:
        raise NotAccepted("Only JPG, PNG, WebP, GIF and PDF files are kept (SVG on the site).")
    if ext not in _ALLOWED[parts[0]]:
        raise NotAccepted(f"A .{ext} file does not belong in {parts[0]}.")
    return path


def _shown(raw: str) -> str:
    """A zip's own name for an entry, made safe to print."""
    return "".join(c if ord(c) >= 32 and ord(c) != 127 else "?" for c in raw)[:120]


def existing_names(names) -> set[str]:
    """Which of these names the storage already holds. One query on the database storage."""
    names = list(names)
    ask_once = getattr(default_storage, "existing", None)
    if ask_once is not None:
        return ask_once(names)
    return {n for n in names if default_storage.exists(n)}


def _check_central_directory(fileobj: IO[bytes], size: int) -> None:
    """Refuse a zip that lists too many files before Python reads the list.

    zipfile builds an object per entry from the central directory the moment it
    opens a zip, so a few megabytes of crafted entries would cost far more than
    that in memory. The end record says how large the directory is, and a
    directory fit for 5,000 modest names is a small fraction of 2.5 MB.
    """
    window = min(size, _EOCD.size + 0xFFFF)
    fileobj.seek(size - window)
    tail = fileobj.read(window)
    at = tail.rfind(b"PK\x05\x06")
    if at < 0 or len(tail) - at < _EOCD.size:
        raise MediaImportError(NOT_A_ZIP)
    *_, entries, directory_bytes, _offset, _comment = _EOCD.unpack_from(tail, at)
    if entries > MAX_ENTRIES or directory_bytes > MAX_ENTRIES * 512:
        raise _too_many()


def _too_many() -> MediaImportError:
    return MediaImportError(f"That zip holds more than {MAX_ENTRIES:,} files. Split it into smaller zips.")


def _check_declared_sizes(infos: list[zipfile.ZipInfo]) -> None:
    if sum(i.file_size for i in infos) > MAX_UNCOMPRESSED:
        raise MediaImportError(f"Unpacked, that zip would be over {_mb(MAX_UNCOMPRESSED)}. Split it into smaller zips.")


def _entry_problem(info: zipfile.ZipInfo) -> str | None:
    if info.flag_bits & _ZIP_ENCRYPTED:
        return "It is password protected."
    mode = info.external_attr >> 16
    if mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG):
        return "It is a link or a special file, not a file."
    if info.file_size == 0:
        return "The file is empty."
    if info.file_size > MAX_FILE:
        return f"Over the {_mb(MAX_FILE)} limit for one file."
    return None


def _content_problem(ext: str, data: bytearray) -> str | None:
    """Do the bytes hold what the extension says? None when they do."""
    if ext == "svg":
        if len(data) > MAX_SVG:
            return f"An SVG over {_mb(MAX_SVG)} is not accepted."
        body = bytes(data)
        if not body.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"<") or b"<svg" not in body[:4096].lower():
            return "The contents are not an SVG picture."
        if _ACTIVE.search(body):
            return "The SVG carries a script or other active content."
        return None
    kind = sniff(bytes(data[:4096]))
    if kind is None:
        return "The contents are not a picture or PDF this app accepts."
    if kind.extension != _FAMILY[ext]:
        return f"The name says .{ext} but the contents are a {kind.label}."
    return None


class _Run:
    """What one import has done so far."""

    def __init__(self) -> None:
        self.added = self.replaced = self.skipped = self.bytes = 0
        self.read = 0  # every byte unpacked, kept or not
        self.over = False  # the unpacked total has passed MAX_UNCOMPRESSED
        self.problems: list[tuple[int, str, str]] = []

    def reject(self, index: int, raw: str, why: str) -> None:
        self.problems.append((index, _shown(raw), why))

    def report(self) -> dict:
        ordered = sorted(self.problems)
        return {
            "added": self.added,
            "replaced": self.replaced,
            "skipped": self.skipped,
            "rejected": [{"name": name, "why": why} for _, name, why in ordered[:MAX_REPORTED]],
            "rejected_count": len(ordered),
            "bytes": self.bytes,
        }


def _unpack(zf: zipfile.ZipFile, item: _Item, run: _Run) -> bytearray:
    """One entry's bytes, read in pieces and counted, or NotAccepted."""
    unpacks_past = f"The zip unpacks past {_mb(MAX_UNCOMPRESSED)}, so this was not read."
    if run.over:
        raise NotAccepted(unpacks_past)
    data = bytearray()
    try:
        with zf.open(item.info) as handle:
            while chunk := handle.read(CHUNK):
                run.read += len(chunk)
                if run.read > MAX_UNCOMPRESSED:
                    run.over = True
                    raise NotAccepted(unpacks_past)
                data += chunk
                if len(data) > item.info.file_size:
                    raise NotAccepted("The file is larger than the zip says it is.")
    except (
        zipfile.BadZipFile, zlib.error, lzma.LZMAError, RuntimeError, NotImplementedError, EOFError, OSError,
    ) as exc:
        raise NotAccepted(
            "It could not be read: the zip is damaged there, or built a way this does not support."
        ) from exc
    return data


def _store(batch: list[tuple[str, bytes]], replacing: set[str]) -> None:
    """File a batch under exactly these names.

    Storage.save would call a second file avatars/<name>_AbC123.jpg rather than
    replace the first, which leaves the database pointing at the old one. So a
    file being replaced is deleted first, and the name the storage settles on is
    checked rather than assumed.
    """
    put_many = getattr(default_storage, "put_many", None)
    if put_many is not None:
        put_many(batch)
        return
    for name, data in batch:
        if name in replacing:
            default_storage.delete(name)
        saved = default_storage.save(name, ContentFile(data))
        if saved != name:
            default_storage.delete(saved)
            raise MediaImportError(f"The storage filed {name} as {saved}, which nothing points to. It was removed.")


def _classify(infos: list[zipfile.ZipInfo], run: _Run) -> list[_Item]:
    items, seen = [], set()
    for index, info in enumerate(infos):
        raw = info.filename
        if raw.replace("\\", "/").endswith("/"):  # a folder entry: nothing to file, nothing to say
            if info.file_size:
                run.reject(index, raw, "A folder that carries data.")
            continue
        try:
            path = member_path(raw)
            problem = _entry_problem(info)
            if problem:
                raise NotAccepted(problem)
            if path in seen:
                raise NotAccepted("The same name is in the zip twice; the first is used.")
        except NotAccepted as exc:
            run.reject(index, raw, str(exc))
            continue
        seen.add(path)
        items.append(_Item(index, raw, path, path.rsplit(".", 1)[1], info))
    return items


def import_zip(fileobj: IO[bytes], *, overwrite: bool = False) -> dict:
    """File every acceptable entry of a zip under its own name.

    Returns {"added", "replaced", "skipped", "rejected", "rejected_count", "bytes"}:
    `added` counts files written (new or replaced; `replaced` is the part of it
    that replaced one), `skipped` files left alone because the name was already
    held and `overwrite` is off, `rejected` the entries refused with the reason.
    Raises MediaImportError when the zip as a whole cannot be taken.
    """
    fileobj.seek(0, 2)
    size = fileobj.tell()
    if size > MAX_ARCHIVE:
        raise MediaImportError(f"That zip is over {_mb(MAX_ARCHIVE)}. Split it into smaller zips.")
    _check_central_directory(fileobj, size)
    fileobj.seek(0)
    try:
        zf = zipfile.ZipFile(fileobj)
    except (zipfile.BadZipFile, ValueError, OSError) as exc:
        raise MediaImportError(NOT_A_ZIP) from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise _too_many()
        _check_declared_sizes(infos)
        run = _Run()
        items = _classify(infos, run)
        pending: list[tuple[str, bytes]] = []
        replacing: set[str] = set()
        held = 0

        def flush() -> None:
            nonlocal held
            if pending:
                _store(pending, replacing)
                run.added += len(pending)
                run.replaced += len(replacing)
                run.bytes += held
            pending.clear()
            replacing.clear()
            held = 0

        for start in range(0, len(items), BATCH_FILES):
            window = items[start:start + BATCH_FILES]
            present = existing_names(item.path for item in window)
            for item in window:
                exists = item.path in present
                if exists and not overwrite:
                    run.skipped += 1
                    continue
                try:
                    data = _unpack(zf, item, run)
                    problem = _content_problem(item.ext, data)
                    if problem:
                        raise NotAccepted(problem)
                except NotAccepted as exc:
                    run.reject(item.index, item.raw, str(exc))
                    continue
                pending.append((item.path, bytes(data)))
                held += len(data)
                if exists:
                    replacing.add(item.path)
                if held >= BATCH_BYTES:
                    flush()
            flush()
    return run.report()
