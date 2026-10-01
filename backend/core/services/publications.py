"""The college's full publication record, harvested from OpenAlex.

**Where the college is in OpenAlex.** Nowhere as an institution. OpenAlex
has no record for Saveetha Engineering College: ``institutions?search=Saveetha
Engineering`` returns nothing, and every SEC paper is filed under
*Saveetha University* (``I85461943``, ROR 0034me914 -- which is SIMATS, a
different institution). Filtering on that id would harvest ~63,000 SIMATS
papers. So the harvest asks for works whose *raw affiliation text* names the
college::

    works?filter=raw_affiliation_strings.search:"Saveetha Engineering College"

(~5,100 works in September 2026) and then decides, author by author, whether
*that author's* raw affiliation names the college (`is_college`). A SIMATS
co-author on the same paper stays outside.

**What else is harvested.** Works by each member's ORCID (OpenAlex filters
on ``authorships.author.orcid``); every DOI the college's claims and ledger
rows carry that the harvest did not already bring in; and, once authors are
matched, every work of each matched OpenAlex author (their papers from before
they joined). OpenAlex does not index Scopus author ids (``authors?filter=
scopus:`` returns nothing), so a Scopus id is used only through the Scopus
profile workbook (core.services.scopus_profile).

**Budget.** Pages of 200, cursor paging, `select=` to the fields used, at most
~8 requests a second, one page in memory at a time -- the free Render
instance has 512 MB. Idempotent: running it twice changes nothing the second
time except citation counts.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import date
from typing import Any, Callable, Iterable, Iterator

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core.models import (
    Authorship,
    Claim,
    ClaimStatus,
    PaidLedger,
    Publication,
    PublicationMetrics,
    User,
)
from core.services.author_names import departments_in, name_key, name_parts, name_score
from core.services.normalize import clean_venue, normalize_doi, normalize_title

logger = logging.getLogger(__name__)

OPENALEX = "https://api.openalex.org"
#: Documented here because nothing else in OpenAlex identifies the college.
COLLEGE_FILTER = 'raw_affiliation_strings.search:"Saveetha Engineering College"'
#: The institution OpenAlex files SEC papers under -- and SIMATS papers too.
#: Recorded, never used as a filter.
OPENALEX_SAVEETHA_UNIVERSITY = "I85461943"
COLLEGE_RE = re.compile(r"saveetha\s+eng(?:ineering|ineering|g)?\.?\s+coll", re.I)

WORK_FIELDS = (
    "id,doi,title,publication_year,publication_date,type,cited_by_count,"
    "open_access,primary_location,authorships,topics"
)
PAGE = 200
BATCH = 50
MIN_INTERVAL = 0.125  # 8 requests a second, under OpenAlex's 10

NOT_COUNTED = (ClaimStatus.DRAFT, ClaimStatus.REJECTED)
QUARTILES = {"Q1", "Q2", "Q3", "Q4"}

Fetch = Callable[[str, dict[str, Any]], dict[str, Any]]

# --------------------------------------------------------------------------- HTTP

_last_call = [0.0]
_lock = threading.Lock()


def _params(extra: dict[str, Any]) -> dict[str, Any]:
    from core.services.search import upstream

    params = dict(extra)
    params["mailto"] = upstream.contact()
    key = getattr(settings, "OPENALEX_API_KEY", "")
    if key:
        params["api_key"] = key
    return params


def openalex_get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    """One throttled GET against OpenAlex, retried with growing waits.

    A harvest makes thousands of calls, and OpenAlex answers a burst with 429
    for a while rather than for a second -- three quick retries lost most of
    a local run to one of those. Six tries waiting 5, 10, 20, 40, 60 s ride
    it out; anything longer is a daily limit, and the harvest (an idempotent
    upsert) is simply run again the next day.
    """
    from core.services.search import upstream

    tries = 6
    for attempt in range(tries):
        with _lock:
            wait = MIN_INTERVAL - (time.monotonic() - _last_call[0])
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.monotonic()
        try:
            return upstream.get_json(f"{OPENALEX}/{path}", _params(params), read_timeout=30.0) or {}
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(min(60, 5 * 2 ** attempt))
    return {}


def iter_works(filter_: str, *, fetch: Fetch = openalex_get, limit: int | None = None) -> Iterator[dict]:
    """Every work matching `filter_`, one page (200) held at a time."""
    cursor = "*"
    seen = 0
    while cursor:
        payload = fetch("works", {"filter": filter_, "per_page": PAGE, "cursor": cursor, "select": WORK_FIELDS})
        results = payload.get("results") or []
        for work in results:
            yield work
            seen += 1
            if limit is not None and seen >= limit:
                return
        cursor = (payload.get("meta") or {}).get("next_cursor")
        if not results:
            return


# --------------------------------------------------------------------------- upsert

def short_id(value: str | None) -> str:
    return (value or "").rstrip("/").rsplit("/", 1)[-1]


def _orcid(value: str | None) -> str:
    return short_id(value) if value else ""


def is_college_affiliation(text: str | None) -> bool:
    return bool(COLLEGE_RE.search(text or ""))


def _date(value: str | None) -> date | None:
    try:
        return date.fromisoformat((value or "")[:10])
    except ValueError:
        return None


def _author_key(openalex_author_id: str, name: str) -> str:
    return openalex_author_id or f"n:{name_key(name)}"[:160]


def _authorship_rows(work: dict) -> list[dict]:
    rows = []
    for index, a in enumerate(work.get("authorships") or [], start=1):
        author = a.get("author") or {}
        name = (author.get("display_name") or a.get("raw_author_name") or "").strip()[:255]
        if not name:
            continue
        raw = "; ".join(a.get("raw_affiliation_strings") or [])
        institutions = a.get("institutions") or []
        college = is_college_affiliation(raw)
        inst = institutions[0] if institutions else {}
        inst_name = "Saveetha Engineering College" if college else (inst.get("display_name") or "")
        oa_author = short_id(author.get("id"))
        rows.append({
            "position": index,
            "display_name": name,
            "raw_affiliation": raw,
            "openalex_author_id": oa_author,
            "orcid": _orcid(author.get("orcid")),
            "institution_name": inst_name[:255],
            "institution_country": (inst.get("country_code") or (a.get("countries") or [""])[0] or "")[:8],
            "author_key": _author_key(oa_author, name),
            "is_college": college,
            "is_corresponding": bool(a.get("is_corresponding")),
        })
    return rows


def _find_publication(oa_id: str, doi: str | None, title_key: str, year: int | None) -> Publication | None:
    pub = Publication.objects.filter(openalex_id=oa_id).first()
    if pub:
        return pub
    if doi:
        pub = Publication.objects.filter(doi=doi).filter(Q(openalex_id__isnull=True) | Q(openalex_id="")).first()
        if pub:
            return pub
    if title_key and len(title_key) > 20:
        return (
            Publication.objects.filter(normalized_title=title_key[:512], openalex_id__isnull=True)
            .filter(Q(year=year) | Q(year__isnull=True))
            .first()
        )
    return None


def upsert_work(work: dict) -> tuple[Publication, bool]:
    """Write one OpenAlex work and its authors. Returns (publication, created)."""
    oa_id = short_id(work.get("id"))
    doi = normalize_doi(work.get("doi"))
    title = " ".join((work.get("title") or "").split())
    title_key = normalize_title(title)
    location = work.get("primary_location") or {}
    source = location.get("source") or {}
    oa = work.get("open_access") or {}
    topics = [t.get("display_name") for t in (work.get("topics") or [])[:5] if t.get("display_name")]
    fields = {
        "openalex_id": oa_id,
        "doi": doi,
        "title": title,
        "normalized_title": title_key[:512],
        "year": work.get("publication_year"),
        "date": _date(work.get("publication_date")),
        "venue": clean_venue(source.get("display_name") or location.get("raw_source_name"))[:512],
        "issn": (source.get("issn_l") or ",".join(source.get("issn") or []))[:64],
        "type": (work.get("type") or "")[:64],
        "citations": int(work.get("cited_by_count") or 0),
        "citations_refreshed_at": timezone.now(),
        "oa_url": oa.get("oa_url") or "",
        "topics_json": json.dumps(topics),
        "source": "openalex",
    }
    with transaction.atomic():
        pub = _find_publication(oa_id, doi, title_key, fields["year"])
        created = pub is None
        if created:
            pub = Publication(**fields)
            pub.save()
        else:
            for k, v in fields.items():
                setattr(pub, k, v)
            pub.save()
        _sync_authorships(pub, _authorship_rows(work), fresh=created)
    return pub, created


_KEEP = ("user_id", "match_confidence", "match_method", "match_locked")


def _sync_authorships(pub: Publication, rows: list[dict], *, fresh: bool) -> None:
    if fresh:
        Authorship.objects.bulk_create([Authorship(publication=pub, **r) for r in rows])
        return
    existing = list(pub.authorships.all())
    by_position = {a.position: a for a in existing if a.position is not None}
    loose = [a for a in existing if a.position is None]  # added from a record
    keep_ids = set()
    new = []
    for row in rows:
        old = by_position.get(row["position"])
        if old and (old.author_key == row["author_key"] or name_score(old.display_name, row["display_name"]) >= 0.85):
            for k, v in row.items():
                setattr(old, k, v)
            old.save()
            keep_ids.add(old.id)
        else:
            new.append(Authorship(publication=pub, **row))
    Authorship.objects.bulk_create(new)
    stale = [a.id for a in existing if a.position is not None and a.id not in keep_ids]
    if stale:
        Authorship.objects.filter(id__in=stale).delete()
    # A person a record put on this paper before OpenAlex knew it: move them
    # onto their OpenAlex row rather than keep them twice.
    if loose:
        rows_now = [a for a in pub.authorships.all() if a.position is not None]
        for extra in loose:
            if not extra.user_id:
                continue
            best = _best_row(rows_now, extra.display_name, require_free=True)
            if best:
                for k in _KEEP:
                    setattr(best, k, getattr(extra, k))
                best.is_college = True
                best.save()
                extra.delete()


def _best_row(rows: list[Authorship], name: str, *, require_free: bool, floor: float = 0.8) -> Authorship | None:
    scored = sorted(
        ((name_score(name, r.display_name), r) for r in rows if not (require_free and r.user_id)),
        key=lambda x: -x[0],
    )
    if not scored or scored[0][0] < floor:
        return None
    if len(scored) > 1 and scored[1][0] == scored[0][0]:
        return None
    return scored[0][1]


def harvest_filter(filter_: str, *, fetch: Fetch = openalex_get, limit: int | None = None) -> dict[str, int]:
    summary = {"works": 0, "created": 0}
    for work in iter_works(filter_, fetch=fetch, limit=limit):
        try:
            _, created = upsert_work(work)
        except Exception:
            logger.warning("could not store work %s", work.get("id"), exc_info=True)
            continue
        summary["works"] += 1
        summary["created"] += created
    return summary


def _or_batches(values: Iterable[str], size: int = BATCH) -> Iterator[list[str]]:
    batch: list[str] = []
    for v in values:
        if not v or "|" in v or "," in v:
            continue
        batch.append(v)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def harvest_college(*, since: int | None = None, limit: int | None = None, fetch: Fetch = openalex_get) -> dict:
    filter_ = COLLEGE_FILTER + (f",from_publication_date:{since}-01-01" if since else "")
    return harvest_filter(filter_, fetch=fetch, limit=limit)


def harvest_orcids(*, fetch: Fetch = openalex_get) -> dict:
    orcids = [o.strip() for o in User.objects.exclude(orcid_id__isnull=True).exclude(orcid_id="").values_list("orcid_id", flat=True)]
    total = {"works": 0, "created": 0, "orcids": len(orcids)}
    for batch in _or_batches(orcids):
        got = harvest_filter("authorships.author.orcid:" + "|".join(batch), fetch=fetch)
        total["works"] += got["works"]
        total["created"] += got["created"]
    return total


#: An OpenAlex author with more works than this is probably several people
#: merged under one common name; their works are not pulled in wholesale.
MAX_AUTHOR_WORKS = 300


def harvest_author_ids(author_ids: Iterable[str], *, fetch: Fetch = openalex_get) -> dict:
    ids = sorted(set(a for a in author_ids if a))
    sizes: dict[str, int] = {}
    for batch in _or_batches(ids):
        payload = fetch("authors", {"filter": "openalex:" + "|".join(batch), "per_page": BATCH,
                                    "select": "id,works_count"})
        for a in payload.get("results") or []:
            sizes[short_id(a.get("id"))] = int(a.get("works_count") or 0)
    too_big = {a for a in ids if sizes.get(a, 0) > MAX_AUTHOR_WORKS}
    ids = [a for a in ids if a not in too_big]
    total = {"works": 0, "created": 0, "authors": len(ids), "skipped_merged_profiles": len(too_big)}
    for batch in _or_batches(ids):
        got = harvest_filter("authorships.author.id:" + "|".join(batch), fetch=fetch)
        total["works"] += got["works"]
        total["created"] += got["created"]
    return total


# --------------------------------------------------------------------------- records

BLANK = {"", "-", "na", "n/a", "nil", "none", "nan", "0"}


def _cell(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    return "" if text.lower() in BLANK else text


def _eid(value: Any) -> str:
    text = _cell(value)
    return text if text.startswith("2-s2.0-") else ""


def _year(value: Any) -> int | None:
    m = re.search(r"(19|20)\d\d", _cell(value))
    return int(m.group(0)) if m else None


def college_records() -> Iterator[dict]:
    """Every paper the college's own records name, with whose it is.

    Filed claims (not drafts or rejections), and ledger rows -- credited to
    the account with the row's staff id, the rule the payments page uses.
    """
    for c in (
        Claim.objects.exclude(status__in=NOT_COUNTED)
        .select_related("owner")
        .only("id", "owner", "doi", "eid", "paper_title", "journal_title", "issn", "publication_year",
              "publication_type", "quartile")
    ):
        yield {
            "claim_id": c.id, "ledger_id": None, "user": c.owner,
            "doi": normalize_doi(c.doi), "eid": _eid(c.eid), "title": c.paper_title or "",
            "venue": c.journal_title or "", "issn": c.issn or "", "year": c.publication_year,
            "type": c.publication_type or "", "quartile": (c.quartile or "").upper(),
        }
    staff = {}
    for u in User.objects.exclude(staff_id__isnull=True).exclude(staff_id=""):
        staff.setdefault(u.staff_id.strip().lower(), u)
    for row in PaidLedger.objects.only("id", "claim_id", "staff_id", "paper_title", "journal_title", "raw_json").iterator(chunk_size=500):
        try:
            raw = json.loads(row.raw_json or "{}")
        except ValueError:
            raw = {}
        user = staff.get((row.staff_id or "").strip().lower())
        yield {
            "claim_id": row.claim_id, "ledger_id": row.id, "user": user,
            "doi": normalize_doi(_cell(raw.get("DOI"))), "eid": _eid(raw.get("Scopus EID")),
            "title": _cell(raw.get("Scopus Article Title")) or row.paper_title or "",
            "venue": _cell(raw.get("Source Title")) or row.journal_title or "",
            "issn": _cell(raw.get("ISSN")), "year": _year(raw.get("Publication Date")),
            "type": _cell(raw.get("Document Type")),
            "quartile": _cell(raw.get("SJR Quartile")).upper()[:2],
        }


def uncovered_record_dois() -> list[str]:
    have = set(Publication.objects.exclude(doi__isnull=True).values_list("doi", flat=True))
    want = {r["doi"] for r in college_records() if r["doi"] and r["doi"].startswith("10.")}
    return sorted(want - have)


def harvest_record_dois(*, fetch: Fetch = openalex_get) -> dict:
    dois = uncovered_record_dois()
    total = {"dois": len(dois), "works": 0, "created": 0}
    for batch in _or_batches(dois):
        got = harvest_filter("doi:" + "|".join(batch), fetch=fetch)
        total["works"] += got["works"]
        total["created"] += got["created"]
    return total


class _Index:
    """Publications by DOI, EID and title, so linking is lookups not scans."""

    def __init__(self) -> None:
        self.doi: dict[str, str] = {}
        self.eid: dict[str, str] = {}
        self.title: dict[str, str] = {}
        for pid, doi, eid, title in Publication.objects.values_list("id", "doi", "eid", "normalized_title"):
            self.add(pid, doi, eid, title)

    def add(self, pid: str, doi: str | None, eid: str | None, title: str | None) -> None:
        if doi:
            self.doi.setdefault(doi, pid)
        if eid:
            self.eid.setdefault(eid, pid)
        if title and len(title) > 20:
            self.title.setdefault(title, pid)

    def find(self, doi: str | None, eid: str | None, title: str) -> str | None:
        return (doi and self.doi.get(doi)) or (eid and self.eid.get(eid)) or (title and self.title.get(title)) or None


def ensure_user_authorship(pub: Publication, user: User, *, method: str, confidence: float) -> Authorship:
    """Put `user` on `pub`: on their own author row when one is recognisably
    theirs, else as an extra row. Never twice."""
    rows = list(pub.authorships.all())
    mine = [r for r in rows if r.user_id == user.id]
    if mine:
        row = mine[0]
        if not row.match_locked and row.match_confidence < confidence:
            row.match_confidence, row.match_method = confidence, method
            row.is_college = True
            row.save(update_fields=["match_confidence", "match_method", "is_college"])
        return row
    best = _best_row([r for r in rows if not r.match_locked], user.name, require_free=False)
    if best and (not best.user_id or best.match_confidence < confidence):
        best.user = user
        best.match_confidence, best.match_method, best.is_college = confidence, method, True
        best.save(update_fields=["user", "match_confidence", "match_method", "is_college"])
        return best
    return Authorship.objects.create(
        publication=pub, position=None, display_name=user.name[:255],
        author_key=_author_key("", user.name), is_college=True,
        institution_name="Saveetha Engineering College", institution_country="IN",
        user=user, match_confidence=confidence, match_method=method,
    )


def link_records() -> dict[str, int]:
    """Tie every claim and ledger row to its Publication (creating one for a
    paper OpenAlex does not know) and put its owner on it."""
    index = _Index()
    summary = {"records": 0, "linked": 0, "created": 0, "no_owner": 0}
    ClaimLink = Publication.claims.through
    LedgerLink = Publication.ledger_rows.through
    claim_links, ledger_links = [], []
    for rec in college_records():
        summary["records"] += 1
        title_key = normalize_title(rec["title"])[:512]
        pid = index.find(rec["doi"], rec["eid"], title_key)
        if pid is None:
            if not (rec["doi"] or rec["eid"] or title_key):
                continue
            pub = Publication.objects.create(
                doi=rec["doi"], eid=rec["eid"] or None, title=" ".join(rec["title"].split()),
                normalized_title=title_key, year=rec["year"], venue=clean_venue(rec["venue"])[:512],
                issn=rec["issn"][:64], type=rec["type"][:64], source="record",
                quartile=rec["quartile"] if rec["quartile"] in QUARTILES else "",
            )
            index.add(pub.id, pub.doi, pub.eid, title_key)
            pid = pub.id
            summary["created"] += 1
        pub = Publication.objects.get(id=pid)
        changed = []
        if rec["eid"] and not pub.eid:
            pub.eid = rec["eid"]
            changed.append("eid")
        if rec["quartile"] in QUARTILES and not pub.quartile:
            pub.quartile = rec["quartile"]
            changed.append("quartile")
        if changed:
            pub.save(update_fields=changed)
        if rec["claim_id"]:
            claim_links.append(ClaimLink(publication_id=pid, claim_id=rec["claim_id"]))
        if rec["ledger_id"]:
            ledger_links.append(LedgerLink(publication_id=pid, paidledger_id=rec["ledger_id"]))
        if rec["user"] is None:
            summary["no_owner"] += 1
            continue
        ensure_user_authorship(pub, rec["user"], method="record", confidence=0.95)
        summary["linked"] += 1
    ClaimLink.objects.bulk_create(claim_links, ignore_conflicts=True, batch_size=500)
    LedgerLink.objects.bulk_create(ledger_links, ignore_conflicts=True, batch_size=500)
    return summary


# --------------------------------------------------------------------------- matching

#: Evidence that survives a re-match: somebody's record or a person said so.
ANCHORED = ("record", "scopus_sheet", "scopus", "scopus_id", "manual")
INFERRED = ("orcid", "alias", "author_id", "name", "name_dept")


def _people() -> list[User]:
    return list(User.objects.filter(active=True).only("id", "name", "department", "orcid_id", "scopus_synced_at"))


class _NameIndex:
    def __init__(self, people: list[User]) -> None:
        self.by_token: dict[str, list[User]] = {}
        for u in people:
            full, _ = name_parts(u.name)
            # "Kamaladevi" on the roster, "Kamala Devi" on a paper: index the
            # run-together form too, and look the paper's up the same way.
            for t in set(full) | {"".join(full)}:
                self.by_token.setdefault(t, []).append(u)

    def candidates(self, name: str) -> list[tuple[float, User]]:
        full, _ = name_parts(name)
        seen: dict[str, User] = {}
        for t in set(full) | {"".join(full)}:
            for u in self.by_token.get(t, ()):
                seen[u.id] = u
        scored = [(name_score(name, u.name), u) for u in seen.values()]
        return sorted([s for s in scored if s[0] >= 0.85], key=lambda s: -s[0])


def _choose(cands: list[tuple[float, User]], affiliation: str) -> tuple[User | None, str, float]:
    if not cands:
        return None, "", 0.0
    top = cands[0][0]
    best = [u for s, u in cands if s == top]
    if len(best) == 1:
        return best[0], "name", round(0.8 * top, 2)
    depts = departments_in(affiliation)
    in_dept = [u for u in best if (u.department or "") in depts]
    if len(in_dept) == 1:
        return in_dept[0], "name_dept", round(0.7 * top, 2)
    return None, "", 0.0


SELF_FLOOR = 0.85


def is_own_variant(user_name: str, display_name: str) -> bool:
    """An unlinked author row on a paper `user` is already on, whose name is
    theirs ("R. Subhashini" beside Dr. R. Subhashini): the same person, not a
    co-author."""
    return name_score(user_name, display_name) >= SELF_FLOOR


def _absorb_own_variants(by_id: dict[str, User]) -> int:
    """A paper that already has a member on it through a record (a loose row
    with no author position) and an unlinked OpenAlex row carrying that
    member's name: the OpenAlex row *is* them. Move them onto it and drop the
    loose row, so they are neither on the paper twice nor their own
    co-author. Only when exactly one member on the paper fits the name."""
    on_paper: dict[str, list[Authorship]] = {}
    for row in Authorship.objects.filter(user__isnull=False).only(
        "id", "publication_id", "user_id", "position", "match_confidence", "match_method", "match_locked"
    ):
        on_paper.setdefault(row.publication_id, []).append(row)
    moved = 0
    free = Authorship.objects.filter(
        user__isnull=True, match_locked=False, publication_id__in=list(on_paper)
    ).only("id", "publication_id", "display_name", "position")
    for row in free:
        linked = on_paper.get(row.publication_id) or []
        fits = [a for a in linked if a.user_id in by_id and is_own_variant(by_id[a.user_id].name, row.display_name)]
        if len({a.user_id for a in fits}) != 1:
            continue
        loose = [a for a in fits if a.position is None and not a.match_locked]
        if row.position is None or not loose or any(a.position is not None for a in fits):
            continue
        keep = loose[0]
        Authorship.objects.filter(id=row.id).update(
            user_id=keep.user_id, match_confidence=keep.match_confidence,
            match_method=keep.match_method, is_college=True,
        )
        Authorship.objects.filter(id=keep.id).delete()
        linked.remove(keep)
        linked.append(Authorship(id=row.id, publication_id=row.publication_id, user_id=keep.user_id,
                                 position=row.position))
        moved += 1
    return moved


def match_authors() -> dict[str, Any]:
    """Match authorships to college members, most certain evidence first.

    1. ORCID -- the member's ORCID on the author (1.0).
    2. Records -- a claim or ledger row put them on the paper (0.95, kept
       from link_records; never cleared here).
    3. OpenAlex author id -- an author id already matched to exactly one
       member is theirs on every other paper too, if the name agrees (0.9).
    4. Name -- a college-affiliated author whose name matches exactly one
       member best (0.8 x score), department breaking a tie (0.7 x score).
       Anything still tied is left unmatched and listed.
    """
    people = _people()
    names = _NameIndex(people)
    by_id = {u.id: u for u in people}
    with transaction.atomic():
        Authorship.objects.filter(match_locked=False, match_method__in=INFERRED).update(
            user=None, match_confidence=0, match_method=""
        )
        # 1. ORCID
        orcid_of = {u.orcid_id.strip(): u for u in people if u.orcid_id}
        for row in Authorship.objects.filter(user__isnull=True, match_locked=False).exclude(orcid="").only("id", "orcid"):
            u = orcid_of.get(row.orcid)
            if u:
                Authorship.objects.filter(id=row.id).update(user=u, match_confidence=1.0, match_method="orcid")

        # 1b. Names the office has already said belong to somebody
        # (core.services.author_review); survives every re-harvest.
        from core.models import AuthorAlias

        alias_of = {}
        for k, uid in AuthorAlias.objects.filter(status=AuthorAlias.MATCHED, user__isnull=False).values_list(
            "name_key", "user_id"
        ):
            if uid in by_id:
                alias_of[k] = by_id[uid]
        if alias_of:
            for row in Authorship.objects.filter(user__isnull=True, is_college=True, match_locked=False).only(
                "id", "display_name"
            ):
                u = alias_of.get(name_key(row.display_name))
                if u:
                    Authorship.objects.filter(id=row.id).update(user=u, match_confidence=0.9, match_method="alias")

        #: Evidence strong enough to carry an OpenAlex author id onto papers
        #: outside the college. OpenAlex merges namesakes ("R. Subhashini" at
        #: TNAU and at SEC under one id), so a name-only match may label only
        #: college rows, and a member whose Scopus list has been synced keeps
        #: only the outside papers Scopus confirms.
        strong_methods = ("orcid", "record", "scopus", "scopus_id", "scopus_sheet", "manual", "alias")
        scopus_pubs: dict[str, set[str]] = {}
        for pid, uid in Authorship.objects.filter(match_method="scopus", user__isnull=False).values_list(
            "publication_id", "user_id"
        ):
            scopus_pubs.setdefault(uid, set()).add(pid)

        def propagate() -> int:
            owners: dict[str, set[str]] = {}
            strong: dict[str, set[str]] = {}
            for aid, uid, method in (
                Authorship.objects.filter(user__isnull=False, match_confidence__gte=0.75)
                .exclude(openalex_author_id="").values_list("openalex_author_id", "user_id", "match_method")
            ):
                owners.setdefault(aid, set()).add(uid)
                if method in strong_methods:
                    strong.setdefault(aid, set()).add(uid)
            done = 0
            for row in (
                Authorship.objects.filter(user__isnull=True, match_locked=False, openalex_author_id__in=list(owners))
                .only("id", "openalex_author_id", "display_name", "is_college", "publication_id")
            ):
                uids = owners[row.openalex_author_id] if row.is_college else strong.get(row.openalex_author_id, set())
                if len(uids) != 1 or len(owners[row.openalex_author_id]) != 1:
                    continue
                u = by_id.get(next(iter(uids)))
                if not u or name_score(row.display_name, u.name) < 0.85:
                    continue
                if not row.is_college and u.scopus_synced_at and row.publication_id not in scopus_pubs.get(u.id, ()):
                    continue
                Authorship.objects.filter(id=row.id).update(user=u, match_confidence=0.9, match_method="author_id")
                done += 1
            return done

        propagated = propagate()
        # 4. names
        ambiguous: list[dict] = []
        for row in (
            Authorship.objects.filter(user__isnull=True, is_college=True, match_locked=False)
            .only("id", "display_name", "raw_affiliation", "publication_id")
        ):
            cands = names.candidates(row.display_name)
            u, method, conf = _choose(cands, row.raw_affiliation)
            if u:
                Authorship.objects.filter(id=row.id).update(user=u, match_confidence=conf, match_method=method)
            elif cands:
                ambiguous.append({"name": row.display_name, "publication_id": row.publication_id,
                                  "candidates": [c.name for _, c in cands[:5]]})
        propagated += propagate()
        absorbed = _absorb_own_variants(by_id)
        # One person once per paper: keep their most certain row.
        dupes = 0
        seen: set[tuple[str, str]] = set()
        for row in (
            Authorship.objects.filter(user__isnull=False, match_locked=False)
            .order_by("publication_id", "user_id", "-match_confidence")
            .only("id", "publication_id", "user_id")
        ):
            key = (row.publication_id, row.user_id)
            if key in seen:
                Authorship.objects.filter(id=row.id).update(user=None, match_confidence=0, match_method="")
                dupes += 1
            seen.add(key)
    college = Authorship.objects.filter(is_college=True)
    return {
        "college_authorships": college.count(),
        "college_matched": college.filter(user__isnull=False).count(),
        "college_unmatched": college.filter(user__isnull=True).count(),
        "propagated": propagated,
        "own_variants_absorbed": absorbed,
        "ambiguous": ambiguous,
        "duplicates_cleared": dupes,
        "users_with_publications": Authorship.objects.filter(user__isnull=False).values("user_id").distinct().count(),
    }


def link_by_scopus_ids(*, fetch: Fetch = openalex_get) -> dict[str, int]:
    """OpenAlex author profiles that carry a member's Scopus author id
    (`ids.scopus`) are that member, on every paper (0.97, `scopus_id`).

    Asks OpenAlex about the author ids on college rows and on rows already
    matched -- 50 a request. Never overrides a locked or record/manual row."""
    from core.services.scopus_profiles import normalize_scopus_id

    by_sid: dict[str, User] = {}
    for u in User.objects.filter(active=True).exclude(scopus_author_id__isnull=True).exclude(scopus_author_id=""):
        sid = normalize_scopus_id(u.scopus_author_id)
        if sid:
            by_sid.setdefault(sid, u)
    summary = {"scopus_ids": len(by_sid), "authors_checked": 0, "authors_linked": 0, "rows_linked": 0}
    if not by_sid:
        return summary
    ids = set(
        Authorship.objects.filter(Q(is_college=True) | Q(user__isnull=False))
        .exclude(openalex_author_id="").values_list("openalex_author_id", flat=True)
    )
    for batch in _or_batches(sorted(ids)):
        payload = fetch("authors", {"filter": "openalex:" + "|".join(batch), "per_page": BATCH, "select": "id,ids"})
        for a in payload.get("results") or []:
            summary["authors_checked"] += 1
            sid = normalize_scopus_id((a.get("ids") or {}).get("scopus"))
            u = by_sid.get(sid or "")
            if not u:
                continue
            summary["authors_linked"] += 1
            summary["rows_linked"] += (
                Authorship.objects.filter(openalex_author_id=short_id(a.get("id")), match_locked=False)
                .exclude(match_method__in=("record", "manual", "scopus_sheet", "scopus"))
                .update(user=u, match_confidence=0.97, match_method="scopus_id", is_college=True)
            )
    return summary


def matched_author_ids(min_confidence: float = 0.8) -> set[str]:
    return set(
        Authorship.objects.filter(user__isnull=False, match_confidence__gte=min_confidence)
        .exclude(openalex_author_id="").values_list("openalex_author_id", flat=True)
    )


# --------------------------------------------------------------------------- metrics

def h_index(citations: list[int]) -> int:
    ordered = sorted(citations, reverse=True)
    return sum(1 for i, c in enumerate(ordered, start=1) if c >= i)


def metrics_for(user_id: str) -> dict[str, Any]:
    rows = list(
        Publication.objects.filter(authorships__user_id=user_id).distinct().values_list("citations", "year")
    )
    cites = [c or 0 for c, _ in rows]
    years = [y for _, y in rows if y]
    return {
        "total_publications": len(rows),
        "total_citations": sum(cites),
        "h_index": h_index(cites),
        "i10_index": sum(1 for c in cites if c >= 10),
        "first_year": min(years) if years else None,
        "last_year": max(years) if years else None,
    }


def refresh_metrics() -> int:
    now = timezone.now()
    users = set(Authorship.objects.filter(user__isnull=False).values_list("user_id", flat=True))
    PublicationMetrics.objects.exclude(user_id__in=users).delete()
    for uid in users:
        PublicationMetrics.objects.update_or_create(user_id=uid, defaults={**metrics_for(uid), "computed_at": now})
    return len(users)


# --------------------------------------------------------------------------- citations

def refresh_citations(*, fetch: Fetch = openalex_get, limit: int | None = None) -> dict[str, int]:
    """Weekly: cited_by_count for every harvested paper, oldest check first,
    50 ids a request; then everybody's metrics again."""
    due = Publication.objects.exclude(openalex_id__isnull=True).exclude(openalex_id="").order_by(
        "citations_refreshed_at", "id"
    )
    if limit is not None:
        due = due[:limit]
    ids = list(due.values_list("openalex_id", flat=True))
    summary = {"checked": 0, "changed": 0, "failed_batches": 0}
    now = timezone.now()
    for batch in _or_batches(ids):
        try:
            payload = fetch("works", {"filter": "openalex:" + "|".join(batch), "per_page": BATCH,
                                      "select": "id,cited_by_count"})
        except Exception:
            logger.warning("citation refresh batch failed", exc_info=True)
            summary["failed_batches"] += 1
            continue
        counts = {short_id(w.get("id")): int(w.get("cited_by_count") or 0) for w in payload.get("results") or []}
        for oa_id in batch:
            summary["checked"] += 1
            if oa_id in counts:
                summary["changed"] += Publication.objects.filter(openalex_id=oa_id).exclude(
                    citations=counts[oa_id]).update(citations=counts[oa_id])
        Publication.objects.filter(openalex_id__in=batch).update(citations_refreshed_at=now)
    summary["people"] = refresh_metrics()
    return summary


# --------------------------------------------------------------------------- the whole run

def run_harvest(
    *, since: int | None = None, limit: int | None = None, expand: bool = True,
    fetch: Fetch = openalex_get, log: Callable[[str], None] = logger.info,
) -> dict[str, Any]:
    """Harvest -> link records -> match -> harvest matched authors' other
    works -> match again -> metrics. Safe to repeat.

    Each OpenAlex stage is allowed to fail on its own. OpenAlex answers a long
    run with 429 once it has had enough for the day, and before this a refusal
    at paper 4,200 of 5,100 threw away the matching step -- so the 4,200 papers
    already stored were attributed to nobody. Now what was fetched is kept,
    linked and matched, `partial` says so, and running it again tomorrow
    (an idempotent upsert) fills in the rest.
    """
    out: dict[str, Any] = {"partial": False, "errors": {}}

    def fetch_stage(name: str, fn: Callable[[], Any]) -> Any:
        try:
            result = fn()
        except Exception as exc:  # the HTTP layer has already retried
            out["partial"] = True
            out["errors"][name] = str(exc)[:300]
            log(f"{name}: stopped early -- {exc}")
            return None
        log(f"{name}: {result}")
        return result

    out["college"] = fetch_stage("college", lambda: harvest_college(since=since, limit=limit, fetch=fetch))
    out["orcid"] = fetch_stage("orcid", lambda: harvest_orcids(fetch=fetch))
    out["record_dois"] = fetch_stage("record_dois", lambda: harvest_record_dois(fetch=fetch))
    out["records"] = link_records()
    log(f"records linked: {out['records']}")
    out["scopus_ids"] = fetch_stage("scopus_ids", lambda: link_by_scopus_ids(fetch=fetch))
    match = match_authors()
    if expand and not out["partial"]:
        out["authors"] = fetch_stage("authors", lambda: harvest_author_ids(matched_author_ids(), fetch=fetch))
        out["records_again"] = link_records()
        match = match_authors()
    out["match"] = {k: v for k, v in match.items() if k != "ambiguous"}
    out["ambiguous"] = len(match["ambiguous"])
    out["people"] = refresh_metrics()
    return out
