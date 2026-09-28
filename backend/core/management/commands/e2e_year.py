"""`manage.py e2e_year`: the cast and the record for the year-long browser spec.

    DJANGO_DEBUG=true python manage.py e2e_year --fixtures <path.json>

Seeds, idempotently and only on a DEBUG database:

- two faculty in CSE: Anand (regular, mentor of one final-year team) and
  Revathi (research faculty, quota 2), each with papers on their record so
  "Pull from Scopus" has something to pull;
- one officer per desk (research cell, Principal, Director, Finance, HOD of
  CSE, super admin);
- the journal tables that price those papers (SNIP and SCImago), one journal
  on the research cell's watch-list, and this financial year's budget;
- a recorded Crossref answer for one DOI, written to ``--fixtures`` for
  `E2E_UPSTREAM_FIXTURES`, so the DOI route files the same paper every run.

It prints one JSON line: a signed-in session per cast member, and the titles
and DOIs the spec files. Every account is at ``year.invalid`` with an unusable
password. ``--reset`` removes all of it first.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.models import (
    Authorship, Budget, FormulaConfig, PriorPayment, Claim, DuplicateFinding, JournalWatch, PaidLedger, Publication, Role,
    ScimagoJournal, SnipSource, Team, TeamMember, User,
)

DOMAIN = "year.invalid"
DEPT = "CSE"
TAG = "E2E-YEAR"


def issn(body: str) -> str:
    """Seven digits plus the right check digit, so the form accepts it."""
    total = sum(int(d) * w for d, w in zip(body, range(8, 1, -1)))
    check = (11 - total % 11) % 11
    return f"{body[:4]}-{body[4:]}{'X' if check == 10 else check}"


J_GOOD = ("Journal of Year Scenario Engineering", issn("2345671"), 1.8, "Q1")
J_SECOND = ("Transactions on Scenario Computing", issn("2345672"), 1.2, "Q2")
J_WATCHED = ("Global Journal of Rapid Acceptance", issn("2345673"), 0.4, "Q4")

CAST = {
    "anand": ("Anand Kumar", Role.FACULTY, "YR0001", "57300000001"),
    "revathi": ("Revathi Sundaram", Role.FACULTY, "YR0002", "57300000002"),
    "meena": ("Meena Krishnan", Role.FACULTY, "YR0004", None),
    "hod": ("Hema Rajan", Role.HOD, "YR0003", None),
    "cell": ("Cell Officer", Role.RESEARCH_CELL, "YR0005", "57300000005"),
    "principal": ("Prabhu Principal", Role.PRINCIPAL, None, None),
    "director": ("Deepa Director", Role.DIRECTOR, None, None),
    "finance": ("Farook Finance", Role.FINANCE, None, None),
    "admin": ("Asha Admin", Role.SUPER_ADMIN, None, None),
}

#: key -> (owner, title, journal, doi, position, total authors)
PAPERS = {
    "anand_scopus": ("anand", "Federated anomaly detection for campus energy grids", J_GOOD,
                     "10.99999/year.anand.1", 1, 3),
    "anand_watched": ("anand", "A quick survey of rapid acceptance venues", J_WATCHED,
                      "10.99999/year.anand.2", 1, 2),
    "revathi_1": ("revathi", "Graph learning for timetable repair", J_GOOD, "10.99999/year.rev.1", 1, 2),
    "revathi_2": ("revathi", "Explainable crop disease detection at the edge", J_SECOND,
                  "10.99999/year.rev.2", 1, 3),
    "revathi_3": ("revathi", "Low-power federated vision for smart classrooms", J_GOOD,
                  "10.99999/year.rev.3", 2, 4),
    # The research cell officer writes papers too, and files them like anyone.
    "cell_own": ("cell", "Auditing incentive schemes with open ledgers", J_SECOND,
                 "10.99999/year.cell.1", 1, 2),
}

#: Not on anybody's record: Anand files it by pasting the DOI.
DOI_PAPER = ("anand", "Secure edge caching with learned eviction policies", J_SECOND,
             "10.99999/year.anand.doi", 1, 2)


class Command(BaseCommand):
    help = "Seed the year-long scenario and print sessions for its cast (DEBUG only)."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true")
        parser.add_argument("--fixtures", default=None, help="Write the recorded upstream answers here.")
        parser.add_argument(
            "--erp-repeat", action="store_true",
            help="Only: add the ERP sheet's row for a payment already made here, and stop.",
        )

    def handle(self, *args, **opts):
        if not settings.DEBUG:
            raise CommandError("e2e_year refuses to run with DJANGO_DEBUG=false.")
        if opts["erp_repeat"]:
            self._erp_repeat()
            return
        if opts["reset"]:
            self._reset()
        people = {key: self._account(key, *spec) for key, spec in CAST.items()}
        self._journals()
        for key, spec in PAPERS.items():
            self._publication(people, key, *spec)
        self._budget()
        team = self._team(people["anand"])
        if opts["fixtures"]:
            self._write_fixtures(opts["fixtures"], people)
        out = {
            "people": {k: {"id": u.id, "name": u.name, "email": u.email, "session": self._session(u)}
                       for k, u in people.items()},
            "cookie_name": settings.SESSION_COOKIE_NAME,
            "papers": {k: {"title": v[1], "doi": v[3], "journal": v[2][0], "issn": v[2][1], "owner": v[0]}
                       for k, v in PAPERS.items()},
            "doi_paper": {"title": DOI_PAPER[1], "doi": DOI_PAPER[3], "journal": DOI_PAPER[2][0]},
            "watched_journal": J_WATCHED[0],
            "team": {"code": team.code, "title": team.title},
            "department": DEPT,
        }
        self.stdout.write(json.dumps(out))

    # -- pieces ------------------------------------------------------------

    def _reset(self) -> None:
        users = User.objects.filter(email__iendswith=f"@{DOMAIN}")
        ids = list(users.values_list("id", flat=True))
        Claim.objects.filter(owner_id__in=ids).delete()
        PaidLedger.objects.filter(staff_id__startswith="YR").delete()
        DuplicateFinding.objects.filter(faculty_name__in=[c[0] for c in CAST.values()]).delete()
        Publication.objects.filter(source=TAG).delete()
        PriorPayment.objects.filter(claim_ref__startswith="ERP-YR").delete()
        Team.objects.filter(code__startswith="FYP-YR").delete()
        # The super admin publishes a policy version in the scenario; put the
        # one it retired back, so every run prices from the same sheet.
        if FormulaConfig.objects.filter(updated_by_id__in=ids).exists():
            FormulaConfig.objects.filter(updated_by_id__in=ids).delete()
            if not FormulaConfig.objects.filter(active=True).exists():
                latest = FormulaConfig.objects.order_by("-version", "-created_at").first()
                if latest is not None:
                    latest.active = True
                    latest.save(update_fields=["active"])
        for row in Session.objects.all().iterator():
            try:
                if str(row.get_decoded().get(SESSION_KEY, "")) in ids:
                    row.delete()
            except Exception:  # noqa: BLE001
                continue
        users.delete()

    def _erp_repeat(self) -> None:
        """Accounts' ERP export arrives with Anand's first paper on it again,
        paid in August under his staff id -- the same paper this app paid in
        September. The nightly sweep should call that one person paid twice."""
        _, title, _journal, doi, _, _ = PAPERS["anand_scopus"]
        PriorPayment.objects.get_or_create(
            claim_ref="ERP-YR-0815",
            defaults={"faculty_name": "ANAND KUMAR", "employee_id": CAST["anand"][2],
                      "paper_title": title, "normalized_title": " ".join(title.lower().split()),
                      "doi": doi, "amount_paid": 74500,
                      "paid_at": timezone.make_aware(datetime(date.today().year, 8, 15)),
                      "raw_json": json.dumps({"Month": f"{date.today().year}-08", "Source": TAG})},
        )

    def _account(self, key, name, role, staff_id, scopus_id) -> User:
        email = f"{key}@{DOMAIN}"
        user = User.objects.filter(email__iexact=email).first() or User(email=email)
        user.name = name
        user.role = role
        user.active = True
        user.must_change_password = False
        user.department = DEPT if role in (Role.FACULTY, Role.HOD) else None
        user.staff_id = staff_id
        user.designation = {Role.FACULTY: "Assistant Professor", Role.HOD: "Head of Department"}.get(
            role, str(role).replace("_", " ").title())
        if scopus_id:
            user.scopus_author_id = scopus_id
        if key == "revathi":
            user.faculty_type = "RESEARCH"
            user.research_quota = 2
            user.research_quota_note = "Research faculty: two papers a year are part of the role."
        if user.has_usable_password() or not user.password:
            user.set_unusable_password()
        user.save()
        return user

    def _session(self, user: User) -> str:
        store = SessionStore()
        store[SESSION_KEY] = str(user.pk)
        store[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
        store[HASH_SESSION_KEY] = user.get_session_auth_hash()
        store.create()
        return store.session_key

    def _journals(self) -> None:
        year = date.today().year
        for title, code, snip, quartile in (J_GOOD, J_SECOND, J_WATCHED):
            SnipSource.objects.get_or_create(print_issn=code, defaults={"title": title, "snip": snip})
            for y in (year - 1, year):
                ScimagoJournal.objects.update_or_create(
                    issn=code.replace("-", ""), year=y,
                    defaults={"title": title, "sjr": snip,
                              "categories_json": json.dumps([{"category": "Computer Science Applications",
                                                              "quartile": quartile}])},
                )
        JournalWatch.objects.get_or_create(
            issn=J_WATCHED[1],
            defaults={"title": J_WATCHED[0], "reason": "Accepts within a week; on the cell's watch-list."},
        )

    def _publication(self, people, key, owner, title, journal, doi, position, total) -> None:
        pub, _ = Publication.objects.update_or_create(
            doi=doi,
            defaults={"title": title, "normalized_title": " ".join(title.lower().split()),
                      "year": date.today().year, "date": date(date.today().year, 2, 10),
                      "venue": journal[0], "issn": journal[1], "type": "article", "quartile": journal[3],
                      "scopus_indexed": True, "eid": f"2-s2.0-{int(hashlib.sha1(doi.encode()).hexdigest(), 16) % 10**11}", "source": TAG},
        )
        pub.authorships.all().delete()
        user = people[owner]
        for pos in range(1, total + 1):
            mine = pos == position
            Authorship.objects.create(
                publication=pub, position=pos,
                display_name=user.name if mine else f"Co Author {pos}",
                raw_affiliation="Saveetha Engineering College, Chennai" if mine else "Elsewhere University",
                institution_name="Saveetha Engineering College" if mine else "Elsewhere University",
                author_key=f"u:{user.id}" if mine else f"n:co author {pos} {key}",
                is_college=mine, user=user if mine else None, match_confidence=1 if mine else 0,
                match_method="e2e" if mine else "", match_locked=mine,
            )

    def _budget(self) -> None:
        today = date.today()
        start = today.year if today.month >= 4 else today.year - 1
        fy = f"{start}-{str(start + 1)[-2:]}"
        Budget.objects.update_or_create(financial_year=fy, department=None,
                                        defaults={"amount": 5_000_000, "note": TAG})

    def _team(self, mentor: User) -> Team:
        team, _ = Team.objects.update_or_create(
            code="FYP-YR-01",
            defaults={"title": "Smart attendance with edge vision", "department": DEPT,
                      "academic_year": "2026-27", "mentor": mentor, "mentor_name": mentor.name,
                      "mentor_staff_id": mentor.staff_id, "active": True},
        )
        for i in range(1, 4):
            TeamMember.objects.get_or_create(team=team, register_number=f"YR2026{i:03d}",
                                             defaults={"name": f"Student {i}", "programme": "B.E. CSE",
                                                       "year_of_study": "IV"})
        return team

    def _write_fixtures(self, path: str, people) -> None:
        """Crossref's answer for every paper in the scenario, as it would give it."""
        table = {}
        for owner, title, journal, doi, position, total in [*PAPERS.values(), DOI_PAPER]:
            user = people[owner]
            authors = []
            for pos in range(1, total + 1):
                mine = pos == position
                given, family = (user.name.split(" ", 1) if mine else ("Co", f"Author {pos}"))
                authors.append({"given": given, "family": family,
                                "sequence": "first" if pos == 1 else "additional",
                                "affiliation": [{"name": "Saveetha Engineering College, Chennai, India"
                                                 if mine else "Elsewhere University"}]})
            message = {
                "DOI": doi, "title": [title], "type": "journal-article", "container-title": [journal[0]],
                "ISSN": [journal[1]], "issn-type": [{"type": "print", "value": journal[1]}],
                "published": {"date-parts": [[date.today().year, 2, 10]]}, "author": authors,
                "volume": "12", "issue": "3", "page": "101-112", "publisher": "Scenario Press",
            }
            table[f"api.crossref.org/works/{doi}"] = {"status": "ok", "message": message}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(table, fh)
