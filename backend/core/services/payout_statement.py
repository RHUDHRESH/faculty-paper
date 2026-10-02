"""One payout month, as the Director signs it and Finance reconciles it.

Every figure is read from the ledger (`college_totals.payments` for the total,
the same rows for the detail), so the statement, the Ledger screen and
Reports can never disagree about a month. Paid claims that have no ledger row
at all (older data) are counted as `college_totals` counts them.

Nothing here reads or returns a flag: the Director and Finance are the
readers, and they are never shown one (core.visibility).
"""
from __future__ import annotations

from core.services.cell_safe import csv_writer
import csv
import io
from collections import defaultdict
from datetime import date
from typing import Any, Optional

from django.db.models import Sum

from core.models import Budget, Claim, ClaimStatus, PaidLedger
from core.services import college_totals, institution
from core.services.record_dates import ledger_month_recorded

_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
         "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
         "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    return _ONES[n] if n < 20 else (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else ""))


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    parts = [f"{_ONES[h]} Hundred"] if h else []
    if r:
        parts.append(_two(r))
    return " ".join(parts)


def rupees_in_words(amount: float) -> str:
    """Indian system: 3,15,370 -> "Rupees Three Lakh Fifteen Thousand Three Hundred Seventy only"."""
    neg = amount < 0
    paise = round(abs(amount) * 100)
    n, p = divmod(paise, 100)
    if n == 0 and p == 0:
        return "Rupees Zero only"
    parts = []
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1000)
    if crore:
        parts.append(f"{rupees_in_words(crore)[7:-5]} Crore" if crore >= 100 else f"{_two(crore)} Crore")
    if lakh:
        parts.append(f"{_two(lakh)} Lakh")
    if thousand:
        parts.append(f"{_two(thousand)} Thousand")
    if n:
        parts.append(_three(n))
    words = "Rupees " + " ".join(parts) if parts else "Rupees Zero"
    if p:
        words += f" and {_two(p)} Paise"
    return ("Minus " if neg else "") + words + " only"


def inr(amount: float) -> str:
    """₹ with Indian digit grouping: 1234567.5 -> "₹12,34,567.50"."""
    neg = amount < 0
    whole, frac = f"{abs(amount):.2f}".split(".")
    head, tail = whole[:-3], whole[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    body = ",".join(groups + [tail]) if groups else tail
    return f"{'-' if neg else ''}₹{body}" + (f".{frac}" if frac != "00" else "")


def _parse_month(month: str) -> date:
    y, m = (int(p) for p in month.split("-", 1))
    return date(y, m, 1)


def label_of(month: str) -> str:
    """"2026-04" as "April 2026"."""
    return _parse_month(month).strftime("%B %Y")


def month_rows(month: str) -> list[dict[str, Any]]:
    """Every payment of the month once, ledger first, then unledgered paid claims."""
    d = _parse_month(month)
    out: list[dict[str, Any]] = []
    ledger = (PaidLedger.objects.filter(payout_month__year=d.year, payout_month__month=d.month)
              .select_related("claim", "claim__owner").order_by("department", "faculty_name", "id"))
    for r in ledger:
        c = r.claim
        out.append({
            "source": "app" if c else "import",
            "ledger_id": r.id,
            "claim_id": r.claim_id,
            "ticket": c.ticket_number if c else None,
            "staff_id": r.staff_id or (c.owner.staff_id if c else None),
            "name": (c.owner.name if c else None) or r.faculty_name or "",
            "department": college_totals._dept((c.owner.department if c else None) or r.department),
            "paper_title": r.paper_title or (c.paper_title if c else "") or "",
            "journal": r.journal_title or "",
            "voucher": r.voucher_number or (c.voucher_number if c else None),
            "amount": float(r.amount or 0),
            "authorised_on": c.director_approved_at.date().isoformat() if c and c.director_approved_at else None,
            "paid_on": c.paid_at.date().isoformat() if c and c.paid_at else None,
            "month_recorded": ledger_month_recorded(r.raw_json),
            # What the research threshold kept back from this claim, so the
            # signer sees why a paper is worth less than the policy says.
            "held_back": round(float(c.research_absorbed or 0), 2) if c else 0.0,
        })
    orphans = (Claim.objects.filter(status=ClaimStatus.PAID, ledger_rows__isnull=True,
                                    payout_month__year=d.year, payout_month__month=d.month)
               .select_related("owner"))
    for c in orphans:
        out.append({
            "source": "claim_only", "ledger_id": None, "claim_id": c.id, "ticket": c.ticket_number,
            "staff_id": c.staff_id or c.owner.staff_id, "name": c.owner.name,
            "department": college_totals._dept(c.owner.department),
            "paper_title": c.paper_title or "", "journal": c.journal_title or "",
            "voucher": c.voucher_number, "amount": float(c.remuneration or 0),
            "authorised_on": c.director_approved_at.date().isoformat() if c.director_approved_at else None,
            "paid_on": c.paid_at.date().isoformat() if c.paid_at else None,
            "month_recorded": True,
            "held_back": round(float(c.research_absorbed or 0), 2),
        })
    return out


def reconcile(month: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Does every paid ticket of the month have its ledger row, for the same amount?"""
    d = _parse_month(month)
    by_claim: dict[str, float] = defaultdict(float)
    for r in rows:
        if r["source"] == "app":
            by_claim[r["claim_id"]] += r["amount"]
    claims = {c.id: c for c in Claim.objects.filter(id__in=list(by_claim)).only(
        "id", "status", "remuneration", "ticket_number")}
    paid_here = Claim.objects.filter(status=ClaimStatus.PAID, payout_month__year=d.year,
                                     payout_month__month=d.month)
    matched, issues = 0, []
    for cid, net in by_claim.items():
        c = claims.get(cid)
        if c is None:
            continue
        if c.status == ClaimStatus.PAID and abs(net - (c.remuneration or 0)) < 0.5:
            matched += 1
        elif c.status != ClaimStatus.PAID and abs(net) < 0.5:
            continue  # paid then voided: the reversing row nets it to zero
        else:
            issues.append({"ticket": c.ticket_number, "claim_id": cid,
                           "ledger": round(net, 2), "claim": round(c.remuneration or 0, 2),
                           "problem": "Ledger and ticket amounts differ" if c.status == ClaimStatus.PAID
                           else "Ledger shows money out, but the ticket is not paid"})
    for c in paid_here.exclude(id__in=list(by_claim)).filter(ledger_rows__isnull=False):
        issues.append({"ticket": c.ticket_number, "claim_id": c.id, "ledger": 0,
                       "claim": round(c.remuneration or 0, 2),
                       "problem": "Paid in this month, but its ledger row is filed under another month"})
    orphans = [r for r in rows if r["source"] == "claim_only"]
    for r in orphans:
        issues.append({"ticket": r["ticket"], "claim_id": r["claim_id"], "ledger": 0,
                       "claim": r["amount"], "problem": "Paid ticket with no ledger row"})
    imported = [r for r in rows if r["source"] == "import"]
    reversals = [r for r in rows if r["amount"] < 0]
    return {
        "app_tickets": len(by_claim),
        "matched": matched,
        "imported": {"count": len(imported), "amount": round(sum(r["amount"] for r in imported), 2)},
        "reversals": {"count": len(reversals), "amount": round(sum(r["amount"] for r in reversals), 2)},
        "month_not_recorded": sum(1 for r in rows if not r["month_recorded"]),
        "issues": issues,
        "balanced": not issues,
    }


def _counts_as_payment(amount: float) -> int:
    """How a ledger row moves the count of payments, the way `/reports` counts.

    A research-quota paper is paid at ₹0: it is settled, it has a voucher and a
    ledger row, but no money went to anybody, the bank file leaves it out, and
    Reports does not count it. A void's reversing row cancels the payment it
    reverses. The statement called the same month "5 payments to 2 people"
    where the bank file and Reports said 3.
    """
    return 1 if amount > 0.005 else -1 if amount < -0.005 else 0


def statement(month: str) -> dict[str, Any]:
    rows = month_rows(month)
    total = round(sum(r["amount"] for r in rows), 2)
    # The ledger's own figure for the month, as every other screen reads it.
    ledger_total = round(sum(p["amount"] for p in college_totals.payments(month=month)), 2)
    depts: dict[str, list[float]] = defaultdict(lambda: [0.0, 0])
    net_by_person: dict[str, float] = defaultdict(float)
    for r in rows:
        depts[r["department"]][0] += r["amount"]
        depts[r["department"]][1] += _counts_as_payment(r["amount"])
        net_by_person[(r["staff_id"] or r["name"]).strip().casefold()] += r["amount"]
    people = {k for k, v in net_by_person.items() if v > 0.005}
    d = _parse_month(month)
    return {
        "month": month,
        "label": d.strftime("%B %Y"),
        "college": institution.get("college_name"),
        "count": sum(_counts_as_payment(r["amount"]) for r in rows),
        "people": len(people),
        "total": total,
        "ledger_total": ledger_total,
        "total_in_words": rupees_in_words(total),
        "by_department": [{"department": k, "amount": round(v[0], 2), "count": v[1]}
                          for k, v in sorted(depts.items(), key=lambda kv: -kv[1][0])],
        "rows": rows,
        "reconciliation": reconcile(month, rows),
    }


def months() -> list[dict[str, Any]]:
    """Every payout month, newest first, with its ledger total."""
    sums: dict[str, list[float]] = defaultdict(lambda: [0.0, 0])
    for p in college_totals.payments():
        if p["month"]:
            k = p["month"].strftime("%Y-%m")
            sums[k][0] += p["amount"]
            sums[k][1] += _counts_as_payment(p["amount"])
    return [{"month": k, "label": _parse_month(k).strftime("%b %Y"),
             "amount": round(sums[k][0], 2), "count": int(sums[k][1])}
            for k in college_totals.payout_months()]


def financial_year(fy: Optional[str] = None) -> dict[str, Any]:
    """Month by month spend from April to March against the college allocation."""
    from core.api.budget import financial_year_of, _fy_bounds

    fy = fy or financial_year_of(date.today())
    start, _end = _fy_bounds(fy)
    per: dict[str, float] = defaultdict(float)
    for p in college_totals.payments():
        m = p["month"]
        if m and start <= m <= _end:
            per[m.strftime("%Y-%m")] += p["amount"]
    out, running = [], 0.0
    for i in range(12):
        y, mo = start.year + (start.month - 1 + i) // 12, (start.month - 1 + i) % 12 + 1
        k = f"{y}-{mo:02d}"
        running += per.get(k, 0.0)
        out.append({"month": k, "label": date(y, mo, 1).strftime("%b"),
                    "amount": round(per.get(k, 0.0), 2), "cumulative": round(running, 2)})
    alloc = Budget.objects.filter(financial_year=fy, department__isnull=True).aggregate(s=Sum("amount"))["s"]
    # The Budget page's rule, so the two screens agree: owed from clearing on.
    committed = Claim.objects.filter(
        status__in=[ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED]
    ).aggregate(s=Sum("remuneration"))["s"] or 0
    return {"financial_year": fy, "allocation": alloc, "paid": round(running, 2),
            "committed": round(committed, 2), "months": out}


BANK_HEADER = ["Sl No", "Payment type", "Beneficiary name", "Staff id", "Department",
               "Beneficiary account number", "IFSC", "Amount", "Voucher", "Narration"]


def bank_lines(st: dict[str, Any]) -> list[dict[str, Any]]:
    """The statement rows that go in the bank file: money owed, once each."""
    # A ticket paid and voided in the same month nets to nothing: nobody is owed it.
    net: dict[str, float] = defaultdict(float)
    for r in st["rows"]:
        if r["claim_id"]:
            net[r["claim_id"]] += r["amount"]
    return [r for r in st["rows"]
            if not (r["amount"] <= 0 or (r["claim_id"] and net[r["claim_id"]] <= 0.5))]


def bank_csv(st: dict[str, Any], lines: list[dict[str, Any]] | None = None) -> bytes:
    """One row per payment of the month, shaped for a bulk NEFT or payroll import.

    The app holds no bank details, so account number and IFSC are left for
    Accounts to fill from the payroll master. Reversals, and the payments they
    reverse, are left out (together they move no money) and stay listed in
    the statement instead. `lines` narrows the file to some of those rows
    (a re-export of only what has not gone to the bank yet).
    """
    buf = io.StringIO()
    w = csv_writer(buf)
    w.writerow(BANK_HEADER)
    n = 0
    total = 0.0
    for r in (bank_lines(st) if lines is None else lines):
        n += 1
        total += r["amount"]
        ref = r["ticket"] or r["voucher"] or ""
        w.writerow([n, "NEFT", r["name"], r["staff_id"] or "", r["department"], "", "",
                    f"{r['amount']:.2f}", r["voucher"] or "",
                    f"Research incentive {st['label']} {ref}".strip()[:140]])
    w.writerow([])
    w.writerow(["", "", "Total", "", "", "", "", f"{total:.2f}", "", f"{n} payments"])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def pdf(st: dict[str, Any], prepared_by: str) -> bytes:
    """The month's payment statement as a document a Director signs (A4, portrait).

    Set the way the college's own pages are: Brygada 1918 for the month and the
    figures, Inter for everything a person reads across, ink on white paper, one
    hairline between rows and nothing banded. The page says the one thing first
    (the month, the total in figures and in words, how many people), then the
    payments, the departments, whether the ledger agrees, and the three
    signatures, which never split from the total across a page.
    """
    from datetime import datetime
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.platypus import (
        BaseDocTemplate, Frame, Image, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    )

    from core.services import pdf_fonts as F

    F.register_brand()

    INK = colors.HexColor("#1B1F2E")
    MUTED = colors.HexColor("#55596B")
    HAIR = colors.HexColor("#DAD3C2")
    NAVY = colors.HexColor("#263050")
    RED = colors.HexColor("#B0233F")

    L = R = 18 * mm
    W = A4[0] - L - R

    def ps(name: str, **kw) -> ParagraphStyle:
        base = dict(fontName=F.INTER, fontSize=8.5, leading=11.5, textColor=INK, alignment=TA_LEFT)
        base.update(kw)
        return ParagraphStyle(name, **base)

    s_body = ps("body")
    s_muted = ps("muted", textColor=MUTED, fontSize=7.5, leading=10)
    s_label = ps("label", textColor=MUTED, fontSize=7.5, leading=10)
    s_head = ps("head", fontName=F.INTER_SEMI, fontSize=7.5, leading=10, textColor=MUTED)
    s_head_r = ps("headr", fontName=F.INTER_SEMI, fontSize=7.5, leading=10, textColor=MUTED, alignment=TA_RIGHT)
    s_name = ps("name", fontName=F.INTER_MEDIUM)
    s_amt = ps("amt", fontName=F.INTER_MEDIUM, alignment=TA_RIGHT)
    s_amt_neg = ps("amtneg", fontName=F.INTER_MEDIUM, alignment=TA_RIGHT, textColor=RED)
    s_amt_note = ps("amtnote", textColor=MUTED, fontSize=7, leading=9, alignment=TA_RIGHT)
    s_month = ps("month", fontName=F.BRYGADA, fontSize=30, leading=33, textColor=NAVY)
    s_figure = ps("figure", fontName=F.BRYGADA_MEDIUM, fontSize=26, leading=28)
    s_words = ps("words", fontName=F.BRYGADA_ITALIC, fontSize=10.5, leading=14, textColor=MUTED)
    s_h2 = ps("h2", fontName=F.BRYGADA_MEDIUM, fontSize=12, leading=15, spaceBefore=0, spaceAfter=0)
    s_college = ps("college", fontName=F.BRYGADA_MEDIUM, fontSize=13, leading=16, textColor=NAVY)
    s_kind = ps("kind", fontName=F.INTER_SEMI, fontSize=7.5, leading=10, textColor=MUTED, alignment=TA_RIGHT)
    s_total_l = ps("totall", fontName=F.INTER_SEMI, fontSize=9)
    s_total_r = ps("totalr", fontName=F.BRYGADA_MEDIUM, fontSize=15, leading=18, alignment=TA_RIGHT)
    s_sig = ps("sig", fontName=F.INTER_SEMI, fontSize=8, leading=10.5)
    s_sig_small = ps("sigs", textColor=MUTED, fontSize=7.5, leading=10)

    def money(v: float) -> str:
        return inr(v)

    def day(iso: Optional[str]) -> str:
        if not iso:
            return ""
        try:
            d = date.fromisoformat(iso[:10])
        except ValueError:
            return ""
        return f"{d.day} {d.strftime('%b')}"

    paid = [r for r in st["rows"] if abs(r["amount"]) > 0.005]
    closed = len(st["rows"]) - len(paid)
    depts = [d for d in st["by_department"] if abs(d["amount"]) > 0.005]
    rec = st["reconciliation"]
    agrees = rec["balanced"] and abs(st["total"] - st["ledger_total"]) < 0.5
    today = date.today()
    month_name = st["label"].split(" ")[0]
    year = st["label"].split(" ")[-1]

    class Numbered(rl_canvas.Canvas):
        """Two passes, so every page can say "Page 2 of 3"."""

        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._saved: list[dict] = []

        def showPage(self):
            self._saved.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved)
            for state in self._saved:
                self.__dict__.update(state)
                self._chrome(total)
                super().showPage()
            super().save()

        def _chrome(self, total: int):
            self.saveState()
            self.setStrokeColor(HAIR)
            self.setLineWidth(0.4)
            self.line(L, 13 * mm, A4[0] - R, 13 * mm)
            self.setFont(F.INTER, 7)
            self.setFillColor(MUTED)
            self.drawString(L, 9 * mm, f"{st['college']}  ·  Payment statement, {st['label']}  ·  Figures are read from the payments ledger")
            self.drawRightString(A4[0] - R, 9 * mm, f"Page {self._pageNumber} of {total}")
            if self._pageNumber > 1:
                self.setFont(F.INTER_MEDIUM, 7.5)
                self.drawString(L, A4[1] - 11 * mm, f"Payment statement, {st['label']}")
            self.restoreState()

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf, pagesize=A4, leftMargin=L, rightMargin=R, topMargin=16 * mm, bottomMargin=20 * mm,
        title=f"Payment statement {st['label']}", author=prepared_by or st["college"],
        subject="Research publication incentive: monthly payment statement",
    )
    frame = Frame(L, 20 * mm, W, A4[1] - 16 * mm - 20 * mm, leftPadding=0, rightPadding=0, topPadding=0,
                  bottomPadding=0, id="body")
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame])])

    # ---- the letterhead -------------------------------------------------
    emblem = F.FONT_DIR.parent / "brand" / "emblem.png"
    head_left: list[Any] = [Paragraph(escape(st["college"]), s_college),
                            Paragraph("Research publication incentive", s_label)]
    head = Table(
        [[Image(str(emblem), 11 * mm, 11 * mm) if emblem.exists() else "", head_left,
          [Paragraph("Payment statement", s_kind), Paragraph(f"No. {st['month']}", ps("no", textColor=MUTED, fontSize=7.5, alignment=TA_RIGHT))]]],
        colWidths=[15 * mm, W - 15 * mm - 50 * mm, 50 * mm],
    )
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))

    facts = f"{st['count']} {'payment' if st['count'] == 1 else 'payments'} to {st['people']} {'person' if st['people'] == 1 else 'people'}"
    if depts:
        facts += f"  ·  {len(depts)} {'department' if len(depts) == 1 else 'departments'}"
    facts += f"  ·  Prepared {today.day} {today.strftime('%B %Y')}" + (f" by {escape(prepared_by)}" if prepared_by else "")

    title = Table([[Paragraph(f"{month_name} <font color='#55596B'>{year}</font>", s_month)]], colWidths=[W])
    title.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))

    story: list[Any] = [
        head,
        Spacer(1, 5 * mm),
        Table([[""]], colWidths=[W], rowHeights=[0.1], style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.6, INK)])),
        Spacer(1, 5 * mm),
        title,
        Spacer(1, 6 * mm),
        Paragraph(escape(money(st["total"])), s_figure),
        Spacer(1, 1.5 * mm),
        Paragraph(escape(st["total_in_words"]), s_words),
        Spacer(1, 3.5 * mm),
        Paragraph(facts, ps("facts", textColor=MUTED, fontSize=8.5)),
        Spacer(1, 10 * mm),
    ]

    # ---- the payments ---------------------------------------------------
    cols = [7 * mm, 46 * mm, 56 * mm, 33 * mm, W - 142 * mm]
    data: list[list[Any]] = [[Paragraph("No.", s_head), Paragraph("Paid to", s_head), Paragraph("Paper", s_head),
                              Paragraph("Voucher", s_head), Paragraph("Amount", s_head_r)]]
    for i, r in enumerate(paid, 1):
        who = f"{escape(r['name'] or 'Name not recorded')}"
        sub = " · ".join(x for x in (r["staff_id"], r["department"]) if x)
        paper = escape(" ".join((r["paper_title"] or "Title not recorded").split()))
        meta = " · ".join(x for x in (r["ticket"], ("authorised " + day(r["authorised_on"])) if r["authorised_on"] else "") if x)
        amount: list[Any] = [Paragraph(escape(money(r["amount"])), s_amt_neg if r["amount"] < 0 else s_amt)]
        if (r.get("held_back") or 0) > 0.005:
            amount.append(Paragraph(escape(f"{money(r['held_back'])} held back by the research threshold"), s_amt_note))
        data.append([
            Paragraph(str(i), s_muted),
            [Paragraph(who, s_name), Paragraph(escape(sub), s_muted)] if sub else Paragraph(who, s_name),
            [Paragraph(paper, s_body), Paragraph(escape(meta), s_muted)] if meta else Paragraph(paper, s_body),
            Paragraph(escape(r["voucher"] or "None"), s_muted if not r["voucher"] else ps("v", fontSize=8, textColor=INK)),
            amount,
        ])
    if not paid:
        data.append(["", Paragraph("No money was paid this month.", s_muted), "", "", ""])
    # The total is the table's own last row, so it can never be left on a page
    # of its own: the last payment and the total are kept together.
    data.append(["", Paragraph("Total", s_total_l), "", "", Paragraph(escape(money(st["total"])), s_total_r)])
    t = Table(data, colWidths=cols, repeatRows=1)
    last = len(data) - 1
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (-1, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, INK),
        ("LINEBELOW", (0, 1), (-1, last - 2), 0.3, HAIR),
        ("LINEABOVE", (0, last), (-1, last), 0.8, INK),
        ("TOPPADDING", (0, 0), (-1, 0), 0), ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("TOPPADDING", (0, last), (-1, last), 7), ("VALIGN", (0, last), (-1, last), "BOTTOM"),
        ("NOSPLIT", (0, max(1, last - 1)), (-1, last)),
    ]))
    story.append(Paragraph("Payments", s_h2))
    story.append(Spacer(1, 3 * mm))
    story.append(t)
    if closed:
        story.append(Spacer(1, 2.5 * mm))
        story.append(Paragraph(
            f"{closed} {'claim' if closed == 1 else 'claims'} closed at ₹0 {'is' if closed == 1 else 'are'} not listed: nothing was paid and "
            "none is in the bank file.", s_muted))
    story.append(Spacer(1, 12 * mm))
    # What the signatures cover, stated beside them, so the sheet that is
    # signed carries the total even when the payments run over two pages.
    closing: list[Any] = [
        Paragraph(
            f"<font name='{F.INTER_SEMI}'>{escape(money(st['total']))}</font> ({escape(st['total_in_words'])}) in "
            f"{st['count']} {'payment' if st['count'] == 1 else 'payments'} to {st['people']} {'person' if st['people'] == 1 else 'people'}, "
            f"as listed above.", ps("covers", fontSize=9, leading=13)),
        Spacer(1, 5 * mm),
    ]

    # ---- by department, and the ledger ---------------------------------
    dd: list[list[Any]] = [[Paragraph("Department", s_head), Paragraph("Payments", s_head_r), Paragraph("Amount", s_head_r)]]
    for d in depts:
        dd.append([Paragraph(escape(d["department"]), s_body), Paragraph(str(d["count"]), ps("c", alignment=TA_RIGHT)),
                   Paragraph(escape(money(d["amount"])), ps("d", fontName=F.INTER_MEDIUM, alignment=TA_RIGHT))])
    half = (W - 10 * mm) / 2
    dt = Table(dd, colWidths=[half - 46 * mm, 16 * mm, 30 * mm], hAlign="LEFT")
    dt.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, INK), ("LINEBELOW", (0, 1), (-1, -1), 0.3, HAIR),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))

    ledger_lines: list[list[Any]] = [
        [Paragraph("Claims paid here", s_label), Paragraph(f"{rec['matched']} of {rec['app_tickets']} have one ledger row for the same amount", s_body)],
    ] if rec["app_tickets"] else []
    ledger_lines += [
        [Paragraph("From the old ERP", s_label), Paragraph(f"{escape(money(rec['imported']['amount']))} in {rec['imported']['count']} {'row' if rec['imported']['count'] == 1 else 'rows'}", s_body)],
        [Paragraph("Reversed", s_label), Paragraph(f"{escape(money(rec['reversals']['amount']))} in {rec['reversals']['count']} voided {'payment' if rec['reversals']['count'] == 1 else 'payments'}", s_body)],
        [Paragraph("Ledger total", s_label), Paragraph(f"{escape(money(st['ledger_total']))}", s_body)],
    ]
    lt = Table(ledger_lines, colWidths=[26 * mm, half - 26 * mm])
    lt.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, HAIR), ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    verdict = (
        Paragraph("<font name='" + F.INTER_SEMI + "'>Agrees with the ledger.</font> Every claim paid this month has one ledger row for the same amount.", ps("ok", fontSize=8.5, leading=12))
        if agrees
        else Paragraph(
            f"<font name='{F.INTER_SEMI}' color='#B0233F'>{len(rec['issues'])} {'line' if len(rec['issues']) == 1 else 'lines'} to explain before this is signed:</font> "
            + escape("; ".join(f"{i['ticket'] or 'a claim'}: {i['problem'].lower()}" for i in rec["issues"][:6])),
            ps("bad", fontSize=8.5, leading=12),
        )
    )
    two = Table(
        [[[Paragraph("By department", s_h2), Spacer(1, 3 * mm), dt],
          [Paragraph("Against the ledger", s_h2), Spacer(1, 3 * mm), lt, Spacer(1, 3 * mm), verdict]]],
        colWidths=[half + 10 * mm, half], hAlign="LEFT",
    )
    two.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                             ("RIGHTPADDING", (0, 0), (0, 0), 10 * mm), ("RIGHTPADDING", (1, 0), (1, 0), 0),
                             ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    story.append(KeepTogether([two]))
    story.append(Spacer(1, 9 * mm))

    # ---- the signatures -------------------------------------------------
    col = (W - 2 * 6 * mm) / 3
    sig = Table(
        [
            ["", "", "", "", ""],
            [Paragraph("Prepared by", s_sig), "", Paragraph("Authorised by", s_sig), "", Paragraph("Approved by", s_sig)],
            [Paragraph("Finance" if not prepared_by else f"Finance · {escape(prepared_by)}", s_sig_small), "",
             Paragraph("Director", s_sig_small), "", Paragraph("Principal", s_sig_small)],
            [Paragraph("Date", s_sig_small), "", Paragraph("Date", s_sig_small), "", Paragraph("Date", s_sig_small)],
        ],
        colWidths=[col, 6 * mm, col, 6 * mm, col], rowHeights=[13 * mm, None, None, 8 * mm],
    )
    sig.setStyle(TableStyle([
        ("LINEABOVE", (0, 1), (0, 1), 0.7, INK), ("LINEABOVE", (2, 1), (2, 1), 0.7, INK), ("LINEABOVE", (4, 1), (4, 1), 0.7, INK),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 1), (-1, 1), 4), ("TOPPADDING", (0, 2), (-1, 2), 1), ("TOPPADDING", (0, 3), (-1, 3), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 3), (0, 3), 0.3, HAIR), ("LINEBELOW", (2, 3), (2, 3), 0.3, HAIR), ("LINEBELOW", (4, 3), (4, 3), 0.3, HAIR),
    ]))
    story.append(KeepTogether(closing + [sig]))

    doc.build(story, canvasmaker=Numbered)
    return buf.getvalue()
