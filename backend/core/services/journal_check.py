"""Is this journal safe to send a paper to, and is it worth it?

One box takes a journal name, an ISSN or a website. The answer is built only
from what the college holds: the Scimago rows, the SNIP rows, the research
cell's watch-list, the discontinued and hijacked lists (`JournalFlagList`,
plus the dated `JournalStanding` rows), the college's own papers and claims,
and the payout formula. A list that has not been loaded is reported as
"unknown", never as "fine".
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any
from urllib.parse import urlparse

from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone

from core import hod
from core.models import (
    Authorship,
    Claim,
    ClaimStatus,
    JournalFlagList,
    JournalStanding,
    Publication,
    Role,
    ScimagoJournal,
)
from core.services import discover
from core.services.journal_watch import watch_for
from core.services.normalize import normalize_issn, normalize_title
from core.services.scimago import best_by_quartile, issn_variants

MAX_MATCHES = 5
ISSN_RE = re.compile(r"^\s*(\d{4})\s*-?\s*(\d{3}[\dXx])\s*$")
#: Positions the estimate is worked out for, on a paper with this many authors.
POSITIONS = (1, 2, 3)
ASSUMED_AUTHORS = 3


# --------------------------------------------------------------------------- #
# Reading the input                                                           #
# --------------------------------------------------------------------------- #


def kind_of(q: str) -> str:
    q = (q or "").strip()
    if ISSN_RE.match(q):
        return "issn"
    if re.match(r"^(https?://|www\.)", q, re.I) or (
        " " not in q and re.search(r"[a-z0-9-]+\.[a-z]{2,}(/|$)", q, re.I)
    ):
        return "url"
    return "name"


def domain_of(q: str) -> str:
    text = q.strip()
    if not re.match(r"^https?://", text, re.I):
        text = "http://" + text
    host = (urlparse(text).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def _same_domain(a: str, b: str) -> bool:
    a, b = domain_of(a), domain_of(b)
    return bool(a and b) and (a == b or a.endswith("." + b) or b.endswith("." + a))


def data_latest_year() -> int:
    return ScimagoJournal.objects.aggregate(y=Max("year"))["y"] or 2025


def _variants(issns: list[str]) -> list[str]:
    return list(dict.fromkeys(v for i in issns if i for v in issn_variants(i)))


def _row_issns(row: ScimagoJournal) -> list[str]:
    return [n for n in (normalize_issn(row.issn), normalize_issn(row.eissn)) if n]


def _latest_row(row: ScimagoJournal) -> ScimagoJournal:
    """The newest Scimago row for the same journal (by ISSN, else title)."""
    variants = _variants(_row_issns(row))
    qs = ScimagoJournal.objects.filter(Q(issn__in=variants) | Q(eissn__in=variants)) if variants else \
        ScimagoJournal.objects.filter(title__iexact=row.title)
    return qs.order_by("-year").first() or row


def _candidates(q: str, kind: str, latest: int) -> list[ScimagoJournal]:
    rows: list[ScimagoJournal] = []
    if kind == "issn":
        variants = _variants([q])
        rows = list(
            ScimagoJournal.objects.filter(Q(issn__in=variants) | Q(eissn__in=variants)).order_by("-year")[:20]
        )
    else:
        text = q
        if kind == "url":
            # No homepage is held for Scimago titles, so the domain is read as
            # words: "ieeeaccess.org" -> "ieeeaccess".
            text = domain_of(q).rsplit(".", 1)[0].replace(".", " ").replace("-", " ")
        exact = discover.find_journal(text, year=latest)
        if exact:
            rows.append(exact)
        words = [w for w in discover._tokens(text) if w not in discover._STOPWORDS] or discover._tokens(text)
        if words:
            cond = Q()
            for w in sorted(words, key=len, reverse=True)[:3]:
                cond &= Q(title__icontains=w)
            rows += list(ScimagoJournal.objects.filter(cond).order_by("-year", "-sjr")[:40])
            if not rows and len(words) > 1:
                cond = Q()
                for w in words[:4]:
                    cond |= Q(title__icontains=w)
                rows += list(ScimagoJournal.objects.filter(cond).order_by("-year", "-sjr")[:40])
        wanted = normalize_title(text)
        rows.sort(key=lambda r: (normalize_title(r.title) != wanted, -r.year, -(r.sjr or 0)))
    seen: set[str] = set()
    out: list[ScimagoJournal] = []
    for r in rows:
        key = normalize_title(r.title)
        if key in seen:
            continue
        seen.add(key)
        out.append(_latest_row(r))
        if len(out) >= MAX_MATCHES:
            break
    return out


# --------------------------------------------------------------------------- #
# Facts about one journal                                                     #
# --------------------------------------------------------------------------- #


def _publisher(row: ScimagoJournal) -> str | None:
    try:
        raw = json.loads(row.raw_json or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    for k in ("Publisher", "publisher"):
        if raw.get(k):
            return str(raw[k])
    return None


def _homepage(row: ScimagoJournal) -> str | None:
    try:
        raw = json.loads(row.raw_json or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    for k in ("homepage_url", "Homepage", "homepage", "url", "URL"):
        if raw.get(k):
            return str(raw[k])
    return None


def journal_facts(row: ScimagoJournal) -> dict[str, Any]:
    cats = [c for c in discover.categories_of(row) if isinstance(c, dict)]
    best = best_by_quartile(cats) if cats else {}
    return {
        "id": row.id,
        "name": row.title,
        "issns": _row_issns(row),
        "publisher": _publisher(row),
        "quartile": best.get("quartile"),
        "subject": best.get("category"),
        "sjr": row.sjr,
        "snip": discover.find_snip(row),
        "categories": [{"name": c.get("category"), "quartile": c.get("quartile")} for c in cats],
        "latest_year_in_data": row.year,
    }


def _match_dict(row: ScimagoJournal) -> dict[str, Any]:
    cats = [c for c in discover.categories_of(row) if isinstance(c, dict)]
    best = best_by_quartile(cats) if cats else {}
    return {
        "id": row.id,
        "name": row.title,
        "issns": _row_issns(row),
        "quartile": best.get("quartile"),
        "latest_year_in_data": row.year,
    }


# --------------------------------------------------------------------------- #
# The checks                                                                  #
# --------------------------------------------------------------------------- #


def _check(key: str, status: str, title: str, detail: str) -> dict[str, str]:
    return {"key": key, "status": status, "title": title, "detail": detail}


def _when(dt) -> str:
    return timezone.localtime(dt).strftime("%d %b %Y") if dt else "an unknown date"


def _flag_hit(source: str, issns: list[str], title: str) -> JournalFlagList | None:
    variants = _variants(issns)
    key = normalize_title(title)
    for f in JournalFlagList.objects.filter(source=source):
        if f.issn and variants and normalize_issn(f.issn) in {normalize_issn(v) for v in variants}:
            return f
        if key and f.title and normalize_title(f.title) == key and not (f.issn and variants):
            return f
    return None


def checks_for(
    facts: dict[str, Any] | None, *, q: str, kind: str, latest: int
) -> list[dict[str, str]]:
    issns = facts["issns"] if facts else ([normalize_issn(q)] if kind == "issn" and normalize_issn(q) else [])
    title = facts["name"] if facts else (q if kind == "name" else "")
    out: list[dict[str, str]] = []

    # In the list at all, and still in it.
    if not facts:
        out.append(_check("listed", "warn", "Not in our Scopus/Scimago list",
                          f"Not in our Scopus/Scimago list for {latest}: check Scopus before you submit."))
    else:
        out.append(_check("listed", "ok", "In our Scopus/Scimago list",
                          f"Listed in the Scimago data for {facts['latest_year_in_data']}."))
        last = facts["latest_year_in_data"]
        if last < latest:
            out.append(_check("covered", "warn", "No longer listed",
                              f"Scopus stopped listing it after {last}. Our data runs to {latest}."))
        else:
            out.append(_check("covered", "ok", "Still covered", f"Still listed in {latest}, the newest year we hold."))

        q_ = facts["quartile"]
        bits = [b for b in (
            f"{q_} in {facts['subject']}" if q_ and facts["subject"] else q_,
            f"SJR {facts['sjr']:.2f}" if facts["sjr"] is not None else None,
            f"SNIP {facts['snip']:.2f}" if facts["snip"] is not None else "no SNIP held",
        ) if b]
        if not q_:
            out.append(_check("quartile", "unknown", "No quartile", "We hold no quartile for this journal. " + ", ".join(bits) + "."))
        else:
            # A Q3 or Q4 Scopus journal is a sound place to publish; it only
            # pays less. Saying "think twice" about it would steer people
            # away from journals that are fine.
            note = "" if q_ in ("Q1", "Q2") else " Eligible; Q3 and Q4 journals pay less than Q1 and Q2."
            out.append(_check("quartile", "ok", f"Quartile {q_}", ", ".join(bits) + "." + note))

    # The research cell's watch-list.
    watched = None
    for issn in issns or [None]:
        watched = watch_for(issn, title)
        if watched:
            break
    if watched:
        out.append(_check("watch", "bad", "On the college watch list",
                          (watched.get("reason") or "The college is keeping a close eye on this journal.")
                          + " Ask the research office before you submit."))
    else:
        out.append(_check("watch", "ok", "Not on the college watch list", "The research office has not flagged it."))

    # Scopus discontinued: our flag list, and the dated standing rows.
    flags = JournalFlagList.objects.filter(source=JournalFlagList.Source.SCOPUS_DISCONTINUED)
    standing = JournalStanding.objects.filter(source=JournalStanding.Source.SCOPUS_DISCONTINUED)
    loaded = [d for d in (flags.aggregate(m=Max("loaded_at"))["m"], standing.aggregate(m=Max("imported_at"))["m"]) if d]
    if not loaded:
        out.append(_check("discontinued", "unknown", "Discontinued list",
                          "Unknown: the discontinued list has not been loaded yet."))
    else:
        hit = _flag_hit(JournalFlagList.Source.SCOPUS_DISCONTINUED, issns, title)
        gone = standing.filter(issn__in=_variants(issns), listed=False).first() if issns else None
        when = _when(max(loaded))
        if hit or gone:
            why = (hit.note if hit else gone.reason) or ""
            out.append(_check("discontinued", "bad", "Discontinued by Scopus",
                              f"On the Scopus discontinued list (loaded {when}). {why}".strip()))
        else:
            out.append(_check("discontinued", "ok", "Not discontinued",
                              f"Not on the Scopus discontinued list (loaded {when})."))

    # Hijacked journals.
    hij = JournalFlagList.objects.filter(source=JournalFlagList.Source.HIJACKED)
    hij_when = hij.aggregate(m=Max("loaded_at"))["m"]
    if not hij_when:
        out.append(_check("hijacked", "unknown", "Hijacked list",
                          "Unknown: the hijacked journals list has not been loaded yet."))
    else:
        hit = _flag_hit(JournalFlagList.Source.HIJACKED, issns, title)
        if hit:
            # The journal itself is real; the danger is sending the paper (and
            # the fee) to a copy of it. Say that, and name the real site.
            site = f" One fake site is {hit.domain}." if hit.domain else ""
            real = re.search(r"the real site is ([^\s;]+?)\.?$", hit.note or "")
            where = f"the real site, {real.group(1)}" if real else "the publisher's real site"
            out.append(_check("hijacked", "warn", "Fake copies exist",
                              f"This journal is real, but fake websites copy it (list loaded {_when(hij_when)}).{site} "
                              f"Submit only through {where}."))
        else:
            out.append(_check("hijacked", "ok", "Not on the hijacked list",
                              f"Not on the hijacked journals list (loaded {_when(hij_when)})."))

    # The website itself.
    other = JournalFlagList.objects.filter(source=JournalFlagList.Source.OTHER)
    if other.exists():
        hit = _flag_hit(JournalFlagList.Source.OTHER, issns, title)
        if hit:
            out.append(_check("other", "warn", "On another warning list", hit.note or "Listed by the research office."))

    if kind == "url":
        dom = domain_of(q)
        bad = next((f for f in hij.exclude(domain="") if _same_domain(f.domain, dom)), None)
        known = facts.get("homepage") if facts else None
        if bad:
            out.append(_check("domain", "bad", "Known fake website",
                              f"{dom} is on the hijacked journals list" + (f" as a copy of {bad.title}" if bad.title else "")
                              + ". Do not submit or pay here."))
        elif known and not _same_domain(known, dom):
            out.append(_check("domain", "warn", "Not the journal's known site",
                              f"This website is not the journal's known site ({domain_of(known)})."))
        elif known:
            out.append(_check("domain", "ok", "The journal's known site", f"{dom} is the journal's known site."))
        else:
            out.append(_check("domain", "unknown", "Website not checked",
                              "We do not hold this journal's website, so we cannot compare it. "
                              "Check the address against the publisher's page."))
    return out


def _lead(title: str) -> str:
    """A check title mid-sentence: lower the first letter only, so "Q3",
    "Scopus" and ISSNs keep their capitals."""
    return title if title[:2].isupper() else title[:1].lower() + title[1:]


def verdict_for(checks: list[dict[str, str]], facts: dict[str, Any] | None, college: dict[str, Any]) -> dict[str, str]:
    bad = [c for c in checks if c["status"] == "bad"]
    warn = [c for c in checks if c["status"] == "warn"]
    papers = college.get("papers", 0)
    here = f"the college has {papers} paper{'s' if papers != 1 else ''} here"
    if bad:
        return {"level": "avoid", "text": "Avoid: " + "; ".join(_lead(c["title"]) for c in bad) + "."}
    if warn:
        return {"level": "caution", "text": "Think twice: " + "; ".join(_lead(c["title"]) for c in warn) + "."}
    bits = [facts["quartile"]] if facts and facts["quartile"] else []
    bits += ["in Scopus", here]
    return {"level": "safe", "text": "Looks safe: " + ", ".join(bits) + "."}


# --------------------------------------------------------------------------- #
# The college's history there, and the estimate                               #
# --------------------------------------------------------------------------- #


def college_for(user, facts: dict[str, Any] | None, q: str) -> dict[str, Any]:
    if facts:
        variants = _variants(facts["issns"])
        title = facts["name"]
    else:
        variants = _variants([q]) if ISSN_RE.match(q or "") else []
        title = q
    pub_q = Q(venue__iexact=title) if title else Q(pk__in=[])
    if variants:
        pub_q |= Q(issn__in=variants)
    pubs = Publication.objects.filter(pub_q)
    pub_ids = list(pubs.values_list("id", flat=True)[:2000])
    people: dict[str, str] = {}
    for uid, name in (
        Authorship.objects.filter(publication_id__in=pub_ids, user__isnull=False)
        .values_list("user_id", "user__name").distinct()
    ):
        if uid != user.id:
            people[uid] = name
    mine = list(
        pubs.filter(authorships__user=user).distinct().order_by("-year").values("id", "title", "year")[:20]
    )

    claim_q = Q(journal_title__iexact=title) if title else Q(pk__in=[])
    if variants:
        claim_q |= Q(issn__in=variants)
    statuses = list(Claim.objects.filter(claim_q).exclude(status=ClaimStatus.DRAFT).values_list("status", flat=True))
    if user.role == Role.HOD:
        claims: dict[str, int] = {}
        for s in statuses:
            label = hod.progress_of(s).lower().replace(" ", "_")
            claims[label] = claims.get(label, 0) + 1
    else:
        claims = {
            "in_review": sum(1 for s in statuses if s == ClaimStatus.SUBMITTED),
            "cleared": sum(1 for s in statuses if s in (
                ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED)),
            "paid": sum(1 for s in statuses if s == ClaimStatus.PAID),
            "sent_back": sum(1 for s in statuses if s == ClaimStatus.REJECTED),
        }
    return {
        "papers": len(pub_ids),
        "colleagues": [{"id": k, "name": v} for k, v in sorted(people.items(), key=lambda kv: kv[1])[:20]],
        "colleague_count": len(people),
        "mine": mine,
        "claims": {"total": len(statuses), **claims},
    }


def estimate_for(facts: dict[str, Any] | None) -> dict[str, Any]:
    if not facts:
        return {"needs": "Estimate needs the journal to be in our Scimago list."}
    missing = [n for n, v in (("a quartile", facts["quartile"]), ("a SNIP", facts["snip"])) if not v and v != 0]
    if missing:
        return {"needs": f"Estimate needs {' and '.join(missing)} for this journal, which we do not hold."}
    rows = []
    for p in POSITIONS:
        e = discover.estimate_payout(snip=facts["snip"], quartile=facts["quartile"],
                                     author_position=p, total_authors=ASSUMED_AUTHORS)
        rows.append({"position": p, "amount": e.get("amount"), "why_not": e.get("why_not")})
    return {"assumes": f"A Scopus journal article with {ASSUMED_AUTHORS} authors.", "positions": rows}


# --------------------------------------------------------------------------- #
# The whole answer                                                            #
# --------------------------------------------------------------------------- #


def check(user, q: str, pick: str | None = None) -> dict[str, Any]:
    q = (q or "").strip()[:300]
    kind = kind_of(q)
    latest = data_latest_year()
    rows = _candidates(q, kind, latest) if q else []
    chosen = next((r for r in rows if r.id == pick), None) if pick else None
    chosen = chosen or (rows[0] if rows else None)
    facts = journal_facts(chosen) if chosen else None
    if facts and chosen:
        facts["homepage"] = _homepage(chosen)
    checks = checks_for(facts, q=q, kind=kind, latest=latest)
    college = college_for(user, facts, q)
    out: dict[str, Any] = {
        "query": q,
        "kind": kind,
        "domain": domain_of(q) if kind == "url" else None,
        "data_latest_year": latest,
        "matches": [_match_dict(r) for r in rows],
        "journal": facts,
        "checks": checks,
        "verdict": verdict_for(checks, facts, college),
        "college": college,
    }
    if user.role == Role.HOD:
        out["estimate_hidden"] = True
        return hod.without_money(out)
    out["estimate"] = estimate_for(facts)
    return out


# --------------------------------------------------------------------------- #
# Loading a list                                                              #
# --------------------------------------------------------------------------- #

COLUMNS = {
    "title": ["title", "source title", "journal title", "journal", "name", "journal name", "name of the journal"],
    "issn": ["issn", "print issn", "p-issn", "eissn", "e-issn", "online issn", "issn (print)"],
    "domain": ["domain", "url", "website", "hijacked url", "hijacked website", "fake url", "link"],
    "note": ["note", "notes", "reason", "remarks", "comment"],
}


def _pick_col(row: dict, names: list[str]) -> str:
    low = {(k or "").strip().lower(): v for k, v in row.items()}
    for n in names:
        v = low.get(n)
        if v and str(v).strip():
            return str(v).strip()
    return ""


def parse_flags(text: str) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    out = []
    for row in reader:
        title = _pick_col(row, COLUMNS["title"])
        issn = normalize_issn(_pick_col(row, COLUMNS["issn"])) or ""
        raw_dom = _pick_col(row, COLUMNS["domain"])
        dom = domain_of(raw_dom) if raw_dom else ""
        if title or issn or dom:
            out.append({"title": title[:512], "issn": issn, "domain": dom[:255],
                        "note": _pick_col(row, COLUMNS["note"])})
    return out


def load_flags(text: str, source: str, *, replace: bool = True) -> int:
    if source not in JournalFlagList.Source.values:
        raise ValueError(f"Unknown list: {source}")
    rows = parse_flags(text)
    now = timezone.now()
    with transaction.atomic():
        if replace:
            JournalFlagList.objects.filter(source=source).delete()
        JournalFlagList.objects.bulk_create([JournalFlagList(source=source, loaded_at=now, **r) for r in rows])
    return len(rows)
