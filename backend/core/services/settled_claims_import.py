"""The settled-claims workbook (Claim_Settled_Upto_<month>.xlsx), brought into the ledger.

Every row is a claim that has already been paid. The app keeps that history as
`PaidLedger` rows (what the payments, statements and totals read) plus
`PriorPayment` rows (what the already-paid warning reads), written the way
`import_erp_excel` writes them: a PAYMENT, cycle 1, no claim, the month the
money went out. This service adds only what is missing and never edits money.

**A row of the file is one payment.** Its identity is its Month and "Overall S
No" (without an S No: Month, person, paper and amount). A row is already
recorded only when a ledger row made from that very row exists (its key is on
the row). A paper listed twice for one person, each with money, is two
payments: both are written, and the pair is flagged "paid more than once"
(`double_payments`, and a Data conflicts entry), never dropped.

History older than these keys (the ERP import, this importer's earlier
version, a claim paid in the app) is matched one to one: each record of a
person and paper answers at most ONE row, by the same month first, then the
same amount. Any further row with money is new.

Each row is one of:

* already_recorded: a record made from that row, or an older record of the
  same person and paper (or DOI) that no other row has used. Nothing is written.
* amount_differs: already recorded, with another amount. Reported only. The
  ledger is never changed here.
* zero_amount: a count-only row (amount 0, or "No remuneration" in the notes).
  Written as a zero ledger row, as the existing history does. A zero or text
  row is not a payment, so it is already recorded when the paper is.
* new: not on the ledger. A ledger row and a prior payment are written. A row
  whose Amount is blank or text ("N/A") is still new, but only its prior
  payment is written: its money is not imported, and it is counted.

unmatched_staff is a flag on a row about to be written (new or zero_amount)
whose Faculty ID belongs to nobody in the app: still imported as text.

Separately, a DOI the app does not hold yet is filled into a paper of the
same person and title that has none.

Running it twice writes nothing the second time. A check (dry run) writes
nothing but a note of each amount_differs row for the Data conflicts screen
(`import_conflicts`), which the import step notes too. Only an import notes
the double payments (the check lists them, with what it would add).
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
from core.services.double_payments import find as find_double_payments
from core.services.import_conflicts import note_conflicts
from core.models import Claim, ClaimStatus, FacultyMaster, ImportConflict, PaidLedger, PriorImport, PriorPayment, Publication, User
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
MAX_DOUBLE_ROWS = 200
KEY_PREFIX = "settled-import:"
#: A ledger row made from one row of the file carries this key (see `_row_key`).
ROW_PREFIX = f"{KEY_PREFIX}r:"
#: Claims made by the old bulk ERP import carry the day it ran, not the day they were paid.
BULK_PREFIX = "ERP-PROCESSED"
DOUBLE = ImportConflict.Kind.DOUBLE_PAYMENT.value


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


class _Entry:
    """One record the app already holds: what it was paid, and for which month."""

    __slots__ = ("amount", "month", "key", "used", "claimed", "claim_id", "ticket")

    def __init__(self, amount: float | None, month: dt.date | None, key: str | None = None,
                 claim_id: str | None = None, ticket: str | None = None) -> None:
        self.amount, self.month, self.key = amount, month, key
        self.claim_id, self.ticket = claim_id, ticket   # the app claim this payment belongs to
        self.used = False      # already answered for one row of this file
        self.claimed = False   # made from a row of this file: matched by that row only


def _zero_claim(e: _Entry) -> bool:
    """An app claim that is paid but carries no money: the college sheet may say what was really paid."""
    return bool(e.claim_id) and (e.amount or 0) <= 0.005


class _Store:
    """One kind of record, indexed by person and paper."""

    def __init__(self) -> None:
        self.by_title: dict[tuple[str, str], list[_Entry]] = defaultdict(list)
        self.by_doi: dict[tuple[str, str], list[_Entry]] = defaultdict(list)  # staff "" = names nobody
        self.keyed: dict[str, _Entry] = {}

    def add(self, who: str, title: str, doi: str, entry: _Entry) -> None:
        if title:
            self.by_title[(who, title)].append(entry)
        if doi:
            self.by_doi[(who, doi)].append(entry)
        if entry.key:
            self.keyed[entry.key] = entry

    def by_paper(self, who: str, title: str, doi: str) -> list[_Entry]:
        """Everything held for this person and paper, by title and by DOI, once each.
        Strictly this person's: a co-author's record of the same paper never answers it."""
        out: dict[int, _Entry] = {}
        for lst in (self.by_title.get((who, title)), self.by_doi.get((who, doi)) if doi else None):
            for e in lst or ():
                out.setdefault(id(e), e)
        return list(out.values())


def _first(value: dt.date | dt.datetime | None) -> dt.date | None:
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        value = timezone.localtime(value).date() if timezone.is_aware(value) else value.date()
    return value.replace(day=1)


class _History:
    """What the app already holds, indexed once.

    A record made from a row of this very file (it carries that row's key) is
    matched by that row alone. Every other record (the older ERP history, the
    older version of this importer, a claim paid in the app, or a row of an
    earlier file that this file no longer lists) can absorb at most ONE row,
    so a second payment of the same paper is never taken for the first.
    """

    def __init__(self) -> None:
        self.ledger, self.prior, self.added = _Store(), _Store(), _Store()
        self.pub_dois: set[str] = set()
        # Payments, and any row this importer made (a claim's correction row is not a PAYMENT).
        ledger = PaidLedger.objects.filter(
            Q(kind=PaidLedger.Kind.PAYMENT) | Q(idempotency_key__startswith=ROW_PREFIX)
        ).values_list(
            "staff_id", "paper_title", "amount", "raw_json", "idempotency_key", "payout_month",
            "claim_id", "claim__ticket_number", "claim__owner__staff_id",
        )
        with_ledger: set[str] = set()
        self.claim_amount: dict[str, float] = {}   # what the ledger holds for each claim
        for staff, title, amount, raw, key, month, claim_id, ticket, owner_staff in ledger.iterator(chunk_size=2000):
            doi = ""
            if raw and '"DOI"' in raw:
                try:
                    doi = normalize_doi(str(json.loads(raw).get("DOI") or "")) or ""
                except (ValueError, AttributeError):
                    doi = ""
            entry = _Entry(amount, _first(month), key if key and key.startswith(ROW_PREFIX) else None, claim_id, ticket)
            # A claim's payment belongs to the claim's owner, as the Top 5 reads it.
            who = (staff_key(owner_staff) if claim_id else "") or staff_key(staff)
            if claim_id:
                with_ledger.add(claim_id)
                self.claim_amount[claim_id] = self.claim_amount.get(claim_id, 0.0) + float(amount or 0)
            self.ledger.add(who, normalize_title(title)[:512], doi, entry)
        # A paid claim with nothing on the ledger stands for its own remuneration.
        self.paid_claims: list[dict[str, Any]] = []
        self.claim_by_id: dict[str, dict[str, Any]] = {}
        for c in Claim.objects.filter(status=ClaimStatus.PAID).values(
            "id", "ticket_number", "owner__staff_id", "owner__name", "paper_title", "doi", "remuneration",
            "payout_month", "paid_at",
        ).iterator(chunk_size=2000):
            when_ = c["payout_month"] or c["paid_at"]
            who = staff_key(c["owner__staff_id"])
            title = normalize_title(c["paper_title"])[:512]
            doi = normalize_doi(c["doi"]) or "" if c["doi"] else ""
            self.paid_claims.append({**c, "who": who, "title": title, "doi_n": doi, "month": _first(when_)})
            self.claim_by_id[c["id"]] = self.paid_claims[-1]
            if c["id"] not in with_ledger:
                self.claim_amount[c["id"]] = float(c["remuneration"] or 0)
            if c["id"] not in with_ledger and who and title:
                self.ledger.add(who, title, doi, _Entry(float(c["remuneration"] or 0), _first(when_), None, c["id"], c["ticket_number"]))
        plain = PriorPayment.objects.exclude(raw_json__contains='"row_key"')
        for staff, title, doi, amount, paid in plain.values_list(
            "employee_id", "normalized_title", "doi", "amount_paid", "paid_at"
        ).iterator(chunk_size=2000):
            self.prior.add(staff_key(staff), (title or "")[:512], (normalize_doi(doi) or doi or "") if doi else "",
                           _Entry(amount, _first(paid)))
        for staff, title, doi, amount, paid, raw in PriorPayment.objects.filter(raw_json__contains='"row_key"').values_list(
            "employee_id", "normalized_title", "doi", "amount_paid", "paid_at", "raw_json"
        ).iterator(chunk_size=2000):
            try:
                key = str(json.loads(raw).get("row_key") or "")
            except (ValueError, AttributeError):
                key = ""
            self.prior.add(staff_key(staff), (title or "")[:512], (normalize_doi(doi) or doi or "") if doi else "",
                           _Entry(amount, _first(paid), key or None))
        for doi in Publication.objects.exclude(doi__isnull=True).exclude(doi="").values_list("doi", flat=True):
            self.pub_dois.add(normalize_doi(doi) or doi)

    def claim(self, keys: set[str]) -> None:
        """Mark the records that this file's rows made."""
        for store in (self.ledger, self.prior):
            for key, entry in store.keyed.items():
                entry.claimed = key in keys

    def exact(self, key: str) -> _Entry | None:
        """The record made from this very row, if any (its twin is used up with it)."""
        hit = self.ledger.keyed.get(key)
        twin = self.prior.keyed.get(key)
        for e in (hit, twin):
            if e is not None:
                e.used = True
        return hit or twin

    def pool(self, who: str, title: str, doi: str) -> list[_Entry]:
        """The records one row may be answered by. The ledger is the record of
        payments; the earlier-payments list stands in only where it holds more."""
        led = [e for e in self.ledger.by_paper(who, title, doi) if not e.claimed]
        pri = [e for e in self.prior.by_paper(who, title, doi) if not e.claimed]
        return led if len(led) >= len(pri) else pri

    def seen(self, who: str, title: str, doi: str, stores: tuple[_Store, ...] | None = None) -> list[_Entry]:
        """Every record of the paper, by title, else by DOI (what a row without money is checked against)."""
        stores = stores or (self.ledger, self.prior, self.added)
        by_title = [e for s in stores for e in s.by_title.get((who, title), ())]
        if by_title:
            return by_title
        if not doi:
            return []
        return [e for s in stores for e in (s.by_doi.get((who, doi)) or ())]

    def note(self, who: str, title: str, doi: str, amount: float | None, month: dt.date | None) -> None:
        self.added.add(who, title, doi, _Entry(amount, month))


def _row_key(row: dict[str, Any], who: str, title_key: str) -> str:
    """What one row of the file is: its month and Overall S No, else month, person, paper and amount."""
    month = row["month"].strftime("%Y-%m") if row["month"] else "none"
    sno = (row["sno"] or "").strip()
    if sno.endswith(".0") and sno[:-2].isdigit():
        sno = sno[:-2]
    if sno:
        return f"{month}|sno:{sno.casefold()}"
    amount = f"{row['amount']:.2f}" if row["amount"] is not None else "none"
    return f"{month}|{who}|{title_key}|{amount}"


def _ledger_key(row_key: str) -> str:
    return f"{ROW_PREFIX}{hashlib.sha1(row_key.encode('utf-8')).hexdigest()[:40]}"


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
              "unmatched_staff": 0, "unparseable_amount": 0, "doi_filled": 0, "skipped_no_title": 0,
              "claim_at_zero": 0}
    claim_rows: list[dict[str, Any]] = []
    corrections: dict[str, dict[str, Any]] = {}
    blank_rows: list[dict[str, Any]] = []
    new_total = 0.0
    by_month: dict[str, dict[str, Any]] = {}
    differs: list[dict[str, Any]] = []
    unmatched: dict[str, dict[str, str]] = {}
    to_write: list[dict[str, Any]] = []
    fills: list[tuple[str, str]] = []

    # Each row of the file is its own payment. Two rows for one paper are two payments.
    items: list[dict[str, Any]] = []
    occurrence: dict[str, int] = defaultdict(int)
    for row in rows:
        title_key = normalize_title(row["title"])[:512]
        if not title_key:
            counts["skipped_no_title"] += 1
            continue
        who = staff_key(row["staff_id"])
        rkey = _row_key(row, who, title_key)
        occurrence[rkey] += 1
        if occurrence[rkey] > 1:  # the file lists the very same row again: a further payment, not the first
            rkey = f"{rkey}#{occurrence[rkey]}"
        money = row["amount_ok"] and row["amount"] is not None and not _is_zero_row(row)
        items.append({"row": row, "title_key": title_key, "who": who, "doi": row["doi"],
                      "key": _ledger_key(rkey), "money": money, "entry": None})

    history.claim({it["key"] for it in items})
    for it in items:
        it["entry"] = history.exact(it["key"])

    # A row whose record is older than this importer's keys: one record answers one row.
    # Same month and amount, then same month, then same amount, then any that is left.
    tests = (
        lambda e, r: e.month == _first(r["month"]) and e.amount is not None and _same_amount(e.amount, r["amount"]),
        lambda e, r: e.month == _first(r["month"]),
        lambda e, r: e.amount is not None and _same_amount(e.amount, r["amount"]),
        lambda e, r: True,
    )
    for test in tests:
        for it in items:
            if it["entry"] is not None or not it["money"]:
                continue
            for e in history.pool(it["who"], it["title_key"], it["doi"]):
                if not e.used and not _zero_claim(e) and test(e, it["row"]):
                    e.used = True
                    it["entry"] = e
                    break

    # The sheet is the record of what was paid. An app claim marked paid at nothing, which
    # is the only record of the person's paper, gets the sheet's payment as its own.
    for it in items:
        if it["entry"] is not None or not it["money"] or not it["row"]["month"] or it["row"]["amount"] <= 0:
            continue
        for e in history.pool(it["who"], it["title_key"], it["doi"]):
            if not e.used and _zero_claim(e):
                e.used = True
                it["entry"], it["zero_claim"] = e, e
                break

    for it in items:
        row, who, title_key, doi, entry = it["row"], it["who"], it["title_key"], it["doi"], it["entry"]
        month_text = row["month"].isoformat() if row["month"] else None
        if it.get("zero_claim") is not None:
            kind = "claim_at_zero"
            claim_rows.append({
                "ticket": entry.ticket, "staff_id": row["staff_id"], "name": row["name"], "title": row["title"],
                "amount": row["amount"], "month": month_text,
            })
        elif entry is not None:
            kind = "already_recorded"
            if it["money"] and entry.amount is not None and not _same_amount(entry.amount, row["amount"]):
                kind = "amount_differs"
                differs.append({
                    "staff_id": row["staff_id"], "name": row["name"], "title": row["title"],
                    "ledger_amount": entry.amount, "file_amount": row["amount"], "month": month_text,
                })
        elif it["money"]:
            kind = "new"
        else:
            seen = history.seen(who, title_key, doi)
            if seen and not row["amount_ok"] and not _is_zero_row(row) and not history.seen(
                who, title_key, doi, (history.ledger, history.added)
            ):
                # An earlier import kept only an earlier-payments note for a blank amount, so the
                # paper never counted as settled. Record it on the ledger now (the note stays as it is).
                seen, it["prior_exists"] = [], True
            if seen:
                kind = "already_recorded"
                if row["amount_ok"] and row["amount"] is not None:
                    paid = [e.amount for e in seen if e.amount is not None]
                    if paid and not any(_same_amount(a, row["amount"]) for a in paid):
                        kind = "amount_differs"
                        differs.append({
                            "staff_id": row["staff_id"], "name": row["name"], "title": row["title"],
                            "ledger_amount": paid[0], "file_amount": row["amount"], "month": month_text,
                        })
            else:
                kind = "zero_amount" if _is_zero_row(row) else "new"
        counts[kind] += 1

        # The old bulk ERP import stamped its claims with the day it ran. The sheet says when each
        # was really paid, and that month is what the monthly and yearly boards must read.
        if row["month"]:
            # Every bulk-imported claim of this person's paper, not only the one that answered the row:
            # the same paper may also sit on the ledger from the older history, with the claim beside it.
            held = {e.claim_id: e for e in history.ledger.by_paper(who, title_key, doi) if e.claim_id}
            if entry is not None and entry.claim_id:
                held[entry.claim_id] = entry
            for claim_id, e in held.items():
                c = history.claim_by_id.get(claim_id)
                if (claim_id not in corrections and c and (c["ticket_number"] or "").startswith(BULK_PREFIX)
                        and (c["month"] != row["month"] or e.month != row["month"])):
                    corrections[claim_id] = {
                        "ticket": c["ticket_number"], "staff_id": row["staff_id"], "name": row["name"],
                        "title": row["title"], "from_month": c["month"].isoformat() if c["month"] else None,
                        "to_month": row["month"].isoformat(),
                    }

        if kind in ("new", "zero_amount", "claim_at_zero"):
            if kind != "claim_at_zero" and who not in known_staff:
                counts["unmatched_staff"] += 1
                if len(unmatched) < MAX_UNMATCHED_ROWS:
                    unmatched.setdefault(row["staff_id"], {"staff_id": row["staff_id"], "name": row["name"]})
            amount = 0.0 if kind == "zero_amount" else row["amount"]
            blank = kind == "new" and not row["amount_ok"]
            if blank:
                # A settled paper whose amount the sheet leaves blank still counts as settled, at nothing.
                counts["unparseable_amount"] += 1
                amount = 0.0
                blank_rows.append({
                    "staff_id": row["staff_id"], "name": row["name"], "title": row["title"],
                    "month": month_text, "in_sheet": str(row["raw"].get("Amount") or "") or None,
                })
            bucket = by_month.setdefault(row["month"].strftime("%Y-%m") if row["month"] else "", {"new": 0, "amount": 0.0})
            bucket["new"] += 1
            bucket["amount"] += amount or 0.0
            new_total += amount or 0.0
            to_write.append({**row, "amount": amount, "who": who, "title_key": title_key, "key": it["key"],
                             "blank": blank, "claim_id": entry.claim_id if kind == "claim_at_zero" else None,
                             "prior_exists": bool(it.get("prior_exists"))})
            history.note(who, title_key, doi, amount, row["month"])

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
            _correct_months(corrections, actor, filename)

    # Every difference is noted, however many the report lists.
    note_conflicts("amount", differs, filename)

    # A paper paid more than once is recorded and flagged, never hidden. A check
    # lists what the import would add to what the ledger already holds.
    pending = [
        {"staff_id": r["staff_id"], "name": r["name"], "title": r["title"], "doi": r["doi"],
         "month": r["month"], "amount": r["amount"]}
        for r in to_write if r["month"] and r["amount"]
    ] if dry_run else []
    twice = find_double_payments(pending)
    not_in_sheet = _not_in_sheet(history, items)
    if not dry_run:
        note_conflicts(DOUBLE, twice, filename)

    return {
        "dry_run": dry_run,
        "rows": len(rows),
        "claim_payments_from_sheet": {
            "count": len(claim_rows), "total_amount": round(sum(r["amount"] for r in claim_rows), 2),
            "rows": claim_rows[:MAX_DOUBLE_ROWS],
        },
        "blank_amounts": {"count": len(blank_rows), "rows": blank_rows[:MAX_DOUBLE_ROWS]},
        "payment_months_corrected": {
            "count": len(corrections), "rows": list(corrections.values())[:MAX_DOUBLE_ROWS],
        },
        "paid_in_app_not_in_sheet": not_in_sheet,
        "counts": counts,
        "new_total_amount": round(new_total, 2),
        "by_month": [{"month": m, "new": v["new"], "amount": round(v["amount"], 2)} for m, v in sorted(by_month.items())],
        "amount_differs": differs[:MAX_AMOUNT_ROWS],
        "unmatched_staff": list(unmatched.values()),
        "double_payments": {
            "count": len(twice),
            "total_amount": round(sum(d["total"] for d in twice), 2),
            "rows": twice[:MAX_DOUBLE_ROWS],
        },
    }


def _not_in_sheet(history: _History, items: list[dict[str, Any]]) -> dict[str, Any]:
    """Claims the app holds as paid (at any amount, even nothing) that the sheet does not list for that person.
    Nothing is changed; the office looks at each. Only months the sheet covers are looked at."""
    months = [it["row"]["month"] for it in items if it["row"]["month"]]
    if not months:
        return {"count": 0, "total_amount": 0.0, "rows": []}
    lo, hi = min(months), max(months)
    listed = {(it["who"], it["title_key"]) for it in items}
    listed_doi = {(it["who"], it["doi"]) for it in items if it["doi"]}
    under: dict[str, set[str]] = defaultdict(set)
    for it in items:
        under[it["title_key"]].add(it["row"]["staff_id"])
    out = []
    for c in history.paid_claims:
        money = history.claim_amount.get(c["id"], 0.0)
        if not c["month"] or not lo <= c["month"] <= hi:
            continue
        if (c["who"], c["title"]) in listed or (c["doi_n"] and (c["who"], c["doi_n"]) in listed_doi):
            continue
        others = sorted(x for x in under.get(c["title"], ()) if staff_key(x) != c["who"])
        out.append({
            "ticket": c["ticket_number"], "staff_id": c["owner__staff_id"] or "", "name": c["owner__name"] or "",
            "title": c["paper_title"] or "", "amount": round(money, 2), "month": c["month"].isoformat(),
            "listed_under": others,
        })
    out.sort(key=lambda r: (r["month"], r["staff_id"], r["title"]))
    return {"count": len(out), "total_amount": round(sum(r["amount"] for r in out), 2), "rows": out[:MAX_DOUBLE_ROWS]}


def _correct_months(corrections: dict[str, dict[str, Any]], actor: User | None, filename: str) -> None:
    """Set a bulk-imported claim's paid month (and its ledger rows') to the sheet's month.

    Only claims whose ticket marks them as made by the old bulk import; a claim paid through the
    app's own payment flow is never touched. The old value stays in each ledger row's raw data and
    in an audit entry. No amount changes."""
    if not corrections:
        return
    from core.models import AuditLog
    from core.services.aggregate_cache import bump

    now = timezone.now()
    for claim_id, c in corrections.items():
        claim = Claim.objects.filter(pk=claim_id, ticket_number__startswith=BULK_PREFIX).first()
        if claim is None:
            continue
        to = dt.date.fromisoformat(c["to_month"])
        old_paid_at = claim.paid_at
        old_month = claim.payout_month
        Claim.objects.filter(pk=claim.pk).update(
            payout_month=to, paid_at=timezone.make_aware(dt.datetime.combine(to, dt.time())),
        )
        moved = []
        for row in PaidLedger.objects.filter(claim=claim).exclude(payout_month=to):
            try:
                raw = json.loads(row.raw_json) if row.raw_json else {}
                if not isinstance(raw, dict):
                    raise ValueError
            except ValueError:
                raw = {"previous_raw_json": row.raw_json}
            raw.setdefault("month_history", []).append({
                "from": row.payout_month.isoformat(), "to": to.isoformat(), "at": now.isoformat(),
                "source": "settled_claims_import", "file": filename[:120],
            })
            moved.append({"ledger": row.id, "from": row.payout_month.isoformat(), "amount": row.amount})
            PaidLedger.objects.filter(pk=row.pk).update(payout_month=to, raw_json=json.dumps(raw, ensure_ascii=False))
        AuditLog.objects.create(
            actor=actor, action="CLAIM_PAID_MONTH_CORRECTED", entity="Claim", entity_id=claim.pk,
            detail_json=json.dumps({
                "ticket": claim.ticket_number, "file": filename[:120],
                "before": {"payout_month": old_month.isoformat() if old_month else None,
                           "paid_at": old_paid_at.isoformat() if old_paid_at else None},
                "after": {"payout_month": to.isoformat()}, "ledger_rows": moved,
            }),
        )
    bump()


def _write(to_write: list[dict[str, Any]], fills: list[tuple[str, str]], actor: User | None, filename: str) -> None:
    if to_write:
        batch = PriorImport.objects.create(
            filename=filename[:255], row_count=len(to_write), mapping_json="{}",
            imported_by=actor or User.objects.order_by("created_at").first(),
        )
        ledgers, priors = [], []
        from core.services.payment_guards import current_cycle

        claims = Claim.objects.in_bulk([r["claim_id"] for r in to_write if r.get("claim_id")])
        for r in to_write:
            amount = r["amount"]
            paid_at = None
            if r["month"]:
                paid_at = timezone.make_aware(dt.datetime.combine(r["month"], dt.time()))
            raw = json.dumps(
                {"row_key": r["key"], **{k: (str(v)[:500] if v is not None else None) for k, v in r["raw"].items()},
                 "source": "settled_claims_import",
                 **({"claim_ticket": claims[r["claim_id"]].ticket_number} if r.get("claim_id") in claims else {}),
                 **({"amount_blank_in_sheet": True} if r.get("blank") else {})},
                ensure_ascii=False,
            )[:20000]
            (priors if not r.get("prior_exists") else []).append(PriorPayment(
                faculty_name=r["name"] or None, employee_id=r["staff_id"] or None, paper_title=r["title"],
                normalized_title=r["title_key"], doi=r["doi"] or None, issn=r["issn"] or None,
                journal_title=r["journal"] or None,
                publication_year=r["pub_date"].year if r["pub_date"] else None,
                amount_paid=None if r.get("blank") else r["amount"], paid_at=paid_at, claim_ref=r["sno"] or None,
                raw_json=raw, import_batch=batch,
            ))
            # Money is written only for a row with a month and a figure.
            if r["month"] and r["amount"] is not None:
                claim, kind, cycle = claims.get(r.get("claim_id")), PaidLedger.Kind.PAYMENT, 1
                if claim is not None:
                    # The claim's own payment, as the app files a payment that arrives later: a
                    # correction when the claim already has one (at nothing) in this cycle.
                    cycle = current_cycle(claim)
                    if claim.ledger_rows.filter(kind=PaidLedger.Kind.PAYMENT, cycle=cycle).exists():
                        kind = PaidLedger.Kind.ADJUSTMENT
                ledgers.append(PaidLedger(
                    claim=claim, kind=kind, cycle=cycle,
                    idempotency_key=r["key"],
                    payout_month=r["month"], department=r["department"] or None,
                    faculty_name=r["name"] or None, staff_id=r["staff_id"] or None,
                    biometric_id=r["bio_id"] or None, paper_title=r["title"],
                    journal_title=r["journal"] or None, amount=r["amount"], raw_json=raw,
                ))
        PriorPayment.objects.bulk_create(priors, batch_size=500)
        PaidLedger.objects.bulk_create(ledgers, batch_size=500)
    for pk, doi in fills:
        Publication.objects.filter(pk=pk).update(doi=doi)
