from core.models import Role

# The chain, in order: FACULTY files, the admin office (SUPER_ADMIN) clears,
# PRINCIPAL approves the spend, DIRECTOR authorises it, FINANCE pays. HOD and
# RESEARCH_CELL are not approvers; RESEARCH_CELL survives in Role so existing
# accounts keep loading and folded into SUPER_ADMIN.
#
# HOD is a faculty member who also heads the department (the college's
# decision of 2026-09-23): they file and track their own papers exactly as
# faculty do, and on top of that have a money-blind view of their department.
# "Money-blind" now means blind to everybody's money but their own -- see
# `hod.for_head`.
ROLE_RANK = {
    Role.FACULTY: 1,
    Role.HOD: 1,
    Role.RESEARCH_COORDINATOR: 5,
    Role.PRINCIPAL: 3,
    # Oversight, like the Principal. Rank is a permission ladder, not the
    # approval chain -- the Director comes *after* the Principal in the chain
    # while seeing the same things, so they sit on the same rung.
    Role.DIRECTOR: 3,
    Role.FINANCE: 4,
    Role.RESEARCH_CELL: 5,
    Role.SUPER_ADMIN: 5,
}

#: Everything the admin role can do. RESEARCH_CELL is here so an unmigrated
#: account is not locked out of the portal it has always used.
#:
#: RESEARCH_COORDINATOR joins them because the chain reads "faculty, then the
#: coordinator *or* the admin, then the Principal" -- two desks doing one job,
#: not two steps. Anything the office may do to a filed paper, a coordinator
#: may do, and that includes the second signature on a high-value claim.
ADMIN_ROLES = (Role.SUPER_ADMIN, Role.RESEARCH_CELL, Role.RESEARCH_COORDINATOR)

#: The accounts a claim can belong to: the people who publish. A head of
#: department is one of them -- they are faculty who also head the department,
#: and they keep filing their own papers.
CLAIMANT_ROLES = (Role.FACULTY, Role.HOD)


def has_min_role(user_role: str, required: str) -> bool:
    return ROLE_RANK.get(user_role, 0) >= ROLE_RANK.get(required, 99)


def can_faculty_portal(role: str) -> bool:
    return role in CLAIMANT_ROLES


def can_principal_portal(role: str) -> bool:
    return role in (Role.PRINCIPAL, Role.SUPER_ADMIN)


def can_director_portal(role: str) -> bool:
    return role in (Role.DIRECTOR, Role.SUPER_ADMIN)


def can_approve_as_director(role: str) -> bool:
    """Authorise a Principal-approved claim, which is what lets Finance pay it.

    A super admin stands in, for the same reason they stand in for the
    Principal and for Finance: somebody has to keep payments moving while a
    post is vacant or a person is away.
    """
    return role in (Role.DIRECTOR, Role.SUPER_ADMIN)


def can_admin_portal(role: str) -> bool:
    return role in ADMIN_ROLES


def can_finance_portal(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


def portal_for_role(role: str) -> str:
    if role == Role.HOD:
        return "hod"
    if role == Role.DIRECTOR:
        return "director"
    if role == Role.FINANCE:
        return "finance"
    if role == Role.PRINCIPAL:
        return "principal"
    if role in ADMIN_ROLES:
        return "admin"
    # FACULTY, and any leftover HOD account.
    return "faculty"


def can_manage_users(role: str) -> bool:
    return role in ADMIN_ROLES


def can_import_prior(role: str) -> bool:
    return role in (*ADMIN_ROLES, Role.PRINCIPAL)


def can_edit_formula(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


def can_view_college_wide(role: str) -> bool:
    return role in (*ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE)


def can_view_reports(role: str) -> bool:
    """Read the ledger, payout history, exports, and the cross-college query.

    Reporting is not the same permission as moving money: everyone who oversees
    the scheme can read the numbers, only Finance can pay.
    """
    return role in (*ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE)


def can_issue_claims(role: str) -> bool:
    """File a ticket -- one's own, or on a claimant's behalf -- and upload its evidence."""
    return role in (*CLAIMANT_ROLES, *ADMIN_ROLES)


def can_clear_claims(role: str) -> bool:
    """Admin clearing is the single approval step before payment."""
    return role in ADMIN_ROLES


def can_reject_claims(role: str) -> bool:
    """Whoever sits at a review desk may send a paper back from it.

    Which paper, from which desk, is decided against the paper's status (see
    `can_act_at_desk`). Finance used to be here, on the grounds that a payment
    problem surfaces there first; the chain is now forward-only past the
    Principal, so Finance pays and the Director authorises, and neither sends
    anything back.
    """
    return sits_at_a_desk(role)


def can_approve_as_finance(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


# ---- the two review desks ---------------------------------------------------
#
# A filed paper waits at one of two desks before anybody agrees to spend money
# on it: the research supervisor's (the office roles, status SUBMITTED) and the
# Principal's (status CLEARED). Holding, returning and rejecting happen only at
# those two desks, and only by whoever sits at the desk the paper is at. A super
# admin sits at both. The Director and Finance sit at neither: they move a paper
# forward and nothing else.

SUPERVISOR_DESK = "supervisor"
PRINCIPAL_DESK = "principal"


def desk_for_status(status: str | None) -> str | None:
    """Which review desk a paper at this status is sitting at, if any."""
    from core.models import ClaimStatus

    if status == ClaimStatus.SUBMITTED:
        return SUPERVISOR_DESK
    if status == ClaimStatus.CLEARED:
        return PRINCIPAL_DESK
    return None


def can_act_at_desk(role: str, desk: str | None) -> bool:
    if desk == SUPERVISOR_DESK:
        return role in ADMIN_ROLES
    if desk == PRINCIPAL_DESK:
        return role in (Role.PRINCIPAL, Role.SUPER_ADMIN)
    return False


def sits_at_a_desk(role: str) -> bool:
    return can_act_at_desk(role, SUPERVISOR_DESK) or can_act_at_desk(role, PRINCIPAL_DESK)


def can_view_audit(role: str) -> bool:
    return role in (*ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE)


def can_review_flags(role: str) -> bool:
    """Raise, read and resolve discrepancy flags, and browse the whole history.

    The desks that judge a paper: the office roles and the Principal. Not the
    Director or Finance, who authorise and pay what those desks decided and
    are not shown the doubts about it (the same rule as a contested
    payment-history match, `core.visibility`); not a claimant.
    """
    return role in (*ADMIN_ROLES, Role.PRINCIPAL)


# Back-compat aliases used by older api paths
def can_admin_approve(role: str) -> bool:
    return can_clear_claims(role)


def can_approve_as_research(role: str) -> bool:
    return can_clear_claims(role)
