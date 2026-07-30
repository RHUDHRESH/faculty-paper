from core.models import Role

ROLE_RANK = {
    Role.FACULTY: 1,
    Role.HOD: 2,
    Role.PRINCIPAL: 3,
    Role.RESEARCH_CELL: 3,
    Role.FINANCE: 4,
    Role.SUPER_ADMIN: 5,
}


def has_min_role(user_role: str, required: str) -> bool:
    return ROLE_RANK.get(user_role, 0) >= ROLE_RANK.get(required, 99)


def can_faculty_portal(role: str) -> bool:
    return role == Role.FACULTY


def can_hod_portal(role: str) -> bool:
    return role in (Role.HOD, Role.SUPER_ADMIN)


def can_principal_portal(role: str) -> bool:
    return role in (Role.PRINCIPAL, Role.SUPER_ADMIN)


def can_admin_portal(role: str) -> bool:
    """Super admin + research cell imports helper."""
    return role in (Role.SUPER_ADMIN, Role.RESEARCH_CELL)


def can_finance_portal(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


def portal_for_role(role: str) -> str:
    if role == Role.FINANCE:
        return "finance"
    if role == Role.HOD:
        return "hod"
    if role == Role.PRINCIPAL:
        return "principal"
    if role in (Role.SUPER_ADMIN, Role.RESEARCH_CELL):
        return "admin"
    return "faculty"


def can_manage_users(role: str) -> bool:
    return role == Role.SUPER_ADMIN


def can_import_prior(role: str) -> bool:
    return role in (Role.SUPER_ADMIN, Role.RESEARCH_CELL, Role.PRINCIPAL)


def can_edit_formula(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


def can_view_college_wide(role: str) -> bool:
    return role in (
        Role.SUPER_ADMIN,
        Role.PRINCIPAL,
        Role.RESEARCH_CELL,
        Role.FINANCE,
    )


def can_view_department(role: str) -> bool:
    return role == Role.HOD


def can_approve_as_hod(role: str) -> bool:
    return role in (Role.HOD, Role.SUPER_ADMIN)


def can_approve_as_principal(role: str) -> bool:
    return role in (Role.PRINCIPAL, Role.SUPER_ADMIN)


def can_approve_as_finance(role: str) -> bool:
    return role in (Role.FINANCE, Role.SUPER_ADMIN)


def can_view_audit(role: str) -> bool:
    return role in (Role.SUPER_ADMIN, Role.PRINCIPAL, Role.RESEARCH_CELL)


# Back-compat aliases used by older api paths
def can_admin_approve(role: str) -> bool:
    return can_approve_as_hod(role) or can_approve_as_principal(role)


def can_approve_as_research(role: str) -> bool:
    return can_approve_as_principal(role)
