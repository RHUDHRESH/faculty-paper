"""Fill empty profile fields from the college's own public website.

The scrape (scripts/college_site/scrape.py) writes a folder -- faculty.json,
departments.json, photos/, images/ -- that never enters the repository. This
module reads that folder (or a zip of it) and fills what people have left
empty. Three rules:

* It never overwrites. A photo, bio or designation somebody set stays.
* It fills a field for a person once. What was filled is remembered in the
  ``college_site_applied`` setting, so when somebody removes an imported photo
  or bio, a re-run of the import does not put it back.
* A match must be unambiguous: email, then Scopus author id, then a name
  that scores >= 0.85 and is unique -- in the department when it is not
  unique college-wide. Anything else is reported, not guessed.
"""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction

from core.models import ResearchInterest, SystemSetting, User
from core.services.images import NotAPicture, reencode
from core.services.publications import _NameIndex

APPLIED_KEY = "college_site_applied"
DEPARTMENTS_KEY = "department_profiles"
PHOTO_SIDE = 320

#: The website's department slugs, as this app's department codes.
SLUG_TO_DEPT: dict[str, tuple[str, ...]] = {
    "agricultural-engineering": ("AGRI",),
    "artificial-intelligence-data-science": ("AI&DS",),
    "artificial-intelligence-machine-learning": ("AI&ML",),
    "bio-medical-engineering": ("BME",),
    "chemical-engineering": ("CHEMICAL",),
    "civil-engineering": ("CIVIL",),
    "computer-science-and-engineering": ("CSE",),
    "computer-science-and-engineering-cyber-security": ("CSE - CS",),
    "computer-science-and-engineering-internet-of-things": ("CSE - IoT",),
    "electrical-amp-electronics-engineering": ("EEE",),
    "electronics-communication-engineering": ("ECE",),
    "electronics-instrumentation-engineering": ("EIE",),
    "information-technology": ("IT",),
    "master-of-business-administration": ("MBA",),
    "mechanical-engineering": ("MECH",),
    "medical-electronics": ("MED",),
    "science-and-humanities": ("S&H-MATHS", "S&H-ENGLISH", "S&H-CHY", "S&H-PHY"),
    "training": ("TRAINING",),
}


class Source(Protocol):
    def read(self, name: str) -> bytes | None: ...


class FolderSource:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def read(self, name: str) -> bytes | None:
        p = self.root / name
        return p.read_bytes() if p.is_file() else None


class ZipSource:
    """A zip of the scrape folder; the folder may be the zip's root or one level down."""

    def __init__(self, content: bytes) -> None:
        self.zf = zipfile.ZipFile(io.BytesIO(content))
        names = self.zf.namelist()
        hit = next((n for n in names if n.endswith("faculty.json")), None)
        self.prefix = hit[: -len("faculty.json")] if hit else ""
        self.names = set(names)

    def read(self, name: str) -> bytes | None:
        full = self.prefix + name
        if full not in self.names:
            return None
        info = self.zf.getinfo(full)
        if info.file_size > 20 * 1024 * 1024:
            return None
        return self.zf.read(full)


@dataclass
class Report:
    scraped: int = 0
    matched: int = 0
    photos: int = 0
    bios: int = 0
    designations: int = 0
    interests: int = 0
    departments: int = 0
    unmatched: list[dict] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    dry_run: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "scraped": self.scraped,
            "matched": self.matched,
            "unmatched_count": len(self.unmatched),
            "photos": self.photos,
            "bios": self.bios,
            "designations": self.designations,
            "interests": self.interests,
            "departments": self.departments,
            "unmatched": self.unmatched[:200],
            "conflicts": self.conflicts[:200],
            "dry_run": self.dry_run,
        }


def _clean_email(value: Any) -> str:
    return str(value or "").strip().lower()


def match(rows: list[dict], people: list[User]) -> tuple[dict[int, User], list[dict], list[dict]]:
    """Row index -> account, plus the unmatched rows and the ambiguous ones."""
    by_email = {u.email.lower(): u for u in people if u.email}
    by_scopus = {u.scopus_author_id: u for u in people if u.scopus_author_id}
    index = _NameIndex(people)
    found: dict[int, User] = {}
    unmatched: list[dict] = []
    conflicts: list[dict] = []
    for i, row in enumerate(rows):
        who = {"name": row.get("name"), "department": row.get("department")}
        user = by_email.get(_clean_email(row.get("email")))
        if user is None and row.get("scopus_author_id"):
            user = by_scopus.get(str(row["scopus_author_id"]))
        if user is None:
            cands = index.candidates(row.get("name") or "")
            if cands:
                top = cands[0][0]
                best = [u for s, u in cands if s == top]
                depts = set(SLUG_TO_DEPT.get(row.get("department_slug") or "", ()))
                in_dept = [u for u in best if (u.department or "") in depts]
                if len(in_dept) == 1:
                    user = in_dept[0]
                elif len(best) == 1 and not in_dept and not depts:
                    user = best[0]
                elif len(best) == 1 and best[0].department in depts:
                    user = best[0]
                elif len(best) == 1:
                    # One name, different department: plausible, but not safe.
                    conflicts.append({**who, "reason": f"name matches {best[0].name} in {best[0].department}"})
                    continue
                else:
                    conflicts.append({**who, "reason": f"{len(best)} accounts share this name"})
                    continue
        if user is None:
            unmatched.append(who)
            continue
        if user.id in {u.id for u in found.values()}:
            conflicts.append({**who, "reason": f"{user.name} already matched to another card"})
            continue
        found[i] = user
    return found, unmatched, conflicts


def _bio(row: dict) -> str:
    parts = []
    if row.get("qualifications"):
        parts.append(row["qualifications"].strip().rstrip(","))
    if row.get("teaching_experience"):
        parts.append(f"Teaching experience: {row['teaching_experience']}.")
    areas = [a for a in row.get("research_areas") or [] if a]
    if areas:
        parts.append("Areas of specialisation: " + ", ".join(areas[:8]) + ".")
    return " ".join(parts).strip()


def _store(folder: str, content: bytes, ext: str) -> str:
    return default_storage.save(f"{folder}/{uuid.uuid4().hex}.{ext}", ContentFile(content))


def _setting(key: str) -> dict:
    row = SystemSetting.objects.filter(key=key).first()
    return dict(row.value) if row and isinstance(row.value, dict) else {}


def _put(key: str, value: dict, actor: User | None) -> None:
    SystemSetting.objects.update_or_create(key=key, defaults={"value": value, "updated_by": actor})


def import_site(source: Source, *, actor: User | None = None, dry_run: bool = False) -> Report:
    raw = source.read("faculty.json")
    if raw is None:
        raise ValueError("No faculty.json in that folder or zip.")
    rows: list[dict] = json.loads(raw.decode("utf-8"))
    report = Report(scraped=len(rows), dry_run=dry_run)
    people = list(User.objects.filter(active=True))
    found, report.unmatched, report.conflicts = match(rows, people)
    report.matched = len(found)
    applied = _setting(APPLIED_KEY)
    categories = {c.lower(): c for c in _subject_categories()}

    with transaction.atomic():
        for i, user in found.items():
            row = rows[i]
            done = set(applied.get(user.id, []))
            changed: list[str] = []
            if not user.photo and "photo" not in done and row.get("photo_file"):
                data = source.read(f"photos/{row['photo_file']}")
                if data:
                    try:
                        pic, kind = reencode(data, max_side=PHOTO_SIDE, square=True)
                    except NotAPicture:
                        pic = None
                    if pic is not None:
                        if not dry_run:
                            user.photo = _store("avatars", pic, kind.extension)
                        changed.append("photo")
                        report.photos += 1
            bio = _bio(row)
            if not (user.bio or "").strip() and "bio" not in done and bio:
                user.bio = bio
                changed.append("bio")
                report.bios += 1
            desig = (row.get("designation") or "").strip()
            if desig and "designation" not in done:
                if not (user.designation or "").strip():
                    user.designation = desig[:128]
                    changed.append("designation")
                    report.designations += 1
                elif user.designation.strip().lower() != desig.lower():
                    report.conflicts.append({
                        "name": user.name, "department": user.department,
                        "reason": f"designation here '{user.designation}', website '{desig}' (kept ours)",
                    })
            if "interests" not in done and not user.research_interests.exists():
                hits = {categories[a.lower()] for a in row.get("research_areas") or [] if a.lower() in categories}
                if hits:
                    if not dry_run:
                        ResearchInterest.objects.bulk_create(
                            [ResearchInterest(user=user, domain=d) for d in sorted(hits)], ignore_conflicts=True
                        )
                    changed.append("interests")
                    report.interests += 1
            if changed and not dry_run:
                fields = [f for f in ("photo", "bio", "designation") if f in changed]
                if fields:
                    user.save(update_fields=[*fields, "updated_at"])
                applied[user.id] = sorted(done | set(changed))

        report.departments = _import_departments(source, actor, dry_run)
        if not dry_run:
            _put(APPLIED_KEY, applied, actor)
        else:
            transaction.set_rollback(True)
    return report


def _subject_categories() -> list[str]:
    from core.services.discover import research_domains

    return research_domains(limit=302)


def _import_departments(source: Source, actor: User | None, dry_run: bool) -> int:
    raw = source.read("departments.json")
    if raw is None:
        return 0
    profiles = _setting(DEPARTMENTS_KEY)
    count = 0
    for dept in json.loads(raw.decode("utf-8")):
        for code in SLUG_TO_DEPT.get(dept.get("slug") or "", ()):
            current = dict(profiles.get(code) or {})
            if not current.get("description") and dept.get("description"):
                current["description"] = dept["description"]
            if not current.get("image") and dept.get("image_file") and not dry_run:
                data = source.read(f"images/{dept['image_file']}")
                if data:
                    try:
                        pic, kind = reencode(data, max_side=1600)
                        current["image"] = _store("site", pic, kind.extension)
                    except NotAPicture:
                        pass
            if not current.get("research_focus") and dept.get("research_focus"):
                current["research_focus"] = dept["research_focus"][:20]
            current.setdefault("source_url", dept.get("url"))
            current["name"] = current.get("name") or dept.get("name")
            if current != profiles.get(code):
                profiles[code] = current
                count += 1
    if not dry_run:
        _put(DEPARTMENTS_KEY, profiles, actor)
    return count


def department_profile(code: str) -> dict | None:
    from django.conf import settings

    p = _setting(DEPARTMENTS_KEY).get(code)
    if not p:
        return None
    image = p.get("image")
    return {
        "code": code,
        "name": p.get("name"),
        "description": p.get("description") or "",
        "image_url": f"{settings.MEDIA_URL}{image}" if image else None,
        "research_focus": p.get("research_focus") or [],
        "source_url": p.get("source_url"),
    }
