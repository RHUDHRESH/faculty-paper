"""Rebuild the whole database from the ERP workbook, which is the record of truth.

The incremental importer loaded Master_List_Accounts into PriorPayment and
orphan PaidLedger rows -- useful for duplicate detection, invisible to every
statistic, because the dashboard and reports count Claim rows. The result was an
app reporting 83 payments worth Rs 4,00,651 against a workbook holding 3,137
payments worth Rs 2.49 crore.

This command rebuilds instead of patching: it clears the imported world, loads
each sheet into the model that actually drives the app, and then reconciles its
own output against the workbook so a silent shortfall cannot pass.

    python manage.py rebuild_from_erp ../data/Publication_Processing_ERP_V3.0.xlsx \
        --confirm --credentials-out ../faculty-credentials.csv
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import re
import secrets
import string
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from core.models import (
    AuditLog,
    Claim,
    ClaimAction,
    ClaimAttachment,
    ClaimStatus,
    FacultyMaster,
    Notification,
    PaidLedger,
    PriorImport,
    PriorPayment,
    Role,
    ScimagoJournal,
    SnipSource,
    User,
)
from core.services.normalize import normalize_doi, normalize_title
from core.services.scimago import parse_categories_field
from core.services.scopus import author_profile_url

EXCEL_EPOCH = dt.datetime(1899, 12, 30)
#: Spellings that mean "nothing recorded".
BLANKISH = {
    "", "-", "--", "n/a", "na", "none", "null", "nil", "—", "–", "nan",
    "not found", "notfound", "skipped", "#n/a",
}


def s(value, limit: int | None = None) -> str | None:
    """A cell as clean text, or None when it holds one of the blank spellings."""
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in BLANKISH:
        return None
    return text[:limit] if limit else text


def ident(value, limit: int | None = None) -> str | None:
    """An identifier. Excel hands whole numbers back as floats, and an author id
    is not 57918759100.0."""
    text = s(value)
    if text is None:
        return None
    if text.endswith(".0") and text[:-2].isdigit():
        text = text[:-2]
    return text[:limit] if limit else text


def num(value) -> float | None:
    text = s(value)
    if text is None:
        return None
    try:
        return float(text.replace(",", "").replace("₹", ""))
    except ValueError:
        return None


def when(value) -> dt.datetime | None:
    """A date, whether the sheet stored it as a datetime or an Excel serial."""
    if isinstance(value, dt.datetime):
        return value
    if isinstance(value, dt.date):
        return dt.datetime.combine(value, dt.time())
    n = num(value)
    if n is not None and 20000 < n < 80000:
        return EXCEL_EPOCH + dt.timedelta(days=n)
    text = s(value)
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(text[:10], fmt)
        except ValueError:
            continue
    return None


def rows(ws):
    """Every non-empty row as a dict. Duplicate headers keep the first column."""
    it = ws.iter_rows(values_only=True)
    try:
        header = next(it)
    except StopIteration:
        return
    names, seen = [], set()
    for i, h in enumerate(header):
        name = str(h).strip() if h is not None else f"col{i}"
        while name in seen:
            name += "_"
        seen.add(name)
        names.append(name)
    for raw in it:
        if not any(v is not None and str(v).strip() != "" for v in raw):
            continue
        yield dict(zip(names, raw))


def cell(row: dict, *keys):
    for k in keys:
        if k in row and row[k] is not None:
            return row[k]
    lowered = {k.lower(): v for k, v in row.items()}
    for k in keys:
        v = lowered.get(k.lower())
        if v is not None:
            return v
    return None


def password() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(16))


def clean_email(value) -> str | None:
    text = s(value)
    if not text:
        return None
    # A few rows carry two addresses in one cell.
    first = re.split(r"[,;/\s]+", text)[0].strip().lower()
    return first if "@" in first and "." in first.split("@")[-1] else None


def ledger_amount(row: dict) -> float | None:
    """What this ledger row actually paid.

    The newest block of Master_List_Accounts carries six extra columns, and in
    those rows the column headed "Amount" holds the author count -- so reading
    the header at face value prices a Rs 200 payment at Rs 6, and loses
    Rs 27,29,099 across the sheet. The trailing columns are the ERP's own
    working: col25 the quartile incentive, col26 (SNIP x 55000) + QF, col27 the
    payout after author-position points. Where that working is present it is
    the figure that was paid.
    """
    payout = num(cell(row, "col27"))
    if payout is not None:
        return payout
    return num(cell(row, "Amount"))


class Command(BaseCommand):
    help = "Rebuild claims, payments, faculty and journal masters from the ERP workbook"

    def add_arguments(self, parser):
        parser.add_argument("xlsx")
        parser.add_argument(
            "--confirm",
            action="store_true",
            help="Required. Deletes every imported claim, payment and faculty account.",
        )
        parser.add_argument(
            "--credentials-out",
            default=None,
            help="Write the generated faculty passwords to this CSV. Keep it out of git.",
        )
        parser.add_argument("--skip-masters", action="store_true",
                            help="Leave SJR/SNIP reference tables alone (they are slow and rarely change)")
        parser.add_argument("--limit", type=int, default=0)

    # ── entry point ──────────────────────────────────────────────────────

    def handle(self, *args, **opts):
        path = Path(opts["xlsx"])
        if not path.exists():
            raise CommandError(f"File not found: {path}")
        if not opts["confirm"]:
            raise CommandError(
                "This clears every imported claim, payment and faculty account. "
                "Re-run with --confirm once you mean it."
            )

        try:
            from openpyxl import load_workbook
        except ImportError as exc:
            raise CommandError("openpyxl is required") from exc

        self.limit = opts["limit"] or 0
        self.stdout.write(f"Reading {path.name} …")
        wb = load_workbook(str(path), read_only=True, data_only=True)

        self.expected: dict[str, float] = {}
        created: dict[str, int] = {}

        with transaction.atomic():
            self._wipe(created)
            self._faculty(wb, created, opts["credentials_out"])
            if not opts["skip_masters"]:
                self._journals(wb, created)
            self._ledger(wb, created)
            self._submissions(wb, created)

        wb.close()
        self._report(created)

    # ── steps ────────────────────────────────────────────────────────────

    def _wipe(self, created):
        """Clear the imported world, keeping the staff logins that run it."""
        keep = list(
            User.objects.exclude(role=Role.FACULTY).values_list("id", flat=True)
        )
        counts = {
            "claim attachments": ClaimAttachment.objects.all().delete()[0],
            "claim actions": ClaimAction.objects.all().delete()[0],
            "notifications": Notification.objects.all().delete()[0],
            "ledger rows": PaidLedger.objects.all().delete()[0],
            "claims": Claim.objects.all().delete()[0],
            "prior payments": PriorPayment.objects.all().delete()[0],
            "prior imports": PriorImport.objects.all().delete()[0],
            "faculty masters": FacultyMaster.objects.all().delete()[0],
            "faculty accounts": User.objects.exclude(id__in=keep).delete()[0],
        }
        self.stdout.write(self.style.WARNING("Cleared: " + ", ".join(
            f"{v} {k}" for k, v in counts.items() if v
        ) or "Cleared: nothing to remove"))
        created["kept staff accounts"] = len(keep)

    def _faculty(self, wb, created, credentials_out):
        """Faculty_Data -> FacultyMaster + a login for everyone with an address."""
        if "Faculty_Data" not in wb.sheetnames:
            return
        rows_seen = 0
        masters = []
        people: dict[str, dict] = {}
        for row in rows(wb["Faculty_Data"]):
            name = s(cell(row, "Name of the Staff", "Faculty Name", "Name"), 255)
            staff_id = ident(cell(row, "Staff-ID", "Staff ID"), 64)
            if not name and not staff_id:
                continue
            rows_seen += 1
            email = clean_email(cell(row, "Email ID", "Email"))
            record = {
                "name": name or email or staff_id,
                "staff_id": staff_id,
                "department": s(cell(row, "Department"), 128),
                "biometric_id": ident(cell(row, "Bio-ID", "Biometric ID"), 64),
                "scopus_author_id": ident(cell(row, "Scopus ID"), 64),
                "designation": s(cell(row, "Designation"), 128),
                "email": email,
                "phone": ident(cell(row, "Phone Number", "Phone"), 64),
            }
            if staff_id:
                masters.append(record)
            if email and email not in people:
                people[email] = record
            if self.limit and rows_seen >= self.limit:
                break

        FacultyMaster.objects.bulk_create(
            [
                FacultyMaster(
                    staff_id=m["staff_id"], name=m["name"], department=m["department"],
                    biometric_id=m["biometric_id"], scopus_author_id=m["scopus_author_id"],
                    designation=m["designation"], email=m["email"], phone=m["phone"],
                )
                for m in {m["staff_id"]: m for m in masters}.values()
            ],
            batch_size=500,
        )
        created["faculty master rows"] = FacultyMaster.objects.count()

        # One login each, with a password nobody has seen. The CSV is the only
        # copy and it is written locally, never committed or deployed.
        secrets_written = []
        for email, r in people.items():
            pw = password()
            user = User(
                email=email, name=r["name"], role=Role.FACULTY,
                department=r["department"], staff_id=r["staff_id"],
                biometric_id=r["biometric_id"], designation=r["designation"],
                scopus_author_id=r["scopus_author_id"],
                scopus_author_url=author_profile_url(r["scopus_author_id"]),
                must_change_password=True, active=True,
            )
            user.set_password(pw)
            user.save()
            secrets_written.append(
                {"email": email, "name": r["name"] or "", "department": r["department"] or "",
                 "staff_id": r["staff_id"] or "", "password": pw}
            )
        created["faculty accounts"] = len(secrets_written)

        if credentials_out and secrets_written:
            out = Path(credentials_out)
            out.parent.mkdir(parents=True, exist_ok=True)
            with out.open("w", newline="", encoding="utf-8") as fh:
                w = csv.DictWriter(
                    fh, fieldnames=["email", "name", "department", "staff_id", "password"]
                )
                w.writeheader()
                w.writerows(secrets_written)
            self.stdout.write(self.style.WARNING(
                f"Passwords written to {out} - distribute it yourself and delete it after."
            ))

    def _journals(self, wb, created):
        """SJR_Data and SNIP_2025 are the reference tables verification reads."""
        if "SJR_Data" in wb.sheetnames:
            ScimagoJournal.objects.all().delete()
            batch, n = [], 0
            for row in rows(wb["SJR_Data"]):
                title = s(cell(row, "Title"))
                if not title:
                    continue
                issns = [i.strip() for i in str(cell(row, "Issn") or "").split(",") if i.strip()]
                # The quartile is per subject category, not per journal: a title
                # can be Q1 in Oncology and Q3 in Medicine. `categories_json` is
                # what the verification step reads, so it is the field that has
                # to carry it.
                batch.append(ScimagoJournal(
                    title=title[:512],
                    issn=(issns[0] if issns else f"TITLE:{title[:26]}")[:32],
                    categories_json=json.dumps(
                        parse_categories_field(s(cell(row, "Categories")) or "")
                    ),
                    sjr=num(cell(row, "SJR")),
                    source_id=ident(cell(row, "Sourceid"), 64),
                    year=2025,
                ))
                n += 1
                if len(batch) >= 2000:
                    ScimagoJournal.objects.bulk_create(batch, ignore_conflicts=True)
                    batch = []
                if self.limit and n >= self.limit:
                    break
            if batch:
                ScimagoJournal.objects.bulk_create(batch, ignore_conflicts=True)
            created["scimago journals"] = ScimagoJournal.objects.count()

        if "SNIP_2025" in wb.sheetnames:
            SnipSource.objects.all().delete()
            batch, n, seen = [], 0, set()
            for row in rows(wb["SNIP_2025"]):
                snip = num(cell(row, "SNIP"))
                title = s(cell(row, "Title"))
                source_id = ident(cell(row, "Scopus Source ID"), 32)
                if snip is None or not title or source_id in seen:
                    continue
                seen.add(source_id)
                batch.append(SnipSource(
                    source_id=source_id, title=title[:512], snip=snip, year=2025,
                ))
                n += 1
                if len(batch) >= 2000:
                    SnipSource.objects.bulk_create(batch, ignore_conflicts=True)
                    batch = []
                if self.limit and n >= self.limit:
                    break
            if batch:
                SnipSource.objects.bulk_create(batch, ignore_conflicts=True)
            created["snip sources"] = SnipSource.objects.count()

    def _owner_index(self):
        """Every way a sheet row might name a person, mapped to their account."""
        index: dict[str, User] = {}
        for u in User.objects.filter(role=Role.FACULTY):
            for key in (u.staff_id, u.biometric_id, u.scopus_author_id, u.email,
                        (u.name or "").casefold().replace(" ", "").replace(".", "")):
                if key:
                    index.setdefault(str(key).strip().casefold(), u)
        return index

    def _match(self, index, *candidates) -> User | None:
        for c in candidates:
            key = s(c)
            if not key:
                continue
            hit = index.get(key.casefold())
            if hit:
                return hit
            squashed = key.casefold().replace(" ", "").replace(".", "")
            hit = index.get(squashed)
            if hit:
                return hit
        return None

    def _ledger(self, wb, created):
        """Master_List_Accounts -> PAID claims, their ledger rows, and the
        duplicate-detection record. The Amount recorded here is what was paid;
        it is imported as-is rather than recomputed."""
        if "Master_List_Accounts" not in wb.sheetnames:
            return
        index = self._owner_index()
        fallback = self._unattributed_account()
        batch = PriorImport.objects.create(
            filename="Master_List_Accounts", row_count=0, mapping_json="{}",
            imported_by=User.objects.filter(role=Role.SUPER_ADMIN).first(),
        )

        claims, ledgers, priors = [], [], []
        total = 0.0
        n = 0
        unmatched = 0
        for row in rows(wb["Master_List_Accounts"]):
            title = s(cell(row, "Scopus Article Title", "Article Title"))
            if not title:
                continue
            amount = ledger_amount(row)
            month = when(cell(row, "Month"))
            published = when(cell(row, "Publication Date"))
            owner = self._match(
                index,
                cell(row, "Faculty ID"), cell(row, "Biometric ID"),
                cell(row, "Scopus ID"), cell(row, "Faculty Name"),
            )
            if owner is None:
                # The ledger runs from 2024 and Faculty_Data is the current
                # roster, so these are overwhelmingly people who have since
                # left. Each keeps their own record: folding 267 people into
                # one holding account would put a false name on real payments
                # and wreck every per-person and per-department figure.
                owner = self._former_staff(index, row)
                unmatched += 1

            n += 1
            paid_at = month or published or timezone.now()
            if timezone.is_naive(paid_at):
                paid_at = timezone.make_aware(paid_at)

            claim = Claim(
                owner=owner,
                status=ClaimStatus.PAID,
                ticket_number=f"ERP-{n:06d}",
                paper_title=title,
                normalized_title=normalize_title(title)[:512],
                journal_title=s(cell(row, "Source Title"), 512),
                issn=ident(cell(row, "ISSN"), 32),
                doi=s(cell(row, "DOI"), 255),
                eid=s(cell(row, "Scopus EID"), 64),
                scopus_url=s(cell(row, "Scopus Article Link")),
                publication_date=published.date().isoformat() if published else None,
                publication_year=published.year if published else None,
                publication_type=s(cell(row, "Document Type"), 128),
                aggregation_type=s(cell(row, "Document Type"), 128),
                indexing_level="Scopus",
                indexing_status=s(cell(row, "Indexing Status"), 64),
                linkage_status=s(cell(row, "Scopus ID Link Status"), 64),
                staff_id=ident(cell(row, "Faculty ID"), 64),
                biometric_id=ident(cell(row, "Biometric ID"), 64),
                scopus_author_id=ident(cell(row, "Scopus ID"), 64),
                snip=num(cell(row, "SNIP Value")),
                snip_source="SNIP_DUMP" if num(cell(row, "SNIP Value")) is not None else None,
                quartile=s(cell(row, "SJR Quartile"), 32),
                quartile_source="SCIMAGO" if s(cell(row, "SJR Quartile")) else None,
                engineering_class=s(cell(row, "Engineering Classification"), 64),
                subjects_json=s(cell(row, "Subject Area")),
                remuneration=amount,
                payout_month=month.date().replace(day=1) if month else None,
                paid_at=paid_at,
                submitted_at=paid_at,
                verification_ok=True,
            )
            claims.append(claim)
            if amount is not None:
                total += amount

            if len(claims) >= 500:
                self._flush_ledger(claims, ledgers, priors, batch)
            if self.limit and n >= self.limit:
                break

        self._flush_ledger(claims, ledgers, priors, batch)
        batch.row_count = n
        batch.save()
        created["paid claims"] = n
        created["payments from former staff"] = unmatched
        self.expected["ledger total"] = total

    def _flush_ledger(self, claims, ledgers, priors, batch):
        if not claims:
            return
        Claim.objects.bulk_create(claims, batch_size=500)
        # `created_at` is auto_now_add, so every imported row would otherwise
        # carry the moment of the import. That makes "latest activity" a list of
        # whatever inserted last, and sorts thirty months of history into one
        # instant. Stamp each row with when it was actually paid.
        by_moment: dict = {}
        for c in claims:
            by_moment.setdefault(c.paid_at, []).append(c.pk)
        for moment, pks in by_moment.items():
            Claim.objects.filter(pk__in=pks).update(created_at=moment, updated_at=moment)
        PaidLedger.objects.bulk_create(
            [
                PaidLedger(
                    claim=c, payout_month=c.payout_month or c.paid_at.date().replace(day=1),
                    department=c.owner.department, faculty_name=c.owner.name,
                    staff_id=c.staff_id, biometric_id=c.biometric_id,
                    paper_title=c.paper_title, journal_title=c.journal_title,
                    amount=c.remuneration or 0,
                )
                for c in claims
            ],
            batch_size=500,
        )
        PriorPayment.objects.bulk_create(
            [
                PriorPayment(
                    faculty_name=c.owner.name, employee_id=c.staff_id,
                    paper_title=c.paper_title, normalized_title=c.normalized_title,
                    doi=normalize_doi(c.doi) if c.doi else None,
                    issn=c.issn, journal_title=c.journal_title,
                    amount_paid=c.remuneration, paid_at=c.paid_at,
                    claim_ref=c.ticket_number, import_batch=batch,
                )
                for c in claims
            ],
            batch_size=500,
        )
        claims.clear()

    def _submissions(self, wb, created):
        """Raw_Data -> claims awaiting review, at the moment they were filed."""
        if "Raw_Data" not in wb.sheetnames:
            return
        index = self._owner_index()
        fallback = self._unattributed_account()
        made = 0
        for row in rows(wb["Raw_Data"]):
            title = s(cell(row, "Title of the Paper", "Article Title"))
            if not title:
                continue
            email = clean_email(cell(row, "Email Address"))
            owner = self._match(
                index, email, cell(row, "Staff ID"), cell(row, "Biometric ID"),
                cell(row, "Faculty Name"),
            ) or fallback

            filed = when(cell(row, "Timestamp"))
            if filed and timezone.is_naive(filed):
                filed = timezone.make_aware(filed)
            published = when(cell(row, "Date of Publication"))
            made += 1

            claim = Claim.objects.create(
                owner=owner,
                status=ClaimStatus.SUBMITTED,
                ticket_number=f"SUB-{made:05d}",
                paper_title=title,
                normalized_title=normalize_title(title)[:512],
                journal_title=s(cell(row, "Journal Name"), 512),
                issn=s(cell(row, "ISSN No"), 32),
                yukthi_id=s(cell(row, "Yukthi ID"), 64),
                publication_date=published.date().isoformat() if published else None,
                publication_year=published.year if published else None,
                publication_type=s(cell(row, "Publication Type"), 128),
                indexing_level=s(cell(row, "Journal Indexing Level"), 128),
                self_reported_quartile=s(cell(row, "Journal quartile"), 32),
                self_reported_snip=num(cell(row, "SNIP")),
                impact_factor=s(cell(row, "Impact Factor"), 64),
                staff_id=ident(cell(row, "Staff ID"), 64),
                biometric_id=ident(cell(row, "Biometric ID"), 64),
                designation=s(cell(row, "Designation"), 128),
                scopus_author_url=s(cell(row, "Author SCOPUS Link")),
                total_authors=int(num(cell(row, "Total No of Authors")) or 1),
                author_position=int(num(cell(row, "Author Position")) or 1),
                sec_refs=s(cell(row, "Reference Number of Articles cited with SEC affiliation",
                                "Reference Number of Articles cited wit")),
                reference_articles=s(cell(row, "List the reference articles cited with SEC affiliation",
                                          "List the reference articles cited with")),
                proof_url=s(cell(row, "Upload Proof (Full length Published Paper)",
                                 "Upload Proof (Full length Published Pa")),
                sec_proof_url=s(cell(row, "Upload reference papers with SEC affiliation",
                                     "Upload reference papers with SEC affil")),
                submitted_at=filed or timezone.now(),
            )
            # The moment it was filed is the moment it was filed; auto_now_add
            # would stamp every one of them with the time of the import.
            if filed:
                Claim.objects.filter(pk=claim.pk).update(created_at=filed, updated_at=filed)
            ClaimAction.objects.create(
                claim=claim, actor=owner, action="SUBMIT",
                note="Imported from the ERP submission sheet",
            )
            if self.limit and made >= self.limit:
                break
        created["claims awaiting review"] = made

    def _former_staff(self, index, row) -> User:
        """An account for someone in the ledger but not on the current roster."""
        staff_id = ident(cell(row, "Faculty ID"), 64)
        bio = ident(cell(row, "Biometric ID"), 64)
        name = s(cell(row, "Faculty Name"), 255)
        handle = staff_id or bio or (name or "unknown").casefold().replace(" ", "-")
        email = f"former-{handle}@saveetha.invalid".lower()

        user = index.get(email.casefold())
        if user:
            return user
        user, _ = User.objects.get_or_create(
            email=email,
            defaults={
                "name": name or f"Former staff {handle}",
                "role": Role.FACULTY,
                "department": s(cell(row, "Department"), 128),
                "staff_id": staff_id,
                "biometric_id": bio,
                "scopus_author_id": ident(cell(row, "Scopus ID"), 64),
                # No longer on the roster, so no sign-in — the record exists to
                # keep their payment history attributed, not to grant access.
                "active": False,
                "must_change_password": True,
            },
        )
        for key in (email, staff_id, bio, user.scopus_author_id):
            if key:
                index.setdefault(str(key).casefold(), user)
        return user

    def _unattributed_account(self) -> User:
        """Rows whose faculty cannot be identified still have to belong to someone.

        They go to a clearly-named holding account rather than being dropped, so
        the totals stay honest and an admin can reassign them.
        """
        user, _ = User.objects.get_or_create(
            email="unattributed@saveetha.ac.in",
            defaults={
                "name": "Unattributed ERP records",
                "role": Role.FACULTY,
                "active": False,
                "must_change_password": True,
            },
        )
        return user

    # ── reconciliation ───────────────────────────────────────────────────

    def _report(self, created):
        self.stdout.write("")
        for k, v in created.items():
            self.stdout.write(f"  {k:<28} {v}")

        paid = Claim.objects.filter(status=ClaimStatus.PAID)
        app_total = sum(c.remuneration or 0 for c in paid.only("remuneration"))
        ledger_total = sum(PaidLedger.objects.values_list("amount", flat=True))
        expected = self.expected.get("ledger total")

        self.stdout.write("")
        self.stdout.write("  reconciliation")
        self.stdout.write(f"    paid claims               {paid.count()}")
        self.stdout.write(f"    claims total              {app_total:,.2f}")
        self.stdout.write(f"    ledger total              {ledger_total:,.2f}")
        if expected is not None:
            self.stdout.write(f"    workbook total            {expected:,.2f}")
            drift = abs(app_total - expected)
            if drift > 0.01:
                raise CommandError(
                    f"Imported total is off by {drift:,.2f} - refusing to leave the "
                    "database in a state that misreports money."
                )
            self.stdout.write(self.style.SUCCESS("    matches the workbook exactly"))
