"""Get the college running: the order a new installation is brought to life in.

One list, in the order the work is done on a fresh host or a first install:
load the college's record (a restore or the three imports), put someone at each
desk, hand out the first passwords, publish a policy, take a backup. The photos and
files the rows name, email and the Scopus key follow as optional steps. Every step
is answered from state that already exists (the user table, the restore run, the
policy table, the readiness checks, the stored files), and every step names the
page where it is done. Nothing here writes.

The readiness checks answer "is the system healthy right now"; this answers
"what is left to do before people can sign in", so the two share their desk,
policy and backup logic and differ only in order and in what they add (the
record and the passwords).
"""
from __future__ import annotations

from typing import Any

from django.conf import settings
from django.utils import timezone

from core.models import ClaimAttachment, Publication, Role, User
from core.services import media_import, readiness
from core.services.issue_passwords import HASHER, HOLDING_SUFFIX


def _people_qs():
    """Real accounts other than the administrators."""
    return (
        User.objects.filter(active=True)
        .exclude(email__iendswith=HOLDING_SUFFIX)
        .exclude(role=Role.SUPER_ADMIN)
    )


def _step(key: str, title: str, state: str, fact: str, to: str, action: str, required: bool = True) -> dict[str, Any]:
    return {"key": key, "title": title, "state": state, "fact": fact, "to": to, "action": action,
            "required": required}


def _plural(n: int, one: str, many: str) -> str:
    return f"{n:,} {one if n == 1 else many}"


def _record_step() -> dict[str, Any]:
    from core.services import restore

    title = "Load the college's record"
    run = restore.public(restore.get_run())
    if run and run["status"] in ("queued", "running") and not run["stalled"]:
        return _step("record", title, "working", f"Restoring: {run['percent']}% loaded.", "/imports", "See progress")
    if run and run["status"] in ("queued", "running"):
        return _step("record", title, "todo", "The restore stopped part-way. Continue it where it stopped.",
                     "/imports", "Continue the restore")
    people = _people_qs().count()
    papers = Publication.objects.count()
    if people and papers:
        return _step("record", title, "done",
                     f"{_plural(people, 'person', 'people')} and {_plural(papers, 'paper', 'papers')} on record.",
                     "/imports", "Open Imports")
    if people:
        return _step("record", title, "todo",
                     f"{_plural(people, 'person', 'people')} on the roster and no papers yet.",
                     "/imports", "Load the papers")
    return _step("record", title, "todo",
                 "Nothing is loaded. Restore a previous installation, or import the faculty roster and the ERP workbook.",
                 "/imports", "Load the record")


def _desks_step() -> dict[str, Any]:
    title = "Put someone at every desk"
    desks = readiness._desk_checks()
    empty = [d for d in desks if not d["ok"]]
    if not empty:
        return _step("desks", title, "done", "Research office, Principal, Director and Finance each have someone.",
                     "/people", "See who")
    names = [d["label"].replace(" desk has someone", "") for d in empty]
    listed = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    step = _step("desks", title, "todo", f"Nobody holds {listed}. A claim waits there.", empty[0]["to"],
                 f"Choose the {names[0]}")
    # The empty desks, so the page can offer a person-picker for each one
    # instead of sending the admin to a filtered list that has nobody in it.
    step["desks"] = [
        {"role": readiness._ROLE_FOR_LINK[d["key"].removeprefix("desk_")], "label": n}
        for d, n in zip(empty, names)
    ]
    return step


def _passwords_step() -> dict[str, Any]:
    title = "Give people their first password"
    people = _people_qs()
    total = people.count()
    if total == 0:
        return _step("passwords", title, "todo", "There is nobody to give one to yet.", "/people/passwords",
                     "Issue passwords")
    never = people.filter(last_login__isnull=True)
    without = never.exclude(password__startswith=HASHER + "$").count()
    waiting = never.filter(password__startswith=HASHER + "$").count()
    if without:
        return _step("passwords", title, "todo",
                     f"{_plural(without, 'person has', 'people have')} no password to sign in with.",
                     "/people/passwords", "Issue passwords")
    if waiting:
        return _step("passwords", title, "done",
                     f"Everyone has one. {_plural(waiting, 'person has', 'people have')} not signed in yet.",
                     "/people/passwords", "Issue more")
    return _step("passwords", title, "done", "Everyone has signed in at least once.", "/people/passwords",
                 "Issue passwords")


#: How many photos, and how many claim files, are looked for on each check.
#: A restore brings every row and no file, so a few are enough to tell.
_FILE_SAMPLE = 12


def _spread(names: list[str], n: int) -> list[str]:
    """n names spread evenly through a sorted list, so the same ones are asked each time."""
    if len(names) <= n:
        return names
    return [names[i * len(names) // n] for i in range(n)]


def _files_step() -> dict[str, Any]:
    """Are the photos and claim files the rows name actually here? (media_import.py loads them.)"""
    title = "Photos and files"
    photos = sorted(set(User.objects.filter(photo__startswith="avatars/").values_list("photo", flat=True)))
    prefix = f"{settings.MEDIA_URL}claims/"
    claim_files = sorted({
        url[len(settings.MEDIA_URL):]
        for url in ClaimAttachment.objects.filter(url__startswith=prefix).values_list("url", flat=True)
    })
    names = _spread(photos, _FILE_SAMPLE) + _spread(claim_files, _FILE_SAMPLE)
    to = "/admin/start"
    if not names:
        return _step("files", title, "done", "No photos or files are recorded yet.", to, "Add photos and files", False)
    missing = len(names) - len(media_import.existing_names(names))
    if missing:
        return _step(
            "files", title, "todo",
            f"{missing:,} of {len(names):,} photos and files checked are missing from this server. "
            "Upload the media zip so faces and claim files appear.",
            to, "Add photos and files", False,
        )
    return _step("files", title, "done", f"The {len(names):,} photos and files checked are all here.", to,
                 "Add more", False)


def _from_check(key: str, title: str, check: dict[str, Any], required: bool) -> dict[str, Any]:
    ok = bool(check["ok"])
    return _step(key, title, "done" if ok else "todo", check["detail"], check["to"], check["fix"], required)


def summary() -> dict[str, Any]:
    steps = [
        _record_step(),
        _desks_step(),
        _passwords_step(),
        _from_check("policy", "Publish a policy", readiness._policy_check(), True),
        _from_check("backup", "Have a recent backup", readiness._backup_check(), True),
        _files_step(),
        _from_check("email", "Set up email", readiness._email_check(), False),
        _from_check("scopus", "Add the Scopus key", readiness._scopus_check(), False),
    ]
    required = [s for s in steps if s["required"]]
    done = sum(1 for s in required if s["state"] == "done")
    nxt = next((s["key"] for s in required if s["state"] != "done"), None)
    return {
        "checked_at": timezone.now().isoformat(),
        "steps": steps,
        "done": done,
        "total": len(required),
        "next": nxt,
        "complete": nxt is None,
    }
