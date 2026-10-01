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


def bank_csv(st: dict[str, Any]) -> bytes:
    """One row per payment of the month, shaped for a bulk NEFT or payroll import.

    The app holds no bank details, so account number and IFSC are left for
    Accounts to fill from the payroll master. Reversals, and the payments they
    reverse, are left out (together they move no money) and stay listed in
    the statement instead.
    """
    buf = io.StringIO()
    w = csv_writer(buf)
    w.writerow(BANK_HEADER)
    # A ticket paid and voided in the same month nets to nothing: nobody is owed it.
    net: dict[str, float] = defaultdict(float)
    for r in st["rows"]:
        if r["claim_id"]:
            net[r["claim_id"]] += r["amount"]
    n = 0
    total = 0.0
    for r in st["rows"]:
        if r["amount"] <= 0 or (r["claim_id"] and net[r["claim_id"]] <= 0.5):
            continue
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
    """A4 portrait: college header, month, rows, department subtotals, total, signatures."""
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    from core.services import pdf_fonts

    SANS, SANS_BOLD = pdf_fonts.register()  # DejaVu Sans prints a real rupee sign

    def money(v: float) -> str:
        return inr(v)

    ss = getSampleStyleSheet()
    normal = ParagraphStyle("n", parent=ss["Normal"], fontName=SANS, fontSize=9.5, leading=12)
    small = ParagraphStyle("s", parent=normal, fontSize=7.5, leading=9.5)
    head = ParagraphStyle("h", parent=ss["Title"], fontName=SANS_BOLD, fontSize=15, spaceAfter=2)
    sub = ParagraphStyle("u", parent=normal, fontSize=10, alignment=1)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=16 * mm,
                            title=f"Payout statement {st['label']}")
    story: list[Any] = [
        Paragraph(st["college"], head),
        Paragraph("Research publication incentive: monthly payout statement", sub),
        Paragraph(f"<b>{st['label']}</b> &nbsp; {st['count']} payments to {st['people']} people"
                  + (f" &nbsp;·&nbsp; {len(st['rows'])} ledger rows listed, including ₹0 settlements"
                     if len(st["rows"]) != st["count"] else ""), sub),
        Spacer(1, 6 * mm),
    ]
    data = [["#", "Staff id", "Name", "Dept", "Paper", "Voucher", "Amount"]]
    for i, r in enumerate(st["rows"], 1):
        data.append([str(i), r["staff_id"] or "", Paragraph(escape(r["name"] or ""), small),
                     Paragraph(escape(r["department"] or ""), small),
                     Paragraph(escape(r["paper_title"] or ""), small), Paragraph(escape(r["voucher"] or ""), small),
                     money(r["amount"])])
    data.append(["", "", "", "", "Total", "", money(st["total"])])
    t = Table(data, colWidths=[8 * mm, 17 * mm, 30 * mm, 18 * mm, 69 * mm, 18 * mm, 22 * mm],
              repeatRows=1)
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), SANS_BOLD, 7.5), ("FONT", (0, 1), (-1, -1), SANS, 7.5),
        ("FONT", (0, -1), (-1, -1), SANS_BOLD, 9),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#efe9df")),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#cfc6b8")),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.black),
        ("ALIGN", (-1, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story += [t, Spacer(1, 5 * mm)]
    dd = [["Department", "Payments", "Amount"]] + [
        [d["department"], str(d["count"]), money(d["amount"])] for d in st["by_department"]
    ] + [["All departments", str(st["count"]), money(st["total"])]]
    dt = Table(dd, colWidths=[60 * mm, 25 * mm, 35 * mm], hAlign="LEFT")
    dt.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), SANS, 8.5), ("FONT", (0, 0), (-1, 0), SANS_BOLD, 8.5),
        ("FONT", (0, -1), (-1, -1), SANS_BOLD, 8.5),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.black),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]))
    rec = st["reconciliation"]
    tail: list[Any] = [dt, Spacer(1, 4 * mm),
              Paragraph(f"<b>Total: {money(st['total'])}</b> ({st['total_in_words']})", normal),
              Paragraph(
                  f"Ledger reconciliation: {rec['matched']} of {rec['app_tickets']} app tickets match "
                  f"their ledger row; {rec['imported']['count']} rows from the ERP import; "
                  f"{rec['reversals']['count']} reversals; "
                  + ("no differences." if rec["balanced"] else f"{len(rec['issues'])} to explain."),
                  small),
              Spacer(1, 16 * mm)]
    sig = Table([["", "", ""],
                 ["Prepared by (Finance)", "Authorised by (Director)", "Approved by (Principal)"],
                 [prepared_by, "", ""],
                 ["Date:", "Date:", "Date:"]],
                colWidths=[60 * mm, 60 * mm, 60 * mm])
    sig.setStyle(TableStyle([
        ("LINEABOVE", (0, 1), (0, 1), 0.6, colors.black), ("LINEABOVE", (1, 1), (1, 1), 0.6, colors.black),
        ("LINEABOVE", (2, 1), (2, 1), 0.6, colors.black), ("FONT", (0, 0), (-1, -1), SANS, 8.5),
        ("FONT", (0, 1), (-1, 1), SANS_BOLD, 8.5), ("TOPPADDING", (0, 0), (-1, 0), 14),
    ]))
    tail.append(sig)
    # The totals and the signature block never split from each other across a page.
    story.append(KeepTogether(tail))

    def footer(canvas, _doc):
        canvas.setFont(SANS, 7)
        canvas.drawString(14 * mm, 8 * mm, f"{st['college']}: payout statement {st['label']}. "
                                            "Figures from the payments ledger.")
        canvas.drawRightString(A4[0] - 14 * mm, 8 * mm, f"Page {_doc.page}")

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
