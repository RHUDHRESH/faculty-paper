"""Who may see a thread, and what an @name points at.

Both questions are answered here rather than at each endpoint, for the same
reason `hod.without_money` exists: a rule spread across six call sites is a
rule that is wrong at one of them, and the one it is wrong at is the one
nobody tested.
"""
from __future__ import annotations

import re
from typing import Any

from django.db.models import Q

from core.models import Claim, ClaimStatus, Mention, Role, Thread, User
from core.services import rbac

#: `@name`, `@"a name with spaces"`, or a typed form like `@journal:Nature`.
#: The quoted form exists because journal titles and people's names both
#: contain spaces, and a mention that stops at the first one points at the
#: wrong thing more often than not.
MENTION_RE = re.compile(
    r"@(?:(?P<kind>user|person|journal|paper|dept|department|agent):)?"
    r'(?:"(?P<quoted>[^"]{1,200})"|(?P<bare>[A-Za-z0-9._\-]{1,80}))'
)

AGENT_NAMES = {"agent", "assistant", "bot"}


def is_office(role: str | None) -> bool:
    return role in rbac.ADMIN_ROLES


def visible_threads(user: User):
    """Every thread this account may read.

    The OFFICE clause has two halves on purpose. The office sees all of them;
    everybody else sees the ones they opened. "Ask the admin why my claim was
    sent back" has to be invisible to colleagues *and* visible to the person
    who asked, or it is a write-only box and they go back to email.
    """
    condition = Q(visibility=Thread.Visibility.PUBLIC)

    department = (getattr(user, "department", "") or "").strip()
    if department:
        condition |= Q(
            visibility=Thread.Visibility.DEPARTMENT, department__iexact=department
        )

    if is_office(user.role):
        # The office reads everything, department threads included.
        #
        # Not an afterthought: `may_moderate` lets the office lock any thread,
        # and moderation without sight is not moderation -- it would be a
        # button for a thread they cannot open. It also means DEPARTMENT here
        # says "not the other departments" rather than "not the
        # administration", which is the only honest reading in a system where
        # the same accounts already read every claim and the audit log.
        condition |= Q(visibility=Thread.Visibility.OFFICE)
        condition |= Q(visibility=Thread.Visibility.DEPARTMENT)
    else:
        condition |= Q(visibility=Thread.Visibility.OFFICE, created_by=user)

    # A direct conversation is readable by the people in it and by nobody
    # else -- including the office, which reads every other kind. That is the
    # difference between a private line and a quiet one, and a "direct
    # message" the administration can read is the second thing wearing the
    # name of the first.
    condition |= Q(visibility=Thread.Visibility.DIRECT, participants__user=user)

    # `participants` is a reverse FK, so the join can repeat a thread once per
    # matching row. Only ever one row per person per thread, but the join is
    # still a join.
    return Thread.objects.filter(condition).distinct()


def may_read(user: User, thread: Thread) -> bool:
    return visible_threads(user).filter(pk=thread.pk).exists()


def may_post(user: User, thread: Thread) -> bool:
    """Reading is not writing: a locked thread stays readable."""
    return may_read(user, thread) and not thread.locked


def may_moderate(user: User, thread: Thread) -> bool:
    """The office moderates anywhere; anybody moderates their own thread.

    Except a direct conversation, which the office cannot even read. Letting
    them lock or delete inside one would be a moderation power over something
    invisible to them -- and would quietly undo the privacy the visibility
    exists to provide.
    """
    if thread.visibility == Thread.Visibility.DIRECT:
        return may_read(user, thread)
    return is_office(user.role) or thread.created_by_id == user.id


def check_visibility(
    user: User,
    visibility: str,
    department: str | None,
    participant_ids: list[str] | None = None,
) -> str | None:
    """Why this account may not open a thread with these settings, or None.

    A department thread is the one worth guarding: without this, anybody could
    open one against a department they have nothing to do with and it would be
    invisible to them the moment it was created -- a thread you cannot find
    again, which reads as the post having been lost.
    """
    if visibility not in Thread.Visibility.values:
        return f"Visibility must be one of: {', '.join(Thread.Visibility.values)}."
    if visibility == Thread.Visibility.DEPARTMENT:
        mine = (getattr(user, "department", "") or "").strip()
        if not department:
            return "Choose which department this is for."
        if not is_office(user.role) and department.strip().lower() != mine.lower():
            return (
                f"You can only open a department thread for {mine or 'your own department'}."
            )
    if visibility == Thread.Visibility.DIRECT:
        others = {p for p in (participant_ids or []) if p and p != user.id}
        if not others:
            # Without this a direct thread with an empty audience is readable
            # by its creator alone -- a private note that looks like a sent
            # message, which is the worst way for one to fail.
            return "Choose at least one person to talk to."
        if len(others) > 20:
            return "A direct conversation is for a handful of people, not a mailing list."
    return None


# ---------------------------------------------------------------- mentions --


def _match_user(label: str) -> User | None:
    """A person by email local-part, staff id, or name.

    Tried in that order because the first two are unique and the third is not:
    two people called R. Kumar is normal, and picking one of them at random is
    how a mention notifies the wrong colleague.
    """
    text = label.strip()
    if not text:
        return None
    found = User.objects.filter(email__iexact=text).first()
    if found:
        return found
    found = User.objects.filter(email__istartswith=f"{text}@").first()
    if found:
        return found
    found = User.objects.filter(staff_id__iexact=text).first()
    if found:
        return found
    matches = list(User.objects.filter(name__iexact=text)[:2])
    if len(matches) == 1:
        return matches[0]
    # An ambiguous or partial name resolves to nobody rather than to a guess.
    return None


def _match_claim(label: str) -> Claim | None:
    text = label.strip()
    if not text:
        return None
    return (
        Claim.objects.filter(ticket_number__iexact=text).first()
        or Claim.objects.filter(pk=text).first()
    )


def _match_journal(label: str) -> str | None:
    """A journal by title, as this system spells it.

    Matched against titles we have actually seen, so a mention resolves to
    something the agent can then look up rather than to free text.
    """
    text = label.strip()
    if not text:
        return None
    exact = (
        Claim.objects.filter(journal_title__iexact=text)
        .values_list("journal_title", flat=True)
        .first()
    )
    if exact:
        return exact
    return (
        Claim.objects.filter(journal_title__icontains=text)
        .values_list("journal_title", flat=True)
        .first()
    )


def _match_department(label: str) -> str | None:
    text = label.strip()
    if not text:
        return None
    return (
        User.objects.filter(department__iexact=text)
        .values_list("department", flat=True)
        .first()
    )


def parse_mentions(body: str) -> list[dict[str, Any]]:
    """Every @name in a post, resolved to what it points at.

    An unresolved mention is dropped rather than stored as a dangling label:
    a mention nothing answers to is just text, and storing it would put rows
    in the table that no notification, link or lookup can ever use.
    """
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    for match in MENTION_RE.finditer(body or ""):
        label = (match.group("quoted") or match.group("bare") or "").strip()
        if not label:
            continue
        kind_hint = (match.group("kind") or "").lower()

        if kind_hint == "agent" or (not kind_hint and label.lower() in AGENT_NAMES):
            key = (Mention.Kind.AGENT, "agent")
            if key not in seen:
                seen.add(key)
                out.append({"kind": Mention.Kind.AGENT, "label": label})
            continue

        resolvers: list[tuple[str, Any]] = []
        if kind_hint in ("user", "person"):
            resolvers = [(Mention.Kind.USER, _match_user)]
        elif kind_hint == "journal":
            resolvers = [(Mention.Kind.JOURNAL, _match_journal)]
        elif kind_hint == "paper":
            resolvers = [(Mention.Kind.PAPER, _match_claim)]
        elif kind_hint in ("dept", "department"):
            resolvers = [(Mention.Kind.DEPARTMENT, _match_department)]
        else:
            # Untyped: the specific things first, the fuzzy one last. A
            # ticket number and a staff id cannot be mistaken for anything
            # else; a journal title can be mistaken for half the dictionary.
            resolvers = [
                (Mention.Kind.PAPER, _match_claim),
                (Mention.Kind.USER, _match_user),
                (Mention.Kind.DEPARTMENT, _match_department),
                (Mention.Kind.JOURNAL, _match_journal),
            ]

        for kind, resolve in resolvers:
            hit = resolve(label)
            if not hit:
                continue
            row: dict[str, Any] = {"kind": kind, "label": label}
            if kind == Mention.Kind.USER:
                row["user"] = hit
                key = (kind, hit.id)
            elif kind == Mention.Kind.PAPER:
                row["claim"] = hit
                key = (kind, hit.id)
            elif kind == Mention.Kind.JOURNAL:
                row["journal_title"] = hit
                key = (kind, hit.lower())
            else:
                row["department"] = hit
                key = (kind, hit.lower())
            if key not in seen:
                seen.add(key)
                out.append(row)
            break

    return out


def mention_candidates(user: User, query: str, kind: str | None, limit: int = 8):
    """What the @ autocomplete offers, scoped to what this account may see.

    A claimant must not be able to enumerate every ticket in the college by
    typing @ and a digit, so papers are theirs unless they are in the office.
    """
    text = (query or "").strip()
    out: list[dict[str, Any]] = []
    if not text:
        return out

    want = (kind or "").upper()

    if not want or want == Mention.Kind.USER:
        for u in User.objects.filter(
            Q(name__icontains=text) | Q(email__istartswith=text), active=True
        ).order_by("name")[:limit]:
            out.append({
                "kind": Mention.Kind.USER,
                "id": u.id,
                "label": u.name or u.email,
                "hint": " · ".join(x for x in (u.department, u.designation) if x) or u.email,
            })

    if not want or want == Mention.Kind.DEPARTMENT:
        seen_dept: set[str] = set()
        for d in (
            User.objects.filter(department__icontains=text)
            .values_list("department", flat=True)
            .distinct()[:limit]
        ):
            key = (d or "").strip()
            if key and key.lower() not in seen_dept:
                seen_dept.add(key.lower())
                out.append({
                    "kind": Mention.Kind.DEPARTMENT, "id": key,
                    "label": key, "hint": "Department",
                })

    if not want or want == Mention.Kind.JOURNAL:
        seen_journal: set[str] = set()
        for j in (
            Claim.objects.filter(journal_title__icontains=text)
            .values_list("journal_title", flat=True)
            .distinct()[: limit * 2]
        ):
            key = (j or "").strip()
            if key and key.lower() not in seen_journal:
                seen_journal.add(key.lower())
                out.append({
                    "kind": Mention.Kind.JOURNAL, "id": key,
                    "label": key, "hint": "Journal",
                })
            if len(seen_journal) >= limit:
                break

    if not want or want == Mention.Kind.PAPER:
        papers = Claim.objects.exclude(status=ClaimStatus.DRAFT)
        if not is_office(user.role) and user.role not in (Role.PRINCIPAL, Role.FINANCE):
            papers = papers.filter(owner=user)
        for c in papers.filter(
            Q(ticket_number__icontains=text) | Q(paper_title__icontains=text)
        ).select_related("owner")[:limit]:
            out.append({
                "kind": Mention.Kind.PAPER,
                "id": c.ticket_number or c.id,
                "label": c.ticket_number or (c.paper_title or "")[:60],
                "hint": (c.paper_title or "")[:70],
            })

    if "agent".startswith(text.lower()) or text.lower() in AGENT_NAMES:
        out.insert(0, {
            "kind": Mention.Kind.AGENT, "id": "agent", "label": "agent",
            "hint": "Ask the assistant to look something up",
        })

    return out[: limit * 3]
