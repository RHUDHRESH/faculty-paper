"""What the social layer knows about how people relate, worked out in one place.

Four questions several screens ask, answered once so they cannot drift apart:

- **Who wrote this paper with them?** (`coauthors_by_claim`) Colleagues who
  filed a claim for the same paper -- the only co-authorship signal the system
  holds, keyed exactly as `collaborate._paper_key` keys it.
- **What field is somebody in?** (`fields_of`) The subject areas of their own
  published papers plus the interests they chose, and the journals they
  publish in.
- **How complete is a profile?** (`completeness`, `completeness_score_expr`)
  The seven things that let a colleague decide whether to get in touch.
- **How close are two people?** (`overlap`) Shared areas, journals and
  skills, with a reason a person can read.

Nothing here reads or returns money.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable

from django.db.models import Case, Exists, IntegerField, OuterRef, Q, Value, When

from core.models import Claim, PinnedPaper, ResearchInterest, Skill, User
from core.social import NOT_PUBLISHED

# ------------------------------------------------------------------ co-authors --


def coauthors_by_claim(claims: Iterable[Claim]) -> dict[str, list[User]]:
    """For each claim, the active colleagues who filed the same paper, by name.

    A prefilter on the indexed DOI and normalised title keeps this to the few
    claims that could match, rather than the full scan `research_record`
    makes; the key comparison afterwards is the exact one.
    """
    from core.api.collaborate import _paper_key

    claims = [c for c in claims if c is not None]
    keys = {c.id: _paper_key(c) for c in claims}
    wanted = {k for k in keys.values() if k}
    if not wanted:
        return {}

    condition = Q(pk__in=[])
    for kind, value in wanted:
        if kind == "doi":
            condition |= Q(doi__icontains=value)
        else:
            condition |= Q(normalized_title=value)
    titles = [c.paper_title for c in claims if keys[c.id] and keys[c.id][0] == "title" and c.paper_title]
    for title in titles:
        condition |= Q(paper_title__iexact=title)

    owners: dict[tuple[str, str], set[str]] = defaultdict(set)
    for other in (
        Claim.objects.exclude(status__in=NOT_PUBLISHED)
        .filter(condition)
        .only("id", "owner_id", "doi", "paper_title")
    ):
        key = _paper_key(other)
        if key in wanted and other.owner_id:
            owners[key].add(other.owner_id)

    people = {u.id: u for u in User.objects.filter(pk__in={p for s in owners.values() for p in s}, active=True)}
    out: dict[str, list[User]] = {}
    for c in claims:
        ids = owners.get(keys[c.id], set()) - {c.owner_id}
        out[c.id] = sorted((people[i] for i in ids if i in people), key=lambda u: u.name or "")
    return out


# ----------------------------------------------------------------------- fields --


@dataclass
class Field:
    areas: set[str] = field(default_factory=set)
    journals: set[str] = field(default_factory=set)
    skills: set[str] = field(default_factory=set)
    #: The same areas as written, for saying them back to a person.
    labels: dict[str, str] = field(default_factory=dict)


def split_subjects(raw: str | None) -> list[str]:
    from core.api.dashboard import _split_subjects

    return [area for area, _q in _split_subjects(raw)]


def fields_of(user_ids: Iterable[str]) -> dict[str, Field]:
    """Areas, journals and skills for each person, in three queries."""
    ids = list({i for i in user_ids if i})
    out: dict[str, Field] = defaultdict(Field)
    if not ids:
        return out
    for uid, domain in ResearchInterest.objects.filter(user_id__in=ids).values_list("user_id", "domain"):
        out[uid].areas.add(domain.lower())
        out[uid].labels.setdefault(domain.lower(), domain)
    for uid, subjects, journal in (
        Claim.objects.filter(owner_id__in=ids).exclude(status__in=NOT_PUBLISHED)
        .values_list("owner_id", "subjects_json", "journal_title")
    ):
        for area in split_subjects(subjects):
            out[uid].areas.add(area.lower())
            out[uid].labels.setdefault(area.lower(), area)
        if journal:
            out[uid].journals.add(journal.strip().lower())
    for uid, name in Skill.objects.filter(user_id__in=ids).values_list("user_id", "name"):
        out[uid].skills.add(name.lower())
    return out


@dataclass
class Overlap:
    score: float
    why: str


def overlap(mine: Field, theirs: Field) -> Overlap:
    """How close two people's work is, and the one sentence that says why."""
    areas = mine.areas & theirs.areas
    journals = mine.journals & theirs.journals
    skills = mine.skills & theirs.skills
    score = 3.0 * len(areas) + 2.0 * len(journals) + 1.0 * len(skills)
    if areas:
        named = sorted(theirs.labels.get(a, a) for a in areas)
        why = f"Works in {named[0]}" + (f" and {len(named) - 1} more of your areas" if len(named) > 1 else "")
    elif journals:
        why = "Publishes in a journal you publish in" if len(journals) == 1 else (
            f"Publishes in {len(journals)} journals you publish in"
        )
    elif skills:
        why = "Shares one of your skills" if len(skills) == 1 else f"Shares {len(skills)} of your skills"
    else:
        why = ""
    return Overlap(score, why)


# ----------------------------------------------------------------- completeness --

#: The seven parts of a complete profile, in the order the meter lists them.
PARTS = ("photo", "bio", "interests", "orcid", "scopus", "pinned", "skills")


def _set(value: str | None) -> bool:
    return bool((value or "").strip())


def completeness(user: User) -> dict[str, Any]:
    """The meter on your own profile: what is done, and the next concrete step for each."""
    has_papers = Claim.objects.filter(owner=user).exclude(status__in=NOT_PUBLISHED).exists()
    done = {
        "photo": _set(user.photo),
        "bio": _set(user.bio),
        "interests": ResearchInterest.objects.filter(user=user).exists(),
        "orcid": _set(user.orcid_id),
        "scopus": _set(user.scopus_author_url) or _set(user.scopus_author_id),
        "pinned": PinnedPaper.objects.filter(user=user).exists(),
        "skills": Skill.objects.filter(user=user).exists(),
    }
    steps = {
        "photo": ("A photo", "Add a photo so colleagues recognise you.", "edit"),
        "bio": ("A few lines about you", "Say what you work on and what you would like to hear about.", "edit"),
        "interests": ("Research interests", "Choose the subject areas you work in.", "edit"),
        "orcid": ("ORCID iD", "Paste your ORCID iD from orcid.org.", "edit"),
        "scopus": ("Scopus link", "Ask the research office to add your Scopus author link.", "/me"),
        "pinned": (
            "Pinned papers",
            "Pin up to three of your best papers." if has_papers else "File a paper, then pin it here.",
            "pins" if has_papers else "/papers/new",
        ),
        "skills": ("Skills", "List a skill or two for colleagues to endorse.", "skills"),
    }
    items = [
        {"key": k, "label": steps[k][0], "done": done[k], "next_step": steps[k][1], "action": steps[k][2]}
        for k in PARTS
    ]
    return {"score": round(100 * sum(done.values()) / len(PARTS)), "items": items}


def completeness_score_expr():
    """The same seven parts as a number from 0 to 7, for ordering a queryset of people."""

    def one(condition):
        return Case(When(condition, then=Value(1)), default=Value(0), output_field=IntegerField())

    def present(name):
        return Q(**{f"{name}__isnull": False}) & ~Q(**{name: ""})

    return (
        one(present("photo"))
        + one(present("bio"))
        + one(Exists(ResearchInterest.objects.filter(user=OuterRef("pk"))))
        + one(present("orcid_id"))
        + one(present("scopus_author_url") | present("scopus_author_id"))
        + one(Exists(PinnedPaper.objects.filter(user=OuterRef("pk"))))
        + one(Exists(Skill.objects.filter(user=OuterRef("pk"))))
    )
