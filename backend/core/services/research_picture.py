"""My research (past, present, future), the college's picture, and Discover's feed.

Everything here is counted from the publication record (`Publication` /
`Authorship`, built by harvest_publications + match_authors). No model, no
money. Each idea carries the reason it is there, in words, from the counts.

Known limit, said rather than hidden: OpenAlex gives a paper's *current*
citation count, not citations per calendar year, so "citations by year" is
citations earned by the papers published in each year.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import date
from typing import Any, Iterable, Optional

from django.utils import timezone

from core.models import Authorship, Claim, Follow, Publication, ResearchGoal, ResearchInterest, User
from core.services import coauthors as graph

#: Papers this far back count as "what you work on now".
NOW_YEARS = 3


def _topics(raw: str) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except ValueError:
        return []
    return [str(t).strip() for t in value if str(t).strip()] if isinstance(value, list) else []


def _fold(text: str) -> str:
    return " ".join((text or "").lower().split())


def h_index(cites: Iterable[int]) -> int:
    ranked = sorted((c for c in cites if c), reverse=True)
    return sum(1 for i, c in enumerate(ranked, start=1) if c >= i)


def _plural(n: int, word: str, many: Optional[str] = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


def _is_journal(kind: str) -> bool:
    k = _fold(kind)
    return not any(w in k for w in ("conference", "proceedings", "book", "chapter", "preprint"))


def _kind_label(kind: str) -> str:
    k = _fold(kind)
    if "conference" in k or "proceedings" in k:
        return "Conference"
    if "book" in k or "chapter" in k:
        return "Book / chapter"
    if "review" in k:
        return "Review"
    if "preprint" in k:
        return "Preprint"
    return "Journal article"


class _College:
    """The college's publication record in memory: one pass, reused."""

    def __init__(self) -> None:
        self.pubs: dict[str, dict[str, Any]] = {}
        rows = Authorship.objects.filter(is_college=True).values_list("publication_id", flat=True)
        ids = set(rows) | set(Authorship.objects.filter(user__isnull=False).values_list("publication_id", flat=True))
        for p in Publication.objects.filter(id__in=ids).values(
            "id", "title", "year", "date", "venue", "quartile", "citations", "topics_json", "type", "doi"
        ):
            p["topics"] = _topics(p.pop("topics_json"))
            p["members"] = set()
            self.pubs[p["id"]] = p
        self.users: dict[str, User] = {}
        member_rows = Authorship.objects.filter(publication_id__in=ids, user__isnull=False).values_list(
            "publication_id", "user_id"
        )
        for pid, uid in member_rows:
            self.pubs[pid]["members"].add(uid)
        uids = {u for p in self.pubs.values() for u in p["members"]}
        self.users = {u.id: u for u in User.objects.filter(id__in=uids)}

    def of(self, uid: str) -> list[dict[str, Any]]:
        return [p for p in self.pubs.values() if uid in p["members"]]


def _today() -> date:
    return timezone.localdate()


# --------------------------------------------------------------------------- #
# /me/research                                                                #
# --------------------------------------------------------------------------- #


def my_research(user: User, college: Optional[_College] = None) -> dict[str, Any]:
    today = _today()
    college = college or _College()
    mine_rows = list(
        Authorship.objects.filter(user=user)
        .select_related("publication")
        .order_by("publication__year", "publication__date")
    )
    seen: set[str] = set()
    pubs = []
    for a in mine_rows:
        p = a.publication
        if p.id in seen:
            continue
        seen.add(p.id)
        pubs.append((p, a.position))
    all_auth = defaultdict(list)
    for pid, uid, college_flag, inst in Authorship.objects.filter(publication_id__in=seen).values_list(
        "publication_id", "user_id", "is_college", "institution_name"
    ):
        all_auth[pid].append((uid, college_flag, inst))

    cites = [p.citations or 0 for p, _ in pubs]
    q1 = sum(1 for p, _ in pubs if (p.quartile or "").upper() == "Q1")
    first = sum(1 for _, pos in pubs if pos == 1)

    # ---- past ---------------------------------------------------------------
    by_year_papers: Counter[int] = Counter(p.year for p, _ in pubs if p.year)
    by_year_cites: Counter[int] = Counter()
    for p, _ in pubs:
        if p.year:
            by_year_cites[p.year] += p.citations or 0
    years = sorted(by_year_papers)
    span = list(range(years[0], today.year + 1)) if years else []
    strip = Counter(
        f"{p.date.year:04d}-{p.date.month:02d}" if p.date else f"{p.year:04d}-01" for p, _ in pubs if p.year
    )

    timeline: list[dict[str, Any]] = []
    if pubs:
        p0 = next((p for p, _ in pubs if p.year), None)
        if p0:
            timeline.append({"year": p0.year, "kind": "first_paper", "text": f"First paper: {p0.title}",
                             "ref": p0.id})
        fq1 = next((p for p, _ in pubs if (p.quartile or "").upper() == "Q1" and p.year), None)
        if fq1:
            timeline.append({"year": fq1.year, "kind": "first_q1",
                             "text": f"First Q1 paper, in {fq1.venue or 'a Q1 journal'}", "ref": fq1.id})
        ffa = next((p for p, pos in pubs if pos == 1 and p.year), None)
        if ffa:
            timeline.append({"year": ffa.year, "kind": "first_author",
                             "text": f"First paper as first author: {ffa.title}", "ref": ffa.id})
        ext = next(
            ((p, inst) for p, _ in pubs if p.year
             for uid, cf, inst in all_auth[p.id] if not uid and not cf and inst),
            None,
        )
        if ext:
            timeline.append({"year": ext[0].year, "kind": "external_coauthor",
                             "text": f"First paper with a co-author outside the college ({ext[1]})",
                             "ref": ext[0].id})
        top = max(pubs, key=lambda x: x[0].citations or 0)[0]
        if (top.citations or 0) > 0 and top.year:
            timeline.append({"year": top.year, "kind": "most_cited",
                             "text": f"Most-cited paper ({_plural(top.citations, 'citation')}): {top.title}",
                             "ref": top.id})
        for y in years:
            n = by_year_papers[y]
            timeline.append({"year": y, "kind": "year", "text": f"{_plural(n, 'paper')} published", "ref": None})
        running = 0
        for p, _ in pubs:
            running += 1
            if running in (10, 25, 50, 100) and p.year:
                timeline.append({"year": p.year, "kind": "milestone", "text": f"{running}th paper", "ref": p.id})

    top_papers = [
        {"id": p.id, "title": p.title, "year": p.year, "venue": p.venue or None, "citations": p.citations or 0,
         "quartile": p.quartile or None, "doi": p.doi, "position": pos, "authors": len(all_auth[p.id])}
        for p, pos in sorted(pubs, key=lambda x: -(x[0].citations or 0))[:5]
        if (p.citations or 0) > 0
    ]

    # ---- present -------------------------------------------------------------
    recent_from = today.year - NOW_YEARS + 1
    topic_all: Counter[str] = Counter()
    topic_now: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    for p, _ in pubs:
        for t in _topics(p.topics_json):
            k = _fold(t)
            spelled.setdefault(k, t)
            topic_all[k] += 1
            if (p.year or 0) >= recent_from:
                topic_now[k] += 1
    topics = [
        {"id": k, "label": spelled[k], "papers": n, "recent": topic_now.get(k, 0)}
        for k, n in topic_all.most_common(12)
    ]

    venue_count: Counter[str] = Counter()
    venue_q: dict[str, str] = {}
    venue_name: dict[str, str] = {}
    for p, _ in pubs:
        if p.venue:
            k = _fold(p.venue)
            venue_name.setdefault(k, p.venue)
            venue_count[k] += 1
            if p.quartile:
                venue_q[k] = p.quartile
    venue_colleagues: dict[str, set[str]] = defaultdict(set)
    for p in college.pubs.values():
        if p["venue"]:
            venue_colleagues[_fold(p["venue"])] |= p["members"] - {user.id}
    venues = [
        {"id": k, "name": venue_name[k], "quartile": venue_q.get(k), "papers": n,
         "colleagues": len(venue_colleagues.get(k, ()))}
        for k, n in venue_count.most_common(6)
    ]
    mix: Counter[str] = Counter(_kind_label(p.type) for p, _ in pubs)

    co = graph.coauthors(user)

    # ---- this year (docs/ux/13) ----------------------------------------------
    same_day_last = date(today.year - 1, today.month, min(today.day, 28))
    this_year = sum(1 for p, _ in pubs if p.year == today.year)
    last_by_now = sum(
        1 for p, _ in pubs
        if p.year == today.year - 1 and (p.date is None or p.date <= same_day_last)
    )
    last_total = by_year_papers.get(today.year - 1, 0)
    goal = ResearchGoal.objects.filter(user=user, year=today.year, metric=ResearchGoal.Metric.PAPERS).first()
    under_review = Claim.objects.filter(owner=user, status__in=(
        "SUBMITTED", "CLEARED", "PRINCIPAL_APPROVED", "DIRECTOR_APPROVED", "HOD_APPROVED", "RESEARCH_APPROVED",
    )).count()
    drafts = Claim.objects.filter(owner=user, status="DRAFT").count()

    headline = None
    if topics:
        names = [t["label"] for t in sorted(topics, key=lambda t: (-t["recent"], -t["papers"]))[:2]]
        headline = f"You write about {names[0]}" + (f" and {names[1]}." if len(names) > 1 else ".")

    return {
        "headline": headline,
        "headline_is_custom": False,
        "metrics": {
            "papers": len(pubs),
            "citations": sum(cites) if pubs else None,
            "h_index": h_index(cites) if pubs else None,
            "i10_index": sum(1 for c in cites if c >= 10) if pubs else None,
            "q1": q1,
            "first_author": first,
            "first_year": years[0] if years else None,
            "cited_papers": sum(1 for c in cites if c),
        },
        "papers_by_year": [{"year": y, "count": by_year_papers.get(y, 0)} for y in span],
        "citations_by_year": [{"year": y, "count": by_year_cites.get(y, 0)} for y in span],
        "strip": [{"month": m, "papers": n} for m, n in sorted(strip.items())],
        "timeline": timeline,
        "top_papers": top_papers,
        "topics": topics,
        "venues": venues,
        "mix": dict(mix),
        "coauthors": {
            "inside_count": co["inside_count"],
            "outside_count": co["outside_count"],
            "inside": co["inside"][:6],
            "outside": co["outside"][:6],
        },
        "this_year": {
            "year": today.year,
            "papers": this_year,
            "same_date_last_year": last_by_now,
            "last_year_total": last_total,
            "target": goal.target if goal else None,
            "quota": user.research_quota if user.faculty_type == "RESEARCH" else None,
            "under_review": under_review,
            "drafts": drafts,
        },
        "ideas": ideas_for(user, college, pubs=[p for p, _ in pubs], coauthor_ids={
            c["user_id"] for c in co["inside"] if c["user_id"]}),
    }


# --------------------------------------------------------------------------- #
# Ideas: rising topics, venues that fit, partners who complete you             #
# --------------------------------------------------------------------------- #


def _topic_growth(college: _College, today: date) -> tuple[Counter, Counter, dict[str, str]]:
    """Papers per topic in the last 12 months, and in the 12 before that."""
    now: Counter[str] = Counter()
    before: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    cut = today.toordinal()
    for p in college.pubs.values():
        d = p["date"] or (date(p["year"], 7, 1) if p["year"] else None)
        if not d:
            continue
        age = cut - d.toordinal()
        for t in p["topics"]:
            k = _fold(t)
            spelled.setdefault(k, t)
            if 0 <= age < 365:
                now[k] += 1
            elif 365 <= age < 730:
                before[k] += 1
    return now, before, spelled


def ideas_for(user: User, college: _College, *, pubs: list[Publication], coauthor_ids: set[str],
              limit: int = 3) -> list[dict[str, Any]]:
    today = _today()
    my_topics = Counter(_fold(t) for p in pubs for t in _topics(p.topics_json))
    followed = {_fold(d) for d in ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)}
    followed |= {_fold(t) for t in Follow.objects.filter(follower=user, topic__isnull=False)
                 .values_list("topic", flat=True)}
    mine_keys = set(my_topics) | followed
    if not mine_keys:
        return []
    ideas: list[dict[str, Any]] = []

    # A rising topic next to mine: shares a paper with one of my topics, grew.
    near: Counter[str] = Counter()
    for p in college.pubs.values():
        ks = {_fold(t) for t in p["topics"]}
        if ks & mine_keys:
            for k in ks - mine_keys:
                near[k] += 1
    now, before, spelled = _topic_growth(college, today)
    rising = sorted(
        (k for k in near if now.get(k, 0) >= 2 and now[k] > before.get(k, 0)),
        key=lambda k: (-(now[k] - before.get(k, 0)), -near[k]),
    )
    if rising:
        k = rising[0]
        by_co = sum(1 for p in college.pubs.values()
                    if k in {_fold(t) for t in p["topics"]} and p["members"] & coauthor_ids)
        bits = [f"{_plural(now[k], 'paper')} here in the last 12 months"]
        if before.get(k):
            bits.append(f"up from {before[k]}")
        if by_co:
            bits.append(f"{by_co} by people you have written with")
        ideas.append({
            "kind": "topic", "id": k, "title": spelled.get(k, k),
            "reason": ", ".join(bits) + f"; it sits next to {_near_label(k, college, mine_keys, spelled)}.",
            "source": "counted", "to": f"/search?scope=topics&q={spelled.get(k, k)}",
        })

    # A venue that fits: colleagues published my topics there; I have not.
    my_venues = {_fold(p.venue) for p in pubs if p.venue}
    venue_fit: dict[str, dict[str, Any]] = {}
    for p in college.pubs.values():
        v = _fold(p["venue"])
        if not v or v in my_venues or user.id in p["members"]:
            continue
        shared = {_fold(t) for t in p["topics"]} & mine_keys
        if not shared:
            continue
        slot = venue_fit.setdefault(v, {"name": p["venue"], "quartile": None, "papers": 0, "people": set(),
                                        "topics": Counter()})
        slot["papers"] += 1
        slot["people"] |= p["members"]
        if p["quartile"]:
            slot["quartile"] = p["quartile"]
        for t in shared:
            slot["topics"][t] += 1
    qrank = {"Q1": 0, "Q2": 1, "Q3": 2, "Q4": 3}
    fits = sorted(venue_fit.values(), key=lambda s: (qrank.get((s["quartile"] or "").upper(), 4), -s["papers"]))
    if fits:
        f = fits[0]
        tnames = [spelled.get(t, t) for t, _ in f["topics"].most_common(2)]
        ideas.append({
            "kind": "venue", "id": _fold(f["name"]), "title": f["name"], "quartile": f["quartile"],
            "reason": (f"Publishes {', '.join(tnames)}; {_plural(len(f['people']), 'colleague')} "
                       f"published {_plural(f['papers'], 'paper')} there on your topics."),
            "source": "counted", "to": f"/search?scope=journals&q={f['name']}",
        })

    # A partner who completes you: shares a topic, not yet a co-author.
    two_hop: dict[str, str] = {}
    for p in college.pubs.values():
        if p["members"] & coauthor_ids:
            for m in p["members"] - coauthor_ids - {user.id}:
                via = next(iter(p["members"] & coauthor_ids))
                two_hop.setdefault(m, via)
    cand: dict[str, Counter] = defaultdict(Counter)
    for p in college.pubs.values():
        ks = {_fold(t) for t in p["topics"]} & mine_keys
        for m in p["members"] - coauthor_ids - {user.id}:
            for k in ks:
                cand[m][k] += 1
    ranked = sorted(cand, key=lambda m: (-(m in two_hop), -sum(cand[m].values())))
    for m in ranked[:1]:
        person = college.users.get(m)
        if not person:
            continue
        shared = [spelled.get(k, k) for k, _ in cand[m].most_common(2)]
        via = college.users.get(two_hop.get(m, ""))
        reason = f"Writes on {', '.join(shared)}, as you do"
        if person.department and person.department != user.department:
            reason += f", from {person.department}"
        reason += "." + (f" You know them through {via.name}." if via else "")
        ideas.append({
            "kind": "person", "id": m, "title": person.name, "department": person.department,
            "via": {"id": via.id, "name": via.name} if via else None,
            "reason": reason, "source": "counted", "to": f"/u/{m}",
        })
    return ideas[:limit]


def _near_label(k: str, college: _College, mine: set[str], spelled: dict[str, str]) -> str:
    co: Counter[str] = Counter()
    for p in college.pubs.values():
        ks = {_fold(t) for t in p["topics"]}
        if k in ks:
            for m in ks & mine:
                co[m] += 1
    best = co.most_common(1)
    return f"your work on {spelled.get(best[0][0], best[0][0])}" if best else "your work"


# --------------------------------------------------------------------------- #
# /college/research                                                           #
# --------------------------------------------------------------------------- #


def college_research(user: User, college: Optional[_College] = None) -> dict[str, Any]:
    today = _today()
    college = college or _College()
    pubs = list(college.pubs.values())
    topic_n: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    for p in pubs:
        for t in p["topics"]:
            k = _fold(t)
            spelled.setdefault(k, t)
            topic_n[k] += 1
    now, before, _ = _topic_growth(college, today)
    mine = {_fold(t) for p in college.of(user.id) for t in p["topics"]}
    topics = [
        {"id": k, "label": spelled[k], "papers": n, "now": now.get(k, 0), "before": before.get(k, 0),
         "growth": now.get(k, 0) - before.get(k, 0), "mine": k in mine}
        for k, n in topic_n.most_common(24)
    ]
    rising = sorted(
        ({"id": k, "label": spelled[k], "now": now[k], "before": before.get(k, 0)}
         for k in now if now[k] >= 3 and now[k] > before.get(k, 0)),
        key=lambda r: (-(r["now"] - r["before"]), -r["now"]),
    )[:5]

    dept_papers: dict[str, set[str]] = defaultdict(set)
    dept_topic: Counter[tuple[str, str]] = Counter()
    top10 = [t["id"] for t in topics[:10]]
    for p in pubs:
        depts = {college.users[m].department for m in p["members"] if m in college.users
                 and college.users[m].department}
        ks = {_fold(t) for t in p["topics"]}
        for d in depts:
            dept_papers[d].add(p["id"])
            for k in ks & set(top10):
                dept_topic[(d, k)] += 1
    depts = sorted(dept_papers, key=lambda d: -len(dept_papers[d]))[:12]

    near: list[dict[str, Any]] = []
    if mine:
        score: dict[str, Counter] = defaultdict(Counter)
        for p in pubs:
            for k in {_fold(t) for t in p["topics"]} & mine:
                for m in p["members"] - {user.id}:
                    score[m][k] += 1
        for m in sorted(score, key=lambda m: -sum(score[m].values()))[:6]:
            u = college.users.get(m)
            if not u:
                continue
            near.append({
                "id": u.id, "name": u.name, "department": u.department, "designation": u.designation,
                "papers": sum(score[m].values()),
                "reason": f"{_plural(sum(score[m].values()), 'paper')} on "
                          f"{', '.join(spelled[k] for k, _ in score[m].most_common(2))}",
            })

    years = Counter(p["year"] for p in pubs if p["year"])
    return {
        "totals": {
            "papers": len(pubs),
            "people": len({m for p in pubs for m in p["members"]}),
            "departments": len(dept_papers),
            "this_year": years.get(today.year, 0),
            "last_year": years.get(today.year - 1, 0),
            "citations": sum(p["citations"] or 0 for p in pubs),
        },
        "papers_by_year": [{"year": y, "count": years[y]} for y in sorted(years) if y >= today.year - 9],
        "topics": topics,
        "rising": rising,
        "departments": [{"name": d, "papers": len(dept_papers[d])} for d in depts],
        "dept_topic": [{"dept": d, "topic": k, "papers": n} for (d, k), n in dept_topic.items() if d in depts],
        "near_me": near,
        "my_topics": sorted(mine),
    }


# --------------------------------------------------------------------------- #
# /discover/for-you                                                           #
# --------------------------------------------------------------------------- #


def for_you(user: User, next_things: dict[str, Any], college: Optional[_College] = None) -> dict[str, Any]:
    """One magazine feed in a fixed rhythm: feature, venue, 3 people/papers, repeat.

    `next_things` is `suggestions.for_person(user)`; its people, journals and
    topics are woven in with rising topics and fresh papers from the record.
    """
    today = _today()
    college = college or _College()
    mine_pubs = college.of(user.id)
    my_topics = Counter(_fold(t) for p in mine_pubs for t in p["topics"])
    followed = {_fold(d): d for d in ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)}
    for t in Follow.objects.filter(follower=user, topic__isnull=False).values_list("topic", flat=True):
        followed[_fold(t)] = t
    keys = set(my_topics) | set(followed)
    now, before, spelled = _topic_growth(college, today)

    directions: list[dict[str, Any]] = []
    for k in sorted((k for k in now if now[k] >= 2), key=lambda k: -(now[k] - before.get(k, 0))):
        adjacent = sum(1 for p in college.pubs.values()
                       if k in {_fold(t) for t in p["topics"]} and ({_fold(t) for t in p["topics"]} & keys))
        if keys and not adjacent:
            continue
        mine_n = my_topics.get(k, 0)
        why = (f"You have {_plural(mine_n, 'paper')} here." if mine_n
               else f"{_plural(adjacent, 'paper')} here also touch your topics." if keys
               else "One of the busiest topics at the college this year.")
        growth = (round(100 * (now[k] - before[k]) / before[k]) if before.get(k) else None)
        directions.append({
            "kind": "direction", "id": f"topic:{k}", "title": spelled.get(k, k), "why": why, "source": "counted",
            "payload": {"papers": now[k], "before": before.get(k, 0), "growth_pct": growth, "topic": spelled.get(k, k),
                        "spark": _topic_spark(college, k, today)},
        })
        if len(directions) >= 6:
            break
    for t in next_things.get("topics", [])[:3]:
        k = _fold(t["area"])
        if any(d["id"] == f"topic:{k}" for d in directions):
            continue
        directions.append({"kind": "direction", "id": f"topic:{k}", "title": t["area"], "why": t["reason"],
                           "source": "counted", "payload": {"papers": t.get("alongside"), "topic": t["area"]}})

    venues = [
        {"kind": "venue", "id": f"venue:{_fold(j['title'])}", "title": j["title"], "why": j["reason"],
         "source": "counted", "payload": {"quartile": j.get("quartile"), "colleagues": j.get("colleagues"),
                                          "areas": j.get("areas", [])}}
        for j in next_things.get("journals", [])
    ]
    people = [
        {"kind": "person", "id": f"person:{p['id']}", "title": p["name"],
         "why": (p.get("reasons") or ["Works near your topics."])[0], "source": "counted",
         "payload": {"user_id": p["id"], "department": p.get("department"), "designation": p.get("designation"),
                     "papers": p.get("papers"), "affiliation": "Saveetha"}}
        for p in next_things.get("people", [])
    ]
    papers = []
    fresh = sorted(
        (p for p in college.pubs.values() if user.id not in p["members"] and p["year"]
         and p["year"] >= today.year - 1 and (not keys or {_fold(t) for t in p["topics"]} & keys)),
        key=lambda p: (p["date"] or date(p["year"], 1, 1)),
        reverse=True,
    )[:12]
    for p in fresh:
        shared = [spelled.get(_fold(t), t) for t in p["topics"] if _fold(t) in keys][:1]
        authors = [college.users[m] for m in p["members"] if m in college.users]
        who = authors[0] if authors else None
        papers.append({
            "kind": "paper", "id": f"paper:{p['id']}", "title": p["title"],
            "why": (f"In your topic {shared[0]}" if shared else "New at the college") +
                   (f" · by {who.name}" + (f" ({who.department})" if who.department else "") if who else ""),
            "source": "counted",
            "payload": {"venue": p["venue"] or None, "year": p["year"], "quartile": p["quartile"] or None,
                        "doi": p["doi"], "authors": [a.name for a in authors][:4]},
        })

    feed: list[dict[str, Any]] = []
    d, v, mixed = list(directions), list(venues), []
    for a, b in zip(people, papers):
        mixed += [a, b]
    longer = people if len(people) > len(papers) else papers
    mixed += longer[min(len(people), len(papers)):]
    while d or v or mixed:
        if d:
            feed.append(d.pop(0))
        if v:
            feed.append(v.pop(0))
        feed += mixed[:3]
        mixed = mixed[3:]
    return {
        "items": feed,
        "counts": {"directions": len(directions), "venues": len(venues), "people": len(people),
                   "papers": len(papers)},
        "tuned_to": sorted(followed.values()),
        "my_topics": [spelled.get(k, k) for k, _ in my_topics.most_common(5)],
        "grounded_on": {"papers": len(mine_pubs), "followed": len(followed)},
    }


def _topic_spark(college: _College, k: str, today: date) -> list[int]:
    years = list(range(today.year - 5, today.year + 1))
    c: Counter[int] = Counter(
        p["year"] for p in college.pubs.values() if p["year"] in years and k in {_fold(t) for t in p["topics"]}
    )
    return [c.get(y, 0) for y in years]
