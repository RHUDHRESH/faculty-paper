"""Who may claim under the final-year project scheme, and on what.

The college's rule (2026-09-23), in the order it is checked:

1. The claim names one of the claimant's own teams -- a team off the roster
   whose mentor is the claim's owner. Nobody else may file for it; the office
   filing on somebody's behalf is held to the same rule, against the owner.
2. A team is claimed once. A filed claim holds its team until it is withdrawn
   or rejected outright (see `holding_claims`), and a second is refused by
   naming the ticket that holds it.
3. The paper is a conference paper. The scheme is "15k per conference".

Kept out of the API modules because three of them apply it -- the claim
payload, the submission gate and the mentor's team picker -- and they load in
an order that would make any one of them importing another a cycle.
"""
from __future__ import annotations

from core.models import Claim, ClaimReason, ClaimStatus, Team
from core.services.remuneration import is_conference_paper


class StudentProjectRefusal(Exception):
    """A student-project claim the rule does not allow, and why.

    Carries the HTTP status the API should answer with: 403 for the wrong
    person, 409 for a team already claimed, 400 for the rest.
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def holding_claims():
    """Student-project claims that hold their team.

    The scheme pays once per team, so one filed claim is all a team can carry.
    A claim holds its team from the moment it is filed until it is paid and
    forever after -- including while it is sent back to its mentor to fix,
    because it is still theirs to refile. Two things let go: withdrawing it
    (back to a draft), and a rejection outright, which cannot be refiled.
    A draft that was never filed holds nothing; it has not claimed anything.
    """
    return (
        Claim.objects.filter(claim_reason=ClaimReason.STUDENT_PROJECT, team__isnull=False)
        .exclude(status=ClaimStatus.DRAFT)
        .exclude(status=ClaimStatus.REJECTED, rejected_outright=True)
    )


def claim_holding(team: Team, *, besides: Claim | None = None) -> Claim | None:
    """The filed claim holding `team`, other than `besides` itself."""
    qs = holding_claims().filter(team=team)
    if besides is not None and besides.pk:
        qs = qs.exclude(pk=besides.pk)
    return qs.order_by("submitted_at", "created_at").first()


def mentor_label(team: Team) -> str:
    if team.mentor_id:
        return team.mentor.name
    return team.mentor_name or "a mentor with no account here yet"


def check_student_project(claim: Claim, *, filing: bool) -> None:
    """Raise `StudentProjectRefusal` if this student-project claim may not stand.

    `filing` is the submission gate. Before it -- while a draft is saved --
    only what is already wrong is refused: a draft may still be missing its
    team or its publication type, but may not name somebody else's team, a
    claimed one, or a type the scheme does not cover.
    """
    if claim.claim_reason != ClaimReason.STUDENT_PROJECT:
        return

    team = claim.team if claim.team_id else None
    if team is None:
        if not filing:
            return
        if not Team.objects.filter(mentor_id=claim.owner_id).exists():
            raise StudentProjectRefusal(
                403,
                "You are not the mentor of any final-year project team on the "
                "roster, so this paper cannot be filed as a student project. Only "
                "a team's mentor may claim for it. If you do mentor a team, ask "
                "the research office to check the roster names you by your staff "
                "id.",
            )
        raise StudentProjectRefusal(
            400,
            "A student project claim has to name the team. Choose it from your "
            "teams — the incentive is claimed on their project, and a ticket "
            "that names only you does not show whose work it was.",
        )

    if team.mentor_id != claim.owner_id:
        raise StudentProjectRefusal(
            403,
            f"Only a team's mentor may file its student-project claim. Team "
            f"{team.code} is mentored by {mentor_label(team)}, not by "
            f"{claim.owner.name}.",
        )

    holder = claim_holding(team, besides=claim)
    if holder is not None:
        raise StudentProjectRefusal(
            409,
            f"Team {team.code} has already been claimed on ticket "
            f"{holder.ticket_number or 'without a number yet'}. The scheme pays "
            "once per team; that claim has to be withdrawn or rejected before "
            "another can be filed.",
        )

    pub_type = claim.publication_type or claim.aggregation_type
    if pub_type and not is_conference_paper(pub_type):
        raise StudentProjectRefusal(
            400,
            f"The final-year project scheme is for conference papers — a fixed "
            f"amount per team per conference paper — and this is filed as "
            f"{pub_type}. File a journal article or book chapter as a faculty "
            "publication incentive or a publication count instead.",
        )
    if filing and not pub_type:
        raise StudentProjectRefusal(
            400,
            "Say what type of publication this is. The final-year project scheme "
            "is for conference papers only.",
        )
