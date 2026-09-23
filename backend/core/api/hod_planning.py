"""What a head of department plans, hands out and chases.

The rest of a head's screens answer "what has the department done". These
answer the other half of the job: what it is for (the plan), who is doing
what towards it (assignments -- tasks, co-author pairings, research areas),
and a word to somebody who has gone quiet (a nudge).

Every endpoint keeps the two limits the rest of `/hod/` keeps. A head acts in
their own department, read from their account and never from a parameter --
a head naming another department is refused, not filtered. And nothing here
carries money; the responses go through `hod.without_money` all the same, so
that a field added later cannot quietly become the first leak.

A super admin may do anything a head may, for any department, by naming it in
`?department=`.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any, Optional

from django.db import transaction
from django.db.models import Case, F, IntegerField, Q, Value, When
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.models import (
    AuditLog,
    DepartmentAssignment,
    DepartmentPlan,
    Notification,
    Role,
    User,
)

#: How long a person is left alone after a nudge, whoever sent it. A
#: reminder that arrives three times in an afternoon because two people
#: clicked the same button is nagging, and it teaches the reader to ignore
#: the next one.
NUDGE_COOLDOWN = timedelta(hours=24)
NUDGE_MIN, NUDGE_MAX = 10, 500

MAX_AREAS, MAX_AREA_LENGTH = 20, 80
MAX_VISION_LENGTH = 5000
MAX_TITLE_LENGTH = 200

#: Where a faculty member's notification lands: their home screen, which is
#: where their assignments are listed. The department page is a head's, and
#: a link there would be a 403 to everybody it is sent to.
FACULTY_HOME = "/"


# ---------- whose department ----------


def _no_department() -> HttpError:
    return HttpError(
        400,
        "This account has no department set, so there is nothing to show. "
        "Ask the research cell to set it.",
    )


def _acting_department(user: User, department: Optional[str]) -> str:
    """The department a head -- or a super admin standing in -- acts on.

    A head's is their own. Naming another one is refused rather than quietly
    ignored: an answer about the wrong department that looks like the right
    one is worse than a refusal. A super admin names the department, and it
    has to be one somebody is actually in -- a typo would otherwise create a
    plan for a department that does not exist.
    """
    asked = (department or "").strip()
    if user.role == Role.SUPER_ADMIN:
        chosen = asked or hod.department_of(user)
        if not chosen:
            raise HttpError(400, "Say which department this is for: ?department=…")
        if not User.objects.filter(department__iexact=chosen).exists():
            raise HttpError(400, f"Nobody is in a department called {chosen}.")
        return chosen
    if user.role != Role.HOD:
        raise HttpError(403, "Forbidden")
    return _own_department(user, asked)


def _own_department(user: User, asked: str) -> str:
    own = hod.department_of(user)
    if not own:
        raise _no_department()
    if asked and asked.lower() != own.lower():
        raise HttpError(403, f"This account acts within its own department, {own}.")
    return own


def _manages(user: User, department: str) -> bool:
    """May this account change things in this department?"""
    if user.role == Role.SUPER_ADMIN:
        return True
    return user.role == Role.HOD and hod.department_of(user).lower() == department.lower()


def _member(department: str, user_id: Optional[str], what: str) -> User:
    """Somebody in this department who can be given work.

    Checked here, on the server, and never only on the screen: the picker
    offering nobody from another department is a convenience, and this is
    the rule.
    """
    person = User.objects.filter(pk=user_id).first() if user_id else None
    if person is None:
        raise HttpError(400, f"No such person for the {what}.")
    if (person.department or "").strip().lower() != department.lower():
        raise HttpError(400, f"{person.name} is not in {department}.")
    if not person.active:
        raise HttpError(400, f"{person.name}'s account is no longer active.")
    return person


# ---------- the department plan ----------


class PlanIn(Schema):
    vision: str = ""
    research_areas: list[str] = []


def _plan_dict(department: str, plan: DepartmentPlan | None) -> dict[str, Any]:
    return hod.without_money({
        "department": plan.department if plan else department,
        "vision": plan.vision if plan else "",
        "research_areas": list(plan.research_areas or []) if plan else [],
        "updated_by": plan.updated_by.name if plan and plan.updated_by_id else None,
        "updated_at": plan.updated_at.isoformat() if plan else None,
    })


def _clean_areas(raw: list[str]) -> list[str]:
    """Trimmed, blanks dropped, and each area once whatever its case."""
    areas: list[str] = []
    seen: set[str] = set()
    for item in raw:
        area = " ".join((item or "").split())
        if not area or area.lower() in seen:
            continue
        if len(area) > MAX_AREA_LENGTH:
            raise HttpError(
                400,
                f"A research area is a short label, {MAX_AREA_LENGTH} characters at most. "
                "Put the description in the vision.",
            )
        seen.add(area.lower())
        areas.append(area)
    if len(areas) > MAX_AREAS:
        raise HttpError(400, f"Name {MAX_AREAS} research areas at most.")
    return areas


@api.get("/hod/plan", auth=session_auth)
def hod_plan(request: HttpRequest, department: Optional[str] = None):
    """The department's vision and research areas.

    A head's own, a super admin's for whichever department they name, and
    readable by every faculty member of the department it belongs to -- a
    direction nobody in the department can see is not a direction.
    """
    user = require_user(request)
    if user.role == Role.FACULTY:
        chosen = _own_department(user, (department or "").strip())
    else:
        chosen = _acting_department(user, department)
    plan = (
        DepartmentPlan.objects.filter(department__iexact=chosen)
        .select_related("updated_by")
        .first()
    )
    return _plan_dict(chosen, plan)


@api.put("/hod/plan", auth=session_auth)
def hod_set_plan(request: HttpRequest, payload: PlanIn, department: Optional[str] = None):
    """Replace the plan as a whole: the screen edits it as one document."""
    user = require_user(request)
    chosen = _acting_department(user, department)

    vision = (payload.vision or "").strip()
    if len(vision) > MAX_VISION_LENGTH:
        raise HttpError(400, f"Keep the vision under {MAX_VISION_LENGTH} characters.")
    areas = _clean_areas(payload.research_areas)

    with transaction.atomic():
        # get_or_create rather than a locked read: there is no row to lock the
        # first time, and two first saves racing would otherwise meet at the
        # unique constraint as a 500.
        plan, created = DepartmentPlan.objects.get_or_create(
            department__iexact=chosen, defaults={"department": chosen}
        )
        plan.vision = vision
        plan.research_areas = areas
        plan.updated_by = user
        plan.save()
        AuditLog.objects.create(
            actor=user, action="PLAN_UPDATE", entity="DepartmentPlan", entity_id=plan.id,
            detail_json=json.dumps({
                "department": plan.department, "research_areas": areas,
                "vision_length": len(vision), "created": created,
            }),
        )
    return _plan_dict(chosen, plan)


# ---------- assignments ----------


class AssignmentIn(Schema):
    kind: str
    title: str
    notes: Optional[str] = None
    assignee_id: str
    partner_id: Optional[str] = None
    due_date: Optional[date] = None


class AssignmentPatch(Schema):
    kind: Optional[str] = None
    title: Optional[str] = None
    notes: Optional[str] = None
    assignee_id: Optional[str] = None
    partner_id: Optional[str] = None
    due_date: Optional[date] = None
    status: Optional[str] = None


_KINDS = {k.value for k in DepartmentAssignment.Kind}
_STATUSES = {s.value for s in DepartmentAssignment.Status}


def _choice(value: Optional[str], allowed: set[str], what: str) -> str:
    if value not in allowed:
        raise HttpError(400, f"{what} must be one of: {', '.join(sorted(allowed))}.")
    return value  # type: ignore[return-value]


def _check_shape(kind: str, title: str, assignee: User, partner: User | None) -> None:
    """The rules every assignment satisfies, however it got into this state."""
    _choice(kind, _KINDS, "Kind")
    if not title:
        raise HttpError(400, "Give the assignment a title.")
    if len(title) > MAX_TITLE_LENGTH:
        raise HttpError(400, f"Keep the title under {MAX_TITLE_LENGTH} characters.")
    if kind == DepartmentAssignment.Kind.PAIRING:
        if partner is None:
            raise HttpError(400, "A co-author pairing needs a second person.")
        if partner.id == assignee.id:
            raise HttpError(400, "Pair two different people.")
    elif partner is not None:
        raise HttpError(400, "Only a co-author pairing takes a second person.")


def _unfinished_first(qs):
    """Open work before finished work, soonest deadline first, newest last."""
    return qs.annotate(
        _finished=Case(
            When(status=DepartmentAssignment.Status.DONE, then=Value(1)),
            default=Value(0),
            output_field=IntegerField(),
        )
    ).order_by("_finished", F("due_date").asc(nulls_last=True), "-created_at")


def _assignment_dict(a: DepartmentAssignment) -> dict[str, Any]:
    return {
        "id": a.id,
        "department": a.department,
        "kind": a.kind,
        "kind_label": DepartmentAssignment.Kind(a.kind).label,
        "title": a.title,
        "notes": a.notes,
        "status": a.status,
        "status_label": DepartmentAssignment.Status(a.status).label,
        "assignee_id": a.assignee_id,
        "assignee_name": a.assignee.name,
        "partner_id": a.partner_id,
        "partner_name": a.partner.name if a.partner_id else None,
        "due_date": a.due_date.isoformat() if a.due_date else None,
        "set_by": a.created_by.name if a.created_by_id else None,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


def _with_people(qs):
    return qs.select_related("assignee", "partner", "created_by")


def _notify_assigned(a: DepartmentAssignment, people: list[User], actor: User) -> None:
    """Tell each person newly on an assignment what it is and who with.

    Never the person who made the change: a head who pairs themselves with a
    colleague does not need to be told what they just did.
    """
    due = f" Due by {a.due_date.strftime('%d %b %Y')}." if a.due_date else ""
    body = ((a.notes or "").strip() + due).strip() or None
    for person in people:
        if person.id == actor.id:
            continue
        if a.kind == DepartmentAssignment.Kind.PAIRING:
            other = a.partner if person.id == a.assignee_id else a.assignee
            title = f"Paired with {other.name} to write together: {a.title}"
        elif a.kind == DepartmentAssignment.Kind.RESEARCH_AREA:
            title = f"A research area for you: {a.title}"
        else:
            title = f"Assigned to you: {a.title}"
        Notification.objects.create(
            user=person, title=title[:255], body=body, href=FACULTY_HOME
        )


def _audit(user: User, action: str, a: DepartmentAssignment, **detail: Any) -> None:
    AuditLog.objects.create(
        actor=user, action=action, entity="DepartmentAssignment", entity_id=a.id,
        detail_json=json.dumps({"department": a.department, "kind": a.kind, **detail}),
    )


@api.get("/hod/assignments", auth=session_auth)
def hod_assignments(
    request: HttpRequest,
    status: Optional[str] = None,
    kind: Optional[str] = None,
    department: Optional[str] = None,
):
    """Everything handed out in the department, unfinished first."""
    user = require_user(request)
    chosen = _acting_department(user, department)
    qs = DepartmentAssignment.objects.filter(department__iexact=chosen)
    # An unknown filter is refused rather than ignored: ignoring it answers a
    # different question -- "everything" -- that looks like the one asked.
    if status:
        qs = qs.filter(status=_choice(status, _STATUSES, "Status"))
    if kind:
        qs = qs.filter(kind=_choice(kind, _KINDS, "Kind"))
    return hod.without_money([_assignment_dict(a) for a in _unfinished_first(_with_people(qs))])


@api.post("/hod/assignments", auth=session_auth)
def hod_create_assignment(
    request: HttpRequest, payload: AssignmentIn, department: Optional[str] = None
):
    """Hand a task, a pairing or a research area to people in the department.

    Both people must be in it. The people it is for are told in-app, with a
    link to their own home screen, where it is listed.
    """
    user = require_user(request)
    chosen = _acting_department(user, department)

    kind = _choice(payload.kind, _KINDS, "Kind")
    title = (payload.title or "").strip()
    assignee = _member(chosen, payload.assignee_id, "assignment")
    partner = _member(chosen, payload.partner_id, "pairing") if payload.partner_id else None
    _check_shape(kind, title, assignee, partner)

    with transaction.atomic():
        a = DepartmentAssignment.objects.create(
            department=chosen,
            kind=kind,
            title=title,
            notes=(payload.notes or "").strip(),
            assignee=assignee,
            partner=partner,
            due_date=payload.due_date,
            created_by=user,
        )
        _audit(
            user, "ASSIGNMENT_CREATE", a,
            assignee=assignee.id, partner=partner.id if partner else None,
            due_date=a.due_date.isoformat() if a.due_date else None,
        )
        _notify_assigned(a, [p for p in (assignee, partner) if p], user)
    return hod.without_money(_assignment_dict(a))


@api.patch("/hod/assignments/{assignment_id}", auth=session_auth)
def hod_update_assignment(request: HttpRequest, assignment_id: str, payload: AssignmentPatch):
    """Change an assignment.

    The head of its department (or a super admin) may change anything. The
    people it is for may move its status and nothing else -- they can say
    they have started or finished, not redefine what they were asked to do.
    """
    user = require_user(request)
    a = get_object_or_404(_with_people(DepartmentAssignment.objects), pk=assignment_id)
    changes = payload.dict(exclude_unset=True)

    if not _manages(user, a.department):
        if user.id not in (a.assignee_id, a.partner_id):
            raise HttpError(403, "This assignment is not yours to change.")
        if set(changes) - {"status"}:
            raise HttpError(
                403, "You can move the status of work given to you; the rest is the head's."
            )

    before = {"assignee": a.assignee_id, "partner": a.partner_id}
    if "status" in changes:
        a.status = _choice(changes["status"], _STATUSES, "Status")
    if "kind" in changes:
        a.kind = _choice(changes["kind"], _KINDS, "Kind")
    if "title" in changes:
        a.title = (changes["title"] or "").strip()
    if "notes" in changes:
        a.notes = (changes["notes"] or "").strip()
    if "due_date" in changes:
        a.due_date = changes["due_date"]
    if "assignee_id" in changes:
        a.assignee = _member(a.department, changes["assignee_id"], "assignment")
    if "partner_id" in changes:
        a.partner = (
            _member(a.department, changes["partner_id"], "pairing")
            if changes["partner_id"]
            else None
        )
    _check_shape(a.kind, a.title, a.assignee, a.partner)

    with transaction.atomic():
        a.save()
        _audit(
            user, "ASSIGNMENT_UPDATE", a,
            changed=sorted(changes), status=a.status,
        )
        involved_before = {v for v in before.values() if v}
        newcomers = [p for p in (a.assignee, a.partner) if p and p.id not in involved_before]
        _notify_assigned(a, newcomers, user)
    return hod.without_money(_assignment_dict(a))


@api.delete("/hod/assignments/{assignment_id}", auth=session_auth)
def hod_delete_assignment(request: HttpRequest, assignment_id: str):
    user = require_user(request)
    a = get_object_or_404(DepartmentAssignment, pk=assignment_id)
    if not _manages(user, a.department):
        raise HttpError(403, "Only the head of the department can withdraw this.")
    _audit(user, "ASSIGNMENT_DELETE", a, title=a.title)
    a.delete()
    return {"ok": True}


@api.get("/me/assignments", auth=session_auth)
def my_assignments(request: HttpRequest):
    """Work given to me, as the one asked or the one paired with them.

    `with_name` is the other person on a pairing, seen from where I stand --
    for the partner that is the assignee, not themselves.
    """
    user = require_user(request)
    qs = _with_people(
        DepartmentAssignment.objects.filter(Q(assignee=user) | Q(partner=user))
    )
    rows = []
    for a in _unfinished_first(qs):
        row = _assignment_dict(a)
        mine_as_partner = a.partner_id == user.id
        row["my_part"] = "PARTNER" if mine_as_partner else "ASSIGNEE"
        row["with_name"] = (
            a.assignee.name if mine_as_partner else (a.partner.name if a.partner_id else None)
        )
        rows.append(row)
    return hod.without_money(rows)


# ---------- nudges ----------


class NudgeIn(Schema):
    user_ids: list[str]
    message: str


@api.post("/hod/nudge", auth=session_auth)
def hod_nudge(request: HttpRequest, payload: NudgeIn, department: Optional[str] = None):
    """A reminder to people in the department, one per person per day.

    Everybody named must be in the department, or nobody is sent anything --
    half a batch delivered is harder to reason about than a refusal. Somebody
    reminded in the last day is skipped and listed, not refused: the rest of
    the batch still goes, and the head is told who was left out and why.

    The audit log is the record of each reminder, one row per person, and
    the daily limit reads it rather than keeping a second record that could
    disagree with the first.
    """
    user = require_user(request)
    chosen = _acting_department(user, department)

    message = (payload.message or "").strip()
    if not NUDGE_MIN <= len(message) <= NUDGE_MAX:
        raise HttpError(
            400, f"Write between {NUDGE_MIN} and {NUDGE_MAX} characters."
        )
    ids = list(dict.fromkeys(i for i in payload.user_ids if i))
    if not ids:
        raise HttpError(400, "Choose at least one person to remind.")
    people = [_member(chosen, i, "reminder") for i in ids]

    since = timezone.now() - NUDGE_COOLDOWN
    recent: dict[str, Any] = {}
    for row in (
        AuditLog.objects.filter(
            action="HOD_NUDGE", entity="User", entity_id__in=ids, created_at__gte=since
        )
        .order_by("created_at")
        .values("entity_id", "created_at")
    ):
        recent[row["entity_id"]] = row["created_at"]

    sent = 0
    skipped = []
    with transaction.atomic():
        for person in people:
            if person.id in recent:
                skipped.append({
                    "id": person.id,
                    "name": person.name,
                    "last_nudged_at": recent[person.id].isoformat(),
                })
                continue
            Notification.objects.create(
                user=person,
                title="A reminder from your head of department",
                body=message,
                href=FACULTY_HOME,
            )
            AuditLog.objects.create(
                actor=user, action="HOD_NUDGE", entity="User", entity_id=person.id,
                detail_json=json.dumps({"department": chosen, "message": message}),
            )
            sent += 1
    return hod.without_money({"sent": sent, "skipped": skipped})


__all__ = [
    'AssignmentIn',
    'AssignmentPatch',
    'FACULTY_HOME',
    'NUDGE_COOLDOWN',
    'NudgeIn',
    'PlanIn',
    '_acting_department',
    '_assignment_dict',
    '_member',
    'hod_assignments',
    'hod_create_assignment',
    'hod_delete_assignment',
    'hod_nudge',
    'hod_plan',
    'hod_set_plan',
    'hod_update_assignment',
    'my_assignments',
]
