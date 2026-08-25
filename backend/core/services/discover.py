"""Helping somebody decide what to write next, and where to send it.

Two questions, both asked before a paper exists, which is the point — every
other screen in this system deals with work that is already done. This is the
only place the software is any use *before* the writing starts.

The design rule is the one in `gemini.py`: **the model proposes, the database
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
from core.services import gemini
from core.services.normalize import normalize_title
from core.services.remuneration import calculate_remuneration, formula_from_model
from core.services.scimago import best_by_quartile, parse_categories_field

logger = logging.getLogger(__name__)

#: How many of the model's suggestions we bother resolving. It is asked for a
#: few more than we show, because some will not resolve.
ASK_FOR = 12
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

_VENUE_SCHEMA = {
    "type": "object",
    "properties": {
        "journals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "why": {"type": "string"},
                },
                "required": ["title", "why"],
            },
        }
    },
    "required": ["journals"],
}


def suggest_venues(
    *,
    title: str,
    abstract: str = "",
    keywords: str = "",
    author_position: int = 1,
    total_authors: int = 1,
) -> dict[str, Any]:
    """Where this paper could go, with what each venue would actually pay.

    Returns both what we could verify and what we could not, separately. The
    unverified ones are still worth showing — the model may well be right and
    the journal simply absent from a 2025 dump — but they carry no numbers.
    """
    prompt = (
        "You are helping an engineering academic in India choose where to submit a paper.\n"
        f"Paper title: {title}\n"
        + (f"Abstract: {abstract[:1500]}\n" if abstract else "")
        + (f"Keywords: {keywords}\n" if keywords else "")
        + f"\nName up to {ASK_FOR} peer-reviewed journals indexed in Scopus that genuinely "
        "publish work of this kind. Use each journal's exact full title as it appears in "
        "Scopus, with no abbreviation and no publisher name appended. Do not invent "
        "journals. Prefer established venues over new ones. For each, give one short "
        "sentence on why this paper fits it — about scope and fit, not about prestige."
    )

    raw = gemini.ask_json(prompt, schema=_VENUE_SCHEMA, temperature=0.3)
    proposed = (raw or {}).get("journals") or []

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


_DIRECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "directions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "why": {"type": "string"},
                    "first_step": {"type": "string"},
                },
                "required": ["topic", "why", "first_step"],
            },
        }
    },
    "required": ["directions"],
}


def suggest_directions(*, history: list[dict[str, str]], interests: list[str]) -> dict[str, Any]:
    """What this person might write next, given what they have written.

    Each suggestion carries a first step, because a research direction without
    one is a horoscope. The point is that somebody can act on it this week.
    """
    if not history and not interests:
        return {"directions": [], "grounded_on": {"papers": 0, "interests": []}}

    lines = [f"- {h['title']} ({h['journal']}, {h['year']})" for h in history[:20]]
    prompt = (
        "You are advising an engineering academic in India on what to work on next.\n\n"
        + ("Their recent publications:\n" + "\n".join(lines) + "\n\n" if lines else "")
        + ("Domains they have said they are interested in: " + ", ".join(interests) + "\n\n" if interests else "")
        + "Suggest 5 specific research directions they are well placed to pursue in the next "
        "year. Build on what they have already done rather than proposing a change of field. "
        "For each: a concrete topic, one sentence on why it suits them specifically given the "
        "work above, and a first step they could take within a week. Be concrete and avoid "
        "buzzwords. Do not suggest anything that requires equipment or funding they have "
        "shown no sign of having."
    )

    raw = gemini.ask_json(prompt, schema=_DIRECTION_SCHEMA, temperature=0.6)
    directions = [
        {
            "topic": (d.get("topic") or "").strip(),
            "why": (d.get("why") or "").strip(),
            "first_step": (d.get("first_step") or "").strip(),
        }
        for d in ((raw or {}).get("directions") or [])
        if (d.get("topic") or "").strip()
    ]

    return {
        "directions": directions[:5],
        # Said on screen, so a reader can tell whether a thin answer is the
        # model's fault or their own empty history.
        "grounded_on": {"papers": len(history), "interests": interests},
    }


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
