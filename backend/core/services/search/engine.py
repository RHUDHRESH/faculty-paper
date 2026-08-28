"""One box. One fan-out. Four kinds of answer, and a full account of who answered.

Somebody typing "graphene supercapacitor" into a search box does not know
whether they are asking for a paper, a journal or a colleague, and making them
pick a tab first means they pick the wrong one. So the query goes to everything
and the answer comes back grouped.

Two structural decisions carry most of the weight.

**Network and database are separated by a hard line.**

    fan_out  ->  every HTTP call, in parallel, on worker threads, no ORM
    assemble ->  every database read, on the calling thread, no HTTP

That is not tidiness. Django opens a connection per thread, so ORM work inside
the fan-out would open one per source on every search and break outright
against an in-memory test database. Keeping resolution on the calling thread
also means the whole search costs *one* wall-clock network budget rather than
one per scope -- papers and venues share a single ceiling instead of queueing.

**Every source reports itself, whether it worked or not.**

`sources[]` is built on complete success as well as on failure, because a
search that returns three results with two sources down looks identical to one
that returns three results because that is all there is. The first is a lie by
omission. With a full roster the page can tell the three states apart: all
well, some down (name each, with its reason), all down (an error, never "no
results"). Our own tables are in that roster too -- they are sources like any
other, they simply never fail, and saying so is what lets a reader see that the
venue list survived an OpenAlex outage.
"""

from __future__ import annotations

import time
from typing import Any, Iterable

from django.utils import timezone

from core.services.search import money, papers, people, sources, upstream, venues

KINDS = ("papers", "venues", "people")

#: The client does not call below two characters; the server agrees rather than
#: disagreeing by one, which would leave a keystroke that renders as an error.
MIN_QUERY = 2
MAX_LIMIT = 50


def search(
    query: str,
    *,
    viewer,
    kinds: Iterable[str] = KINDS,
    limit: int = 10,
    field: str | None = None,
    quartile: str | None = None,
    doi: str | None = None,
) -> dict[str, Any]:
    """The whole search. Never raises for an upstream problem.

    `viewer` is the `User` making the request. It decides what they may see of
    the college's own data, and whether an amount appears on a ticket at all.
    """
    started = time.monotonic()
    query = (query or "").strip()
    role = getattr(viewer, "role", None)
    wanted = [k for k in kinds if k in KINDS] or list(KINDS)
    limit = max(1, min(int(limit or 10), MAX_LIMIT))

    if len(query) < MIN_QUERY:
        return _empty(query, role, reason="Type at least two characters to search.")

    # --- everything that leaves the machine, once, in parallel ------------- #
    jobs: dict[str, Any] = {}
    skipped: list[dict[str, Any]] = []
    if "papers" in wanted:
        jobs.update({f"papers:{k}": v for k, v in papers.tasks(query, limit).items()})
        if not papers.scopus_configured():
            skipped.append(
                sources.not_configured(
                    "scopus",
                    "Scopus is not set up on this server, so it was not searched. "
                    "Crossref and OpenAlex need no key and were.",
                )
            )
    if "venues" in wanted:
        jobs.update({f"venues:{k}": v for k, v in venues.tasks(query, limit).items()})

    fetched, errors = upstream.fan_out(jobs)

    # --- everything that touches the database, on this thread -------------- #
    reported: list[dict[str, Any]] = []
    this_year = timezone.now().year
    found_papers: list[dict[str, Any]] = []
    found_venues: dict[str, Any] = {"resolved": [], "unresolved": []}
    found_people: list[dict[str, Any]] = []
    found_tickets: list[dict[str, Any]] = []

    if "papers" in wanted:
        batches = {
            name.split(":", 1)[1]: rows
            for name, rows in fetched.items()
            if name.startswith("papers:")
        }
        found_papers = papers.assemble(
            batches, limit=limit, this_year=this_year, viewer=viewer
        )
        reported.extend(_report("papers", jobs, fetched, errors))
        reported.extend(skipped)

    if "venues" in wanted:
        external = fetched.get("venues:openalex_sources") or []
        found_venues = venues.assemble(
            external, query=query, field=field, quartile=quartile, limit=limit
        )
        # Our own tables answer even when every upstream is down. Reporting
        # them as a source is what tells a reader that the venue list they are
        # looking at is complete rather than salvaged.
        reported.append(sources.ok("journals", len(found_venues["resolved"])))
        reported.extend(_report("venues", jobs, fetched, errors))

    if "people" in wanted:
        found_people = people.find_people(query, viewer=viewer, limit=limit)
        found_tickets = people.find_tickets(query, viewer=viewer, doi=doi, limit=limit)
        reported.append(sources.ok("college", len(found_people) + len(found_tickets)))

    payload = {
        "query": query,
        "sources": _ordered(reported),
        "papers": found_papers,
        "venues": {
            "resolved": found_venues["resolved"],
            "unresolved": found_venues["unresolved"],
        },
        "people": found_people,
        "tickets": found_tickets,
        "dataset_year": found_venues.get("dataset_year"),
        "took_ms": int((time.monotonic() - started) * 1000),
        "money_visible": money.may_see_money(role),
    }
    # Nothing money-bearing was built for a blind viewer in the first place.
    # This is the second lock on the same door: a field added upstream of here
    # under a known money key is still stripped on the way out.
    return money.redact(payload, role)


def _report(
    scope: str,
    jobs: dict[str, Any],
    fetched: dict[str, Any],
    errors: dict[str, BaseException | None],
) -> list[dict[str, Any]]:
    """One `sources[]` entry per source this scope asked, success or not."""
    out = []
    for job in jobs:
        if not job.startswith(f"{scope}:"):
            continue
        source_id = job.split(":", 1)[1]
        # The venue upstream is one OpenAlex endpoint among several; the reader
        # only cares that OpenAlex was asked.
        reported_as = "openalex" if source_id == "openalex_sources" else source_id
        if job in fetched:
            out.append(sources.ok(reported_as, len(fetched[job] or [])))
        elif job in errors:
            failure = errors[job]
            if failure is None:
                out.append(sources.timed_out(reported_as, upstream.FANOUT_BUDGET))
            else:
                code, detail = sources.classify(
                    failure, sources.LABELS.get(reported_as, reported_as)
                )
                out.append(sources.failed(reported_as, code, detail))
    return out


#: The order the page lists them in. Stable, so a source does not jump around
#: between requests depending on which finished first.
_ORDER = ["crossref", "openalex", "scopus", "journals", "college"]


def _ordered(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One entry per source, in a fixed order.

    A source asked by two scopes -- OpenAlex serves both works and journals --
    reports once, and a failure outranks a success: if either call to OpenAlex
    fell over, the reader needs to know OpenAlex is unwell.
    """
    merged: dict[str, dict[str, Any]] = {}
    for entry in entries:
        existing = merged.get(entry["id"])
        if existing is None:
            merged[entry["id"]] = entry
            continue
        if existing["ok"] and not entry["ok"]:
            merged[entry["id"]] = entry
        elif existing["ok"] and entry["ok"]:
            existing["count"] = (existing.get("count") or 0) + (entry.get("count") or 0)
    return sorted(
        merged.values(),
        key=lambda e: (_ORDER.index(e["id"]) if e["id"] in _ORDER else len(_ORDER), e["id"]),
    )


def _empty(query: str, role: str | None, *, reason: str) -> dict[str, Any]:
    """Too short to ask anybody. Nobody was asked, so nobody is reported."""
    return {
        "query": query,
        "sources": [],
        "papers": [],
        "venues": {"resolved": [], "unresolved": []},
        "people": [],
        "tickets": [],
        "dataset_year": None,
        "took_ms": 0,
        "money_visible": money.may_see_money(role),
        "message": reason,
    }
