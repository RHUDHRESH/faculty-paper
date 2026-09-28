"""Publication-record quality: the same paper recorded twice, roster names
spelt differently from the person's own papers, and records that cannot be
right (title "-", a year before the college existed, no authors, a web
address where the journal name belongs).

Nothing here changes data on its own. `find_duplicates` and
`roster_name_suggestions` only report; `merge` and `undo_merge` act on one
pair a super admin chose, and both are audit-logged.
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone

from core.models import (
    AuditLog, Authorship, FeedPost, Publication, PublicationMerge, PublicationMetrics, SystemSetting, User,
)
from core.services.author_names import _one_edit, name_parts, name_score
from core.services.normalize import normalize_doi, normalize_title

# ------------------------------------------------------------ anomalies --

#: Titles that are a placeholder, not a title.
PLACEHOLDER_TITLES = frozenset({"", "-", "--", ".", "na", "n/a", "n.a", "nil", "none", "null", "untitled", "0"})
FIRST_YEAR = 1950

#: Venues that are a preprint server, not a journal.
PREPRINT_VENUES = ("arxiv", "biorxiv", "medrxiv", "ssrn", "research square", "preprints.org", "techrxiv",
                   "chemrxiv", "authorea", "preprint")
PREPRINT_DOI_PREFIXES = ("10.48550/", "10.21203/", "10.20944/", "10.2139/", "10.1101/", "10.36227/",
                         "10.26434/", "10.22541/")

_URL_VENUE = re.compile(r"^(https?://|www\.)|^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$", re.I)


def last_plausible_year() -> int:
    return timezone.now().year + 1


def is_placeholder_title(title: str | None) -> bool:
    return (title or "").strip().lower() in PLACEHOLDER_TITLES


def venue_is_url(venue: str | None) -> bool:
    """"decision.csl.uiuc.edu" or "http://x.org/a.pdf" -- but not
    "Preprints.org" or "Procedia Comput. Sci." (a space, or a known name)."""
    v = (venue or "").strip()
    if not v or " " in v:
        return False
    if v.lower() in ("preprints.org",):
        return False
    return bool(_URL_VENUE.match(v)) and "." in v


def anomalies() -> dict[str, Any]:
    """Querysets for each anomaly, keyed as the data-health checks name them."""
    placeholder = Q()
    for t in PLACEHOLDER_TITLES:
        placeholder |= Q(title__iexact=t) if t else Q(title="")
    # Stripped whitespace variants of the same: SQLite has no trim lookup in
    # the ORM, so catch titles that are only punctuation too.
    placeholder |= Q(title__regex=r"^[\s\-\.\?]*$")
    ids_url = [pk for pk, v in Publication.objects.exclude(venue="").exclude(venue__contains=" ")
               .values_list("pk", "venue") if venue_is_url(v)]
    return {
        "placeholder_title": Publication.objects.filter(placeholder),
        "impossible_year": Publication.objects.filter(Q(year__lt=FIRST_YEAR) | Q(year__gt=last_plausible_year())),
        "no_authors": Publication.objects.annotate(n=Count("authorships")).filter(n=0),
        "venue_is_url": Publication.objects.filter(pk__in=ids_url),
    }


def fix_url_venues(actor: Optional[User] = None) -> int:
    """Move a web address out of the journal name into the open-access link
    when that is empty, and blank the journal name. The only safe fix: the
    real journal name is not known, and a blank reads as "Not recorded"."""
    changed = 0
    for p in anomalies()["venue_is_url"]:
        updates = {"venue": ""}
        if not p.oa_url and p.venue.lower().startswith(("http://", "https://")):
            updates["oa_url"] = p.venue
        Publication.objects.filter(pk=p.pk).update(**updates)
        changed += 1
    return changed


# ----------------------------------------------------------- duplicates --


def title_key(title: str | None) -> str:
    """normalize_title, with each word's plural 's' dropped: "technique" and
    "techniques" are one paper registered twice (real data, 2022)."""
    words = [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in normalize_title(title).split()]
    return " ".join(words)


def _usable_key(key: str) -> bool:
    return len(key.split()) >= 4 and len(key) >= 20


def is_preprint(venue: str | None, doi: str | None, type_: str | None = "") -> bool:
    v = (venue or "").lower()
    d = (doi or "").lower()
    return (type_ or "").lower() == "preprint" or any(p in v for p in PREPRINT_VENUES) or d.startswith(PREPRINT_DOI_PREFIXES)


@dataclass
class _Pub:
    id: str
    title: str
    year: Optional[int]
    doi: str
    venue: str
    type: str
    openalex_id: str
    citations: int
    source: str
    authors: int = 0
    users: set[str] = field(default_factory=set)
    claims: int = 0

    @property
    def preprint(self) -> bool:
        return is_preprint(self.venue, self.doi, self.type)

    def richness(self) -> tuple:
        return (not self.preprint, not is_placeholder_title(self.title), bool(self.doi), bool(self.openalex_id),
                self.claims, len(self.users), self.authors, self.citations, bool(self.venue), self.id)

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "year": self.year, "doi": self.doi or None,
                "venue": self.venue, "citations": self.citations, "source": self.source, "authors": self.authors,
                "claims": self.claims, "preprint": self.preprint}


REASONS = {
    "same_doi": "Same DOI",
    "same_title_year": "Same title and year",
    "preprint": "Preprint and published version",
}

DISMISSED_KEY = "record_duplicates_dismissed"


def pair_key(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


def dismissed() -> set[str]:
    row = SystemSetting.objects.filter(key=DISMISSED_KEY).first()
    return set(row.value or []) if row else set()


def dismiss(a: str, b: str, actor: Optional[User]) -> None:
    keys = dismissed() | {pair_key(a, b)}
    SystemSetting.objects.update_or_create(key=DISMISSED_KEY, defaults={"value": sorted(keys)})
    AuditLog.objects.create(actor=actor, action="PUBLICATION_PAIR_DISMISSED", entity="Publication",
                            entity_id=a, detail_json=json.dumps({"pair": [a, b]}))


def _load() -> dict[str, _Pub]:
    pubs: dict[str, _Pub] = {}
    for row in Publication.objects.values_list("id", "title", "year", "doi", "venue", "type", "openalex_id",
                                               "citations", "source").iterator():
        pubs[row[0]] = _Pub(row[0], row[1] or "", row[2], (normalize_doi(row[3]) or "").lower(), row[4] or "",
                            row[5] or "", row[6] or "", row[7] or 0, row[8] or "")
    for pub_id, user_id in Authorship.objects.values_list("publication_id", "user_id").iterator():
        p = pubs.get(pub_id)
        if p is None:
            continue
        p.authors += 1
        if user_id:
            p.users.add(user_id)
    for pub_id, n in Publication.claims.through.objects.values("publication_id").annotate(n=Count("id")).values_list("publication_id", "n"):
        if pub_id in pubs:
            pubs[pub_id].claims = n
    return pubs


def find_duplicates(*, include_dismissed: bool = False, user_id: Optional[str] = None) -> list[dict[str, Any]]:
    """Every pair of records that look like one paper, richer record first.

    A pair is reported when the DOI is the same, or when the titles match
    (plurals aside) and either the year is the same or one is the preprint of
    the other within two years. A title match is only reported when a college
    member is on both records -- the duplicate is on somebody's record.
    """
    pubs = _load()
    skip = set() if include_dismissed else dismissed()
    seen: set[str] = set()
    out: list[dict[str, Any]] = []

    def add(a: _Pub, b: _Pub, reason: str):
        k = pair_key(a.id, b.id)
        if k in seen or k in skip:
            return
        if user_id and user_id not in (a.users | b.users):
            return
        seen.add(k)
        keep, drop = (a, b) if a.richness() >= b.richness() else (b, a)
        shared = sorted(a.users & b.users)
        out.append({"key": k, "reason": reason, "reason_label": REASONS[reason], "keep": keep.as_dict(),
                    "drop": drop.as_dict(), "shared_people": shared})

    by_doi: dict[str, list[_Pub]] = defaultdict(list)
    by_title: dict[str, list[_Pub]] = defaultdict(list)
    for p in pubs.values():
        if p.doi:
            by_doi[p.doi].append(p)
        key = title_key(p.title)
        if _usable_key(key):
            by_title[key].append(p)
    for group in by_doi.values():
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                add(a, b, "same_doi")
    for group in by_title.values():
        if len(group) < 2:
            continue
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                if not (a.users & b.users):
                    continue
                if a.year and a.year == b.year:
                    add(a, b, "same_title_year")
                elif (a.preprint != b.preprint) and (not a.year or not b.year or abs(a.year - b.year) <= 2):
                    add(a, b, "preprint")
    out.sort(key=lambda r: (list(REASONS).index(r["reason"]), -(r["keep"]["year"] or 0), r["keep"]["title"]))
    return out


def summary(pairs: Iterable[dict[str, Any]]) -> dict[str, Any]:
    pairs = list(pairs)
    people = Counter(uid for p in pairs for uid in p["shared_people"])
    return {"pairs": len(pairs), "by_reason": dict(Counter(p["reason"] for p in pairs)),
            "people_affected": len(people)}


# ---------------------------------------------------------------- merge --

_FILL = ("doi", "eid", "issn", "venue", "type", "quartile", "oa_url", "date", "year", "title", "normalized_title")


def _fields(p: Publication) -> dict[str, Any]:
    out = {}
    for f in Publication._meta.concrete_fields:
        v = getattr(p, f.attname)
        out[f.attname] = v.isoformat() if hasattr(v, "isoformat") else v
    return out


def _authorship_fields(a: Authorship) -> dict[str, Any]:
    return {f.attname: getattr(a, f.attname) for f in Authorship._meta.concrete_fields}


def _refresh_people(user_ids: Iterable[str]) -> None:
    from core.services.publications import metrics_for

    now = timezone.now()
    for uid in {u for u in user_ids if u}:
        PublicationMetrics.objects.update_or_create(user_id=uid, defaults={**metrics_for(uid), "computed_at": now})


class MergeError(ValueError):
    pass


@transaction.atomic
def merge(keep_id: str, drop_id: str, actor: Optional[User], reason: str = "") -> PublicationMerge:
    """Fold `drop` into `keep`. Authors, claims, ledger rows and posts move;
    an author already on `keep` is not repeated; `keep`'s blank fields are
    filled from `drop`; citations take the higher count. Reversible."""
    if keep_id == drop_id:
        raise MergeError("A record cannot be merged into itself")
    keep = Publication.objects.select_for_update().filter(pk=keep_id).first()
    drop = Publication.objects.select_for_update().filter(pk=drop_id).first()
    if keep is None or drop is None:
        raise MergeError("One of the two records no longer exists")

    snap: dict[str, Any] = {"removed": _fields(drop), "kept_before": _fields(keep)}
    keep_users = set(keep.authorships.exclude(user__isnull=True).values_list("user_id", flat=True))
    keep_keys = set(keep.authorships.values_list("author_key", flat=True))
    moved, repeated = [], []
    for a in list(drop.authorships.all()):
        if (a.user_id and a.user_id in keep_users) or (not a.user_id and a.author_key in keep_keys):
            repeated.append(_authorship_fields(a))
        else:
            moved.append(a.pk)
    Authorship.objects.filter(pk__in=moved).update(publication=keep)
    snap["moved_authorships"] = moved
    snap["repeated_authorships"] = repeated

    claims = set(drop.claims.values_list("pk", flat=True))
    ledger = set(drop.ledger_rows.values_list("pk", flat=True))
    snap["claims"] = sorted(claims)
    snap["ledger_rows"] = sorted(ledger)
    snap["claims_added"] = sorted(claims - set(keep.claims.values_list("pk", flat=True)))
    snap["ledger_added"] = sorted(ledger - set(keep.ledger_rows.values_list("pk", flat=True)))
    keep.claims.add(*snap["claims_added"])
    keep.ledger_rows.add(*snap["ledger_added"])
    posts = list(FeedPost.objects.filter(publication=drop).values_list("pk", flat=True))
    FeedPost.objects.filter(pk__in=posts).update(publication=keep)
    snap["posts"] = posts

    openalex_id = drop.openalex_id
    users = {u for u in [*keep_users, *drop.authorships.exclude(user__isnull=True).values_list("user_id", flat=True)]}
    drop.delete()  # repeated authorships go with it

    for name in _FILL:
        cur = getattr(keep, name)
        if (cur in (None, "") or (name == "title" and is_placeholder_title(cur))) and getattr_snapshot(snap, name):
            setattr(keep, name, getattr_snapshot(snap, name, parse=True))
    if not keep.openalex_id and openalex_id:
        keep.openalex_id = openalex_id
    keep.citations = max(keep.citations or 0, snap["removed"]["citations"] or 0)
    if snap["removed"]["scopus_citations"] is not None:
        keep.scopus_citations = max(keep.scopus_citations or 0, snap["removed"]["scopus_citations"])
    keep.scopus_indexed = keep.scopus_indexed or snap["removed"]["scopus_indexed"]
    keep.save()

    m = PublicationMerge.objects.create(kept_id=keep_id, removed_id=drop_id, reason=reason,
                                        snapshot_json=json.dumps(snap, default=str), actor=actor)
    AuditLog.objects.create(actor=actor, action="PUBLICATION_MERGED", entity="Publication", entity_id=keep_id,
                            detail_json=json.dumps({"merge": m.pk, "removed": drop_id, "reason": reason,
                                                    "title": snap["removed"]["title"][:200],
                                                    "moved_authorships": len(moved), "claims": len(claims)}))
    _refresh_people(users)
    return m


def getattr_snapshot(snap: dict[str, Any], name: str, parse: bool = False):
    v = snap["removed"].get(name)
    if parse and name == "date" and isinstance(v, str):
        from datetime import date

        return date.fromisoformat(v)
    return v


def _restore(model, fields: dict[str, Any]):
    obj = model()
    for f in model._meta.concrete_fields:
        if f.attname in fields:
            v = fields[f.attname]
            if v is not None and f.get_internal_type() in ("DateField", "DateTimeField") and isinstance(v, str):
                v = f.to_python(v)
            setattr(obj, f.attname, v)
    return obj


@transaction.atomic
def undo_merge(merge_id: str, actor: Optional[User]) -> PublicationMerge:
    m = PublicationMerge.objects.select_for_update().filter(pk=merge_id).first()
    if m is None:
        raise MergeError("No such merge")
    if m.undone_at:
        raise MergeError("This merge was already undone")
    snap = json.loads(m.snapshot_json)
    keep = Publication.objects.filter(pk=m.kept_id).first()
    if keep is None:
        raise MergeError("The kept record has been deleted since; the merge cannot be undone")
    if Publication.objects.filter(pk=m.removed_id).exists():
        raise MergeError("The removed record exists again")

    # The kept record's own fields first: it may hold the removed record's
    # OpenAlex id, which is unique.
    before = _restore(Publication, snap["kept_before"])
    for f in Publication._meta.concrete_fields:
        if f.attname not in ("id", "created_at", "updated_at"):
            setattr(keep, f.attname, getattr(before, f.attname))
    keep.save()
    removed = _restore(Publication, snap["removed"])
    removed.save(force_insert=True)
    Publication.objects.filter(pk=removed.pk).update(created_at=_restore(Publication, snap["removed"]).created_at)

    Authorship.objects.filter(pk__in=snap["moved_authorships"]).update(publication=removed)
    for fields in snap["repeated_authorships"]:
        _restore(Authorship, fields).save(force_insert=True)
    keep.claims.remove(*snap["claims_added"])
    keep.ledger_rows.remove(*snap["ledger_added"])
    removed.claims.add(*snap["claims"])
    removed.ledger_rows.add(*snap["ledger_rows"])
    FeedPost.objects.filter(pk__in=snap["posts"]).update(publication=removed)

    m.undone_at = timezone.now()
    m.save(update_fields=["undone_at"])
    AuditLog.objects.create(actor=actor, action="PUBLICATION_MERGE_UNDONE", entity="Publication",
                            entity_id=m.kept_id, detail_json=json.dumps({"merge": m.pk, "restored": m.removed_id}))
    users = set(Authorship.objects.filter(publication__in=[keep, removed], user__isnull=False)
                .values_list("user_id", flat=True))
    _refresh_people(users)
    return m


# --------------------------------------------------------- roster names --


@dataclass
class _Evidence:
    spelling: Counter = field(default_factory=Counter)
    samples: Counter = field(default_factory=Counter)


def _close(a: str, b: str) -> bool:
    """One letter apart, or one letter missing ("Bhuaneswari"/"Bhuvaneswari");
    for long names also two apart."""
    if a == b or a[0] != b[0]:
        return False
    if _one_edit(a, b):
        return True
    return min(len(a), len(b)) >= 8 and _edit_distance(a, b, 2) <= 2


def _edit_distance(a: str, b: str, cap: int) -> int:
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def _replace_token(name: str, old: str, new: str) -> str:
    def sub(m: re.Match) -> str:
        w = m.group(0)
        if w.lower() != old:
            return w
        if w.isupper():
            return new.upper()
        return new.capitalize() if w[:1].isupper() else new
    return re.sub(r"[A-Za-z]+", sub, name)


def roster_name_suggestions(min_papers: int = 2) -> list[dict[str, Any]]:
    """Roster names whose spelling of a name word differs from how the same
    person's papers spell it.

    Evidence is every college authorship -- matched to the person or still
    unmatched -- whose name agrees with the roster name except for that one
    word spelt a letter or two apart. Rows that carry the roster spelling
    exactly (copied from the person's own claims) are not evidence either way.
    A suggestion needs `min_papers` papers and more papers on the other
    spelling than on the roster's. Never applied here.
    """
    people = list(User.objects.filter(active=True).exclude(name="").only("id", "name", "department"))
    # Index college author names by (first letter) for close-token lookup.
    names: Counter = Counter()
    owner: dict[str, Counter] = defaultdict(Counter)
    for display, uid in Authorship.objects.filter(Q(is_college=True) | Q(user__isnull=False)).values_list(
            "display_name", "user_id").iterator():
        names[display] += 1
        owner[display][uid] += 1
    tokens: dict[str, set[str]] = defaultdict(set)  # token -> display names
    for display in names:
        for t in name_parts(display)[0]:
            tokens[t].add(display)
    by_first: dict[str, list[str]] = defaultdict(list)
    for t in tokens:
        by_first[t[0]].append(t)

    out = []
    for u in people:
        full, initials = name_parts(u.name)
        if not full:
            continue
        best = None
        for t in full:
            for s in by_first.get(t[0], ()):
                if not _close(t, s):
                    continue
                suggested = _replace_token(u.name, t, s)
                want_full = sorted(s if x == t else x for x in full)
                support, samples = 0, Counter()
                for display in tokens[s]:
                    mine = owner[display].get(u.pk, 0)
                    other_owners = {k for k in owner[display] if k and k != u.pk}
                    if other_owners and not mine:
                        continue  # someone else's paper
                    d_full, d_init = name_parts(display)
                    # Every name word the same once the one word is re-spelt,
                    # and the initials the same: "G. Bhuvaneswari" for
                    # "Dr. G. Bhuaneswari", never "R. Ramesh" for "C. Rajesh".
                    if sorted(d_full) != want_full:
                        continue
                    if sorted(d_init) != sorted(initials) and not (mine and (not d_init or not initials)):
                        continue
                    n = mine + owner[display].get(None, 0)
                    support += n
                    samples[display] += n
                if support < min_papers:
                    continue
                roster_support = sum(owner[d].get(u.pk, 0) for d in tokens[t]
                                     if name_parts(d)[0] != full)  # an exact copy is not evidence
                if support <= roster_support:
                    continue
                cand = {"user_id": u.pk, "name": u.name, "department": u.department, "suggested": suggested,
                        "word": t, "spelt": s, "papers": support, "roster_spelling_papers": roster_support,
                        "unmatched_papers": sum(owner[d].get(None, 0) for d in samples),
                        "samples": [d for d, _ in samples.most_common(4)]}
                if best is None or cand["papers"] > best["papers"]:
                    best = cand
        if best:
            out.append(best)
    ignored = set((SystemSetting.objects.filter(key="roster_names_dismissed").values_list("value", flat=True).first()) or [])
    out = [r for r in out if f"{r['user_id']}:{r['suggested']}" not in ignored]
    out.sort(key=lambda r: -r["papers"])
    return out


def dismiss_roster_suggestion(user_id: str, suggested: str, actor: Optional[User]) -> None:
    row = SystemSetting.objects.filter(key="roster_names_dismissed").first()
    keys = set(row.value or []) if row else set()
    keys.add(f"{user_id}:{suggested}")
    SystemSetting.objects.update_or_create(key="roster_names_dismissed", defaults={"value": sorted(keys)})
    AuditLog.objects.create(actor=actor, action="ROSTER_NAME_SUGGESTION_DISMISSED", entity="User",
                            entity_id=user_id, detail_json=json.dumps({"suggested": suggested}))


def apply_roster_name(user_id: str, name: str, actor: Optional[User]) -> User:
    """A super admin accepted a suggestion (or typed their own)."""
    u = User.objects.get(pk=user_id)
    old = u.name
    name = name.strip()
    if not name:
        raise ValueError("A name is required")
    u.name = name
    u.save(update_fields=["name"])
    AuditLog.objects.create(actor=actor, action="ROSTER_NAME_CORRECTED", entity="User", entity_id=user_id,
                            detail_json=json.dumps({"from": old, "to": name}))
    return u
