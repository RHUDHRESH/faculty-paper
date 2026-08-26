from core.models import Role

# The chain, in order: FACULTY files, the admin office (SUPER_ADMIN) clears,
# PRINCIPAL approves the spend, DIRECTOR authorises it, FINANCE pays. HOD and
# RESEARCH_CELL are not in the chain; their values survive in Role so existing
# accounts keep loading -- RESEARCH_CELL folded into SUPER_ADMIN, HOD down to
# faculty rights plus a money-blind view of its own department.
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


def has_min_role(user_role: str, required: str) -> bool:
    return ROLE_RANK.get(user_role, 0) >= ROLE_RANK.get(required, 99)


def can_faculty_portal(role: str) -> bool:
    return role in (Role.FACULTY, Role.HOD)


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
    """File a ticket on a faculty member's behalf, and upload its evidence."""
    return role in (Role.FACULTY, *ADMIN_ROLES)


def can_clear_claims(role: str) -> bool:
    """Admin clearing is the single approval step before payment."""
    return role in ADMIN_ROLES


def can_reject_claims(role: str) -> bool:
    """Whoever can clear can also send a ticket back; Finance can too, since a
    payment problem surfaces there and nowhere earlier."""
    return role in (*ADMIN_ROLES, Role.FINANCE)


def can_approve_as_finance(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


def can_view_audit(role: str) -> bool:
    return role in (*ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE)


# Back-compat aliases used by older api paths
def can_admin_approve(role: str) -> bool:
    return can_clear_claims(role)


def can_approve_as_research(role: str) -> bool:
    return can_clear_claims(role)
