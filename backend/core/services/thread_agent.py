"""The assistant that answers when somebody writes @agent in a thread.

It is not a chatbot and does not call a model. Every answer is looked up in
this college's own tables or in the keyless scholarly sources, which means two
things that matter more than fluency:

- **It works.** The Gemini account's prepay credits are depleted, so anything
  built on the model would answer 503 from the day it shipped. This does not.
- **It is accountable.** "Nature is Q1, SNIP 5.2, and at author 3 of 4 that
  pays ₹63,000" is checkable against the same tables the payment is made from.
  A model saying the same sentence is a guess that happens to be formatted
  like a fact.

What it will not do is invent. When a journal is not in our reference data it
says so and stops, because a confident payout figure beside a venue we cannot
identify is how somebody submits to a journal that does not exist.
"""
from __future__ import annotations

from typing import Any

from core.models import Claim, ClaimStatus, Mention, Role, User
from core.services import rbac
from core.services.normalize import normalize_issn

#: A head of department never sees an amount, here as anywhere else.
def _may_see_money(user: User) -> bool:
    return user.role != Role.HOD


def _money(value: float | None) -> str:
    if value is None:
        return "—"
    return f"₹{value:,.0f}"


def _journal_facts(title: str) -> dict[str, Any]:
    """What we hold about a journal, and plainly what we do not.

    Goes through `lookup_scimago` and `lookup_snip_dump` rather than reading
    the tables directly: quartile is not a column on ScimagoJournal, it is
    derived from the subject categories, and SNIP is keyed on `print_issn` or
    `e_issn` with several ISSN spellings to try. Reimplementing either here
    would be a second, slightly different answer to a question the rest of the
    app already answers.
    """
    from core.services.scimago import lookup_scimago
    from core.services.verify import lookup_snip_dump

    rows = Claim.objects.filter(journal_title__iexact=title)
    sample = rows.exclude(issn__isnull=True).exclude(issn="").first() or rows.first()
    issn = normalize_issn(getattr(sample, "issn", None)) if sample else None

    scimago = lookup_scimago(issn=issn, title=title) or {}
    snip = lookup_snip_dump(issn, title)

    return {
        "title": title,
        "issn": issn,
        "quartile": scimago.get("matched_quartile") or scimago.get("quartile"),
        "sjr": scimago.get("sjr"),
        "dataset_year": scimago.get("year") or scimago.get("dataset_year"),
        "snip": snip,
        "papers_here": rows.exclude(status=ClaimStatus.DRAFT).count(),
        "known": bool(scimago.get("matched_quartile") or scimago.get("quartile") or snip),
    }


def _answer_journal(title: str, asker: User) -> str:
    facts = _journal_facts(title)
    lines: list[str] = [f"**{facts['title']}**"]

    if facts["issn"]:
        lines.append(f"ISSN {facts['issn']}")

    if not facts["known"]:
        # Said rather than filled in. This is the branch that stops the
        # assistant from being confidently wrong about a venue.
        lines.append(
            "We hold no SCImago or SNIP record for this journal, so there is no "
            "quartile and nothing can be priced against it. That does not mean "
            "the journal is not indexed — it means our reference data does not "
            "recognise this ISSN, which is worth telling the research cell."
        )
    else:
        standing = []
        if facts["quartile"]:
            standing.append(facts["quartile"])
        if facts["snip"] is not None:
            standing.append(f"SNIP {facts['snip']}")
        if facts["sjr"] is not None:
            standing.append(f"SJR {facts['sjr']}")
        if facts["dataset_year"]:
            standing.append(f"({facts['dataset_year']} data)")
        if standing:
            lines.append(" · ".join(standing))

        if _may_see_money(asker):
            estimate = _price(facts, author_position=1, total_authors=1)
            if estimate is not None:
                lines.append(
                    f"A sole-authored paper here works out at about {_money(estimate)}. "
                    "That is an estimate from the current policy for one author — "
                    "your own position and the number of authors change it."
                )

    if facts["papers_here"]:
        lines.append(
            f"{facts['papers_here']} papers from this college are on record in it."
        )
    else:
        lines.append("Nobody here has filed a paper in it yet.")

    return "\n\n".join(lines)


def _price(facts: dict[str, Any], *, author_position: int, total_authors: int) -> float | None:
    """What the current policy would pay, using the same calculator as a claim."""
    from core.models import FormulaConfig
    from core.services.remuneration import calculate_remuneration, formula_from_model

    cfg_row = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = formula_from_model(cfg_row) if cfg_row else None
    try:
        result = calculate_remuneration(
            snip=facts.get("snip"),
            quartile=facts.get("quartile"),
            total_authors=total_authors,
            author_position=author_position,
            cfg=cfg,
            indexing_level="Scopus",
            # Priced as an eligible paper so the figure answers "what is this
            # journal worth", not "what would happen if you attached nothing".
            sec_reference_count=None,
        )
    except Exception:
        return None
    return getattr(result, "remuneration", None)


def _answer_paper(claim: Claim, asker: User) -> str:
    from core.hod import progress_of

    lines = [f"**{claim.paper_title or 'Untitled'}**"]
    meta = [x for x in (claim.journal_title, str(claim.publication_year or "")) if x]
    if meta:
        lines.append(" · ".join(meta))

    if asker.role == Role.HOD or claim.owner_id == asker.id or rbac.can_view_reports(asker.role):
        lines.append(f"Where it is: {progress_of(claim.status)}")
    if claim.quartile:
        lines.append(f"Quartile {claim.quartile}")

    if _may_see_money(asker) and (
        claim.owner_id == asker.id or rbac.can_view_reports(asker.role)
    ):
        if claim.remuneration is not None:
            lines.append(f"Amount on the ticket: {_money(claim.remuneration)}")
        if claim.calc_error:
            lines.append(f"The amount could not be worked out: {claim.calc_error}")

    if claim.duplicate_warning:
        lines.append(
            "This paper carries a payment-history warning — it may already have been paid for."
        )
    return "\n\n".join(lines)


def _answer_person(person: User, asker: User) -> str:
    papers = Claim.objects.filter(owner=person).exclude(status=ClaimStatus.DRAFT)
    total = papers.count()
    q1 = papers.filter(quartile__iexact="Q1").count()
    led = papers.filter(author_position=1).count()

    lines = [f"**{person.name or person.email}**"]
    where = " · ".join(x for x in (person.department, person.designation) if x)
    if where:
        lines.append(where)
    lines.append(
        f"{total} papers on record, {q1} of them Q1, {led} led as first author."
    )

    areas = _areas_for(papers)
    if areas:
        lines.append("Works on: " + ", ".join(a for a, _ in areas[:5]) + ".")
    # No money about somebody else, whoever is asking. A colleague's payout is
    # not answerable here even for a role that could look it up elsewhere.
    return "\n\n".join(lines)


def _areas_for(queryset) -> list[tuple[str, int]]:
    from core.api import _split_subjects

    counts: dict[str, int] = {}
    for raw in queryset.values_list("subjects_json", flat=True):
        for area, _q in _split_subjects(raw):
            counts[area] = counts.get(area, 0) + 1
    return sorted(counts.items(), key=lambda kv: -kv[1])


def _answer_department(department: str, asker: User) -> str:
    papers = Claim.objects.filter(owner__department__iexact=department).exclude(
        status=ClaimStatus.DRAFT
    )
    total = papers.count()
    people = User.objects.filter(
        role=Role.FACULTY, department__iexact=department, active=True
    ).count()
    q1 = papers.filter(quartile__iexact="Q1").count()

    lines = [f"**{department}**", f"{total} papers on record from {people} faculty, {q1} of them Q1."]
    areas = _areas_for(papers)
    if areas:
        lines.append(
            "Strongest areas: " + ", ".join(f"{a} ({n})" for a, n in areas[:5]) + "."
        )
    return "\n\n".join(lines)


def _answer_search(question: str) -> str:
    """The field outside, from the keyless sources."""
    from core.services import research_search

    try:
        found = research_search.search(question, limit=5, this_year=None)
    except Exception:
        return (
            "I could not reach the scholarly sources just now. Nothing is wrong "
            "with the thread — try again in a moment."
        )

    results = found.get("results") or []
    if not results:
        return f"Nothing came back for “{question}”."

    lines = [f"Recent work on **{question}**:"]
    for r in results[:5]:
        bits = [r.get("title") or "Untitled"]
        tail = " · ".join(
            str(x)
            for x in (r.get("journal"), r.get("year"), f"{r.get('citations')} citations"
                      if r.get("citations") else None)
            if x
        )
        if tail:
            bits.append(tail)
        if r.get("url"):
            bits.append(r["url"])
        lines.append("- " + " — ".join(bits))

    failed = found.get("failed") or []
    if failed:
        # A thin list should read as one source being down, not a thin field.
        lines.append(
            f"({', '.join(failed)} did not answer, so there is likely more than this.)"
        )
    return "\n".join(lines)


HELP = (
    "I look things up in this college's own records and in the open scholarly "
    "sources. No AI model is involved, so I work whether or not the AI features "
    "are switched on.\n\n"
    "Mention something alongside me and I will answer about it:\n"
    "- `@agent @journal:\"Applied Soft Computing\"` — its standing, and what a paper there pays\n"
    "- `@agent @paper:ERP-001934` — where that ticket is\n"
    "- `@agent @person:r.kumar` — what they publish\n"
    "- `@agent @dept:ECE` — what a department is working on\n"
    "- `@agent find recent work on federated learning` — the field outside\n\n"
    "I will not guess. If a journal is not in our reference data I will say so "
    "rather than price it."
)


def answer(post, asker: User) -> str | None:
    """The assistant's reply to one post, or None if it was not asked.

    Driven by the mentions already resolved on the post rather than by parsing
    the text again — so what it answers about is exactly what the thread shows
    it was asked about.
    """
    mentions = list(post.mentions.all())
    if not any(m.kind == Mention.Kind.AGENT for m in mentions):
        return None

    parts: list[str] = []
    for mention in mentions:
        if mention.kind == Mention.Kind.JOURNAL and mention.journal_title:
            parts.append(_answer_journal(mention.journal_title, asker))
        elif mention.kind == Mention.Kind.PAPER and mention.claim_id:
            parts.append(_answer_paper(mention.claim, asker))
        elif mention.kind == Mention.Kind.USER and mention.user_id:
            parts.append(_answer_person(mention.user, asker))
        elif mention.kind == Mention.Kind.DEPARTMENT and mention.department:
            parts.append(_answer_department(mention.department, asker))

    if parts:
        return "\n\n---\n\n".join(parts)

    # Nothing was mentioned alongside it, so the rest of the sentence is the
    # question. Anything long enough to be one goes to the field search.
    question = _strip_mentions(post.body).strip()
    if len(question) >= 8:
        return _answer_search(question)
    return HELP


def _strip_mentions(body: str) -> str:
    from core.discussions import MENTION_RE

    return MENTION_RE.sub("", body or "")
