"""What each role may do, written down once.

The permission rules live in a dozen `if not rbac.can_…` lines scattered
through the API, which is where they belong at the point of use — but there
was nowhere to read the whole picture, and no way to notice that a new
endpoint had been given the wrong guard. This is that picture, as a
declaration.

It is used two ways: a test asserts the running system matches it, and a
command prints it so a person can read the grid and disagree with it. The
second matters as much as the first — a permission model nobody can read is a
permission model nobody checks.

ALLOW means the role reaches the handler. It does not mean the call succeeds:
a finance user may call mark-paid and still be refused because the ticket is
not approved yet. That is business logic, checked elsewhere; this file is
only about who gets through the door.
"""
from __future__ import annotations

from dataclasses import dataclass, field

FACULTY = "FACULTY"
HOD = "HOD"
PRINCIPAL = "PRINCIPAL"
RESEARCH_CELL = "RESEARCH_CELL"
FINANCE = "FINANCE"
SUPER_ADMIN = "SUPER_ADMIN"

#: Every role an account can hold, in the order the grid reads best.
ROLES = [FACULTY, HOD, PRINCIPAL, RESEARCH_CELL, FINANCE, SUPER_ADMIN]


@dataclass(frozen=True)
class Capability:
    """One door, who may open it, and why that line is drawn where it is."""

    name: str
    method: str
    path: str
    allowed: frozenset[str]
    #: Why this set and not another. Read by whoever wants to argue with it.
    because: str
    #: A body that passes schema validation, so a 422 cannot stand in for a
    #: refusal and hide an unlocked door.
    payload: dict | None = None
    #: Group heading in the printed grid.
    group: str = "Other"
    #: Takes a file rather than JSON. Probed with a real one, so that schema
    #: validation cannot answer 422 in place of the permission check.
    upload: bool = False


def cap(
    name, method, path, allowed, because, payload=None, group="Other", upload=False
) -> Capability:
    return Capability(
        name, method, path, frozenset(allowed), because, payload, group, upload
    )


ADMINS = {SUPER_ADMIN, RESEARCH_CELL}
OVERSIGHT = ADMINS | {PRINCIPAL, FINANCE}

#: `{claim}` is replaced with a real claim id, `{user}` with a real user id,
#: and `{actor}` with the role making the call.
CAPABILITIES: list[Capability] = [
    # ---- money ---------------------------------------------------------
    cap("Clear a submitted ticket", "POST", "/api/claims/{claim}/clear",
        ADMINS,
        "Checking a claim is the research cell's job; the principal oversees "
        "rather than checks, and finance pays what it is told to pay.",
        {"expected_amount": 1}, "Money"),
    cap("Approve the spend", "POST", "/api/claims/{claim}/principal-approve",
        {PRINCIPAL, SUPER_ADMIN},
        "The person accountable for the spend, and a super admin who has to "
        "stand in for one.",
        {"expected_amount": 1}, "Money"),
    cap("Mark a ticket paid", "POST", "/api/claims/{claim}/mark-paid",
        {FINANCE, SUPER_ADMIN},
        "Only finance moves money.",
        {"expected_amount": 1}, "Money"),
    cap("Void a payment", "POST", "/api/claims/{claim}/void-payment",
        {SUPER_ADMIN},
        "Finance pays and does nothing else; reversing a payment sends the "
        "paper backwards, which is the super admin's rescue.",
        {"note": "reversing an incorrect disbursement"}, "Money"),
    cap("Second-approve a high-value ticket", "POST",
        "/api/claims/{claim}/second-approve",
        ADMINS,
        "A second pair of eyes on a large amount, from a desk that could have "
        "cleared it but did not. The principal does not need this one: their "
        "own approval step already counts as the second signature.",
        {}, "Money"),
    cap("Clear a batch", "POST", "/api/admin/bulk-clear",
        ADMINS, "The same power as clearing one, at scale.",
        {"claim_ids": ["{claim}"]}, "Money"),
    cap("Pay a batch", "POST", "/api/admin/bulk-mark-paid",
        {FINANCE, SUPER_ADMIN}, "The same power as paying one, at scale.",
        {"items": [{"claim_id": "{claim}", "expected_amount": 1}]}, "Money"),
    cap("Approve a batch as principal", "POST", "/api/principal/bulk-approve",
        {PRINCIPAL, SUPER_ADMIN}, "The approval step, at scale.",
        {"claim_ids": ["{claim}"]}, "Money"),

    # ---- the review desks ------------------------------------------------
    # The probe claim is SUBMITTED, so it sits at the research supervisor's
    # desk. Payloads are deliberately too short to succeed: an allowed role
    # reaches the handler and is refused with a 400, and the probe claim never
    # moves -- a claim rejected by the first role would change what every
    # later door is asked about.
    cap("Hold a paper at its desk", "POST", "/api/claims/{claim}/hold",
        ADMINS,
        "Only whoever sits at the desk the paper is at. A submitted paper is at "
        "the research supervisor's desk, so not the Principal's.",
        {"reason": "short"}, "Desks"),
    cap("Resume a held paper", "POST", "/api/claims/{claim}/resume",
        ADMINS, "The desk that may hold it may resume it.", {}, "Desks"),
    cap("Return a paper to the faculty", "POST",
        "/api/claims/{claim}/return-to-faculty",
        ADMINS,
        "From the desk the paper is at. The Director and Finance only move a "
        "paper forward.",
        {"note": "x"}, "Desks"),
    cap("Reject a paper outright", "POST", "/api/claims/{claim}/reject-outright",
        ADMINS, "The same desks, the same rule, and final.", {"note": "x"}, "Desks"),
    cap("Return a paper one step", "POST", "/api/claims/{claim}/return-one-step",
        {PRINCIPAL, SUPER_ADMIN},
        "The Principal's desk returns a cleared paper to the research "
        "supervisor's.",
        {"note": "x"}, "Desks"),
    cap("Send an approved paper back from the Director's desk", "POST",
        "/api/claims/{claim}/director-reject",
        {SUPER_ADMIN},
        "The Director authorises and does not send back; a super admin keeps "
        "this as the rescue.",
        {"note": "x"}, "Desks"),

    # ---- the rules money is computed by ---------------------------------
    cap("Rewrite the payout formula", "PUT", "/api/admin/formula",
        {SUPER_ADMIN, FINANCE},
        "The multiplier decides every payout in the college. Finance owns the "
        "rates; nobody else may touch them.",
        {"snip_multiplier": 55000, "qf_q1": 50000, "qf_q2": 30000,
         "qf_q3": 15000, "qf_q4": 7000, "author_point_json": '{"1": 1}'},
        "Policy"),
    cap("Read the payout formula", "GET", "/api/admin/formula",
        OVERSIGHT,
        "Anyone who has to explain a figure needs to see the rates behind it.",
        None, "Policy"),
    cap("Set a budget", "POST", "/api/budgets",
        ADMINS | {FINANCE},
        "An allocation is a finance and research-cell decision; the principal "
        "spends against it rather than setting it.",
        {"financial_year": "2099-00", "amount": 1}, "Policy"),
    cap("Read the budget", "GET", "/api/budgets",
        OVERSIGHT,
        "Everyone who oversees the scheme needs to know what is left.",
        None, "Policy"),
    cap("Set verified values by hand", "POST",
        "/api/admin/claims/{claim}/set-verified",
        ADMINS,
        "Overriding what the index said is the research cell's judgement, and "
        "it is recorded against them.",
        {"snip": 1.0, "note": "matched against the publisher page"}, "Policy"),

    # ---- identity and accounts ------------------------------------------
    cap("Edit any user", "PATCH", "/api/admin/users/{user}",
        ADMINS,
        "Account management. Identity fields inside it are super-admin only, "
        "which is enforced separately.",
        {"department": "CSE"}, "Accounts"),
    cap("Create a user", "POST", "/api/admin/users",
        ADMINS, "Account management.",
        # Complete: a partial body is refused by schema validation before the
        # permission check, and a 422 would stand in for a locked door.
        # {actor} is the role doing the probing, so two admin roles creating a
        # user in the same run do not collide on the email.
        {"email": "matrix-probe-{actor}@test.edu", "name": "Probe",
         "password": "a-long-enough-one", "role": "FACULTY"},
        "Accounts"),
    cap("Reset somebody's password", "POST", "/api/admin/reset-password",
        ADMINS, "A password reset is how somebody locked out recovers.",
        {"email": "matrix-target@test.edu", "password": "a-long-enough-one"},
        "Accounts"),
    cap("Impersonate somebody", "POST", "/api/admin/impersonate/{user}",
        {SUPER_ADMIN},
        "Seeing the system as another person is the strongest power here and "
        "is read-only even for the one role that has it.",
        {}, "Accounts"),
    cap("Edit own profile", "PATCH", "/api/auth/profile",
        {SUPER_ADMIN},
        "Every profile field is identity: the name on the payment and the "
        "Scopus link deciding whose record a paper is checked against.",
        {"designation": "Professor"}, "Accounts"),

    # ---- reading the college --------------------------------------------
    cap("Read the college's figures", "GET", "/api/reports",
        OVERSIGHT, "Reporting is not the same permission as moving money.",
        None, "Reading"),
    cap("Download the accreditation pack", "GET",
        "/api/reports/pack?fmt=json", OVERSIGHT,
        "The same data as the reports screen, in NAAC's columns.",
        None, "Reading"),
    cap("Export the ledger", "GET", "/api/reports/export", OVERSIGHT,
        "One row per publication — the sheet the office files.", None, "Reading"),
    cap("Query across the college", "GET", "/api/reports/search?limit=1",
        OVERSIGHT, "The cross-college search behind the query screen.",
        None, "Reading"),
    cap("Read one person's record", "GET", "/api/faculty/{user}/report",
        OVERSIGHT, "Appraisal and promotion questions about one person.",
        None, "Reading"),
    cap("Read the audit log", "GET", "/api/admin/audit?limit=1",
        OVERSIGHT,
        "Who did what. Everyone who oversees the scheme may read it, finance "
        "included: they move the money and are entitled to see who authorised "
        "each movement.",
        None, "Reading"),
    cap("Read duplicate findings", "GET", "/api/admin/duplicate-findings",
        OVERSIGHT, "Possible double payments, for anyone who oversees spend.",
        None, "Reading"),
    cap("Read the faults screen", "GET", "/api/admin/faults",
        ADMINS | {PRINCIPAL},
        "Work that has stopped moving, and rows that need unsticking.",
        None, "Reading"),
    cap("Read the payable queue", "GET", "/api/admin/payouts?limit=1",
        OVERSIGHT, "What finance is about to pay.", None, "Reading"),
    cap("Read the principal's queue", "GET", "/api/principal/queue",
        {PRINCIPAL, SUPER_ADMIN},
        "What is waiting on the principal, and the money it commits.",
        None, "Reading"),
    cap("Read notes on a ticket", "GET", "/api/claims/{claim}/notes",
        ADMINS | {PRINCIPAL},
        "Between the principal and the research cell. Never the claimant, "
        "never finance.",
        None, "Reading"),

    # ---- a head of department --------------------------------------------
    cap("Read own department's publications", "GET", "/api/hod/overview",
        {HOD},
        "A head is asked what their department is publishing and by whom. "
        "Only a head: everyone else has a screen that answers it college-wide.",
        None, "Department"),
    cap("List own department's publications", "GET", "/api/hod/publications",
        {HOD}, "The same data, one row per paper.", None, "Department"),
    cap("Download own department's publications", "GET", "/api/hod/export",
        {HOD},
        "A head works from a spreadsheet in a review meeting. The file carries "
        "no money column, like the screen it comes from.",
        None, "Department"),
    cap("Read the claim list", "GET", "/api/claims",
        {FACULTY, PRINCIPAL, FINANCE} | ADMINS,
        "The claim payload carries the remuneration. A head has their own "
        "screens, which do not, so they are refused this one outright rather "
        "than being handed an empty list that would fill up later.",
        None, "Reading"),

    # ---- filing ----------------------------------------------------------
    cap("File a claim", "POST", "/api/claims",
        {FACULTY} | ADMINS,
        "A claimant files their own; the research cell files on their behalf.",
        {"paper_title": "Matrix probe", "journal_title": "J"}, "Filing"),
    cap("Upload evidence", "POST", "/api/claims/upload",
        {FACULTY} | ADMINS,
        "Whoever may file may attach the proof.", None, "Filing", upload=True),
    cap("Import prior payments", "POST", "/api/admin/prior/import",
        ADMINS | {PRINCIPAL},
        "Loading historical payment data.", None, "Filing", upload=True),
]


def grid() -> list[tuple[str, list[tuple[str, bool]]]]:
    """The matrix as rows of (capability, [(role, allowed)…])."""
    return [
        (c.name, [(r, r in c.allowed) for r in ROLES])
        for c in CAPABILITIES
    ]
