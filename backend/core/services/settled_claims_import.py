"""The settled-claims workbook (Claim_Settled_Upto_<month>.xlsx), brought into the ledger.

Every row is a claim that has already been paid. The app keeps that history as
`PaidLedger` rows (what the payments, statements and totals read) plus
`PriorPayment` rows (what the already-paid warning reads), written the way
`import_erp_excel` writes them: a PAYMENT, cycle 1, no claim, the month the
money went out. This service adds only what is missing and never edits money.

Each row is one of:

* already_recorded: the same person and paper are already on the ledger (or a
  prior payment), or the same DOI is on that person's prior payment or ledger
  row. Nothing is written.
* amount_differs: already recorded, with another amount. Reported only. The
  ledger is never changed here.
* zero_amount: a count-only row (amount 0, or "No remuneration" in the notes).
  Written as a zero ledger row, as the existing history does.
* new: not on the ledger. A ledger row and a prior payment are written. A row
  whose Amount is blank or text ("N/A") is still new, but only its prior
  payment is written: its money is not imported, and it is counted.

unmatched_staff is a flag on a row about to be written (new or zero_amount)
whose Faculty ID belongs to nobody in the app: still imported as text.

Separately, a DOI the app does not hold yet is filled into a paper of the
same person and title that has none.

Running it twice writes nothing the second time. A check (dry run) writes
nothing but a note of each amount_differs row for the Data conflicts screen
(`import_conflicts`), which the import step notes too.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from collections import defaultdict
from typing import IO, Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core.management.commands.rebuild_from_erp import ident, num, s, when
from core.services.import_conflicts import note_conflicts
from core.models import FacultyMaster, PaidLedger, PriorImport, PriorPayment, Publication, User
from core.services.fyp_roster import staff_key
from core.services.normalize import normalize_doi, normalize_title

KEYS = {
    "month": "month", "overallsno": "sno", "department": "department", "facultyname": "name",
    "biometricid": "bio_id", "facultyid": "staff_id", "scopusarticletitle": "title",
    "sourcetitle": "journal", "issn": "issn", "documenttype": "doc_type", "scopusid": "scopus_id",
    "publicationdate": "pub_date", "scopuseid": "eid", "doi": "doi",
    "scopusarticlelink": "link", "subjectarea": "subject", "amount": "amount",
}
MAX_AMOUNT_ROWS = 200
MAX_UNMATCHED_ROWS = 100
KEY_PREFIX = "settled-import:"


def _k(value: Any) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _first_of_month(value: Any) -> dt.date | None:
    d = when(value)
    return d.date().replace(day=1) if d else None


def parse_amount(value: Any) -> tuple[float | None, bool]:
    """(amount, ok). A number is ok; a blank or text such as "N/A" is not."""
    if isinstance(value, bool):
        return None, False
    if isinstance(value, (int, float)):
        return float(value), True
    n = num(value)
    return (n, True) if n is not None else (None, False)


def _plain(value: Any) -> Any:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def read_settled_claims(source: str | IO[bytes]) -> list[dict[str, Any]]:
    """Every non-blank row of the first sheet that has the claim headers."""
    import openpyxl

    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            rows = list(ws.iter_rows(values_only=True))
            for i, header in enumerate(rows[:20]):
                names = {_k(v) for v in header if v is not None}
                if {"month", "scopusarticletitle"} <= names:
                    return _read_rows(header, rows[i + 1:])
        raise ValueError('No sheet has a header row with "Month" and "Scopus Article Title".')
    finally:
        wb.close()


def _read_rows(header: tuple, body: list[tuple]) -> list[dict[str, Any]]:
    cols: dict[str, int] = {}
    labels: dict[int, str] = {}
    unnamed: list[int] = []
    for j, h in enumerate(header):
        if h is None or not str(h).strip():
            unnamed.append(j)
            continue
        labels[j] = str(h).strip()
        key = KEYS.get(_k(h))
        if key and key not in cols:
            cols[key] = j
    out = []
    for raw in body:
        if all(v is None or not str(v).strip() for v in raw):
            continue

        def get(key: str):
            j = cols.get(key)
            return raw[j] if j is not None and j < len(raw) else None

        notes = " ".join(str(raw[j]).strip() for j in unnamed if j < len(raw) and raw[j] is not None and str(raw[j]).strip())
        amount, amount_ok = parse_amount(get("amount"))
        pub = when(get("pub_date"))
        out.append({
            "title": s(get("title")) or "",
            "name": s(get("name"), 255) or "",
            "staff_id": ident(get("staff_id"), 64) or "",
            "bio_id": ident(get("bio_id"), 64) or "",
            "department": s(get("department"), 128) or "",
            "journal": s(get("journal"), 512) or "",
            "issn": ident(get("issn"), 32) or "",
            "doi": normalize_doi(s(get("doi"), 255)) or "",
            "sno": s(get("sno"), 255) or "",
            "month": _first_of_month(get("month")),
            "pub_date": pub.date() if pub else None,
            "amount": amount,
            "amount_ok": amount_ok,
            "notes": notes,
            "raw": {
                **{labels[j]: _plain(raw[j]) for j in labels if j < len(raw) and raw[j] is not None},
                **({"Notes": notes} if notes else {}),
            },
        })
    return out


def _same_amount(a: float, b: float) -> bool:
    return abs(a - b) < 0.005


def _is_zero_row(row: dict[str, Any]) -> bool:
    no_pay = "no remuneration" in row["notes"].casefold()
    if row["amount_ok"] and row["amount"] == 0:
        return True
    return no_pay and (row["amount"] is None or row["amount"] == 0)


class _History:
    """What the app already holds, indexed once. `add` keeps it current so a
    paper that appears twice in the file is written once, in a check too."""

    def __init__(self) -> None:
        # (staff, normalised title) -> amounts seen (None = a record with no amount)
        self.by_title: dict[tuple[str, str], list[float | None]] = defaultdict(list)
        # (staff, doi) -> amounts; staff "" for a record that names nobody
        self.by_doi: dict[tuple[str, str], list[float | None]] = defaultdict(list)
        self.pub_dois: set[str] = set()
        for row in PaidLedger.objects.filter(kind=PaidLedger.Kind.PAYMENT).values_list(
            "staff_id", "paper_title", "amount", "raw_json"
        ).iterator(chunk_size=2000):
            staff, title, amount, raw = row
            who = staff_key(staff)
            self.by_title[(who, normalize_title(title)[:512])].append(amount)
            if raw and '"DOI"' in raw:
                try:
                    doi = normalize_doi(str(json.loads(raw).get("DOI") or ""))
                except (ValueError, AttributeError):
                    doi = None
                if doi:
                    self.by_doi[(who, doi)].append(amount)
        for staff, title, doi, amount in PriorPayment.objects.values_list(
            "employee_id", "normalized_title", "doi", "amount_paid"
        ).iterator(chunk_size=2000):
            who = staff_key(staff)
            if title:
                self.by_title[(who, title[:512])].append(amount)
            if doi:
                self.by_doi[(who, normalize_doi(doi) or doi)].append(amount)
        for doi in Publication.objects.exclude(doi__isnull=True).exclude(doi="").values_list("doi", flat=True):
            self.pub_dois.add(normalize_doi(doi) or doi)

    def recorded(self, who: str, title: str, doi: str) -> list[float | None] | None:
        hit = self.by_title.get((who, title))
        if hit:
            return hit
        if doi:
            hit = self.by_doi.get((who, doi)) or self.by_doi.get(("", doi))
            if hit:
                return hit
        return None

    def add(self, who: str, title: str, doi: str, amount: float | None) -> None:
        self.by_title[(who, title)].append(amount)
        if doi:
            self.by_doi[(who, doi)].append(amount)


def _idempotency_key(who: str, title: str, month: dt.date | None) -> str:
    digest = hashlib.sha1(title.encode("utf-8")).hexdigest()[:20]
    return f"{KEY_PREFIX}{who}:{digest}:{month.isoformat() if month else 'none'}"[:128]


def import_settled_claims(rows: list[dict[str, Any]], *, dry_run: bool = True, actor: User | None = None,
                          filename: str = "Claim_Settled") -> dict[str, Any]:
    """Classify every row; unless dry_run, write the missing ledger history."""
    history = _History()
    known_staff = {staff_key(x) for x in User.objects.exclude(staff_id__isnull=True).values_list("staff_id", flat=True)}
    known_staff |= {staff_key(x) for x in FacultyMaster.objects.exclude(staff_id__isnull=True).values_list("staff_id", flat=True)}
    known_staff.discard("")
    no_doi_pubs: dict[str, list[str]] = defaultdict(list)
    for pk, title, norm in Publication.objects.filter(Q(doi__isnull=True) | Q(doi="")).values_list(
        "id", "title", "normalized_title"
    ).iterator(chunk_size=2000):
        key = normalize_title(title or norm)
        if key:
            no_doi_pubs[key].append(pk)

    counts = {"already_recorded": 0, "new": 0, "amount_differs": 0, "zero_amount": 0,
              "unmatched_staff": 0, "unparseable_amount": 0, "doi_filled": 0, "skipped_no_title": 0}
    new_total = 0.0
    by_month: dict[str, dict[str, Any]] = {}
    differs: list[dict[str, Any]] = []
    unmatched: dict[str, dict[str, str]] = {}
    to_write: list[dict[str, Any]] = []
    fills: list[tuple[str, str]] = []

    for row in rows:
        title_key = normalize_title(row["title"])[:512]
        if not title_key:
            counts["skipped_no_title"] += 1
            continue
        who = staff_key(row["staff_id"])
        doi = row["doi"]
        seen = history.recorded(who, title_key, doi)
        kind = None
        if seen is not None:
            kind = "already_recorded"
            if row["amount_ok"] and row["amount"] is not None:
                money = [a for a in seen if a is not None]
                if money and not any(_same_amount(a, row["amount"]) for a in money):
                    kind = "amount_differs"
                    differs.append({
                        "staff_id": row["staff_id"], "name": row["name"], "title": row["title"],
                        "ledger_amount": money[0], "file_amount": row["amount"],
                        "month": row["month"].isoformat() if row["month"] else None,
                    })
        elif _is_zero_row(row):
            kind = "zero_amount"
        else:
            kind = "new"
        counts[kind] += 1

        if kind in ("new", "zero_amount"):
            if who not in known_staff:
                counts["unmatched_staff"] += 1
                if len(unmatched) < MAX_UNMATCHED_ROWS:
                    unmatched.setdefault(row["staff_id"], {"staff_id": row["staff_id"], "name": row["name"]})
            amount = 0.0 if kind == "zero_amount" else row["amount"]
            if kind == "new" and not row["amount_ok"]:
                counts["unparseable_amount"] += 1
            bucket = by_month.setdefault(row["month"].strftime("%Y-%m") if row["month"] else "", {"new": 0, "amount": 0.0})
            bucket["new"] += 1
            bucket["amount"] += amount or 0.0
            new_total += amount or 0.0
            to_write.append({**row, "amount": amount, "who": who, "title_key": title_key})
            history.add(who, title_key, doi, amount)

        # A DOI the app does not hold yet goes onto the same person's paper that has none.
        if doi and doi not in history.pub_dois and who:
            candidates = no_doi_pubs.get(title_key, [])
            if len(candidates) == 1:
                hit = Publication.objects.filter(pk=candidates[0]).filter(
                    Q(authorships__user__staff_id__iexact=row["staff_id"])
                    | Q(ledger_rows__staff_id__iexact=row["staff_id"])
                    | Q(claims__staff_id__iexact=row["staff_id"])
                ).exists()
                if hit:
                    fills.append((candidates[0], doi))
                    history.pub_dois.add(doi)
                    no_doi_pubs.pop(title_key, None)
                    counts["doi_filled"] += 1

    if not dry_run:
        with transaction.atomic():
            _write(to_write, fills, actor, filename)

    # Every difference is noted, however many the report lists.
    note_conflicts("amount", differs, filename)

    return {
        "dry_run": dry_run,
        "rows": len(rows),
        "counts": counts,
        "new_total_amount": round(new_total, 2),
        "by_month": [{"month": m, "new": v["new"], "amount": round(v["amount"], 2)} for m, v in sorted(by_month.items())],
        "amount_differs": differs[:MAX_AMOUNT_ROWS],
        "unmatched_staff": list(unmatched.values()),
    }


def _write(to_write: list[dict[str, Any]], fills: list[tuple[str, str]], actor: User | None, filename: str) -> None:
    if to_write:
        batch = PriorImport.objects.create(
            filename=filename[:255], row_count=len(to_write), mapping_json="{}",
            imported_by=actor or User.objects.order_by("created_at").first(),
        )
        ledgers, priors = [], []
        for r in to_write:
            amount = r["amount"]
            paid_at = None
            if r["month"]:
                paid_at = timezone.make_aware(dt.datetime.combine(r["month"], dt.time()))
            raw = json.dumps(
                {**{k: (str(v)[:500] if v is not None else None) for k, v in r["raw"].items()},
                 "source": "settled_claims_import"},
                ensure_ascii=False,
            )[:20000]
            priors.append(PriorPayment(
                faculty_name=r["name"] or None, employee_id=r["staff_id"] or None, paper_title=r["title"],
                normalized_title=r["title_key"], doi=r["doi"] or None, issn=r["issn"] or None,
                journal_title=r["journal"] or None,
                publication_year=r["pub_date"].year if r["pub_date"] else None,
                amount_paid=r["amount"], paid_at=paid_at, claim_ref=r["sno"] or None,
                raw_json=raw, import_batch=batch,
            ))
            # Money is written only for a row with a month and a figure.
            if r["month"] and r["amount"] is not None:
                ledgers.append(PaidLedger(
                    claim=None, kind=PaidLedger.Kind.PAYMENT, cycle=1,
                    idempotency_key=_idempotency_key(r["who"], r["title_key"], r["month"]),
                    payout_month=r["month"], department=r["department"] or None,
                    faculty_name=r["name"] or None, staff_id=r["staff_id"] or None,
                    biometric_id=r["bio_id"] or None, paper_title=r["title"],
                    journal_title=r["journal"] or None, amount=r["amount"], raw_json=raw,
                ))
        PriorPayment.objects.bulk_create(priors, batch_size=500)
        PaidLedger.objects.bulk_create(ledgers, batch_size=500)
    for pk, doi in fills:
        Publication.objects.filter(pk=pk).update(doi=doi)
