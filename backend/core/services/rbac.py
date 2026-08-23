from core.models import Role

# Four roles: FACULTY files, SUPER_ADMIN issues and clears, FINANCE pays,
# PRINCIPAL observes and queries. HOD and RESEARCH_CELL were removed; their
# values survive in Role only so existing accounts keep loading — RESEARCH_CELL
# folded into SUPER_ADMIN, HOD down to faculty rights.
ROLE_RANK = {
    Role.FACULTY: 1,
    Role.HOD: 1,
    Role.PRINCIPAL: 3,
    Role.FINANCE: 4,
    Role.RESEARCH_CELL: 5,
    Role.SUPER_ADMIN: 5,
}

#: Everything the admin role can do. RESEARCH_CELL is here so an unmigrated
#: account is not locked out of the portal it has always used.
ADMIN_ROLES = (Role.SUPER_ADMIN, Role.RESEARCH_CELL)


def has_min_role(user_role: str, required: str) -> bool:
    return ROLE_RANK.get(user_role, 0) >= ROLE_RANK.get(required, 99)


def can_faculty_portal(role: str) -> bool:
    return role in (Role.FACULTY, Role.HOD)


def can_principal_portal(role: str) -> bool:
    return role in (Role.PRINCIPAL, Role.SUPER_ADMIN)


def can_admin_portal(role: str) -> bool:
    return role in ADMIN_ROLES


def can_finance_portal(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


def portal_for_role(role: str) -> str:
    if role == Role.HOD:
        return "hod"
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
    return role in (*ADMIN_ROLES, Role.PRINCIPAL, Role.FINANCE)


def can_view_reports(role: str) -> bool:
    """Read the ledger, payout history, exports, and the cross-college query.

    Reporting is not the same permission as moving money: everyone who oversees
    the scheme can read the numbers, only Finance can pay.
    """
    return role in (*ADMIN_ROLES, Role.PRINCIPAL, Role.FINANCE)


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
    return role in (*ADMIN_ROLES, Role.PRINCIPAL, Role.FINANCE)


# Back-compat aliases used by older api paths
def can_admin_approve(role: str) -> bool:
    return can_clear_claims(role)


def can_approve_as_research(role: str) -> bool:
    return can_clear_claims(role)
