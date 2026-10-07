"""Helping somebody decide what to write next, and where to send it.

Two questions, both asked before a paper exists, which is the point — every
other screen in this system deals with work that is already done. This is the
only place the software is any use *before* the writing starts.

The design rule is the one in `ai.py`: **the model proposes, the database
disposes.** Gemini is asked for journal names and research directions. Journal
names are then resolved against our own 32,189 Scimago rows and 32,087 SNIP
rows, and what survives is shown with a real quartile, a real SNIP, and the
amount our own formula computes for this person's author position. A name that
resolves to nothing is either dropped or shown explicitly as unverified — never
dressed up with a number.

The money matters here in a way it does not elsewhere. Telling somebody a
Q1 venue is worth roughly two lakh to them, before they choose where to submit,
is the single most useful thing this system knows and has never once said.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from django.db.models import Q

from core.models import Claim, FormulaConfig, ScimagoJournal, SnipSource
from core.services import ai  # noqa: F401 - AIError is what the endpoints catch
from core.services import ai_harness as harness
from core.services.normalize import normalize_title
from core.services.remuneration import calculate_remuneration, formula_from_model
from core.services.scimago import best_by_quartile, parse_categories_field

logger = logging.getLogger(__name__)

#: How many of the model's suggestions we bother resolving. It is asked for a
#: few more than we show, because some will not resolve.
#: Ask for a couple more than are shown, so that names the database cannot
#: verify still leave eight good ones -- but not many more. Inference runs
#: locally on the CPU here at roughly four and a half tokens a second, and
#: every extra journal is another sentence of prose somebody is waiting on.
#: Asking for twelve to show eight cost about a minute of that wait.
ASK_FOR = 9
SHOW = 8

#: Words carried by so many journal titles that matching on them finds
#: everything and therefore nothing.
_STOPWORDS = {
    "journal", "international", "of", "the", "and", "for", "in", "on", "review",
    "research", "science", "sciences", "studies", "advances", "advanced",
    "letters", "transactions", "proceedings", "annals", "reports", "current",
    "open", "applied", "new", "modern",
}


def _tokens(title: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", (title or "").lower()) if len(w) > 2]


def find_journal(name: str, *, year: int = 2025) -> ScimagoJournal | None:
    """Our own record for a journal the model named, or None.

    Exact normalised title first. Failing that, the rarest words in the name
    are used to pull a small candidate set out of the database, which is then
    checked properly in Python — the same shape as the duplicate sweep, and for
    the same reason: 32,000 rows is too many to scan and too few to justify a
    search index.
    """
    if not name or not name.strip():
        return None

    wanted = normalize_title(name)
    if not wanted:
        return None

    scope = ScimagoJournal.objects.filter(year=year)

    for row in scope.filter(title__iexact=name.strip())[:5]:
        return row

    distinctive = [w for w in _tokens(name) if w not in _STOPWORDS]
    if not distinctive:
        distinctive = _tokens(name)
    if not distinctive:
        return None

    query = Q()
    for word in sorted(distinctive, key=len, reverse=True)[:3]:
        query &= Q(title__icontains=word)

    for row in scope.filter(query)[:60]:
        if normalize_title(row.title) == wanted:
            return row

    # Nothing matched exactly. A near miss is worse than no answer here: the
    # reader would get real numbers attached to the wrong journal.
    return None


def _issns(row: ScimagoJournal) -> list[str]:
    return [v for v in (row.issn, row.eissn) if v]


def find_snip(row: ScimagoJournal) -> float | None:
    """The SNIP for this journal, matched by ISSN.

    ISSN, never title. The SNIP dump and the Scimago dump spell journal names
    differently often enough that title matching between them silently pairs
    the wrong two rows.
    """
    codes = _issns(row)
    if not codes:
        return None
    match = (
        SnipSource.objects.filter(Q(print_issn__in=codes) | Q(e_issn__in=codes))
        .exclude(snip__isnull=True)
        .order_by("-year")
        .first()
    )
    return match.snip if match else None


def categories_of(row: ScimagoJournal) -> list[dict[str, Any]]:
    """The subject categories, whichever way this row happens to store them.

    Rows loaded from the CSV importer hold real JSON; older rows hold the
    Scimago string form, "Software (Q1); Artificial Intelligence (Q2)". Reading
    one with the other's parser does not fail — it returns a single category
    whose name is the entire raw string and whose quartile is None. So a Q1
    journal silently reports no quartile at all, which is exactly the sort of
    quiet wrong answer this whole module exists to avoid.
    """
    raw = row.categories_json or "[]"
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return parse_categories_field(raw)
    if isinstance(parsed, str):
        return parse_categories_field(parsed)
    return parsed if isinstance(parsed, list) else []


def describe_journal(row: ScimagoJournal) -> dict[str, Any]:
    categories = categories_of(row)
    best = best_by_quartile(categories) if categories else {}
    return {
        "title": row.title,
        "issn": row.issn,
        "quartile": best.get("quartile"),
        "subject": best.get("category"),
        "sjr": row.sjr,
        "dataset_year": row.year,
        "snip": find_snip(row),
    }


def estimate_payout(
    *,
    snip: float | None,
    quartile: str | None,
    author_position: int,
    total_authors: int,
) -> dict[str, Any]:
    """What the policy would pay for a paper in this journal.

    An estimate, and labelled as one everywhere it is shown. It assumes the
    paper is a Scopus-indexed journal article, because that is what somebody
    choosing a venue is planning to write, and it cannot know the eventual
    author order — so the caller supplies the position being considered.
    """
    if snip is None or not quartile:
        return {
            "amount": None,
            "why_not": (
                "We do not hold a SNIP for this journal, so the amount cannot be worked out yet."
                if quartile
                else "We do not hold a quartile for this journal."
            ),
        }

    # The same active-policy lookup the /calculate endpoint uses. An estimate
    # computed against a stale or inactive policy would be worse than none.
    config_row = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    result = calculate_remuneration(
        snip,
        quartile,
        max(1, total_authors),
        max(1, author_position),
        formula_from_model(config_row) if config_row else None,
        publication_type="Journal",
        indexing_level="Scopus",
    )
    return {
        "amount": result.remuneration,
        "base": result.base,
        "qf": result.qf,
        "author_point": result.point,
        "category": result.category,
        "note": result.note,
        "why_not": result.error,
    }


def publication_history(user, limit: int = 25) -> list[dict[str, str]]:
    """What this person has actually published, for grounding a suggestion.

    Drafts are excluded — an unfinished ticket is a private intention, and
    feeding it to a model to reason about would be reading somebody's notes.
    """
    rows = (
        Claim.objects.filter(owner=user)
        .exclude(status="DRAFT")
        .exclude(paper_title="")
        .order_by("-publication_year")
        .values("paper_title", "journal_title", "publication_year")[:limit]
    )
    return [
        {
            "title": r["paper_title"],
            "journal": r["journal_title"] or "",
            "year": str(r["publication_year"] or ""),
        }
        for r in rows
    ]


# --------------------------------------------------------------------------- #
# The two questions                                                           #
# --------------------------------------------------------------------------- #

_VENUES_SYSTEM = (
    "You are helping an engineering academic in India choose where to submit a paper. "
    "The paper's title, abstract and keywords are in the data blocks. "
    f"Name up to {ASK_FOR} peer-reviewed journals indexed in Scopus that genuinely "
    "publish work of this kind. Use each journal's exact full title as it appears in "
    "Scopus, with no abbreviation and no publisher name appended. Do not invent "
    "journals. Prefer established venues over new ones. For each, give one short "
    "sentence on why this paper fits it, about scope and fit, not about prestige."
)

#: Every field but the name is optional with an empty default, because the code
#: below always tolerated a missing "why" and a model that leaves one out has
#: still named a journal. A bare list where the object was asked for (the
#: commonest way a smaller model misses a schema) is wrapped rather than
#: refused, and entries that are not objects are dropped.
VENUES = harness.register(
    harness.Feature(
        name="discover.venues",
        model="considered",
        system=_VENUES_SYSTEM,
        schema=harness.Obj(
            {
                "journals": harness.Arr(
                    harness.Obj(
                        {
                            "title": harness.Str(200, truncate=True),
                            "why": harness.Str(400, truncate=True, required=False, default=""),
                        }
                    ),
                    max_items=ASK_FOR + 3,
                    drop_invalid=True,
                )
            },
            from_list="journals",
        ),
        guards=[harness.no_urls_except(), harness.no_pii()],
        temperature=0.3,
        # It names journals from what it knows; the rows below check each one.
        closed_world=False,
    )
)


def suggest_venues(
    *,
    title: str,
    abstract: str = "",
    keywords: str = "",
    author_position: int = 1,
    total_authors: int = 1,
    user=None,
) -> dict[str, Any]:
    """Where this paper could go, with what each venue would actually pay.

    Returns both what we could verify and what we could not, separately. The
    unverified ones are still worth showing — the model may well be right and
    the journal simply absent from a 2025 dump — but they carry no numbers.

    The model is asked through `ai_harness`: the title and abstract are
    untrusted text and go in fenced data blocks, and the answer is checked
    against a schema before anything below reads it. A failure raises
    `ai.AIError`, as it always did, so the endpoints' status mapping holds.
    """
    blocks = [
        harness.DataBlock("paper title", title, 500),
        harness.DataBlock("abstract", abstract, 1500),
        harness.DataBlock("keywords", keywords, 600),
    ]
    # The same paper asked about twice within a quarter of an hour is the same
    # answer: the person's own copy is returned instead of a second call.
    raw = VENUES.run(user=user, data_blocks=blocks, cache_key=harness.AUTO).unwrap()
    proposed = [entry for entry in raw["journals"] if isinstance(entry, dict)]

    verified: list[dict[str, Any]] = []
    unverified: list[dict[str, Any]] = []
    seen: set[str] = set()

    for entry in proposed:
        name = (entry.get("title") or "").strip()
        why = (entry.get("why") or "").strip()
        if not name:
            continue
        key = normalize_title(name)
        if not key or key in seen:
            continue
        seen.add(key)

        row = find_journal(name)
        if not row:
            unverified.append({"title": name, "why": why})
            continue

        journal = describe_journal(row)
        journal["why"] = why
        journal["payout"] = estimate_payout(
            snip=journal["snip"],
            quartile=journal["quartile"],
            author_position=author_position,
            total_authors=total_authors,
        )
        verified.append(journal)

    # Best paying first, then by quartile. Somebody choosing a venue is making
    # a trade-off and the money is one axis of it, so it leads.
    def sort_key(j: dict[str, Any]):
        amount = (j.get("payout") or {}).get("amount")
        return (0 if amount is not None else 1, -(amount or 0), j.get("quartile") or "Z")

    verified.sort(key=sort_key)

    return {
        "journals": verified[:SHOW],
        "unverified": unverified[:4],
        "assumed": {
            "author_position": author_position,
            "total_authors": total_authors,
            "publication_type": "Journal article, Scopus indexed",
        },
    }


_DIRECTIONS_SYSTEM = (
    "You are advising an engineering academic in India on what to work on next. "
    "Their recent publications, and the domains they have said they are interested in, are "
    "in the data blocks. Suggest 5 specific research directions they are well placed to "
    "pursue in the next year. Build on what they have already done rather than proposing a "
    "change of field. For each: a concrete topic, one sentence on why it suits them "
    "specifically given the work above, and a first step they could take within a week. "
    "Be concrete and avoid buzzwords. Do not suggest anything that requires equipment or "
    "funding they have shown no sign of having."
)

DIRECTIONS = harness.register(
    harness.Feature(
        name="discover.directions",
        model="considered",
        system=_DIRECTIONS_SYSTEM,
        schema=harness.Obj(
            {
                "directions": harness.Arr(
                    harness.Obj(
                        {
                            "topic": harness.Str(300, truncate=True),
                            "why": harness.Str(600, truncate=True, required=False, default=""),
                            "first_step": harness.Str(600, truncate=True, required=False, default=""),
                        }
                    ),
                    max_items=8,
                    drop_invalid=True,
                )
            },
            from_list="directions",
        ),
        guards=[harness.no_urls_except(), harness.no_pii()],
        # Higher on purpose, and so not cached: asking again should not give
        # the same five.
        temperature=0.6,
        closed_world=False,
    )
)


def _as_rows(raw, key: str) -> list[dict]:
    """The rows a model returned, whatever container it chose for them.

    Asked for `{"directions": [...]}` a smaller model sometimes answers with
    the bare array. That is close enough to right to use, and calling `.get`
    on it is an uncaught AttributeError -- a 500 for what should be a shrug.
    """
    rows = raw.get(key) if isinstance(raw, dict) else raw
    return [r for r in (rows or []) if isinstance(r, dict)]


def suggest_directions(
    *, history: list[dict[str, str]], interests: list[str], user=None
) -> dict[str, Any]:
    """What this person might write next, given what they have written.

    Each suggestion carries a first step, because a research direction without
    one is a horoscope. The point is that somebody can act on it this week.
    """
    if not history and not interests:
        return {"directions": [], "grounded_on": {"papers": 0, "interests": []}}

    lines = [f"- {h['title']} ({h['journal']}, {h['year']})" for h in history[:20]]
    blocks = [
        harness.DataBlock("recent publications", "\n".join(lines)),
        harness.DataBlock("domains of interest", ", ".join(interests)),
    ]
    raw = DIRECTIONS.run(user=user, data_blocks=blocks).unwrap()
    directions = [
        {
            "topic": (d.get("topic") or "").strip(),
            "why": (d.get("why") or "").strip(),
            "first_step": (d.get("first_step") or "").strip(),
        }
        for d in _as_rows(raw, "directions")
        if (d.get("topic") or "").strip()
    ]

    return {
        "directions": directions[:5],
        # Said on screen, so a reader can tell whether a thin answer is the
        # model's fault or their own empty history.
        "grounded_on": {"papers": len(history), "interests": interests},
    }


#: The most domains one person may follow, and the column's width.
MAX_INTERESTS = 20
MAX_DOMAIN_CHARS = 160


def replace_interests(user, domains: list[str]) -> list[str]:
    """Replace a person's whole set of research interests; the set as kept.

    A whole-set write rather than add and remove: the screens that write it
    (My research's domains, the compass's topics step) are multi-selects, and
    two round trips per tick would leave a set half-applied if one failed.
    Blank and repeated entries are dropped, and at most `MAX_INTERESTS` kept.
    """
    from django.db import transaction

    from core.models import ResearchInterest

    wanted: list[str] = []
    for raw in domains[:MAX_INTERESTS]:
        name = (raw or "").strip()[:MAX_DOMAIN_CHARS]
        if name and name not in wanted:
            wanted.append(name)

    with transaction.atomic():
        ResearchInterest.objects.filter(user=user).exclude(domain__in=wanted).delete()
        existing = set(ResearchInterest.objects.filter(user=user).values_list("domain", flat=True))
        ResearchInterest.objects.bulk_create(
            [ResearchInterest(user=user, domain=d) for d in wanted if d not in existing],
            ignore_conflicts=True,
        )
    return wanted


def research_domains(query: str = "", limit: int = 40) -> list[str]:
    """The vocabulary of interest domains, taken from our own Scimago rows.

    302 real subject categories rather than a list somebody typed. A domain a
    claimant picks here has to be one that journals in our data are actually
    classified under, or matching against it later finds nothing.
    """
    from django.core.cache import cache

    cached = cache.get("research_domains")
    if cached is None:
        found: set[str] = set()
        for raw in ScimagoJournal.objects.filter(year=2025).values_list(
            "categories_json", flat=True
        )[:12000]:
            try:
                parsed = json.loads(raw or "[]")
            except (json.JSONDecodeError, TypeError):
                parsed = parse_categories_field(raw or "")
            if isinstance(parsed, str):
                parsed = parse_categories_field(parsed)
            for entry in parsed if isinstance(parsed, list) else []:
                name = (entry.get("category") or "").strip() if isinstance(entry, dict) else ""
                if name:
                    found.add(name)
        cached = sorted(found)
        cache.set("research_domains", cached, 60 * 60 * 12)

    term = (query or "").strip().lower()
    if term:
        starts = [d for d in cached if d.lower().startswith(term)]
        contains = [d for d in cached if term in d.lower() and d not in starts]
        cached = starts + contains
    return cached[: max(1, min(limit, 302))]


def reprice(*, issns: list[str], author_position: int, total_authors: int) -> dict[str, Any]:
    """Recompute what a set of already-resolved journals would pay.

    The venue screen lets somebody try being second author of four instead of
    first of two, and watch the figures move. Doing that through
    `suggest_venues` would ask the model the same question again for an answer
    that cannot have changed — several seconds and a paid call per keystroke,
    to re-derive a list we already have.

    So this takes the ISSNs the model's suggestions already resolved to and
    does the arithmetic alone. No model, no network. The journals themselves
    are looked up again rather than trusted from the client, because a payout
    is money and the client is not the authority on which journal an ISSN is.
    """
    out: list[dict[str, Any]] = []
    for issn in issns[:20]:
        code = (issn or "").strip()
        if not code:
            continue
        row = (
            ScimagoJournal.objects.filter(year=2025)
            .filter(Q(issn=code) | Q(eissn=code))
            .first()
        )
        if not row:
            continue
        journal = describe_journal(row)
        journal["payout"] = estimate_payout(
            snip=journal["snip"],
            quartile=journal["quartile"],
            author_position=author_position,
            total_authors=total_authors,
        )
        out.append(journal)

    return {
        "journals": out,
        "assumed": {
            "author_position": author_position,
            "total_authors": total_authors,
            "publication_type": "Journal article, Scopus indexed",
        },
    }
