"""The audit log, told in plain words: who changed what, when, from what to what.

The audit log stores a code (``CLAIM_DATA_FIX``), a record id and a JSON blob.
That is right for an auditor's export and wrong for an admin asking "who
changed this amount?". ``describe`` turns one row into a sentence and a list of
changes; ``for_record`` collects them for one claim or one person.

Nothing here writes. A code it does not know still gets a sentence (the code,
lower-cased), so a new kind of entry never blanks a screen.
"""
from __future__ import annotations

import json
from typing import Any


from core.models import AuditLog

#: What a person says the action was, after their name.
ACTION_WORDS: dict[str, str] = {
    "CLAIM_DATA_FIX": "corrected the record",
    "CLAIM_ADMIN_EDIT": "corrected the record",
    "CLAIM_MANUAL_VERIFY": "confirmed the figures by hand",
    "CLAIM_REASSIGN": "moved the claim to another person",
    "REASSIGN": "moved the claim to another person",
    "STATUS_OVERRIDE": "changed where the claim stands",
    "MARK_PAID": "marked the claim paid",
    "VOID_PAYMENT": "cancelled the payment",
    "CLEAR": "cleared the claim",
    "PRINCIPAL_APPROVE": "approved the claim",
    "DIRECTOR_APPROVE": "authorised the claim",
    "SUBMIT": "filed the claim",
    "REJECT": "rejected the claim",
    "REJECT_OUTRIGHT": "rejected the claim",
    "PRINCIPAL_SEND_BACK": "sent the claim back",
    "CLAIM_NOTE": "left a note",
    "CLAIM_FLAG_RAISE": "raised a flag",
    "CLAIM_FLAG_RESOLVE": "resolved a flag",
    "DUPLICATE_REVIEW": "reviewed a possible double payment",
    "USER_UPDATE": "updated the account",
    "USER_ROLE_CHANGE": "changed the role",
    "USER_CREATE": "created the account",
    "USER_RESET_PASSWORD": "reset the password",
    "PASSWORDS_ISSUE": "issued sign-in passwords",
    "PROFILE_UPDATE": "updated the profile",
    "PROFILE_SELF_UPDATE": "updated their own profile",
    "FORMULA_UPDATE": "published a new policy",
    "IMPERSONATE_START": "started viewing as this person",
    "IMPERSONATE_STOP": "stopped viewing as this person",
    "DATA_EDIT": "edited a row in the data table",
    "DATA_DELETE": "deleted a row from the data table",
    "DATA_HEALTH_FIX": "ran a data fix",
    "LEDGER_AMOUNTS_REPAIRED": "corrected ledger amounts",
    "SETTINGS_UPDATE": "changed the college's details",
    "BUDGET_SET": "set an allocation",
    "BUDGET_DELETE": "removed an allocation",
    "LEDGER_ROW_LINK": "linked a payment to its claim",
    "LEDGER_ROW_ADD": "added a missing ledger row",
    "CREATE_DRAFT": "saved a draft",
    "ADMIN_CREATE": "created a claim on someone else's behalf",
    "CONTEST_FORWARD": "forwarded a contested claim",
    "RESUBMIT": "filed a sent-back claim again",
    "WITHDRAW": "withdrew a claim",
    "PROFILE_CORRECTION_REQUEST": "asked for a profile correction",
    "PROFILE_CORRECTION_DECIDED": "decided a profile correction",
    "PASSWORD_CHANGE": "changed their password",
    "CLAIM_RECALC_SKIP_EXTERNAL": "recalculated a claim without an outside lookup",
    "CLAIM_SECOND_APPROVE": "gave the second approval on a high-value claim",
    "REPORT_PACK": "built a report pack",
    "PACK_CORRECT": "corrected a figure in a report pack",
    "SYSTEM_WIPE": "wiped system data",
    "DISCOVER_VENUES": "asked Discover for venues",
    "HOD_EXPORT": "exported a department's data",
    "DATA_EXPORT": "exported a data table",
    "SCIMAGO_IMPORT": "imported Scimago journal data",
    "SCIMAGO_SYNC": "synced Scimago data",
    "PRIOR_PAYMENT_IMPORT": "loaded payment history",
    "SNIP_IMPORT": "imported SNIP figures",
    "FACULTY_MASTER_IMPORT": "loaded the faculty roster",
    "ERP_XLSX_IMPORT_QUEUED": "started the ERP workbook import",
    "ERP_XLSX_IMPORT": "finished the ERP workbook import",
    "BACKUP_STORED": "stored a backup",
    "BACKUP_QUEUED": "started a backup",
    "BACKUP_DOWNLOADED": "downloaded a backup",
    "BACKUP_SKIPPED": "skipped a backup",
    "RESTORE_QUEUED": "started a restore",
    "RESTORE_DONE": "finished a restore",
    "MEDIA_IMPORTED": "loaded photos and files from a zip",
    "JOB_RETRY": "ran a job again",
    "CLAIM_CONDITIONS_ACCEPTED": "ticked the filing conditions",
    "CLAIM_FILES_CHECK": "checked a claim's files",
    "CLAIM_HOLD": "put a claim on hold",
    "CLAIM_RESUME": "took a claim off hold",
    "ACCOUNT_MERGED": "merged two accounts",
    "PUBLICATION_MERGED": "merged two papers",
    "PUBLICATION_MERGE_UNDONE": "undid a paper merge",
    "PUBLICATION_HARVEST_QUEUED": "started a publication harvest",
    "PUBLICATION_HARVEST_DONE": "finished a publication harvest",
    "SCOPUS_SYNC_QUEUED": "started a Scopus sync",
    "SCOPUS_SYNC_DONE": "finished a Scopus sync",
    "AUTHOR_ALIAS_MATCHED": "matched an author name to a person",
    "AUTHOR_MATCH_QUEUED": "started author matching",
    "AUTHOR_MATCH_DONE": "finished author matching",
    "CLAIM_ASSIGN": "assigned a claim to a desk",
    "COLLEGE_SITE_IMPORT": "loaded photos and bios from the college website",
    "FYP_TEAMS_IMPORT": "loaded the final-year project teams",
    "SCOPUS_PROFILES_IMPORT": "loaded Scopus author profiles",
    "SCOPUS_IDS_LINK": "linked Scopus author IDs",
    "LOGIN_GOOGLE": "signed in with Google",
    "LOGIN_CLERK": "signed in",
    "GOOGLE_LINKED": "linked a Google account",
    "GOOGLE_UNLINKED": "unlinked a Google account",
}

#: Field names as people say them.
FIELD_LABELS: dict[str, str] = {
    "paper_title": "Title",
    "journal_title": "Journal",
    "remuneration": "Amount",
    "amount": "Amount",
    "quartile": "Quartile",
    "quartile_source": "Where the quartile came from",
    "snip": "SNIP",
    "snip_source": "Where the SNIP came from",
    "engineering_class": "Engineering class",
    "status": "Where it stands",
    "status_note": "Note on the payment",
    "owner": "Claimant",
    "role": "Role",
    "active": "Account active",
    "department": "Department",
    "name": "Name",
    "email": "Email",
    "staff_id": "Staff ID",
    "biometric_id": "Biometric ID",
    "scopus_author_id": "Scopus author ID",
    "designation": "Designation",
    "faculty_type": "Faculty type",
    "research_quota": "Papers a year paid under the quota",
    "publication_year": "Year published",
    "doi": "DOI",
    "issn": "ISSN",
    "total_authors": "Number of authors",
    "author_position": "Author position",
    "snip_multiplier": "Rate per SNIP point",
    "snip_cap": "SNIP cap",
    "qf_q1": "Q1 bonus",
    "qf_q2": "Q2 bonus",
    "qf_q3": "Q3 bonus",
    "qf_q4": "Q4 bonus",
    "fixed_journal_no_snip": "Journal with no SNIP",
    "fixed_other_no_snip": "Other with no SNIP",
    "fixed_web_of_science": "Web of Science",
    "student_project_amount": "Per project team",
    "high_value_threshold": "Second signature above",
    "max_authors": "Eligible authors",
    "min_sec_references": "Minimum SEC authors",
    "filing_cutoff_day": "Filing cutoff day",
    "research_year_start_month": "Research year starts in month",
    "student_remuneration_zero": "A student author's share is zero",
    "ledger_payment": "Ledger payment",
    "college_name": "College name",
    "sign_in_note": "Sign-in note",
    "support_email": "Support email",
    "claim": "Claim",
    "ledger_total": "Ledger total",
    "row_amount": "Ledger row added",
}

#: Fields that are rupees, so they read as ₹1,09,265.
_MONEY_KEYS = frozenset({
    "remuneration", "amount", "ledger_total", "row_amount", "snip_multiplier", "qf_q1", "qf_q2", "qf_q3", "qf_q4",
    "fixed_journal_no_snip", "fixed_other_no_snip", "fixed_web_of_science",
    "student_project_amount", "high_value_threshold",
})

_STATUS_WORDS = {
    "DRAFT": "Draft",
    "SUBMITTED": "Awaiting check",
    "CLEARED": "Checked",
    "PRINCIPAL_APPROVED": "Approved",
    "DIRECTOR_APPROVED": "Authorised",
    "FINANCE_APPROVED": "Authorised",
    "PAID": "Paid",
    "REJECTED": "Sent back",
}
_ROLE_WORDS = {
    "FACULTY": "Faculty",
    "HOD": "Head of department",
    "PRINCIPAL": "Principal",
    "DIRECTOR": "Director",
    "FINANCE": "Finance",
    "RESEARCH_CELL": "Research office",
    "RESEARCH_COORDINATOR": "Research coordinator",
    "SUPER_ADMIN": "Super admin",
}
_SOURCE_WORDS = {"MANUAL": "Entered by hand", "SCOPUS": "Scopus", "SCIMAGO": "Scimago", "SNIP_DUMP": "SNIP file"}


_DUPLICATE_WORDS = {
    "OPEN": "Reopened for review",
    "CONFIRMED": "Confirmed duplicate",
    "DISMISSED": "Not a duplicate",
    "RECOVERED": "Money recovered",
}


def inr(value: float) -> str:
    """Rupees in Indian grouping: 109265 -> ₹1,09,265."""
    negative = value < 0
    whole = int(round(abs(value) * 100))
    rupees, paise = divmod(whole, 100)
    digits = str(rupees)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        digits = ",".join(parts + [tail])
    text = f"₹{digits}" + (f".{paise:02d}" if paise else "")
    return f"-{text}" if negative else text


def _value(key: str, value: Any) -> str:
    if value is None or value == "":
        return "Not recorded"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if key in _MONEY_KEYS and isinstance(value, (int, float)):
        return inr(float(value))
    if isinstance(value, str):
        if key == "status" and value in _STATUS_WORDS:
            return _STATUS_WORDS[value]
        if key in ("role", "from", "to") and value in _ROLE_WORDS:
            return _ROLE_WORDS[value]
        if key.endswith("_source") and value in _SOURCE_WORDS:
            return _SOURCE_WORDS[value]
        try:  # numbers that arrived as text (str(v) in older entries)
            if key in _MONEY_KEYS:
                return inr(float(value))
        except ValueError:
            pass
        return value
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def _label(key: str) -> str:
    return FIELD_LABELS.get(key) or key.replace("_", " ").capitalize()


def _changes(detail: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    before, after = detail.get("before"), detail.get("after")
    if isinstance(before, dict) and isinstance(after, dict):
        for key in dict.fromkeys([*before, *after]):
            if before.get(key) != after.get(key):
                out.append(
                    {"label": _label(key), "from": _value(key, before.get(key)), "to": _value(key, after.get(key))}
                )
        return out
    for key, value in detail.items():
        if isinstance(value, dict) and set(value) == {"from", "to"}:
            out.append({"label": _label(key), "from": _value(key, value["from"]), "to": _value(key, value["to"])})
    if not out and "from" in detail and "to" in detail and not isinstance(detail["from"], dict):
        out.append({"label": "Changed", "from": _value("from", detail["from"]), "to": _value("to", detail["to"])})
    return out


def describe(log: AuditLog) -> dict[str, Any]:
    try:
        detail = json.loads(log.detail_json) if log.detail_json else {}
    except ValueError:
        detail = {}
    if not isinstance(detail, dict):
        detail = {}
    who = log.actor
    changes = _changes(detail)
    if log.action == "DUPLICATE_REVIEW" and detail.get("status"):
        changes = [{"label": "Decision", "from": "Not yet reviewed", "to": _DUPLICATE_WORDS.get(detail["status"], detail["status"])}]
        if detail.get("extra_amount"):
            changes.append({"label": "Money at issue", "from": "Not recorded", "to": inr(float(detail["extra_amount"]))})
        if detail.get("recovered_amount") is not None:
            changes.append({"label": "Recovered", "from": "Not recorded", "to": inr(float(detail["recovered_amount"]))})
    context = None
    if log.entity == "Budget" and detail.get("financial_year"):
        context = f"{detail.get('department') or 'The college'}, FY {detail['financial_year']}"
    return {
        "id": log.id,
        "context": context,
        "at": log.created_at.isoformat(),
        "who": {"user_id": who.id, "name": who.name or who.email} if who else None,
        "what": ACTION_WORDS.get(log.action) or log.action.replace("_", " ").lower(),
        "changes": changes,
        "reason": detail.get("reason") or None,
        "note": detail.get("note") if isinstance(detail.get("note"), str) else None,
    }


def for_record(
    entity: str, entity_id: str, limit: int = 30, exclude_actions: tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    """Newest first. Only entries that name this record.

    `exclude_actions` are raw audit action codes left out in the query itself,
    so the limit counts only what the reader may see and the code never has to
    be matched against its plain-words label.
    """
    rows = AuditLog.objects.filter(entity=entity, entity_id=entity_id)
    if exclude_actions:
        rows = rows.exclude(action__in=exclude_actions)
    rows = rows.select_related("actor").order_by("-created_at")[: max(1, min(limit, 200))]
    return [describe(r) for r in rows]


_RECORD_WORDS = {
    "PaidLedger": "A ledger row",
    "FormulaConfig": "The policy",
    "Budget": "A budget",
    "DuplicateFinding": "A possible double payment",
    "ClaimFlag": "A flag on a claim",
    "Backup": "A backup",
    "Team": "A project team",
    "Publication": "A paper on the record",
    "system_setting": "The college's details",
}


def describe_many(logs: list[AuditLog]) -> list[dict[str, Any]]:
    """`describe` for a page of rows, each with a readable name for the record
    it is about (a claim's number, a person's name), looked up in two queries
    for the whole page instead of two per row."""
    from core.models import Claim, User

    claim_ids = {l.entity_id for l in logs if l.entity in ("Claim",) and l.entity_id}
    user_ids = {l.entity_id for l in logs if l.entity == "User" and l.entity_id}
    tickets = dict(Claim.objects.filter(pk__in=claim_ids).values_list("id", "ticket_number")) if claim_ids else {}
    names = dict(User.objects.filter(pk__in=user_ids).values_list("id", "name")) if user_ids else {}
    out = []
    for log in logs:
        row = describe(log)
        if log.entity == "Claim":
            label = f"Claim {tickets[log.entity_id] or 'not yet numbered'}" if log.entity_id in tickets else "A claim that no longer exists"
        elif log.entity == "User":
            label = names.get(log.entity_id) or "An account that no longer exists"
        else:
            label = _RECORD_WORDS.get(log.entity, log.entity)
        row["record"] = {"kind": log.entity, "id": log.entity_id, "label": label}
        out.append(row)
    return out


__all__ = ["describe", "describe_many", "for_record", "inr"]
