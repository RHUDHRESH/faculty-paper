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

from django.db.models import Q

from core.models import Authorship, Publication, User


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
    for pid, uid, key, name, college, inst, country, year in rows:
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
            "is_college_member": bool(u),
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
                      "is_college_member": True, "institution": "Saveetha Engineering College"}
    external = [n for n in nodes if not n.startswith("u:")]
    for key, name, inst, college in (
        Authorship.objects.filter(user__isnull=True, author_key__in=external)
        .values_list("author_key", "display_name", "institution_name", "is_college")
    ):
        if key not in out:
            out[key] = {"key": key, "user_id": None, "name": name, "department": None,
                        "is_college_member": False, "institution": inst, "college_affiliated": college}
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
