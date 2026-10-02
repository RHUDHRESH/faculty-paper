"""The research helper: where to send a paper idea, and who to talk to.

A faculty member pastes an abstract or describes an idea, or picks one of
their own papers, and gets four things drawn from the college's own record:

1. journals that fit, each with its quartile and SNIP, what the college has
   already published there, and a plain warning for any journal on the
   research cell's watch-list or flagged by a standing list;
2. colleagues who work on the same topic, with their relevant papers and the
   co-authors they share with the reader;
3. related papers from the college's record;
4. a short, editable introduction to one colleague, which the reader sends
   themselves through Messages. Nothing here ever sends anything.

The rule is the one in `ai.py` and docs/ux/20-ai.md: **the database proposes
and the model only chooses, ranks and explains.** Everything shown is
retrieved first, by counting (`candidates`), and arrives with a stable id. The
model is handed those candidates and may answer only with their ids; an id it
makes up, a journal it names that was not offered, a number the candidate does
not carry, a sum of money, a link: all dropped (`validate_ranking`,
`validate_draft`). With no model the same lists come back, ordered by the
counts, and the page is whole.

What a reader pastes is untrusted *data*. It goes into the prompt between
markers and is described as a description of research, never as an
instruction, and the answer is validated whatever it says.

No money anywhere, and nothing about a claim or the desk that holds it: the
only warning a faculty member gets about a journal is that the college is
watching it or that a standing list has dropped it.

The model is asked through `ai_harness` (`RANK` and `DRAFT`, defined with the
two validators): pasted text fenced as data, ids kept to the candidates
retrieved for the request, no amounts or desks in the sentences, and the
answers cached per person by the harness.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import time
from collections import Counter, defaultdict
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db.models import Q
from django.utils import timezone

from core.models import (
    AuditLog,
    Authorship,
    JournalStanding,
    Publication,
    ScimagoJournal,
    User,
)
from core.services import ai
from core.services import ai_harness as harness
from core.services import coauthors as graph
from core.services import discover
from core.services import research_picture as picture
from core.services.journal_watch import watch_for
from core.services.normalize import normalize_issn, normalize_title
from core.services.scimago import best_by_quartile, issn_variants

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Limits and names                                                            #
# --------------------------------------------------------------------------- #

MAX_TEXT = 4000
MAX_TITLE = 300
MIN_CHARS = 20
POOL_VENUES = 10
POOL_PEOPLE = 8
SHOW_PAPERS = 8
#: How many related papers feed the venue and colleague counts.
POOL = 40
#: Authors above which a paper tells us nothing about who knows whom.
MEGA_PAPER = 25

#: Audit actions. `AI_RESEARCH_HELPER` is a call that reached the model and is
#: what the daily limit counts; the cached one is an answer served from memory.
ACTION_CALL = "AI_RESEARCH_HELPER"
ACTION_CACHED = "AI_RESEARCH_HELPER_CACHED"
ACTION_FEEDBACK = "AI_FEEDBACK"

CANDIDATE_TTL = 10 * 60
ANSWER_TTL = 24 * 60 * 60

FIT = ("strong", "good", "possible")

LABEL = "AI suggestion"

OFF_TEXT = "AI is off for this college. The lists below are counted from the college's record."
UNAVAILABLE_TEXT = "AI is not reachable right now. The lists below are counted from the college's record."
FAILED_TEXT = "The AI did not answer this time. The lists below are counted from the college's record."


class InputError(ValueError):
    """The reader's input cannot be used, with a sentence to show them."""


def daily_limit() -> int:
    configured = getattr(settings, "RESEARCH_HELPER_DAILY_LIMIT", None)
    if configured:
        return int(configured)
    return int(os.getenv("RESEARCH_HELPER_DAILY_LIMIT", "30") or 30)


def used_today(user: User) -> int:
    since = timezone.localtime().replace(hour=0, minute=0, second=0, microsecond=0)
    return AuditLog.objects.filter(actor=user, action=ACTION_CALL, created_at__gte=since).count()


# --------------------------------------------------------------------------- #
# Reading the reader's words                                                  #
# --------------------------------------------------------------------------- #

_STOP = frozenset(
    """
    a about above after again all also an and any are as at be been being below between both but by can could did do
    does doing down during each few for from further had has have having he her here hers him his how if in into is
    it its just more most my no nor not now of off on once only or other our out over own same she should so some
    such than that the their them then there these they this those through to too under until up very was we were
    what when where which while who whom why will with would you your
    paper papers study studies work works using use used based approach approaches method methods result results
    proposed propose present presents presented show shows shown novel new analysis system systems data model models
    also however thus therefore via among within without towards toward different various several many much one two
    first second three high low good better best large small recent current existing review research problem
    problems technique techniques application applications performance effect effects case idea ideas want paper's
    """.split()
)
_WORD = re.compile(r"[a-z0-9]+")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_URL = re.compile(r"(https?://|www\.)\S+", re.I)
_MONEY = re.compile(r"(₹|\brs\.?\s?\d|\binr\b|\brupee|\blakh|\bcrore|\bincentive|\bpayout|\bpaid\b|\bpayment|\bremunerat)", re.I)
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


def _stem(w: str) -> str:
    """A light, consistent stem. Both sides of every comparison go through it,
    so what it gets wrong, it gets wrong the same way twice."""
    if len(w) <= 3:
        return w
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("sses"):
        return w[:-2]
    if w.endswith("s") and not w.endswith(("ss", "us", "is")):
        w = w[:-1]
    if w.endswith("ing") and len(w) > 6:
        return w[:-3]
    if w.endswith("ed") and len(w) > 5:
        return w[:-2]
    return w


def words(text: str) -> list[tuple[str, str]]:
    """(stem, the word as written) for every word worth matching on."""
    out = []
    for raw in _WORD.findall((text or "").lower()):
        if raw in _STOP or len(raw) < 2 or raw.isdigit():
            continue
        s = _stem(raw)
        if s and s not in _STOP:
            out.append((s, raw))
    return out


def _stems(text: str) -> list[str]:
    return [s for s, _ in words(text)]


def clean_text(text: str | None, limit: int) -> str:
    """Pasted text as plain, bounded text: no control characters, one space."""
    text = _CONTROL.sub(" ", text or "")
    return " ".join(text.split())[:limit]


# --------------------------------------------------------------------------- #
# The college's record, indexed for matching                                  #
# --------------------------------------------------------------------------- #


class _Index:
    """Every college paper, indexed by the stems of its title and topics.

    Built once per `_College` snapshot (which `research_picture` rebuilds when
    the record changes), so a request is a handful of dictionary lookups.
    """

    def __init__(self, college: picture._College) -> None:
        self.college = college
        self.n = max(1, len(college.pubs))
        self.df: Counter[str] = Counter()
        self.post: dict[str, list[tuple[str, bool, bool]]] = defaultdict(list)
        self.doc: dict[str, frozenset[str]] = {}
        self.by_venue: dict[str, list[str]] = defaultdict(list)
        for pid, p in college.pubs.items():
            in_title = set(_stems(p["title"]))
            in_topic: set[str] = set()
            for topic in p["topics"]:
                in_topic |= set(_stems(topic))
            both = in_title | in_topic
            self.doc[pid] = frozenset(both)
            for s in both:
                self.df[s] += 1
                self.post[s].append((pid, s in in_title, s in in_topic))
            key = normalize_title(p["venue"])
            if key:
                self.by_venue[key].append(pid)
        self.mass = {pid: sum(self.idf(s) for s in stems) or 1.0 for pid, stems in self.doc.items()}

    def idf(self, stem: str) -> float:
        return math.log(1 + self.n / max(1, self.df.get(stem, 0) or 1))

    def related(self, query: Counter[str], *, exclude: set[str]) -> list[tuple[float, str, set[str]]]:
        """(score, paper id, the stems that matched), best first."""
        usable = {s: tf for s, tf in query.items() if 0 < self.df.get(s, 0) <= 0.25 * self.n}
        top = sorted(usable.items(), key=lambda kv: -(self.idf(kv[0]) * (1 + math.log(kv[1]))))[:40]
        scores: dict[str, float] = defaultdict(float)
        hit: dict[str, set[str]] = defaultdict(set)
        for s, tf in top:
            w = self.idf(s) * (1 + math.log(tf))
            for pid, in_title, in_topic in self.post[s]:
                if pid in exclude:
                    continue
                scores[pid] += w * (1.0 if (in_title and in_topic) else 0.85)
                hit[pid].add(s)
        need = 1 if len(top) < 3 else 2
        rows = [
            (sc / math.sqrt(self.mass[pid]), pid, hit[pid])
            for pid, sc in scores.items()
            if len(hit[pid]) >= need
        ]
        if not rows:
            return []
        rows.sort(
            key=lambda r: (
                -r[0],
                -(self.college.pubs[r[1]]["year"] or 0),
                -(self.college.pubs[r[1]]["citations"] or 0),
                r[1],
            )
        )
        floor = rows[0][0] * 0.35
        return [r for r in rows if r[0] >= floor][:POOL]


_INDEX: dict[str, Any] = {"college": None, "index": None}


def _index() -> _Index:
    college = picture.shared_college()
    if _INDEX["college"] is not college:
        _INDEX.update(college=college, index=_Index(college))
    return _INDEX["index"]


# --------------------------------------------------------------------------- #
# The input                                                                   #
# --------------------------------------------------------------------------- #


def resolve_input(
    user: User, *, title: str | None, text: str | None, paper_id: str | None
) -> dict[str, Any]:
    """What the reader gave us, as plain text and a hash that names it.

    Picking one of their own papers uses its title and topics from the record.
    Only a paper they are an author of: this is a tool for their own work.
    """
    title = clean_text(title, MAX_TITLE)
    body = clean_text(text, MAX_TEXT)
    picked = None
    if paper_id:
        mine = Authorship.objects.filter(user=user, publication_id=paper_id).select_related("publication").first()
        if not mine:
            raise InputError("That is not one of your papers.")
        picked = mine.publication
        topics = picture._topics(picked.topics_json)
        title = title or clean_text(picked.title, MAX_TITLE)
        body = clean_text(" ".join([body, ", ".join(topics)]), MAX_TEXT)
    if len(title) + len(body) < MIN_CHARS or len(set(_stems(f"{title} {body}"))) < 3:
        raise InputError("Paste an abstract or describe the idea in a sentence or two, so there is something to match.")
    norm = " ".join(f"{title} {body}".lower().split())
    digest = hashlib.sha256(f"{user.pk}|{paper_id or ''}|{norm}".encode()).hexdigest()[:24]
    return {"hash": digest, "title": title, "text": body, "paper_id": picked.id if picked else None}


def my_papers(user: User, limit: int = 40) -> list[dict[str, Any]]:
    """Their own papers, newest first, for the "pick one of mine" list."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    rows = (
        Authorship.objects.filter(user=user)
        .select_related("publication")
        .order_by("-publication__year", "-publication__date", "publication__title")
    )
    for a in rows:
        p = a.publication
        if p.id in seen or not (p.title or "").strip():
            continue
        seen.add(p.id)
        out.append({"id": p.id, "title": p.title.strip()[:200], "year": p.year})
        if len(out) >= limit:
            break
    return out


# --------------------------------------------------------------------------- #
# Candidates, counted                                                         #
# --------------------------------------------------------------------------- #


def _spelled(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for s, raw in words(text):
        out.setdefault(s, raw)
    return out


def _caution(issns: list[str], title: str, *, in_scimago: bool, history: bool) -> dict[str, Any] | None:
    """The one warning that applies to a journal, most serious first.

    Never says which desk or person added a journal to the watch-list, or why:
    that is the research cell's note. A faculty member is told the college is
    watching it and who to ask.
    """
    for issn in issns or [None]:
        if watch_for(issn, title):
            return {
                "kind": "watch",
                "level": "warning",
                "text": "The college is keeping a close eye on this journal. Ask the research office before you submit.",
            }
    variants = [v for i in issns for v in issn_variants(i)]
    if variants:
        gone = JournalStanding.objects.filter(issn__in=variants, listed=False).first()
        if gone:
            if gone.source == JournalStanding.Source.SCOPUS_DISCONTINUED:
                text = "Scopus has discontinued this journal. Papers in it may not count for the college."
            else:
                text = "This journal has been removed from the UGC-CARE list. Papers in it may not count."
            return {"kind": "removed", "level": "warning", "text": text}
    if history and not in_scimago:
        return {
            "kind": "unlisted",
            "level": "check",
            "text": "Not in the Scimago list, so there is no quartile or SNIP to show. Check that it is indexed before you submit.",
        }
    return None


def _latest_year() -> int:
    from django.db.models import Max

    return ScimagoJournal.objects.aggregate(y=Max("year"))["y"] or 2025


def _row_for(issns: list[str], name: str, year: int) -> ScimagoJournal | None:
    variants = [v for i in issns for v in issn_variants(i)]
    if variants:
        row = (
            ScimagoJournal.objects.filter(year=year)
            .filter(Q(issn__in=variants) | Q(eissn__in=variants))
            .first()
        )
        if row:
            return row
    return discover.find_journal(name, year=year)


def _categories(row: ScimagoJournal) -> list[dict[str, Any]]:
    return [c for c in discover.categories_of(row) if isinstance(c, dict)]


def _years(pubs: list[dict[str, Any]]) -> list[int]:
    return sorted(p["year"] for p in pubs if p["year"])


def _history(index: _Index, key: str, on_topic: int) -> dict[str, Any]:
    """What the college has published in one journal: counted, never estimated."""
    pubs = [index.college.pubs[pid] for pid in index.by_venue.get(key, [])]
    years = _years(pubs)
    quartiles = Counter(p["quartile"].upper() for p in pubs if p["quartile"])
    colleagues: set[str] = set()
    for p in pubs:
        colleagues |= p["members"]
    return {
        "papers": len(pubs),
        "on_topic": on_topic,
        "first_year": years[0] if years else None,
        "last_year": years[-1] if years else None,
        "citations": sum(p["citations"] or 0 for p in pubs),
        "colleagues": len(colleagues),
        "quartiles": dict(sorted(quartiles.items())),
    }


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _history_why(h: dict[str, Any]) -> str:
    bits = []
    if h["on_topic"]:
        bits.append(f"Colleagues published {_plural(h['on_topic'], 'paper')} on similar topics here")
    else:
        bits.append("Colleagues publish here")
    if h["papers"] > h["on_topic"] or not h["on_topic"]:
        bits[0] += f", {h['papers']} in all"
    if h["first_year"] and h["last_year"]:
        bits[0] += (
            f" ({h['first_year']})" if h["first_year"] == h["last_year"] else f" ({h['first_year']} to {h['last_year']})"
        )
    return bits[0] + "."


def venues_for(
    index: _Index,
    ranked: list[tuple[float, str, set[str]]],
    terms: list[str],
    own: list[str],
    issn_of: dict[str, str],
) -> list[dict[str, Any]]:
    year = _latest_year()
    college = index.college
    groups: dict[str, dict[str, Any]] = {}
    for score, pid, _hit in ranked:
        p = college.pubs[pid]
        if not p["venue"] or not picture._is_journal(p["type"]):
            continue
        key = normalize_title(p["venue"])
        if not key:
            continue
        g = groups.setdefault(key, {"name": p["venue"], "score": 0.0, "pids": [], "issns": []})
        g["score"] += score
        g["pids"].append(pid)
        if issn_of.get(pid):
            g["issns"].append(issn_of[pid])
    history = sorted(groups.items(), key=lambda kv: (-kv[1]["score"], kv[1]["name"]))[:10]

    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(row: ScimagoJournal | None, *, name: str, issns: list[str], source: str, why: str,
            hist: dict[str, Any] | None, matched: list[str], key: str) -> None:
        if key in seen:
            return
        seen.add(key)
        cats = _categories(row) if row else []
        best = best_by_quartile(cats) if cats else {}
        title = row.title if row else name
        all_issns = [i for i in [(row.issn if row else None), (row.eissn if row else None), *issns] if i]
        caution = _caution(all_issns, title, in_scimago=bool(row), history=source == "history")
        out.append({
            "title": title,
            "issn": normalize_issn(row.issn if row and row.issn else (issns[0] if issns else None)),
            "quartile": best.get("quartile"),
            "subject": best.get("category"),
            "sjr": row.sjr if row else None,
            "snip": discover.find_snip(row) if row else None,
            "dataset_year": row.year if row else None,
            "indexed": bool(row),
            "source": source,
            "matched": matched,
            "history": hist,
            "caution": caution,
            "why": why,
            "id": "v" + hashlib.sha1(key.encode()).hexdigest()[:7],
            # Kept so a warning is worked out again on every request: the
            # list of journals is cached for minutes, the watch-list is not.
            "_issns": all_issns,
        })

    for key, g in history:
        row = _row_for(g["issns"], g["name"], year)
        hist = _history(index, key, len(g["pids"]))
        add(row, name=g["name"], issns=g["issns"], source="history", why=_history_why(hist), hist=hist,
            matched=[], key=key)

    # Journals whose own title names the topic, then the neighbours of the
    # journals above: the same subject area, Q1 or Q2, of a similar standing.
    # A title match needs two of the topic's words, or one long, specific
    # word ("photovoltaic"): "power" or "solar" alone names half the catalogue.
    terms = list(dict.fromkeys([*terms[:5], *own[:4]]))
    terms = [t for t in terms if len(t) >= 5]
    found: dict[str, tuple[ScimagoJournal, list[str]]] = {}
    for term in terms[:7]:
        for row in ScimagoJournal.objects.filter(year=year, title__icontains=term).order_by("-sjr")[:8]:
            hits = [t for t in terms if t.lower() in row.title.lower()]
            if len(hits) >= 2 or any(len(h) >= 9 for h in hits):
                found.setdefault(row.id, (row, hits))
    by_title = sorted(found.values(), key=lambda rh: (-len(rh[1]), -(rh[0].sjr or 0), rh[0].title))[:4]
    for row, hits in by_title:
        add(row, name=row.title, issns=[], source="title",
            why=f"The journal's title names your topic: {', '.join(hits)}.", hist=_history_for_row(index, row),
            matched=hits, key=normalize_title(row.title))

    anchors = [o for o in out if o["source"] == "history" and o["subject"] and o["sjr"]][:2]
    for anchor in anchors:
        peers = []
        for row in ScimagoJournal.objects.filter(
            year=year, categories_json__icontains=anchor["subject"]
        ).order_by("-sjr")[:600]:
            cats = [c for c in _categories(row) if c.get("category") == anchor["subject"]]
            if cats and cats[0].get("quartile") in ("Q1", "Q2") and row.sjr and normalize_title(row.title) not in seen:
                overlap = sum(1 for t in terms if t.lower() in row.title.lower())
                peers.append((-overlap, abs(math.log(row.sjr / anchor["sjr"])), row.title, row))
        for _o, _gap, _title, row in sorted(peers, key=lambda r: r[:3])[:2]:
            add(row, name=row.title, issns=[], source="subject",
                why=f"Same subject area as {anchor['title']} ({anchor['subject']}), with a similar standing.",
                hist=_history_for_row(index, row), matched=[], key=normalize_title(row.title))

    return _order_venues(out)[:POOL_VENUES]


def _history_for_row(index: _Index, row: ScimagoJournal) -> dict[str, Any] | None:
    key = normalize_title(row.title)
    if key not in index.by_venue:
        return None
    return _history(index, key, 0)


_SOURCE_ORDER = {"history": 0, "title": 1, "subject": 2}


def _order_venues(venues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The order used with no model: warned journals last, indexed ones before
    journals we cannot find, then where the match came from, then how closely
    the college's papers there match (the order they were found in)."""
    def key(item: tuple[int, dict[str, Any]]):
        i, v = item
        return (
            1 if v["caution"] and v["caution"]["level"] == "warning" else 0,
            0 if v["indexed"] else 1,
            _SOURCE_ORDER[v["source"]],
            i,
        )

    return [v for _i, v in sorted(enumerate(venues), key=key)]


def refresh_cautions(venues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The warnings as they stand now, and the order they imply.

    The lists are cached for minutes; the research cell's watch-list and the
    standing lists can change in that time, and a journal added to the
    watch-list must be warned about from the next request, not the next
    cache expiry.
    """
    for v in venues:
        v["caution"] = _caution(
            v["_issns"], v["title"], in_scimago=v["indexed"], history=v["source"] == "history"
        )
    return _order_venues(venues)


def _shared_coauthors(user_id: str, other_ids: list[str]) -> dict[str, dict[str, Any]]:
    """For each colleague: papers with the reader, and who they both wrote with."""
    me = f"u:{user_id}"
    nodes = [me, *[f"u:{o}" for o in other_ids]]
    pubs = graph.publications_of(nodes)
    all_pids = set().union(*pubs.values()) if pubs else set()
    on_paper: dict[str, set[str]] = defaultdict(set)
    for node, pid in graph._node_rows_for_pubs(all_pids):
        on_paper[pid].add(node)

    def companions(node: str) -> Counter[str]:
        c: Counter[str] = Counter()
        for pid in pubs.get(node, ()):
            people = on_paper.get(pid, set())
            if len(people) > MEGA_PAPER:
                continue
            for other in people:
                if other != node:
                    c[other] += 1
        return c

    mine = companions(me)
    out: dict[str, dict[str, Any]] = {}
    for o in other_ids:
        node = f"u:{o}"
        theirs = companions(node)
        common = [n for n in theirs if n in mine and n not in (me, node)]
        common.sort(key=lambda n: (-min(mine[n], theirs[n]), n))
        out[o] = {
            "papers_together": len(pubs.get(me, set()) & pubs.get(node, set())),
            "shared": common[:4],
            "shared_count": len(common),
        }
    return out


def colleagues_for(
    user: User, index: _Index, ranked: list[tuple[float, str, set[str]]], spelled: dict[str, str]
) -> list[dict[str, Any]]:
    college = index.college
    scores: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for score, pid, _hit in ranked:
        for uid in college.pubs[pid]["members"]:
            if uid != user.id:
                scores[uid].append((score, pid))
    ranked_people = sorted(
        (
            (sum(s for s, _ in sorted(rows, reverse=True)[:3]), uid, rows)
            for uid, rows in scores.items()
            if uid in college.users and college.users[uid].active
        ),
        key=lambda r: (-r[0], -len(r[2]), college.users[r[1]].name),
    )[:POOL_PEOPLE]
    if not ranked_people:
        return []
    ids = [uid for _s, uid, _r in ranked_people]
    links = _shared_coauthors(user.id, ids)
    described = graph._describe({n for v in links.values() for n in v["shared"]})
    out: list[dict[str, Any]] = []
    for _score, uid, rows in ranked_people:
        u = college.users[uid]
        best = [pid for _s, pid in sorted(rows, reverse=True)[:3]]
        papers = [
            {"id": pid, "title": college.pubs[pid]["title"], "year": college.pubs[pid]["year"],
             "venue": college.pubs[pid]["venue"], "doi": college.pubs[pid]["doi"]}
            for pid in best
        ]
        link = links[uid]
        shared = [
            {"user_id": described[n]["user_id"], "name": described[n]["name"]}
            for n in link["shared"] if n in described and described[n]["name"]
        ]
        out.append({
            "user_id": uid,
            "name": u.name,
            "department": u.department or None,
            "designation": u.designation or None,
            "photo_url": f"{settings.MEDIA_URL}{u.photo}" if u.photo else None,
            "papers_on_topic": len(rows),
            "papers_together": link["papers_together"],
            "shared_coauthors": shared,
            "shared_count": link["shared_count"],
            "papers": papers,
            "why": _person_why(len(rows), papers[0], link["papers_together"], shared, link["shared_count"]),
        })
    for p in out:
        p["id"] = "p" + hashlib.sha1(p["user_id"].encode()).hexdigest()[:7]
    return out


def _person_why(n: int, first: dict[str, Any], together: int, shared: list[dict[str, Any]], shared_count: int) -> str:
    parts = [f"Has {_plural(n, 'paper')} on similar topics, for example “{first['title'][:90]}”"
             + (f" ({first['year']})" if first["year"] else "") + "."]
    if together:
        parts.append(f"You have written {_plural(together, 'paper')} together.")
    elif shared:
        names = [s["name"] for s in shared[:2]]
        more = shared_count - len(names)
        who = (", ".join(names) + f" and {more} more") if more > 0 else " and ".join(names)
        parts.append(f"You have both written with {who}.")
    return " ".join(parts)


def papers_for(user: User, index: _Index, ranked: list[tuple[float, str, set[str]]], spelled: dict[str, str]) -> list[dict[str, Any]]:
    college = index.college
    out = []
    for _score, pid, hit in ranked[:SHOW_PAPERS]:
        p = college.pubs[pid]
        authors = [
            {"user_id": uid, "name": college.users[uid].name}
            for uid in sorted(p["members"], key=lambda u: college.users[u].name if u in college.users else "")
            if uid in college.users
        ]
        out.append({
            "id": pid,
            "title": p["title"],
            "year": p["year"],
            "venue": p["venue"] or None,
            "quartile": p["quartile"] or None,
            "doi": p["doi"] or None,
            "mine": user.id in p["members"],
            "authors": authors[:4],
            "authors_more": max(0, len(authors) - 4),
            "matched": sorted(spelled.get(s, s) for s in hit)[:5],
        })
    return out


def topic_terms(index: _Index, ranked: list[tuple[float, str, set[str]]]) -> list[str]:
    """Words that name the topic, read from the topics of the closest papers.

    These are the words a journal's title would use ("photovoltaic", "solar"),
    which an abstract's own rare words ("partially", "shaded") are not.
    """
    weight: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    for score, pid, _hit in ranked[:15]:
        seen: set[str] = set()
        for topic in index.college.pubs[pid]["topics"]:
            for s, raw in words(topic):
                if s not in seen and len(raw) >= 5 and index.df.get(s, 0) <= 0.1 * index.n:
                    seen.add(s)
                    spelled.setdefault(s, raw)
                    weight[s] += score
    return [spelled[s] for s, _w in sorted(weight.items(), key=lambda kv: (-kv[1], kv[0]))]


def candidates(user: User, inp: dict[str, Any]) -> dict[str, Any]:
    """The deterministic answer: venues, colleagues and papers, all counted."""
    key = f"rh:c:{inp['hash']}"
    hit = cache.get(key)
    if hit is not None:
        hit["venues"] = refresh_cautions(hit["venues"])
        return hit
    started = time.monotonic()
    index = _index()
    full = f"{inp['title']} {inp['text']}"
    query: Counter[str] = Counter(_stems(inp["title"]) * 2 + _stems(inp["text"]))
    spelled = _spelled(full)
    ranked = index.related(query, exclude={inp["paper_id"]} if inp["paper_id"] else set())
    issn_of = {}
    if ranked:
        issn_of = dict(
            Publication.objects.filter(id__in=[pid for _s, pid, _h in ranked]).exclude(issn="")
            .values_list("id", "issn")
        )
    # The words that actually found papers, most useful first: shown to the
    # reader as "what we read", and used to look for journals named for them.
    weight = {s: index.idf(s) * (1 + math.log(tf)) for s, tf in query.items() if index.df.get(s)}
    found_by: Counter[str] = Counter(s for _sc, _pid, hit in ranked for s in hit)
    terms = [
        spelled[s]
        for s in sorted(found_by, key=lambda s: (-found_by[s], -weight.get(s, 0), s))
        if s in spelled
    ]
    result = {
        "input": {
            "hash": inp["hash"],
            "title": inp["title"],
            "chars": len(inp["text"]),
            "terms": terms[:8],
            "paper_id": inp["paper_id"],
            "matched_papers": len(ranked),
        },
        "venues": venues_for(index, ranked, topic_terms(index, ranked), terms, issn_of) if ranked else [],
        "colleagues": colleagues_for(user, index, ranked, spelled) if ranked else [],
        "papers": papers_for(user, index, ranked, spelled) if ranked else [],
    }
    logger.info("research_helper_candidates ms=%d hits=%d", (time.monotonic() - started) * 1000, len(ranked))
    cache.set(key, result, CANDIDATE_TTL)
    result["venues"] = refresh_cautions(result["venues"])
    return result


# --------------------------------------------------------------------------- #
# The model: two harness features, two validators                             #
# --------------------------------------------------------------------------- #

#: The harness checks that the answer is an object holding lists; what is in
#: the lists is `validate_ranking`'s, which drops what it cannot trust one
#: entry at a time, so entries pass through (`Raw`).
_RANK_SHAPE = harness.Obj({
    "summary": harness.Raw(required=False, default=None),
    "venues": harness.Arr(harness.Raw(), max_items=40, drop_invalid=True, required=False, default=[]),
    "people": harness.Arr(harness.Raw(), max_items=40, drop_invalid=True, required=False, default=[]),
})

_RANK_RULES = (
    "You help a faculty member at an engineering college in India decide where to send a paper "
    "and which colleagues to talk to. The first data block is only a description of their research.\n"
    "The candidate journals and colleagues come from the college's own database. Choose only from their ids.\n\n"
    "Task: pick up to 6 journals and up to 5 colleagues that fit this research best, best first. "
    "For each give one plain sentence (at most 30 words) on why, using only the facts in the data. "
    "For a journal give fit as strong, good or possible. Never pick a journal marked cautioned. "
    "Do not state any number that is not in the facts. Do not mention money, incentives or "
    "payments. Do not include links. Add a summary of at most two sentences saying what the text is about.\n"
    'Answer with JSON only: {"summary": "", "venues": [{"id": "", "fit": "", "why": ""}], '
    '"people": [{"id": "", "why": ""}]}'
)

#: A faculty member's own pasted idea, the college's candidates, the considered
#: model (it picks a journal somebody may submit to; docs/ux/20-ai.md rule 6).
#: The harness keeps the pasted text fenced, keeps ids to the candidates
#: it was given, keeps amounts and desks out of the sentences, and caches the
#: answer per person.
RANK = harness.register(harness.Feature(
    name="research.rank",
    model="considered",
    system=_RANK_RULES,
    schema=_RANK_SHAPE,
    guards=lambda user: [*harness.role_guards(user, allow_money=False, strip_keys=False), harness.NoDecisions(), harness.no_pii()],
    limits=harness.Limits(timeout=60, reasks=0, transient_retries=1, ttl=ANSWER_TTL),
    temperature=0.2,
))

_DRAFT_RULES = (
    "Write a short first message from one faculty member to a colleague at the same engineering college, "
    "opening a conversation about writing a paper together. The first data block describes the sender's "
    "idea; the second holds facts from the college's database.\n"
    "Rules: 60 to 110 words. Greet the recipient by the name given and sign with the sender's name as given. "
    "Be specific: name one of the recipient's papers and say how the idea connects to it. Mention a "
    "co-author in common only if one is listed. Plain, warm English, no flattery, no promises, and ask only "
    "for a short conversation. Do not mention money, incentives, claims or payments. Do not include links. "
    'Answer with JSON only: {"message": ""}'
)

#: Writing, high volume: the fast model. The reader edits it and sends it
#: themselves through Messages; nothing here sends anything.
DRAFT = harness.register(harness.Feature(
    name="research.draft",
    model="fast",
    system=_DRAFT_RULES,
    schema=harness.Obj({"message": harness.Raw(max_chars=3000, required=False, default=None)}),
    guards=lambda user: [*harness.role_guards(user, allow_money=False, strip_keys=False), harness.NoDecisions(), harness.no_pii()],
    limits=harness.Limits(timeout=45, reasks=0, transient_retries=1, ttl=ANSWER_TTL),
    temperature=0.5,
    closed_world=False,
))


def _numbers(text: str) -> set[str]:
    return {m.replace(",", "") for m in _NUMBER.findall(text or "")}


def _facts_venue(v: dict[str, Any]) -> dict[str, Any]:
    h = v["history"] or {}
    return {
        "id": v["id"],
        "title": v["title"],
        "quartile": v["quartile"],
        "subject": v["subject"],
        "snip": v["snip"],
        "found_in": {"history": "papers the college published here", "title": "journal title names the topic",
                     "subject": "same subject area as a journal colleagues use"}[v["source"]],
        "college_papers_in_all": h.get("papers", 0),
        "college_papers_on_this_topic": h.get("on_topic", 0),
        "last_college_year": h.get("last_year"),
        "cautioned": bool(v["caution"] and v["caution"]["level"] == "warning"),
    }


def _facts_person(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": p["id"],
        "name": p["name"],
        "department": p["department"],
        "papers_on_this_topic": p["papers_on_topic"],
        "example_papers": [{"title": x["title"], "year": x["year"]} for x in p["papers"][:2]],
        "papers_with_the_reader": p["papers_together"],
        "co_authors_in_common": [s["name"] for s in p["shared_coauthors"][:3]],
    }


def _pasted(inp: dict[str, Any], limit: int | None = None) -> harness.DataBlock:
    """What the reader pasted: a description of their research, and data, whatever it says."""
    text = inp["text"] if limit is None else inp["text"][:limit]
    return harness.DataBlock("what the user pasted about their research", f"Title: {inp['title']}\nText: {text}", MAX_TEXT + MAX_TITLE + 100)


def _rank_blocks(inp: dict[str, Any], venues: list[dict[str, Any]], people: list[dict[str, Any]]) -> list[harness.DataBlock]:
    return [
        _pasted(inp),
        harness.DataBlock("candidate journals", json.dumps([_facts_venue(v) for v in venues], ensure_ascii=False), 9000),
        harness.DataBlock("candidate colleagues", json.dumps([_facts_person(p) for p in people], ensure_ascii=False), 9000),
    ]


def _clean_sentence(text: Any, allowed_numbers: set[str], limit: int = 260) -> str:
    """One sentence a model wrote, or "" when it cannot be trusted: a link, a
    sum of money, markup, or a number the facts do not carry."""
    if not isinstance(text, str):
        return ""
    text = clean_text(text, limit + 1)
    if not text or len(text) > limit:
        return ""
    if _URL.search(text) or _MONEY.search(text) or re.search(r"[<>{}\[\]]|`|\*\*", text):
        return ""
    if _numbers(text) - allowed_numbers:
        return ""
    return text


def validate_ranking(
    raw: Any, inp: dict[str, Any], venues: list[dict[str, Any]], people: list[dict[str, Any]]
) -> dict[str, Any]:
    """What survives of a model's ranking: only candidates we handed it.

    An id that is not a candidate, a journal named instead of identified, a
    cautioned journal chosen, a repeat: dropped. A sentence that quotes a
    number, a link or a sum of money the facts do not hold: dropped, and the
    deterministic sentence stands in for it.
    """
    raw = raw if isinstance(raw, dict) else {}
    by_v = {v["id"]: v for v in venues}
    by_p = {p["id"]: p for p in people}
    base = _numbers(json.dumps([_facts_venue(v) for v in venues] + [_facts_person(p) for p in people]))
    base |= _numbers(f"{inp['title']} {inp['text']}")

    def rows(key: str) -> list[dict[str, Any]]:
        value = raw.get(key)
        return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []

    out_v: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows("venues"):
        vid = str(r.get("id") or "").strip()
        v = by_v.get(vid)
        if v is None or vid in seen:
            continue
        seen.add(vid)
        if v["caution"] and v["caution"]["level"] == "warning":
            continue
        fit = r.get("fit") if r.get("fit") in FIT else "good"
        out_v.append({"id": vid, "fit": fit, "why": _clean_sentence(r.get("why"), base)})
    out_p: list[dict[str, Any]] = []
    seen = set()
    for r in rows("people"):
        pid = str(r.get("id") or "").strip()
        if pid not in by_p or pid in seen:
            continue
        seen.add(pid)
        out_p.append({"id": pid, "why": _clean_sentence(r.get("why"), base)})
    return {
        "summary": _clean_sentence(raw.get("summary"), base, 400),
        "venues": out_v[:6],
        "people": out_p[:5],
    }


def apply_ranking(result: dict[str, Any], ranking: dict[str, Any]) -> None:
    """Order the lists by the model's picks and attach its sentences."""
    for key, picks in (("venues", ranking["venues"]), ("colleagues", ranking["people"])):
        items = result[key]
        by_id = {i["id"]: i for i in items}
        picks = [p for p in picks if p["id"] in by_id]
        for rank, pick in enumerate(picks):
            item = by_id[pick["id"]]
            item["picked"] = True
            item["rank"] = rank + 1
            item["ai_why"] = pick["why"] or None
            if key == "venues":
                item["fit"] = pick["fit"]
        chosen = [by_id[p["id"]] for p in picks]
        rest = [i for i in items if i["id"] not in {c["id"] for c in chosen}]
        result[key] = chosen + rest
    result["summary"] = ranking["summary"] or None


def _blank_marks(result: dict[str, Any]) -> None:
    for item in [*result["venues"], *result["colleagues"]]:
        item.setdefault("picked", False)
        item.setdefault("ai_why", None)
    for v in result["venues"]:
        v.setdefault("fit", None)
    result.setdefault("summary", None)


# --- the introduction -------------------------------------------------------


def _draft_blocks(user: User, person: dict[str, Any], inp: dict[str, Any]) -> list[harness.DataBlock]:
    facts = {
        "sender": user.name,
        "sender_department": user.department,
        "recipient": person["name"],
        "recipient_department": person["department"],
        "recipient_papers": [{"title": p["title"], "year": p["year"]} for p in person["papers"][:3]],
        "papers_already_written_together": person["papers_together"],
        "co_authors_in_common": [s["name"] for s in person["shared_coauthors"][:3]],
    }
    return [
        _pasted(inp, 900),
        harness.DataBlock("facts from the college's database", json.dumps(facts, ensure_ascii=False), 4000),
    ]


def validate_draft(raw: Any) -> str:
    """The model's message, or "" when it cannot be used as it stands."""
    text = raw.get("message") if isinstance(raw, dict) else None
    if not isinstance(text, str):
        return ""
    text = _CONTROL.sub(" ", text).replace("\r\n", "\n").strip()
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    if not (40 <= len(text) <= 900):
        return ""
    if _URL.search(text) or _MONEY.search(text) or re.search(r"[<>{}]|```", text):
        return ""
    return text


def template_draft(user: User, person: dict[str, Any], inp: dict[str, Any]) -> str:
    """The message when there is no model: plain, from facts, and short."""
    if inp["title"]:
        about = f"I am working on a paper called “{inp['title'].rstrip('.')}”."
    else:
        about = f"I am working on this idea: {inp['text'][:120].rstrip()}…"
    first = person["papers"][0]
    body = [
        about,
        f"I read your paper “{first['title'][:100]}”"
        + (f" ({first['year']})" if first["year"] else "")
        + " and think our work overlaps.",
    ]
    if person["papers_together"]:
        body.append("We have written together before, so it would be good to do so again.")
    elif person["shared_coauthors"]:
        body.append(f"We have both written with {person['shared_coauthors'][0]['name']}.")
    body.append("Would you be open to a short conversation about whether we could write something together?")
    return "\n".join([f"Hello {person['name']},", "", " ".join(body), "", "Thank you,", user.name])


# --------------------------------------------------------------------------- #
# The answer a request gets                                                   #
# --------------------------------------------------------------------------- #


def ai_block(health: dict[str, Any], user: User) -> dict[str, Any]:
    limit = daily_limit()
    ready = bool(health.get("ready"))
    code = health.get("code")
    state = "ready" if ready else "off"
    detail = None
    if not ready:
        detail = OFF_TEXT if code in (None, "not_configured") else UNAVAILABLE_TEXT
    return {
        "state": state,
        "label": LABEL,
        "model": (health.get("model") or "") if ready else "",
        "host": (health.get("host") or "") if ready else "",
        "hosted": bool(health.get("hosted")) if ready else False,
        "detail": detail,
        "cached": False,
        "per_day": limit,
        "left": max(0, limit - used_today(user)),
    }


def _audit(user: User, action: str, feature: str, inp_hash: str, **detail: Any) -> None:
    AuditLog.objects.create(
        actor=user,
        action=action,
        entity="ResearchHelper",
        entity_id=inp_hash,
        detail_json=json.dumps({"feature": feature, **detail}, default=str),
    )


def respond(
    user: User, inp: dict[str, Any], *, use_ai: bool, refresh: bool = False
) -> dict[str, Any]:
    """The lists, and with `use_ai` the model's ranking of them."""
    result = json.loads(json.dumps(candidates(user, inp)))  # a copy the cache keeps clean
    for v in result["venues"]:
        v.pop("_issns", None)
    health = ai.health()
    block = ai_block(health, user)
    result["ai"] = block
    _blank_marks(result)
    if not use_ai or block["state"] != "ready" or not (result["venues"] or result["colleagues"]):
        return result

    model = block["model"]
    # The same input is answered from memory only while the candidates are
    # the same ones and carry the same warnings: a journal that has since
    # been watch-listed must not be served from a ranking made before.
    shape = hashlib.sha1(json.dumps(
        [[v["id"], (v["caution"] or {}).get("kind")] for v in result["venues"]]
        + [[p["id"]] for p in result["colleagues"]]).encode()).hexdigest()[:12]
    key = f"{inp['hash']}:{shape}"
    blocks = _rank_blocks(inp, result["venues"], result["colleagues"])
    # Only the ids this request retrieved may come back, whatever the model says.
    guards = [harness.grounded_ids([v["id"] for v in result["venues"]] + [p["id"] for p in result["colleagues"]], keys=("id",))]
    held = None if refresh else RANK.run(user=user, data_blocks=blocks, cache_key=key, guards=guards, cache_only=True)
    if held is not None:
        apply_ranking(result, validate_ranking(held.data, inp, result["venues"], result["colleagues"]))
        block.update(state="used", cached=True)
        _audit(user, ACTION_CACHED, "research_helper.rank", inp["hash"], model=model, cached=True)
        return result
    if used_today(user) >= daily_limit():
        block.update(state="limit", detail=(
            f"You have used your {daily_limit()} AI suggestions for today. "
            "The lists below are counted from the college's record."
        ))
        return result

    chars_in = sum(len(b.text) for b in blocks)
    started = time.monotonic()
    try:
        raw = RANK.run(user=user, data_blocks=blocks, cache_key=key, guards=guards, refresh=refresh).unwrap()
    except ai.AIError as exc:
        if exc.code in ("invalid", "unparsable"):
            # An answer that is not an object is a ranking with nothing in it:
            # the lists stand as counted, which is what the page always did.
            raw = {}
        else:
            raw = None
        if raw is not None:
            ranking = validate_ranking(raw, inp, result["venues"], result["colleagues"])
            apply_ranking(result, ranking)
            _audit(user, ACTION_CALL, "research_helper.rank", inp["hash"], model=model, host=block["host"],
                   outcome="ok", seconds=round(time.monotonic() - started, 1), chars_in=chars_in,
                   picked_venues=0, picked_people=0, cached=False)
            block.update(state="used", left=max(0, daily_limit() - used_today(user)))
            return result
        _audit(user, ACTION_CALL, "research_helper.rank", inp["hash"], model=model, host=block["host"],
               outcome="failed", code=exc.code, seconds=round(time.monotonic() - started, 1),
               chars_in=chars_in)
        block.update(state="failed", detail=FAILED_TEXT, left=max(0, daily_limit() - used_today(user)))
        return result
    ranking = validate_ranking(raw, inp, result["venues"], result["colleagues"])
    apply_ranking(result, ranking)
    _audit(user, ACTION_CALL, "research_helper.rank", inp["hash"], model=model, host=block["host"],
           outcome="ok", seconds=round(time.monotonic() - started, 1), chars_in=chars_in,
           picked_venues=len(ranking["venues"]), picked_people=len(ranking["people"]), cached=False)
    block.update(state="used", left=max(0, daily_limit() - used_today(user)))
    return result


def draft(user: User, inp: dict[str, Any], colleague_id: str, *, refresh: bool = False) -> dict[str, Any]:
    """A short introduction to one colleague the lists offered. Never sent."""
    cand = candidates(user, inp)
    person = next((p for p in cand["colleagues"] if p["user_id"] == colleague_id), None)
    if person is None:
        raise InputError("Pick a colleague from the list.")
    health = ai.health()
    block = ai_block(health, user)
    fast_ready = bool(health.get("fast_ready"))
    out = {
        "to": {"user_id": person["user_id"], "name": person["name"]},
        "message": template_draft(user, person, inp),
        "template": True,
        "ai": block,
    }
    if not fast_ready:
        return out
    model = health.get("fast_model") or block["model"]
    block["model"] = model
    key = f"{inp['hash']}:{colleague_id}"
    blocks = _draft_blocks(user, person, inp)
    held = None if refresh else DRAFT.run(user=user, data_blocks=blocks, cache_key=key, cache_only=True)
    cached = validate_draft(held.data) if held is not None else ""
    if cached:
        out.update(message=cached, template=False)
        block.update(state="used", cached=True)
        _audit(user, ACTION_CACHED, "research_helper.draft", inp["hash"], model=model, cached=True)
        return out
    if used_today(user) >= daily_limit():
        block.update(state="limit", detail=(
            f"You have used your {daily_limit()} AI suggestions for today. Here is a plain starting point."
        ))
        return out
    chars_in = sum(len(b.text) for b in blocks)
    started = time.monotonic()
    try:
        raw = DRAFT.run(user=user, data_blocks=blocks, cache_key=key, refresh=refresh).unwrap()
        message = validate_draft(raw)
    except ai.AIError as exc:
        _audit(user, ACTION_CALL, "research_helper.draft", inp["hash"], model=model, host=block["host"],
               outcome="failed", code=exc.code, seconds=round(time.monotonic() - started, 1), chars_in=chars_in)
        block.update(state="failed", detail=FAILED_TEXT, left=max(0, daily_limit() - used_today(user)))
        return out
    outcome = "ok" if message else "unusable"
    _audit(user, ACTION_CALL, "research_helper.draft", inp["hash"], model=model, host=block["host"],
           outcome=outcome, seconds=round(time.monotonic() - started, 1), chars_in=chars_in, cached=False)
    block["left"] = max(0, daily_limit() - used_today(user))
    if not message:
        block.update(state="failed", detail="The AI's message could not be used. Here is a plain starting point.")
        return out
    out.update(message=message, template=False)
    block["state"] = "used"
    return out


def record_feedback(user: User, *, part: str, value: str, input_hash: str) -> None:
    _audit(user, ACTION_FEEDBACK, f"research_helper.{part}", input_hash, value=value)
