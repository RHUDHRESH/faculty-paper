"""Research scout: what to work on next, and with whom.

Two halves, kept apart all the way to the screen:

- **From our records** (no model): the person's profile -- topics, venues,
  citations, recent papers, co-authors -- and the college colleagues in
  *other departments* whose records complement theirs, counted from the
  publication record.
- **From the web** (Claude with server-side web search): open problems,
  funded calls, special issues and conferences; next-level directions that
  build on the person's own papers; external researchers and groups. Only
  URLs the search tool actually returned are kept as links.

Claude may choose among the colleague candidates and say why, but it can only
pick ids we handed it -- it cannot invent a colleague.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

from core.models import ScoutRun, User
from core.services import ai, anthropic_provider
from core.services import ai_harness as harness
from core.services import coauthors as graph
from core.services import research_picture as picture

logger = logging.getLogger(__name__)

DAILY_LIMIT = int(getattr(settings, "SCOUT_DAILY_LIMIT", 5) or 5)
CACHE_FOR = timedelta(hours=24)
MAX_CANDIDATES = 10

SCOUT_SYSTEM = (
    "You are a research scout for a faculty member at an engineering college. "
    "Use web search to find CURRENT (this year and next) opportunities and research. "
    "Prefer primary sources: funder pages, publisher call pages, conference sites, lab pages. "
    "Never invent URLs, people, deadlines or calls; if unsure, leave the field empty."
)


# --------------------------------------------------------------------------- #
# From our records                                                            #
# --------------------------------------------------------------------------- #


def profile_of(user: User, college: picture._College | None = None) -> dict[str, Any]:
    college = college or picture.shared_college()
    mine = picture.my_research(user, college)
    recent = sorted(college.of(user.id), key=lambda p: -(p["year"] or 0))[:8]
    co = graph.coauthors(user)
    return {
        "name": user.name,
        "department": user.department or "",
        "designation": user.designation or "",
        "papers": mine["metrics"]["papers"],
        "citations": mine["metrics"]["citations"] or 0,
        "h_index": mine["metrics"]["h_index"] or 0,
        "topics": [t["label"] for t in mine["topics"][:10]],
        "venues": [v["name"] for v in mine["venues"][:6]],
        "recent_papers": [
            {"title": p["title"], "year": p["year"], "venue": p["venue"] or ""} for p in recent
        ],
        "top_papers": [
            {"title": p["title"], "year": p["year"], "citations": p["citations"]}
            for p in mine["top_papers"][:3]
        ],
        "external_coauthors": [
            {"name": c["name"], "institutions": c["institutions"][:2]} for c in co["outside"][:6]
        ],
        "college_coauthor_ids": [c["user_id"] for c in co["inside"] if c["user_id"]],
    }


def colleague_candidates(
    user: User, college: picture._College, *, limit: int = MAX_CANDIDATES, other_departments_only: bool = True
) -> list[dict[str, Any]]:
    """College members in other departments whose topics touch and extend mine.

    Score = shared topics (common ground) + half the topics they have that I
    do not (what they bring). People I already write with are left out.
    ``other_departments_only=False`` keeps my own department's people too (the
    compass weighs a near colleague and a far one side by side).
    """
    def topics_of(uid: str) -> Counter:
        c: Counter = Counter()
        for p in college.of(uid):
            for t in p["topics"]:
                c[picture._fold(t)] += 1
        return c

    spelled: dict[str, str] = {}
    for p in college.pubs.values():
        for t in p["topics"]:
            spelled.setdefault(picture._fold(t), t)

    mine = topics_of(user.id)
    if not mine:
        return []
    already = {c["user_id"] for c in graph.coauthors(user)["inside"] if c["user_id"]}
    my_dept = picture._fold(user.department or "")
    out = []
    for uid, other in college.users.items():
        if uid == user.id or uid in already or not other.active:
            continue
        if other_departments_only and my_dept and picture._fold(other.department or "") == my_dept:
            continue
        theirs = topics_of(uid)
        shared = [k for k in theirs if k in mine]
        if not shared:
            continue
        extra = [k for k, _ in theirs.most_common() if k not in mine][:5]
        score = sum(min(mine[k], theirs[k]) for k in shared) + 0.5 * len(extra)
        out.append({
            "user_id": uid,
            "name": other.name,
            "department": other.department or "",
            "papers": len(college.of(uid)),
            "shared_topics": [spelled[k] for k in sorted(shared, key=lambda k: -theirs[k])[:4]],
            "their_topics": [spelled[k] for k in extra],
            "score": round(score, 1),
        })
    out.sort(key=lambda c: (-c["score"], -c["papers"], c["name"]))
    return out[:limit]


# --------------------------------------------------------------------------- #
# From Scopus (grounded literature)                                           #
# --------------------------------------------------------------------------- #


def scopus_recent(topics: list[str], *, per_topic: int = 5, max_topics: int = 3) -> list[dict[str, Any]]:
    """Recent, most-cited Scopus papers on the person's top topics.

    Search API only (the key this app has cannot retrieve authors). Query
    pattern after the Scopus Search API docs / pybliometrics' ScopusSearch
    (MIT): ``TITLE-ABS-KEY("topic") AND PUBYEAR > year`` sorted by citations.
    Any failure yields fewer rows, never an error: this is supporting evidence.
    """
    from core.services import scopus

    if not (getattr(settings, "SCOPUS_API_KEY", "") or ""):
        return []
    since = timezone.localdate().year - 3
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for topic in topics[:max_topics]:
        q = scopus.clean_title_for_query(topic).replace("(", " ").replace(")", " ")
        try:
            data = scopus._search(f'TITLE-ABS-KEY("{q}") AND PUBYEAR > {since}', count=per_topic,
                                  sort="-citedby-count")
        except Exception as exc:  # noqa: BLE001
            logger.info("scout_scopus_failed topic=%s err=%s", topic, type(exc).__name__)
            continue
        for e in ((data.get("search-results") or {}).get("entry") or []):
            if not isinstance(e, dict) or e.get("error"):
                continue
            row = scopus.parse_search_entry(e)
            key = row.get("eid") or row.get("title") or ""
            if not row.get("title") or key in seen:
                continue
            seen.add(key)
            aff = e.get("affiliation") or []
            aff0 = aff[0] if isinstance(aff, list) and aff and isinstance(aff[0], dict) else {}
            out.append({
                "topic": topic,
                "title": row["title"],
                "year": row["publication_year"],
                "venue": row["journal_title"] or "",
                "first_author": e.get("dc:creator") or "",
                "affiliation": ", ".join(x for x in (aff0.get("affilname"), aff0.get("affiliation-country")) if x),
                "citations": scopus._intish(e.get("citedby-count")) or 0,
                "url": f"https://doi.org/{row['doi']}" if row.get("doi") else (row.get("scopus_url") or ""),
            })
    return out


# --------------------------------------------------------------------------- #
# From the web                                                                #
# --------------------------------------------------------------------------- #

_TASK = (
    "The data blocks hold a faculty member's publication record from our college database, "
    "college colleagues from OTHER departments whose records overlap theirs (computed from "
    "our database, each with a user_id), and, when there are any, recent highly cited Scopus "
    "papers on their topics (from the Scopus Search API; their first authors are candidate "
    "external collaborators, and those urls are valid to cite). "
    "Search the web (up to 5 searches) and find:\n"
    "1. 3-6 current opportunities: open funded calls (include national funders for an "
    "Indian college, e.g. ANRF/SERB, DST, DBT, ICMR, AICTE, where they fit), journal "
    "special issues, upcoming conferences, or recognised open problems in their area "
    "(with deadlines if stated). 'kind' is one of call, special_issue, conference or "
    "open_problem; 'deadline' is YYYY-MM-DD or empty.\n"
    "2. 3-5 next-level research directions that build directly on their past work.\n"
    "3. 3-6 external researchers or groups active in those directions.\n"
    "4. From the candidate list only, pick up to 4 colleagues (by their user_id) and say "
    "what each pair could do.\n"
    "Every url must be one you actually saw in search results. "
    "After searching, answer with only the JSON."
)


def _blocks(profile: dict[str, Any], candidates: list[dict[str, Any]],
            literature: list[dict[str, Any]] | None = None) -> list[harness.DataBlock]:
    """The record, the candidates and the literature, as fenced data.

    Every name, title and venue in them came from somebody's own entry or from
    a web service, so none of it is an instruction (docs/ux/20-ai.md, rule 4).
    """
    public = {k: v for k, v in profile.items() if k != "college_coauthor_ids"}
    cands = [{k: c[k] for k in ("user_id", "name", "department", "shared_topics", "their_topics")}
             for c in candidates]
    blocks = [
        harness.DataBlock("faculty member's record", json.dumps(public, ensure_ascii=False), 12000),
        harness.DataBlock("colleagues in other departments", json.dumps(cands, ensure_ascii=False), 8000),
    ]
    if literature:
        blocks.append(harness.DataBlock("recent Scopus papers", json.dumps(literature, ensure_ascii=False), 10000))
    return blocks


def _rows(item: harness.Spec, limit: int) -> harness.Arr:
    return harness.Arr(item, max_items=limit, drop_invalid=True, required=False, default=[])


def _opt(limit: int) -> harness.Str:
    return harness.Str(limit, truncate=True, required=False, default="")


#: Loose on purpose: `_clean` below keeps only what is checkable. This is what
#: makes sure it is handed objects and lists, and that a link, an address or a
#: colleague the search never produced is gone before it is.
SCOUT_SCHEMA = harness.Obj(
    {
        "summary": _opt(600),
        "opportunities": _rows(
            harness.Obj({"title": harness.Str(200, truncate=True), "kind": _opt(20), "why": _opt(400),
                         "deadline": _opt(20), "url": _opt(600)}), 10),
        "directions": _rows(
            harness.Obj({"title": harness.Str(200, truncate=True), "builds_on": _opt(300), "why": _opt(400),
                         "urls": harness.Arr(harness.Str(600, truncate=True), max_items=5, drop_invalid=True,
                                             required=False, default=[])}), 8),
        "external_people": _rows(
            harness.Obj({"name": harness.Str(120, truncate=True), "affiliation": _opt(200),
                         "work": _opt(400), "url": _opt(600)}), 10),
        "colleagues": _rows(harness.Obj({"user_id": harness.Str(64), "why": _opt(400)}), 8),
    },
)

SCOUT = harness.register(
    harness.Feature(
        name="scout.research",
        model="considered",
        system=SCOUT_SYSTEM,
        schema=SCOUT_SCHEMA,
        guards=[harness.no_pii()],
        # One web search run is minutes of a paid tool: no re-asking.
        limits=harness.Limits(timeout=180, deadline=420, reasks=0, transient_retries=1,
                              max_input_chars=48000, max_block_chars=12000),
        temperature=0.2,
        # It searches the web; what it may keep is decided by the guards.
        closed_world=False,
    )
)


def _clean(raw: Any, sources: list[dict[str, str]], candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Keep what is checkable; mark what is not. URLs not returned by search are dropped."""
    raw = raw if isinstance(raw, dict) else {}
    seen = {s["url"].rstrip("/") for s in sources}

    def url(u: Any) -> str:
        u = str(u or "").strip()
        return u if u and u.rstrip("/") in seen else ""

    def rows(key: str) -> list[dict]:
        v = raw.get(key)
        return [r for r in v if isinstance(r, dict)] if isinstance(v, list) else []

    def s(v: Any, n: int = 400) -> str:
        return str(v or "").strip()[:n]

    opportunities = [
        {"title": s(r.get("title"), 200), "kind": s(r.get("kind"), 20) or "open_problem",
         "why": s(r.get("why")), "deadline": s(r.get("deadline"), 20), "url": url(r.get("url"))}
        for r in rows("opportunities") if r.get("title")
    ][:8]
    directions = [
        {"title": s(r.get("title"), 200), "builds_on": s(r.get("builds_on"), 300), "why": s(r.get("why")),
         "urls": [u for u in (url(x) for x in (r.get("urls") or []) if isinstance(r.get("urls"), list)) if u][:3]}
        for r in rows("directions") if r.get("title")
    ][:6]
    people = [
        {"name": s(r.get("name"), 120), "affiliation": s(r.get("affiliation"), 200),
         "work": s(r.get("work")), "url": url(r.get("url"))}
        for r in rows("external_people") if r.get("name")
    ][:8]
    by_id = {c["user_id"]: c for c in candidates}
    why = {str(r.get("user_id")): s(r.get("why")) for r in rows("colleagues") if str(r.get("user_id")) in by_id}
    colleagues = []
    for c in candidates:
        colleagues.append({**{k: c[k] for k in ("user_id", "name", "department", "papers",
                                                  "shared_topics", "their_topics")},
                           "why": why.get(c["user_id"], ""), "picked": c["user_id"] in why})
    colleagues.sort(key=lambda c: not c["picked"])
    return {
        "summary": s(raw.get("summary"), 600),
        "opportunities": opportunities,
        "directions": directions,
        "external_people": people,
        "colleagues": colleagues[:6],
    }


def _remember(reply: harness.Reply, seen: list[dict[str, str]], literature: list[dict[str, Any]]) -> harness.Reply:
    """Note which links this run is allowed to show: the search's, and Scopus's."""
    seen[:] = [*(reply.extra or {}).get("sources", []), *({"url": x["url"]} for x in literature if x.get("url"))]
    return reply


def scout(user: User) -> tuple[dict[str, Any], dict[str, Any]]:
    """The full answer and the token usage. Raises ai.AIError on failure."""
    if ai.provider_name() != "anthropic" or anthropic_provider.missing_settings():
        raise ai.AIError("The research scout needs the Claude provider (ANTHROPIC_API_KEY).",
                         code="not_configured")
    college = picture.shared_college()
    profile = profile_of(user, college)
    candidates = colleague_candidates(user, college)
    if not profile["papers"]:
        raise ai.AIError("There are no papers on your record yet, so there is nothing to scout from.",
                         code="no_record")
    literature = scopus_recent(profile["topics"])

    def send(req: harness.Request) -> harness.Reply:
        """Claude with web search, which `ai.ask_json` has no way to ask."""
        try:
            got = anthropic_provider.research(req.prompt, system=req.system)
        except anthropic_provider.AnthropicError as exc:
            raise ai.AIError(exc.message, code=ai._CODE_MAP.get(exc.kind, "error")) from exc
        used = got.get("usage") or {}
        return harness.Reply(
            got["text"],
            usage={"input_tokens": used.get("input_tokens", 0), "output_tokens": used.get("output_tokens", 0)},
            extra=got,
        )

    seen_sources: list[dict[str, str]] = []
    result = SCOUT.run(
        user=user,
        data_blocks=_blocks(profile, candidates, literature),
        system_extra=f"Today is {timezone.localdate().isoformat()}.\n" + _TASK,
        # A colleague the candidate list did not contain is dropped by the
        # harness before `_clean` sees it, and a link the search never
        # returned is removed from every sentence, not only from the url fields.
        guards=[
            harness.grounded_ids([c["user_id"] for c in candidates], keys=("user_id",)),
            harness.no_urls_except(lambda: [x["url"] for x in seen_sources]),
        ],
        transport=lambda req: _remember(send(req), seen_sources, literature),
    )
    parsed = result.unwrap()
    found = result.extra
    lit_sources = [{"url": x["url"], "title": x["title"]} for x in literature if x["url"]]
    web = _clean(parsed, found["sources"] + lit_sources, candidates)
    colleagues = web.pop("colleagues")
    profile.pop("college_coauthor_ids", None)
    result = {
        "profile": profile,
        "web": web,
        "colleagues": colleagues,
        "literature": literature,
        "sources": found["sources"][:40],
        "model": anthropic_provider.model_name(),
        "generated_at": timezone.now().isoformat(),
    }
    return result, found["usage"]


# --------------------------------------------------------------------------- #
# Runs: cache, limit, job                                                     #
# --------------------------------------------------------------------------- #


def runs_today(user: User) -> int:
    return ScoutRun.objects.filter(user=user, created_at__gte=timezone.now() - timedelta(days=1)).count()


def fresh_run(user: User) -> ScoutRun | None:
    return ScoutRun.objects.filter(
        user=user, status=ScoutRun.Status.DONE, created_at__gte=timezone.now() - CACHE_FOR
    ).first()


def execute(run_id: str) -> str:
    """The django-q task body."""
    run = ScoutRun.objects.select_related("user").get(id=run_id)
    run.status = ScoutRun.Status.RUNNING
    run.save(update_fields=["status"])
    try:
        result, usage = scout(run.user)
        run.result_json = json.dumps(result, ensure_ascii=False)
        run.usage_json = json.dumps(usage)
        run.status = ScoutRun.Status.DONE
        logger.info("scout_done run=%s usage=%s", run.id, usage)
    except ai.AIError as exc:
        run.status, run.error, run.error_code = ScoutRun.Status.FAILED, str(exc), exc.code
    except Exception:  # noqa: BLE001 - the page must learn it failed
        logger.exception("scout_failed run=%s", run.id)
        run.status, run.error, run.error_code = ScoutRun.Status.FAILED, "The scout failed.", "error"
    run.finished_at = timezone.now()
    run.save()
    return run.status


def as_payload(run: ScoutRun | None, user: User) -> dict[str, Any]:
    """What the page sees. Never usage or money."""
    left = max(0, DAILY_LIMIT - runs_today(user))
    if run is None:
        return {"status": "none", "runs_left": left, "limit": DAILY_LIMIT}
    out: dict[str, Any] = {
        "id": run.id,
        "status": run.status.lower(),
        "created_at": run.created_at.isoformat(),
        "runs_left": left,
        "limit": DAILY_LIMIT,
    }
    if run.status == ScoutRun.Status.DONE:
        out["result"] = json.loads(run.result_json or "{}")
    if run.status == ScoutRun.Status.FAILED:
        out["error"], out["code"] = run.error, run.error_code
    return out
