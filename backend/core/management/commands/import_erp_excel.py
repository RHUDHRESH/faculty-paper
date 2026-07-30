"""Import master tables from Publication_Processing_ERP Excel workbook."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.models import FacultyMaster, PaidLedger, PriorImport, PriorPayment, ScimagoJournal, SnipSource, User
from core.services.normalize import normalize_doi, normalize_title
from core.services.scimago import parse_categories_field


def _cell(row, *keys):
    for k in keys:
        if k in row and row[k] is not None and str(row[k]).strip() != "":
            return row[k]
    return None


def _f(val):
    if val is None or val == "":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except ValueError:
        return None


def _i(val):
    f = _f(val)
    return int(f) if f is not None else None


def _s(val, n=None):
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("nan", "none", "na", "nil", "n/a"):
        return None
    return s[:n] if n else s


def _rows(ws):
    it = ws.iter_rows(values_only=True)
    headers = [str(h).strip() if h is not None else f"col{i}" for i, h in enumerate(next(it))]
    for row in it:
        if not any(c is not None and str(c).strip() for c in row):
            continue
        yield {headers[i]: row[i] if i < len(row) else None for i in range(len(headers))}


class Command(BaseCommand):
    help = "Import Faculty_Data, Master_List_Accounts, SJR_Data, SNIP_2025 from ERP Excel"

    def add_arguments(self, parser):
        parser.add_argument("xlsx", type=str, help="Path to Publication_Processing_ERP *.xlsx")
        parser.add_argument("--year", type=int, default=2025, help="Scimago/SNIP dataset year")
        parser.add_argument("--skip-sjr", action="store_true")
        parser.add_argument("--skip-snip", action="store_true")
        parser.add_argument("--skip-faculty", action="store_true")
        parser.add_argument("--skip-accounts", action="store_true")
        parser.add_argument("--limit", type=int, default=0, help="Limit rows per sheet (0=all)")

    def handle(self, *args, **options):
        path = Path(options["xlsx"])
        if not path.exists():
            raise CommandError(f"File not found: {path}")

        try:
            from openpyxl import load_workbook
        except ImportError as e:
            raise CommandError("openpyxl required") from e

        self.stdout.write(f"Loading {path} …")
        wb = load_workbook(str(path), read_only=True, data_only=True)
        year = options["year"]
        limit = options["limit"] or 0
        actor = User.objects.filter(role="SUPER_ADMIN").first()

        if not options["skip_faculty"] and "Faculty_Data" in wb.sheetnames:
            n = self._import_faculty(wb["Faculty_Data"], limit)
            self.stdout.write(self.style.SUCCESS(f"FacultyMaster: {n}"))

        if not options["skip_accounts"] and "Master_List_Accounts" in wb.sheetnames:
            n = self._import_accounts(wb["Master_List_Accounts"], actor, limit)
            self.stdout.write(self.style.SUCCESS(f"PriorPayment/PaidLedger: {n}"))

        if not options["skip_sjr"] and "SJR_Data" in wb.sheetnames:
            n = self._import_sjr(wb["SJR_Data"], year, limit)
            self.stdout.write(self.style.SUCCESS(f"ScimagoJournal: {n}"))

        if not options["skip_snip"] and "SNIP_2025" in wb.sheetnames:
            n = self._import_snip(wb["SNIP_2025"], year, limit)
            self.stdout.write(self.style.SUCCESS(f"SnipSource: {n}"))

        wb.close()
        self.stdout.write(self.style.SUCCESS("Import complete."))

    def _import_faculty(self, ws, limit: int) -> int:
        n = 0
        for row in _rows(ws):
            staff_id = _s(_cell(row, "Staff-ID", "Staff ID", "staff_id"), 64)
            name = _s(_cell(row, "Name of the Staff", "Name", "Faculty Name"), 255)
            if not staff_id or not name:
                continue
            FacultyMaster.objects.update_or_create(
                staff_id=staff_id,
                defaults={
                    "department": _s(_cell(row, "Department"), 128),
                    "biometric_id": _s(_cell(row, "Bio-ID", "Biometric ID"), 64),
                    "scopus_author_id": _s(_cell(row, "Scopus ID", "Scopus Author ID"), 64),
                    "name": name,
                    "designation": _s(_cell(row, "Designation"), 128),
                    "email": _s(_cell(row, "Email ID", "Email"), 254),
                    "phone": _s(_cell(row, "Phone Number", "Phone"), 64),
                    "raw_json": json.dumps({k: str(v)[:200] if v is not None else None for k, v in row.items()})[:50000],
                },
            )
            n += 1
            if limit and n >= limit:
                break
        return n

    def _import_accounts(self, ws, actor, limit: int) -> int:
        batch = PriorImport.objects.create(
            filename="Master_List_Accounts",
            row_count=0,
            mapping_json="{}",
            imported_by=actor or User.objects.first(),
        )
        n = 0
        for row in _rows(ws):
            title = _s(_cell(row, "Scopus Article Title", "Article Title", "paper_title"))
            if not title:
                continue
            doi = _s(_cell(row, "DOI"), 255)
            amount = _f(_cell(row, "Amount", "amount"))
            month_raw = _cell(row, "Month")
            payout = None
            if isinstance(month_raw, datetime):
                payout = month_raw.date().replace(day=1)
            elif month_raw:
                try:
                    payout = datetime.strptime(str(month_raw)[:10], "%Y-%m-%d").date().replace(day=1)
                except ValueError:
                    payout = None

            PriorPayment.objects.create(
                faculty_name=_s(_cell(row, "Faculty Name"), 255),
                employee_id=_s(_cell(row, "Faculty ID"), 64),
                paper_title=title,
                normalized_title=normalize_title(title),
                doi=normalize_doi(doi) if doi else None,
                issn=_s(_cell(row, "ISSN"), 32),
                journal_title=_s(_cell(row, "Source Title"), 512),
                amount_paid=amount,
                paid_at=timezone.now() if payout else None,
                claim_ref=_s(_cell(row, "Overall S No"), 255),
                raw_json=json.dumps({k: str(v)[:200] if v is not None else None for k, v in row.items()})[:50000],
                import_batch=batch,
            )
            if payout and amount is not None:
                PaidLedger.objects.create(
                    claim=None,
                    payout_month=payout,
                    department=_s(_cell(row, "Department"), 128),
                    faculty_name=_s(_cell(row, "Faculty Name"), 255),
                    staff_id=_s(_cell(row, "Faculty ID"), 64),
                    biometric_id=_s(_cell(row, "Biometric ID"), 64),
                    paper_title=title,
                    journal_title=_s(_cell(row, "Source Title"), 512),
                    amount=amount,
                    voucher_number=None,
                    raw_json=json.dumps({k: str(v)[:100] if v is not None else None for k, v in row.items()})[:20000],
                )
            n += 1
            if limit and n >= limit:
                break
        batch.row_count = n
        batch.save()
        return n

    def _import_sjr(self, ws, year: int, limit: int) -> int:
        n = 0
        for row in _rows(ws):
            title = _s(_cell(row, "Title"), 512)
            if not title:
                continue
            issn_raw = _s(_cell(row, "Issn", "ISSN"))
            issn = None
            if issn_raw:
                issn = issn_raw.split(",")[0].strip()[:32]
            key = issn or f"TITLE:{title[:40]}"
            cats = _s(_cell(row, "Categories")) or ""
            ScimagoJournal.objects.update_or_create(
                issn=key,
                year=year,
                defaults={
                    "source_id": _s(_cell(row, "Sourceid", "Source ID"), 64),
                    "title": title,
                    "eissn": None,
                    "sjr": _f(_cell(row, "SJR")),
                    "categories_json": json.dumps(parse_categories_field(cats)),
                    "raw_json": json.dumps({k: str(v)[:120] if v is not None else None for k, v in row.items()})[:50000],
                },
            )
            n += 1
            if limit and n >= limit:
                break
            if n % 2000 == 0:
                self.stdout.write(f"  SJR … {n}")
        return n

    def _import_snip(self, ws, year: int, limit: int) -> int:
        n = 0
        for row in _rows(ws):
            title = _s(_cell(row, "Title"), 512)
            if not title:
                continue
            print_issn = _s(_cell(row, "Print ISSN", "Print_ISSN"), 32)
            e_issn = _s(_cell(row, "E-ISSN", "E_ISSN"), 32)
            issn_key = (print_issn or e_issn or f"TITLE:{title[:40]}")[:64]
            SnipSource.objects.update_or_create(
                print_issn=issn_key,
                year=year,
                defaults={
                    "title": title,
                    "e_issn": e_issn,
                    "snip": _f(_cell(row, "SNIP")),
                    "sjr": _f(_cell(row, "SJR")),
                    "source_id": _s(_cell(row, "Scopus Source ID", "Source ID"), 64),
                    "raw_json": json.dumps({k: str(v)[:100] if v is not None else None for k, v in row.items()})[:50000],
                },
            )
            n += 1
            if limit and n >= limit:
                break
            if n % 5000 == 0:
                self.stdout.write(f"  SNIP … {n}")
        return n
