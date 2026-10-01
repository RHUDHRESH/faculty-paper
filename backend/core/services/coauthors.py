"""Who wrote with whom: co-authors, connection paths and outside authors.

A *node* is a person in the co-author graph:

- ``u:<user id>`` -- a college member (an authorship matched to a User);
- the authorship's ``author_key`` otherwise -- an OpenAlex author id such as
  ``A5064642423``, or ``n:<normalised name>`` when OpenAlex gave none.

Two nodes are joined by every paper they share. Everything here reads
authorships only; nothing touches a claim's money.
"""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Any, Iterable

from django.conf import settings
from django.db.models import Q

from core.models import Authorship, Publication, User
from core.services.normalize import clean_venue


def _membership(*, has_account: bool, at_college: bool) -> dict[str, bool]:
    """The two different things "college member" used to mean at once.

    ``has_account``: matched to a person who has an account on this app (they can
    be messaged and followed). ``at_college``: an author of the college, with or
    without an account (a colleague who has never signed in is still one).
    ``is_college_member`` is the old name for ``has_account``, kept so nothing
    reading it breaks; new copy should read the other two, because "Saveetha, not
    on this app" is a fact about ``has_account`` and "colleague" is one about
    ``at_college``.
    """
    return {"has_account": has_account, "at_college": at_college or has_account,
            "is_college_member": has_account}


def node_of(user_id: str | None, author_key: str) -> str:
    return f"u:{user_id}" if user_id else author_key


def resolve_node(value: str) -> str | None:
    """A user id, ``u:<user id>`` or an external author key -> a node, or None."""
    value = (value or "").strip()
    if not value:
        return None
    uid = value[2:] if value.startswith("u:") else value
    if User.objects.filter(id=uid).exists():
        return f"u:{uid}"
    if Authorship.objects.filter(user__isnull=True, author_key=value).exists():
        return value
    return None


def _node_filter(nodes: Iterable[str]) -> Q:
    users = [n[2:] for n in nodes if n.startswith("u:")]
    keys = [n for n in nodes if not n.startswith("u:")]
    q = Q(pk__in=[])
    if users:
        q |= Q(user_id__in=users)
    if keys:
        q |= Q(user__isnull=True, author_key__in=keys)
    return q


def publications_of(nodes: Iterable[str]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for pid, uid, key in Authorship.objects.filter(_node_filter(list(nodes))).values_list(
        "publication_id", "user_id", "author_key"
    ):
        out[node_of(uid, key)].add(pid)
    return out


def coauthors(user: User) -> dict[str, Any]:
    me = f"u:{user.id}"
    mine = publications_of([me]).get(me, set())
    people: dict[str, dict[str, Any]] = {}
    rows = (
        Authorship.objects.filter(publication_id__in=mine)
        .exclude(user_id=user.id)
        .values_list("publication_id", "user_id", "author_key", "display_name", "is_college",
                     "institution_name", "institution_country", "publication__year")
    )
    rows = list(rows)
    from core.services.author_names import name_score

    # Linked colleagues on these papers, to fold their unlinked name variants into.
    linked_names: dict[str, str] = {}
    for _pid, uid, *_rest in rows:
        if uid:
            linked_names.setdefault(uid, "")
    for u in User.objects.filter(id__in=list(linked_names)).only("id", "name"):
        linked_names[u.id] = u.name
    for pid, uid, key, name, college, inst, country, year in rows:
        if not uid:
            # Their own name on their own paper is them, never a co-author.
            if name_score(user.name, name) >= 0.85:
                continue
            fits = [i for i, n in linked_names.items() if n and name_score(n, name) >= 0.85]
            if len(fits) == 1:
                uid = fits[0]
        node = node_of(uid, key)
        p = people.setdefault(node, {"key": node, "user_id": uid, "name": name, "inside": False,
                                     "papers": set(), "first_year": None, "last_year": None,
                                     "institutions": set(), "countries": set()})
        p["papers"].add(pid)
        p["inside"] = p["inside"] or bool(uid) or college
        if inst:
            p["institutions"].add(inst)
        if country:
            p["countries"].add(country)
        if year:
            p["first_year"] = min(filter(None, [p["first_year"], year]))
            p["last_year"] = max(filter(None, [p["last_year"], year]))
    users = {u.id: u for u in User.objects.filter(id__in=[p["user_id"] for p in people.values() if p["user_id"]])}
    inside, outside = [], []
    for p in people.values():
        u = users.get(p["user_id"])
        item = {
            "key": p["key"],
            "user_id": p["user_id"],
            "name": u.name if u else p["name"],
            "department": (u.department if u else None),
            "papers_together": len(p["papers"]),
            "first_year_together": p["first_year"],
            "last_year_together": p["last_year"],
            "institutions": sorted(p["institutions"]),
            "countries": sorted(p["countries"]),
            **_membership(has_account=bool(u), at_college=p["inside"]),
        }
        (inside if p["inside"] else outside).append(item)
    order = lambda i: (-i["papers_together"], -(i["last_year_together"] or 0), i["name"])  # noqa: E731
    inside.sort(key=order)
    outside.sort(key=order)
    return {
        "user_id": user.id,
        "publications": len(mine),
        "inside_count": len(inside),
        "outside_count": len(outside),
        "inside": inside,
        "outside": outside,
    }


MAX_PATHS = 5


def connection(source: str, target: str, *, max_hops: int = 3) -> dict[str, Any]:
    """Shortest co-author paths from `source` to `target`, up to `max_hops`
    papers long, with the papers that make each link."""
    if source == target:
        return {"hops": 0, "paths": []}
    parents: dict[str, list[tuple[str, str]]] = {source: []}
    frontier = {source}
    found = False
    hops = 0
    while frontier and hops < max_hops and not found:
        hops += 1
        pubs_by_node = publications_of(frontier)
        pub_to_nodes: dict[str, set[str]] = defaultdict(set)
        for node, pubs in pubs_by_node.items():
            for pid in pubs:
                pub_to_nodes[pid].add(node)
        next_frontier: set[str] = set()
        for pid, uid, key in Authorship.objects.filter(publication_id__in=list(pub_to_nodes)).values_list(
            "publication_id", "user_id", "author_key"
        ):
            node = node_of(uid, key)
            if node in parents and node not in next_frontier:
                continue
            for prev in pub_to_nodes[pid]:
                if prev == node:
                    continue
                parents.setdefault(node, [])
                if (prev, pid) not in parents[node]:
                    parents[node].append((prev, pid))
                next_frontier.add(node)
        found = target in next_frontier
        frontier = next_frontier
    if not found:
        return {"hops": None, "paths": [], "searched_hops": hops}

    paths: list[list[tuple[str, str | None]]] = []

    def walk(node: str, tail: list[tuple[str, str | None]]) -> None:
        if len(paths) >= MAX_PATHS:
            return
        if node == source:
            paths.append([(source, None)] + tail)
            return
        seen_prev = set()
        for prev, pid in parents.get(node, []):
            if prev in {n for n, _ in tail} or (prev, pid) in seen_prev:
                continue
            seen_prev.add((prev, pid))
            walk(prev, [(node, pid)] + tail)

    walk(target, [])
    # Collapse paths that differ only in which shared paper links a pair.
    grouped: dict[tuple[str, ...], list[list[tuple[str, str | None]]]] = defaultdict(list)
    for p in paths:
        grouped[tuple(n for n, _ in p)].append(p)
    nodes = {n for key in grouped for n in key}
    names = _describe(nodes)
    pubs = {pid for p in paths for _, pid in p if pid}
    pub_info = {
        p.id: {"id": p.id, "title": p.title, "year": p.year, "doi": p.doi}
        for p in Publication.objects.filter(id__in=pubs).only("id", "title", "year", "doi")
    }
    out = []
    for key, variants in grouped.items():
        steps = []
        for i, node in enumerate(key):
            papers = []
            if i:
                papers = sorted({v[i][1] for v in variants if v[i][1]})
            steps.append({**names[node], "via": [pub_info[p] for p in papers if p in pub_info]})
        out.append({"people": steps})
    return {"hops": hops, "paths": out}


def _describe(nodes: set[str]) -> dict[str, dict[str, Any]]:
    users = {u.id: u for u in User.objects.filter(id__in=[n[2:] for n in nodes if n.startswith("u:")])}
    out = {}
    for n in nodes:
        if n.startswith("u:"):
            u = users.get(n[2:])
            out[n] = {"key": n, "user_id": n[2:], "name": u.name if u else "", "department": u.department if u else None,
                      "photo_url": f"{settings.MEDIA_URL}{u.photo}" if u and u.photo else None,
                      **_membership(has_account=True, at_college=True),
                      "institution": "Saveetha Engineering College"}
    external = [n for n in nodes if not n.startswith("u:")]
    for key, name, inst, college in (
        Authorship.objects.filter(user__isnull=True, author_key__in=external)
        .values_list("author_key", "display_name", "institution_name", "is_college")
    ):
        if key not in out:
            out[key] = {"key": key, "user_id": None, "name": name, "department": None,
                        **_membership(has_account=False, at_college=bool(college)),
                        "institution": inst, "college_affiliated": college}
    return out


def search_external(q: str, *, limit: int = 20) -> list[dict[str, Any]]:
    """Authors outside the college's roster by name, and who here wrote with them."""
    q = " ".join((q or "").split())
    if len(q) < 2:
        return []
    groups: dict[str, dict[str, Any]] = {}
    for key, name, inst, country, college, pid in (
        Authorship.objects.filter(user__isnull=True, display_name__icontains=q)
        .values_list("author_key", "display_name", "institution_name", "institution_country", "is_college",
                     "publication_id")[:2000]
    ):
        g = groups.setdefault(key, {"key": key, "name": name, "institutions": set(), "countries": set(),
                                    "papers": set(), "college_affiliated": False})
        g["papers"].add(pid)
        g["college_affiliated"] |= college
        if inst:
            g["institutions"].add(inst)
        if country:
            g["countries"].add(country)
    ranked = sorted(groups.values(), key=lambda g: -len(g["papers"]))[:limit]
    pubs = {p for g in ranked for p in g["papers"]}
    members: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for pid, uid in Authorship.objects.filter(publication_id__in=pubs, user__isnull=False).values_list(
        "publication_id", "user_id"
    ):
        members[pid][uid] += 1
    users = {u.id: u for u in User.objects.filter(id__in={u for m in members.values() for u in m})}
    out = []
    for g in ranked:
        with_whom: dict[str, int] = defaultdict(int)
        for pid in g["papers"]:
            for uid in members.get(pid, {}):
                with_whom[uid] += 1
        out.append({
            "key": g["key"],
            "name": g["name"],
            "institutions": sorted(g["institutions"]),
            "countries": sorted(g["countries"]),
            "papers": len(g["papers"]),
            "college_affiliated": g["college_affiliated"],
            "college_coauthors": sorted(
                ({"user_id": uid, "name": users[uid].name, "department": users[uid].department, "papers_together": n}
                 for uid, n in with_whom.items() if uid in users),
                key=lambda x: -x["papers_together"],
            ),
        })
    return out


def _node_rows_for_pubs(pubs: Iterable[str]):
    for pid, uid, key in Authorship.objects.filter(publication_id__in=list(pubs)).values_list(
        "publication_id", "user_id", "author_key"
    ):
        yield node_of(uid, key), pid


def external_person(key: str) -> dict[str, Any] | None:
    """An author outside the roster: who they are, their papers in the record
    (with the college authors on each) and who in the college wrote with them."""
    rows = list(
        Authorship.objects.filter(user__isnull=True, author_key=key).values_list(
            "publication_id", "display_name", "institution_name", "institution_country", "is_college", "orcid",
            "openalex_author_id",
        )
    )
    if not rows:
        return None
    pubs = {r[0] for r in rows}
    names = sorted({r[1] for r in rows if r[1]}, key=lambda n: -len(n))
    orcid = next((r[5] for r in rows if r[5]), "")
    openalex = next((r[6] for r in rows if r[6]), "") or (key if key[:1] == "A" and key[1:].isdigit() else "")
    members: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for pid, uid, name in (
        Authorship.objects.filter(publication_id__in=pubs, user__isnull=False)
        .order_by("position").values_list("publication_id", "user_id", "user__name")
    ):
        members[pid].append({"user_id": uid, "name": name})
    with_whom: dict[str, dict[str, Any]] = {}
    papers = []
    for p in Publication.objects.filter(id__in=pubs).order_by("-year", "title").only(
        "id", "title", "year", "venue", "quartile", "doi", "citations"
    ):
        college = members.get(p.id, [])
        papers.append({"id": p.id, "title": p.title, "year": p.year, "venue": p.venue, "quartile": p.quartile,
                       "doi": p.doi, "citations": p.citations, "college_authors": college})
        for m in college:
            w = with_whom.setdefault(m["user_id"], {**m, "department": None, "papers_together": 0})
            w["papers_together"] += 1
    for u in User.objects.filter(id__in=list(with_whom)).only("id", "department"):
        with_whom[u.id]["department"] = u.department
    return {
        "key": key,
        "name": names[0] if names else key,
        "institutions": sorted({r[2] for r in rows if r[2]}),
        "countries": sorted({r[3] for r in rows if r[3]}),
        "orcid": orcid,
        "openalex_id": openalex,
        "college_affiliated": any(r[4] for r in rows),
        "papers_count": len(papers),
        "papers": papers,
        "college_coauthors": sorted(with_whom.values(), key=lambda w: (-w["papers_together"], w["name"])),
    }


EGO_MAX = 60


def _second_step(mine: set[str], hop1: set[str], known: set[str], seats: int) -> dict[str, int]:
    """The best `seats` people who wrote with someone in `hop1` but not with me
    (`known` is me and everyone who has: they are the first step, not the second).

    Ranked so the ones worth an introduction come first: colleagues of the
    college before outside authors, then those reached through the most of my
    co-authors (three people vouching beat one), then the most papers with them.
    A 400-author consortium paper adds many names but each reaches me through
    one co-author only, so it cannot crowd out a real neighbour.
    """
    their = publications_of(hop1)
    via: dict[str, set[str]] = defaultdict(set)  # paper -> my co-authors on it
    for node, pubs in their.items():
        for pid in pubs:
            via[pid].add(node)
    reach: dict[str, set[str]] = defaultdict(set)  # candidate -> my co-authors they reach
    papers: dict[str, set[str]] = defaultdict(set)
    at_college: dict[str, bool] = defaultdict(bool)
    for pid, uid, key, college in Authorship.objects.filter(
        publication_id__in=set(via) - mine
    ).values_list("publication_id", "user_id", "author_key", "is_college"):
        node = node_of(uid, key)
        if node in known:
            continue
        reach[node] |= via[pid]
        papers[node].add(pid)
        at_college[node] = at_college[node] or bool(uid) or bool(college)
    ranked = sorted(
        reach, key=lambda n: (not at_college[n], -len(reach[n]), -len(papers[n]), n)
    )
    return {n: 2 for n in ranked[:seats]}


def ego(user: User, *, limit: int = EGO_MAX) -> dict[str, Any]:
    """Me, my co-authors and theirs (two hops), at most `limit` people --
    never the whole college. Links carry how many papers each pair shares."""
    limit = max(2, min(limit, EGO_MAX))
    me = f"u:{user.id}"
    mine = publications_of([me]).get(me, set())
    together: dict[str, set[str]] = defaultdict(set)
    for node, pid in _node_rows_for_pubs(mine):
        if node != me:
            together[node].add(pid)
    # A prolific author has more first-step co-authors than the whole ego holds.
    # If all of them took the seats, nobody would be left to be a co-author's
    # co-author -- the very people "who to write with" wants -- so when they do
    # not all fit, a third of the seats is kept for the second step.
    room = limit - 1
    keep_for_second = limit // 3 if len(together) > room else 0
    hop1 = sorted(together, key=lambda n: (-len(together[n]), n))[: room - keep_for_second]
    chosen: dict[str, int] = {me: 0, **{n: 1 for n in hop1}}
    if len(chosen) < limit and hop1:
        chosen.update(_second_step(mine, set(hop1), {me, *together}, limit - len(chosen)))
    # Seats the second step did not need go back to the first-step co-authors.
    if len(chosen) < limit:
        rest = [n for n in sorted(together, key=lambda n: (-len(together[n]), n)) if n not in chosen]
        chosen.update({n: 1 for n in rest[: limit - len(chosen)]})
    pubs = publications_of(chosen)
    by_pub: dict[str, set[str]] = defaultdict(set)
    for node, ps in pubs.items():
        for p in ps:
            by_pub[p].add(node)
    pairs: dict[tuple[str, str], int] = defaultdict(int)
    for nodes in by_pub.values():
        ordered = sorted(nodes)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:]:
                pairs[(a, b)] += 1
    info = _describe(set(chosen))
    degree: dict[str, int] = defaultdict(int)
    for a, b in pairs:
        degree[a] += 1
        degree[b] += 1
    nodes_out = [
        {**info.get(n, {"key": n, "user_id": None, "name": n, "department": None,
                        **_membership(has_account=False, at_college=False), "institution": None}),
         "hop": hop, "papers": len(pubs.get(n, ())), "together": len(together.get(n, ())), "degree": degree[n]}
        for n, hop in chosen.items()
    ]
    return {
        "center": me,
        "nodes": nodes_out,
        "links": [{"source": a, "target": b, "papers": n} for (a, b), n in pairs.items()],
        "coauthors": len(together),
        "capped": len(together) + 1 > limit,
    }


def why(target: str, viewer: str) -> dict[str, Any]:
    """Counted reasons `target` might matter to `viewer`: papers together,
    shared venues and topics, a different department on the same ground, Q1
    papers, people both have written with. Nothing here is a model's guess."""
    import json

    pubs = publications_of([target, viewer])
    t_ids, v_ids = pubs.get(target, set()), pubs.get(viewer, set())
    fields = ("id", "venue", "quartile", "topics_json")
    t_pubs = list(Publication.objects.filter(id__in=t_ids).only(*fields))
    v_pubs = list(Publication.objects.filter(id__in=v_ids).only(*fields))

    def topics(ps: list[Publication]) -> dict[str, str]:
        out: dict[str, str] = {}
        for p in ps:
            try:
                raw = json.loads(p.topics_json or "[]")
            except ValueError:
                raw = []
            for t in raw if isinstance(raw, list) else []:
                t = str(t).strip()
                if t:
                    out.setdefault(t.lower(), t)
        return out

    def venues(ps: list[Publication]) -> dict[str, str]:
        return {clean_venue(p.venue).lower(): clean_venue(p.venue) for p in ps if clean_venue(p.venue)}

    reasons: list[dict[str, Any]] = []
    both = t_ids & v_ids
    if both:
        n = len(both)
        reasons.append({"kind": "together", "text": f"{n} paper{'s' if n != 1 else ''} together already",
                        "refs": sorted(both)[:5]})
    tv, vv = venues(t_pubs), venues(v_pubs)
    shared_v = sorted(tv[k] for k in tv if k in vv)
    if shared_v:
        n = len(shared_v)
        reasons.append({"kind": "shared_venue", "text": f"Publishes in {n} venue{'s' if n != 1 else ''} you use "
                        f"({', '.join(shared_v[:2])}{', …' if n > 2 else ''})", "refs": shared_v[:5]})
    tt, vt = topics(t_pubs), topics(v_pubs)
    shared_t = sorted(tt[k] for k in tt if k in vt)
    if shared_t:
        reasons.append({"kind": "topic", "text": f"Works on {', '.join(shared_t[:2])}, as your papers do",
                        "refs": shared_t[:5]})
    depts = {n: User.objects.filter(id=n[2:]).values_list("department", flat=True).first()
             for n in (target, viewer) if n.startswith("u:")}
    if depts.get(target) and depts.get(viewer) and depts[target] != depts[viewer] and (shared_v or shared_t):
        reasons.append({"kind": "complement", "text": f"{depts[target]}, not {depts[viewer]}: a different "
                        "department on ground you share", "refs": [depts[target]]})
    tq = sum(1 for p in t_pubs if p.quartile.upper() == "Q1")
    vq = sum(1 for p in v_pubs if p.quartile.upper() == "Q1")
    if tq:
        reasons.append({"kind": "q1", "text": f"Q1 papers: {tq} (you: {vq})", "refs": []})
    t_co = {n for n, _ in _node_rows_for_pubs(t_ids)} - {target, viewer}
    v_co = {n for n, _ in _node_rows_for_pubs(v_ids)} - {target, viewer}
    common = sorted(t_co & v_co)
    if common:
        names = sorted(d["name"] for d in _describe(set(common[:3])).values())
        reasons.append({"kind": "common_coauthors", "text": f"You have both written with {len(common)} "
                        f"{'person' if len(common) == 1 else 'people'} ({', '.join(names[:2])})", "refs": names})
    return {"reasons": reasons, "papers": len(t_ids), "your_papers": len(v_ids)}
