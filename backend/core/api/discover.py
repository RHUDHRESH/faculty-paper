"""what to write next, and where to send it.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _hod_scope, _require_may_see_money, api, rate_limit, session_auth
from core.api.deps import claim_to_dict
from core.api.common import require_user
from core.api.journals import _journal_reference
from core.api.dashboard import _split_subjects

import json
import time
import uuid as uuid_lib
from typing import Any, Optional
from django.db import transaction
from django.db.models import Count, Sum
from django.http import HttpRequest, StreamingHttpResponse
from django.utils import timezone
from ninja import File, Schema
from django.conf import settings
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimStatus, ResearchInterest, Role, User
from core.services import ai, discover as discover_service, research_search, trends
from core.services import rbac
from core.services.normalize import normalize_issn
from core.services.search import KINDS as SEARCH_KINDS, search as run_search
from core import hod, social

# ---------- what to write next, and where to send it ----------
#
# The only part of this system that is any use *before* a paper exists.
# Everything else deals with work already done.
#
# The rule throughout: the model proposes, the database disposes. Gemini names
# journals; those names are resolved against our own Scimago and SNIP rows and
# only what resolves carries a quartile or an amount. See services/discover.py.


class VenueIn(Schema):
    title: str
    abstract: Optional[str] = None
    keywords: Optional[str] = None
    #: The position being considered, since the payout depends on it and
    #: nobody knows the eventual author order while choosing a venue.
    author_position: int = 1
    total_authors: int = 1


class InterestsIn(Schema):
    domains: list[str]


@api.get("/search", auth=session_auth)
def search_everything(
    request: HttpRequest,
    q: str,
    kinds: str = "papers,venues,people",
    limit: int = 10,
    field: str | None = None,
    quartile: str | None = None,
    doi: str | None = None,
):
    """One box over Crossref, OpenAlex, Scopus and our own tables.

    `core.services.search` was complete, tested and reachable from every
    role's sidebar, and nothing had ever registered the route — so the page
    shipped and every query 404'd. The route sweep could not see it: with no
    query the page shows its prompt and looks perfectly well.

    The guard is `require_user`, deliberately not `_require_may_see_money`.
    That helper refuses a head of department outright, which is right for
    `/prior/check` and `/discover/venues` because those exist to hand over a
    figure — but a head is entitled to look a paper up, and refusing here
    would take the search box away from them entirely. Money-blindness is
    enforced inside the package instead, in `search/money.py`, which omits the
    amount key rather than zeroing it, and everything leaves through
    `hod.without_money` after that regardless.

    `limit` is clamped by the engine (1–50), which also never raises for an
    upstream problem: a vendor that is down is reported as a source that did
    not answer. So the only status this endpoint returns other than 200 is the
    401/403 that `require_user` raises.
    """
    user = require_user(request)
    rate_limit(request, "search", settings.SEARCH_DAILY_LIMIT, "day", what="searching")
    wanted = [k.strip() for k in (kinds or "").split(",") if k.strip()] or list(SEARCH_KINDS)
    return run_search(
        q, viewer=user, kinds=wanted, limit=limit,
        field=field, quartile=quartile, doi=doi,
    )


@api.get("/discover/status", auth=session_auth)
def discover_status(request: HttpRequest):
    """Whether the discovery features can run at all.

    The screen asks before offering, so that an unconfigured deployment says
    "this is switched off" rather than presenting a button that always fails.
    """
    require_user(request)
    # More than a boolean, because "off" covers three different situations
    # with three different remedies: no service, a service with the model
    # missing, or a provider name nobody recognises. A screen that cannot tell
    # them apart can only shrug at somebody who could have fixed it.
    state = ai.health()
    return {
        "available": bool(state.get("ready")),
        "model": state.get("model") or "",
        "provider": state.get("provider"),
        "code": state.get("code"),
        "detail": state.get("detail"),
        "base_url": state.get("base_url"),
        # Whether what somebody types here leaves the college, and to where.
        # The screen says so rather than claiming it runs "on this server".
        "hosted": bool(state.get("hosted")),
        "host": state.get("host") or "",
    }


@api.get("/meta/research-domains", auth=session_auth)
def research_domains(request: HttpRequest, q: str = "", limit: int = 40):
    """The subject vocabulary, taken from our own journal data.

    302 categories that journals in our dataset are actually classified under,
    rather than a list somebody typed. A domain outside this vocabulary cannot
    be matched against anything later.
    """
    require_user(request)
    return {"domains": discover_service.research_domains(q, limit)}


@api.get("/me/interests", auth=session_auth)
def my_interests(request: HttpRequest):
    user = require_user(request)
    return {
        "domains": list(
            ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
        )
    }


@api.put("/me/interests", auth=session_auth)
def set_my_interests(request: HttpRequest, payload: InterestsIn):
    """Replace the whole set.

    A whole-set write rather than add and remove endpoints: the screen is a
    multi-select, and two round trips per tick would make it feel slow and
    leave it half-applied if one of them failed.
    """
    user = require_user(request)
    wanted = []
    for raw in payload.domains[:20]:
        name = (raw or "").strip()
        if name and name not in wanted:
            wanted.append(name)

    with transaction.atomic():
        ResearchInterest.objects.filter(user=user).exclude(domain__in=wanted).delete()
        existing = set(
            ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
        )
        ResearchInterest.objects.bulk_create(
            [ResearchInterest(user=user, domain=d) for d in wanted if d not in existing],
            ignore_conflicts=True,
        )
    return {"domains": wanted}


@api.post("/discover/venues", auth=session_auth)
def discover_venues(request: HttpRequest, payload: VenueIn):
    """Where this paper could go, and what each venue would pay.

    Note what is returned separately: journals we could verify, and names we
    could not. The unverified ones still appear -- the model may be right and
    the journal simply absent from a 2025 dump -- but they carry no quartile
    and no amount, because attaching a number to a journal we cannot identify
    is how somebody ends up submitting to a venue that does not exist.
    """
    rate_limit(request, "ai", settings.AI_DAILY_LIMIT, "day", what="the AI suggestions")
    # Every suggested journal comes back with the rupee figure the policy would
    # pay for it. /discover/reprice and /research/search return the same kind of
    # figure and are both guarded; this one, which is where the figure is first
    # produced, was not.
    user = _require_may_see_money(request)
    title = (payload.title or "").strip()
    if len(title) < 8:
        raise HttpError(400, "Give the paper's title so there is something to go on")

    state = ai.health()
    if not state.get("ready"):
        # 503 with the reason attached. "Switched off" was the only thing this
        # ever said, and it is wrong for two of the three ways it happens --
        # the service being down and the model not being pulled are both
        # things somebody can fix in one command.
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")

    try:
        result = discover_service.suggest_venues(
            title=title,
            abstract=(payload.abstract or "").strip(),
            keywords=(payload.keywords or "").strip(),
            author_position=max(1, payload.author_position),
            total_authors=max(1, payload.total_authors),
        )
    except ai.AIError as exc:
        raise HttpError(_ai_failure_status(exc), str(exc)) from exc

    _log_venue_search(user, title, result)
    return result


def _ai_failure_status(exc: ai.AIError) -> int:
    """Which of the two ways this was not the reader's fault.

    A missing model is configuration, not a bad gateway. Answering 502 for it
    sends somebody looking for a network fault that is not there, when the fix
    is one `ollama pull` on the machine it runs on.
    """
    unavailable = (
        "model_missing", "unreachable", "misconfigured", "not_configured", "rate_limited",
    )
    return 503 if exc.code in unavailable else 502


def _log_venue_search(user: User, title: str, result: dict[str, Any]) -> None:
    AuditLog.objects.create(
        actor=user,
        action="DISCOVER_VENUES",
        entity="Claim",
        entity_id="",
        detail_json=json.dumps({"title": title[:300], "verified": len(result["journals"])}),
    )


def _ndjson(obj: dict[str, Any]) -> bytes:
    """One JSON object, one line.

    NDJSON rather than Server-Sent Events because this is a POST with a body
    and `EventSource` cannot make one, so the client is a `fetch` reader
    either way -- and once it is, splitting on newlines is less to get wrong
    than parsing the SSE framing by hand.
    """
    return (json.dumps(obj, default=str) + "\n").encode("utf-8")


@api.post("/discover/venues/stream", auth=session_auth)
def discover_venues_stream(request: HttpRequest, payload: VenueIn):
    """The same answer as `/discover/venues`, with the wait made visible.

    The model runs on this server's CPU at about four and a half tokens a
    second, so this request takes a minute and a half and there is nothing
    anybody can do to make it take less. What was wrong was not the ninety
    seconds; it was that the screen said "Searching..." for all of them and
    offered no way out, so a request that was working looked like one that
    had hung, and the only remedy anybody had was to reload the page --
    which left the model generating an answer no longer going anywhere.

    So: the same result, preceded by the model saying where it has got to,
    and stoppable for real -- see `/discover/venues/cancel`, which exists
    because a dropped connection turned out not to be something this server
    notices.

    Everything that can be refused is refused before the first byte, because
    after that the status is 200 and a failure has to be carried in the body
    instead. What is left -- the model failing part way through -- arrives as
    an `error` event carrying the status it would have been.
    """
    rate_limit(request, "ai", settings.AI_DAILY_LIMIT, "day", what="the AI suggestions")
    user = _require_may_see_money(request)
    title = (payload.title or "").strip()
    if len(title) < 8:
        raise HttpError(400, "Give the paper's title so there is something to go on")

    state = ai.health()
    if not state.get("ready"):
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")

    # Named so it can be stopped. Prefixed with the reader's own id so the
    # endpoint that stops it can check that it is theirs to stop, and random
    # in the rest so it is not somebody else's to guess.
    token = f"{user.pk}:{uuid_lib.uuid4()}"

    def events():
        started = time.monotonic()
        phase = "connecting"

        def since() -> float:
            return round(time.monotonic() - started, 1)

        # Sent immediately, so the screen has a clock and an expectation
        # before the model has done anything at all. A wait somebody was told
        # about in advance is a different experience from the same wait
        # discovered halfway through.
        yield _ndjson(
            {
                "event": "start",
                "token": token,
                "model": state.get("model") or "",
                "expected_seconds": ai.EXPECTED_SECONDS,
                "expected_tokens": ai.EXPECTED_TOKENS,
            }
        )

        for kind, value in ai.run_with_progress(
            discover_service.suggest_venues,
            {
                "title": title,
                "abstract": (payload.abstract or "").strip(),
                "keywords": (payload.keywords or "").strip(),
                "author_position": max(1, payload.author_position),
                "total_authors": max(1, payload.total_authors),
            },
            token=token,
        ):
            if kind == "step":
                phase = value.get("phase") or phase
                yield _ndjson({"event": "step", "elapsed": since(), **value})
            elif kind == "tick":
                # Nothing new, said once a second anyway, because the first
                # eight seconds of a cold search produce no tokens at all and
                # a counter that has not moved since the button was pressed
                # is the thing this endpoint exists to stop showing.
                yield _ndjson({"event": "tick", "phase": phase, "elapsed": since()})
            elif kind == "cancelled":
                yield _ndjson({"event": "cancelled", "elapsed": since()})
            elif kind == "error":
                yield _ndjson(
                    {
                        "event": "error",
                        "status": _ai_failure_status(value),
                        "code": value.code,
                        "detail": str(value),
                        "elapsed": since(),
                    }
                )
            elif kind == "result":
                # Logged here rather than in the worker, on the request's own
                # database connection, and only for a search somebody stayed
                # for. The unverified names are not counted: the audit trail
                # records what the database agreed to, which is the same
                # split the screen shows.
                _log_venue_search(user, title, value)
                yield _ndjson({"event": "result", "elapsed": since(), "data": value})

    response = StreamingHttpResponse(events(), content_type="application/x-ndjson")
    # Nothing between here and the browser may hold this back waiting for a
    # complete body -- buffering a progress stream turns it back into the
    # silence it exists to replace.
    response["Cache-Control"] = "no-cache, no-store, no-transform"
    response["X-Accel-Buffering"] = "no"
    return response


class CancelIn(Schema):
    #: The token the `start` event of a venue stream carried.
    token: str


@api.post("/discover/venues/cancel", auth=session_auth)
def discover_venues_cancel(request: HttpRequest, payload: CancelIn):
    """Stop a search somebody has given up on.

    A separate request rather than an inference from the stream's connection
    dropping, because that inference does not hold. Measured on this server:
    a client closing a streaming connection mid-answer was never noticed --
    the writes into the dead socket went on succeeding -- and the model spent
    another eighty-eight seconds finishing an answer with nowhere to go, on
    the four cores the next reader was waiting for. A cancel button that only
    stops the spinner is not a cancel button.

    Answering whether it found the run is deliberate. With more than one
    worker process the request can land on a worker that never had it, and
    saying so is better than an empty 200 that implies something happened.
    """
    user = require_user(request)
    # A token names one reader's own search. Somebody else's is not theirs to
    # stop, and the prefix is checked rather than trusted because a cancel is
    # a write, however small.
    if not payload.token.startswith(f"{user.pk}:"):
        raise HttpError(403, "That search is not yours to stop.")
    return {"stopped": ai.stop(payload.token)}


class RepriceIn(Schema):
    #: ISSNs from journals `/discover/venues` already resolved.
    issns: list[str]
    author_position: int = 1
    total_authors: int = 1


@api.get("/trends/me", auth=session_auth)
def trends_me(request: HttpRequest, limit: int = 12, people_limit: int = 8):
    """What this college is working on, and who to work with.

    Deliberately `require_user` and not `_require_may_see_money`: there is no
    rupee figure anywhere in this payload, and locking a head of department
    out of a money-free picture of their own institution would be the wrong
    call. Both halves go through `hod.without_money` on the way out anyway, so
    a field named `amount` added here later cannot leak one.

    Never answers 503. It needs no model -- the measured half is the half that
    must always work.
    """
    user = require_user(request)
    return trends.overview(
        user,
        limit=max(1, min(int(limit), 30)),
        people_limit=max(1, min(int(people_limit), 25)),
    )


@api.get("/trends/openings", auth=session_auth)
def trends_openings(request: HttpRequest):
    """The part a model wrote, kept behind its own request.

    Separate from `/trends/me` on purpose. The measured picture answers in
    milliseconds; this takes a couple of minutes on a CPU, and putting them in
    one response would make the fast half wait for the slow one.
    """
    user = require_user(request)
    state = ai.health()
    if not state.get("ready"):
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")
    try:
        return trends.suggest_openings(user=user)
    except ai.AIError as exc:
        raise HttpError(_ai_failure_status(exc), str(exc)) from exc


def _my_areas(user: User) -> tuple[Any, list[tuple[str, int]], list[str]]:
    """What somebody has filed, and the subject areas it falls in, most first.

    The same papers their profile lists (`social.published_papers`): not a
    draft, and not one the college refused.
    """
    mine = social.published_papers(user)
    my_areas: dict[str, int] = {}
    for raw in mine.values_list("subjects_json", flat=True):
        for area, _q in _split_subjects(raw):
            my_areas[area] = my_areas.get(area, 0) + 1
    ranked_areas = sorted(my_areas.items(), key=lambda kv: -kv[1])
    stated = list(
        ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
    )
    return mine, ranked_areas, stated


@api.get("/programme/me", auth=session_auth)
def programme_me(request: HttpRequest):
    """One person's research, and only theirs: their papers, areas and co-authors.

    The owner's rule: "X's research" shows X's work. It used to mix in the
    college's picture -- who else works nearby, what others filed lately --
    which made a page titled with somebody's name mostly about other people.
    That half is `/programme/around` now, on its own page.

    Everything here is derived from papers the person filed, and none of it
    needs a model or a key. No money: the paper list is the same one their
    public profile shows (`social.research_record`), so the two can never
    disagree about what somebody has published.
    """
    user = require_user(request)
    mine, ranked_areas, stated = _my_areas(user)
    top_areas = [a for a, _n in ranked_areas[:8]]
    record = social.research_record(user)

    return {
        **record,
        "areas": [{"key": a, "count": n} for a, n in ranked_areas[:12]],
        "interests": stated,
        # Interests a person stated but has not published in are still theirs,
        # and are what a new arrival with no papers has instead of an area list.
        "search_terms": top_areas[:4] or stated[:4],
        "totals": {"my_papers": mine.count(), "my_areas": len(ranked_areas)},
        # Said on screen, because an empty page looks broken and is usually
        # just somebody whose journals we could not classify.
        "classified": mine.exclude(subjects_json__isnull=True)
        .exclude(subjects_json="")
        .count(),
    }


@api.get("/programme/around", auth=session_auth)
def programme_around(request: HttpRequest, limit: int = 12):
    """The college around one person's areas: who else works in them, and what was filed lately.

    Two questions, in the order somebody asks them:

    - who else works on it? -- colleagues with papers in the same areas, most
      overlap first, excluding the person themselves;
    - what is happening in it right now? -- the most recent papers filed in
      those areas by anybody, so a new arrival can see the live front rather
      than a historical total.

    No money anywhere in the payload. A faculty member may see their own
    amounts and nobody else's, and this endpoint is about other people --
    including it would leak a colleague's payout through the back door.
    """
    user = require_user(request)
    limit = max(1, min(int(limit), 50))
    _mine, ranked_areas, _stated = _my_areas(user)
    top_areas = [a for a, _n in ranked_areas[:8]]

    colleagues: list[dict[str, Any]] = []
    live: list[dict[str, Any]] = []

    if top_areas:
        # One pass over other people's papers, matched on area. Done in Python
        # rather than SQL because the areas live in a semicolon-separated
        # column that no index can help with -- and the alternative, a LIKE per
        # area, is eight table scans instead of one.
        wanted = set(top_areas)
        others = (
            Claim.objects.exclude(owner=user)
            .exclude(status=ClaimStatus.DRAFT)
            .exclude(subjects_json__isnull=True)
            .exclude(subjects_json="")
            .select_related("owner")
            .order_by("-publication_year", "-created_at")
        )
        people: dict[str, dict[str, Any]] = {}
        for claim in others[:4000]:
            areas = {a for a, _q in _split_subjects(claim.subjects_json)}
            shared = areas & wanted
            if not shared:
                continue
            if len(live) < limit:
                live.append({
                    "id": claim.id,
                    "paper_title": claim.paper_title,
                    "journal_title": claim.journal_title,
                    "publication_year": claim.publication_year,
                    "quartile": claim.quartile,
                    "owner_id": claim.owner_id,
                    "owner_name": claim.owner.name if claim.owner_id else None,
                    "owner_department": claim.owner.department if claim.owner_id else None,
                    "areas": sorted(shared),
                })
            slot = people.setdefault(
                claim.owner_id,
                {
                    "id": claim.owner_id,
                    "name": claim.owner.name if claim.owner_id else "Unknown",
                    "department": claim.owner.department if claim.owner_id else None,
                    "designation": claim.owner.designation if claim.owner_id else None,
                    "papers": 0,
                    "areas": set(),
                },
            )
            slot["papers"] += 1
            slot["areas"] |= shared
        colleagues = sorted(
            (
                {**v, "areas": sorted(v["areas"]), "shared": len(v["areas"])}
                for v in people.values()
            ),
            key=lambda r: (-r["shared"], -r["papers"]),
        )[:limit]

    return {
        "areas": list(top_areas),
        "colleagues": colleagues,
        "live": live,
    }


@api.get("/research/search", auth=session_auth)
def research_search_endpoint(
    request: HttpRequest,
    q: str = "",
    limit: int = 20,
    sources: Optional[str] = None,
    author_position: int = 1,
    total_authors: int = 1,
):
    """Search the scholarly record, and price what you find.

    Deliberately needs no model and no key: the AI features degrade to
    "switched off" without credits, and this does not. Somebody can still find
    what is being published in their field, and what it would be worth to them,
    with no AI involved at all.
    """
    _require_may_see_money(request)
    picked = [s.strip() for s in (sources or "").split(",") if s.strip()] or None
    return research_search.search(
        q,
        limit=max(1, min(limit, 50)),
        sources=picked,
        author_position=max(1, author_position),
        total_authors=max(1, total_authors),
        this_year=timezone.now().year,
    )


@api.post("/discover/reprice", auth=session_auth)
def discover_reprice(request: HttpRequest, payload: RepriceIn):
    """The same journals, priced for a different author position.

    No model call — this is arithmetic over rows we already hold, so trying
    "what if I were third of five" costs nothing and answers immediately.
    Available whether or not a model is configured, because it does not need
    one.
    """
    _require_may_see_money(request)
    return discover_service.reprice(
        issns=payload.issns,
        author_position=max(1, payload.author_position),
        total_authors=max(1, payload.total_authors),
    )


@api.get("/discover/directions", auth=session_auth)
def discover_directions(request: HttpRequest):
    """What this person might write next, from what they have written.

    Grounded on filed claims and stated interests. Drafts are excluded --
    an unfinished ticket is a private intention, and feeding one to a model
    would be reading somebody's notes.
    """
    user = require_user(request)
    rate_limit(request, "ai", settings.AI_DAILY_LIMIT, "day", what="the AI suggestions")
    state = ai.health()
    if not state.get("ready"):
        # 503 with the reason attached. "Switched off" was the only thing this
        # ever said, and it is wrong for two of the three ways it happens --
        # the service being down and the model not being pulled are both
        # things somebody can fix in one command.
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")

    history = discover_service.publication_history(user)
    interests = list(
        ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
    )
    if not history and not interests:
        return {
            "directions": [],
            "grounded_on": {"papers": 0, "interests": []},
            "note": (
                "There is nothing to go on yet. File a paper, or pick the domains "
                "you work in, and this will have something to work from."
            ),
        }

    try:
        return discover_service.suggest_directions(history=history, interests=interests)
    except ai.AIError as exc:
        raise HttpError(_ai_failure_status(exc), str(exc)) from exc


@api.get("/journals/report", auth=session_auth)
def journal_report(request: HttpRequest, title: str):
    """One journal: what it is, and what the college has published in it.

    A head of department sees the same record narrowed to their own staff and
    with the money taken out, which is the rule everywhere else they look.
    """
    user = require_user(request)
    is_head = user.role == Role.HOD
    if not (
        is_head
        or rbac.can_view_reports(user.role)
        or rbac.can_manage_users(user.role)
    ):
        raise HttpError(403, "Forbidden")

    name = (title or "").strip()
    if not name:
        raise HttpError(400, "Name a journal.")

    if is_head:
        base = _hod_scope(user)
    else:
        base = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    claims = list(
        base.filter(journal_title__iexact=name)
        .select_related("owner")
        .order_by("-publication_year", "-updated_at")
    )
    if not claims:
        raise HttpError(404, "No publication on record names that journal.")

    paid = [c for c in claims if c.status == ClaimStatus.PAID]

    def group(field: str, blank: str) -> list[dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for c in claims:
            raw = getattr(c, field, None)
            key = (str(raw).strip() or blank) if raw not in (None, "") else blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0.0})
            slot["count"] += 1
            slot["amount"] += c.remuneration or 0
        return sorted(out.values(), key=lambda r: -r["count"])

    # One row per author, so "who publishes here" is answerable without
    # reading the ticket list -- and each row carries the id, so the name is
    # a door to that person's record rather than a label.
    authors: dict[str, dict[str, Any]] = {}
    for c in claims:
        owner = c.owner
        if owner is None:
            continue
        slot = authors.setdefault(
            owner.id,
            {
                "key": owner.name or owner.email,
                "id": owner.id,
                "department": owner.department or "—",
                "count": 0,
                "amount": 0.0,
            },
        )
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0

    years = [c.publication_year for c in claims if c.publication_year]
    # The ISSN is worth having from any ticket that recorded one, because the
    # reference lookup is far more reliable with it than with a title.
    issn = next((c.issn for c in claims if c.issn), None)

    def first(field: str):
        return next((getattr(c, field) for c in claims if getattr(c, field, None)), None)

    payload = {
        "journal": {
            "title": name,
            # Shown normalised: the ticket carries "2728842" because a
            # spreadsheet dropped the leading zero, and printing that back
            # gives the reader a number that will not find the journal
            # anywhere else.
            "issn": normalize_issn(issn) if issn else None,
            "indexing": first("indexing_level"),
            "engineering_class": first("engineering_class"),
            "subject_category": first("subject_category"),
            # The SNIP the college actually paid on, which is not always what
            # the current dump says -- a journal's SNIP moves year to year.
            "snip_on_record": first("snip"),
            "snip_year_on_record": first("snip_year"),
            **_journal_reference(name, issn),
        },
        "totals": {
            "publications": len(claims),
            "authors": len(authors),
            "departments": len({c.owner.department for c in claims if c.owner and c.owner.department}),
            "paid_claims": len(paid),
            "paid_amount": round(sum(c.remuneration or 0 for c in paid), 2),
            "first_year": min(years) if years else None,
            "last_year": max(years) if years else None,
        },
        "by_year": sorted(group("publication_year", "Not stated"), key=lambda r: str(r["key"])),
        "by_quartile": group("quartile", "No quartile"),
        "by_status": group("status", "—"),
        "by_department": sorted(
            [
                {"key": k or "—", "count": v["count"], "amount": v["amount"]}
                for k, v in _by_department(claims).items()
            ],
            key=lambda r: -r["count"],
        ),
        "authors": sorted(authors.values(), key=lambda r: -r["count"])[:50],
        "claims": [claim_to_dict(c) for c in claims[:200]],
    }
    if not is_head:
        return payload

    # A head reads progress, not workflow status. "PAID" is not an amount, but
    # it is still the statement that a named colleague was paid, which is the
    # thing their screens do not say -- and the money-blindness audit reads
    # every byte that comes back, so it caught this the moment the endpoint
    # opened to them.
    payload["by_status"] = sorted(
        _fold_by_progress(payload["by_status"]), key=lambda r: -r["count"]
    )
    for row in payload["claims"]:
        row["progress"] = hod.progress_of(row.pop("status", None))
    return hod.without_money(payload)


def _fold_by_progress(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Several statuses share one progress word, so their counts add up."""
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        key = hod.progress_of(r["key"])
        slot = out.setdefault(key, {"key": key, "count": 0})
        slot["count"] += r["count"]
    return list(out.values())


def _by_department(claims) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for c in claims:
        key = (c.owner.department if c.owner else None) or "Not stated"
        slot = out.setdefault(key, {"count": 0, "amount": 0.0})
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0
    return out


@api.get("/journals/top", auth=session_auth)
def journals_top(request: HttpRequest, q: str | None = None, limit: int = 100):
    """The journals the college publishes in, most-used first."""
    user = require_user(request)
    is_head = user.role == Role.HOD
    if not (
        is_head
        or rbac.can_view_reports(user.role)
        or rbac.can_manage_users(user.role)
    ):
        raise HttpError(403, "Forbidden")

    base = _hod_scope(user) if is_head else Claim.objects.exclude(status=ClaimStatus.DRAFT)
    base = base.exclude(journal_title__isnull=True).exclude(journal_title="")
    if q:
        base = base.filter(journal_title__icontains=q.strip())
    rows = (
        base.values("journal_title")
        .annotate(count=Count("id"), amount=Sum("remuneration"))
        .order_by("-count")[: max(1, min(limit, 500))]
    )
    out = [
        {
            "key": r["journal_title"],
            "count": r["count"],
            "amount": round(r["amount"] or 0, 2),
        }
        for r in rows
    ]
    return hod.without_money({"results": out}) if is_head else {"results": out}




__all__ = [
    'CancelIn',
    'InterestsIn',
    'RepriceIn',
    'VenueIn',
    '_ai_failure_status',
    '_by_department',
    '_fold_by_progress',
    '_log_venue_search',
    '_ndjson',
    'discover_directions',
    'discover_reprice',
    'discover_status',
    'discover_venues',
    'discover_venues_cancel',
    'discover_venues_stream',
    'journal_report',
    'journals_top',
    'my_interests',
    'programme_me',
    'programme_around',
    '_my_areas',
    'research_domains',
    'research_search_endpoint',
    'search_everything',
    'set_my_interests',
    'trends_me',
    'trends_openings',
]
