"""A demo college for `manage.py seed --demo`: people in every role, and papers
at every stage of the chain.

Faculty file -> the research supervisor's desk clears -> the Principal
approves -> the Director authorises -> Finance pays. Fifteen papers are spread
across that chain -- a draft, papers waiting at each desk, one on hold, one
sent back with a reason, one not accepted, one withdrawn, papers approved,
authorised and paid, and one whose claimant contested a payment-history
match and sent it on anyway.

Everything is written the way the live chain would have written it: the
amount comes from `_apply_calc`, the real formula path, against journals held
in the ScimagoJournal/SnipSource tables; every step leaves the ClaimAction the
endpoint would have left, by the person whose desk it was; a paid paper has
its ledger row. The journal figures below are rounded, illustrative values for
a demo database -- they are not a reference for any journal's standing.

Idempotent. A paper is keyed by its ticket number (DEMO-...), or for the one
never-filed draft by its owner and title, and a paper that already exists is
left exactly as it is -- a second run adds nothing.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from django.db import transaction
from django.utils import timezone

from core.models import (
    AttachmentKind,
    Claim,
    ClaimAction,
    ClaimAttachment,
    ClaimStatus,
    PaidLedger,
    Role,
    ScimagoJournal,
    SnipSource,
    User,
)
from core.services.scimago import parse_categories_field

#: Accounts for the roles the base seed does not create. Passwords are set on
#: creation only; an account that exists keeps whatever it has now.
DEMO_STAFF = [
    # email, password, name, role, department, employee id, staff id, biometric, designation
    ("hod@college.edu", "hod123", "Dr. Meenakshi Sundaram", Role.HOD, "CSE",
     "EMP-HOD-CSE", "STF-HOD-CSE", "BIO-HOD-CSE", "Professor and Head, CSE"),
    ("director@college.edu", "director123", "Dr. Ramesh Balasubramanian", Role.DIRECTOR,
     None, "EMP-DIR", "STF-DIR", "BIO-DIR", "Director"),
    ("research@college.edu", "research123", "Research Cell", Role.RESEARCH_CELL,
     None, "EMP-RC", "STF-RC", "BIO-RC", "Research Cell"),
]

#: Six more faculty across three departments. They share the demo faculty
#: password, set only when the account is first created.
DEMO_FACULTY_PASSWORD = "faculty123"
DEMO_FACULTY = [
    ("ananya.rao@college.edu", "Dr. Ananya Rao", "CSE", "STF-CSE-101", "Associate Professor"),
    ("karthik.s@college.edu", "Karthik Subramanian", "CSE", "STF-CSE-102", "Assistant Professor"),
    ("priya.n@college.edu", "Dr. Priya Natarajan", "ECE", "STF-ECE-201", "Professor"),
    ("rahul.m@college.edu", "Rahul Menon", "ECE", "STF-ECE-202", "Assistant Professor"),
    ("divya.k@college.edu", "Dr. Divya Krishnan", "MECH", "STF-MEC-301", "Associate Professor"),
    ("arjun.v@college.edu", "Arjun Venkatesh", "MECH", "STF-MEC-302", "Assistant Professor"),
]

#: Journals the demo papers are published in, added to the three the base
#: seed holds. Rounded, illustrative figures -- see the module docstring.
#: title, print ISSN, e-ISSN, SJR, Scimago categories, SNIP
DEMO_JOURNALS = [
    ("IEEE Access", "2169-3536", None, 0.96,
     "Computer Science (miscellaneous) (Q1); Engineering (miscellaneous) (Q1)", 1.54),
    ("Expert Systems with Applications", "0957-4174", "1873-6793", 1.88,
     "Artificial Intelligence (Q1); Computer Science Applications (Q1)", 2.62),
    ("Sensors", "1424-8220", None, 0.79,
     "Electrical and Electronic Engineering (Q2); Instrumentation (Q2)", 1.21),
    ("IEEE Transactions on Industrial Electronics", "0278-0046", "1557-9948", 3.40,
     "Control and Systems Engineering (Q1); Electrical and Electronic Engineering (Q1)", 2.83),
    ("Applied Thermal Engineering", "1359-4311", "1873-5606", 1.57,
     "Energy Engineering and Power Technology (Q1); Mechanical Engineering (Q1)", 1.83),
    ("Journal of Manufacturing Processes", "1526-6125", "2212-4616", 1.60,
     "Industrial and Manufacturing Engineering (Q1)", 1.92),
]
SCIMAGO_YEAR = 2024
SNIP_YEAR = 2025


@dataclass
class Paper:
    key: str  # ticket number, or "" for the never-filed draft
    owner: str
    title: str
    journal: str
    year: int
    #: The path through the chain, oldest first: "file", "hold", "return",
    #: "clear", "principal", "director", "pay", "reject_outright", "withdraw",
    #: "contest". A draft has none.
    path: list[str] = field(default_factory=list)
    authors: tuple[int, int] = (3, 1)  # total, position
    days_ago: int = 40
    note: str | None = None


PAPERS = [
    Paper("", "faculty@college.edu",
          "Federated Learning for Privacy-Preserving Student Performance Prediction",
          "IEEE Access", 2025, [], days_ago=3),
    Paper("DEMO-2025-0001", "ananya.rao@college.edu",
          "A Lightweight Transformer for Real-Time Traffic Sign Recognition on Edge Devices",
          "IEEE Access", 2025, ["file"], days_ago=6),
    Paper("DEMO-2025-0002", "priya.n@college.edu",
          "Low-Power CMOS Readout Circuit for Wearable Photoplethysmography Sensors",
          "Sensors", 2025, ["file"], (4, 2), days_ago=11),
    Paper("DEMO-2025-0003", "divya.k@college.edu",
          "Thermal Performance of a Phase-Change-Material Heat Sink for Battery Packs",
          "Applied Thermal Engineering", 2025, ["file", "hold"], days_ago=18,
          note="Waiting on the publisher to confirm the final page numbers"),
    Paper("DEMO-2025-0004", "karthik.s@college.edu",
          "Graph Neural Networks for Intrusion Detection in Software-Defined Networks",
          "Expert Systems with Applications", 2025, ["file", "return"], days_ago=21,
          note="Attach the published version of the paper, not the accepted manuscript"),
    Paper("DEMO-2025-0005", "rahul.m@college.edu",
          "Sliding-Mode Control of a Grid-Tied Inverter under Unbalanced Voltage",
          "IEEE Transactions on Industrial Electronics", 2025, ["file", "clear"], (3, 2),
          days_ago=16),
    Paper("DEMO-2025-0006", "faculty@college.edu",
          "Explainable Deep Learning for Early Detection of Diabetic Retinopathy",
          "Expert Systems with Applications", 2025, ["file", "clear"], days_ago=14),
    Paper("DEMO-2025-0007", "arjun.v@college.edu",
          "Tool Wear Prediction in Micro-Milling of Ti-6Al-4V Using Acoustic Emission",
          "Journal of Manufacturing Processes", 2025, ["file", "clear", "principal"],
          (5, 1), days_ago=26),
    Paper("DEMO-2025-0008", "ananya.rao@college.edu",
          "Self-Supervised Contrastive Learning for Low-Resource Tamil Speech Recognition",
          "IEEE Access", 2024, ["file", "clear", "principal", "director"], days_ago=35),
    Paper("DEMO-2025-0009", "priya.n@college.edu",
          "A 5.8 GHz Rectenna Array for Wireless Power Transfer to Implantable Devices",
          "Sensors", 2024, ["file", "clear", "principal", "director"], (2, 1), days_ago=33),
    Paper("DEMO-2024-0010", "faculty@college.edu",
          "Attention-Based Fusion of Multispectral Imagery for Crop Disease Classification",
          "IEEE Access", 2024, ["file", "clear", "principal", "director", "pay"],
          days_ago=70),
    Paper("DEMO-2024-0011", "divya.k@college.edu",
          "Entropy Generation in Nanofluid Flow through a Microchannel Heat Exchanger",
          "Applied Thermal Engineering", 2024, ["file", "clear", "principal", "director", "pay"],
          (4, 1), days_ago=82),
    Paper("DEMO-2025-0012", "rahul.m@college.edu",
          "A Survey of Energy Harvesting Techniques for IoT Nodes",
          "Sensors", 2025, ["file", "clear", "reject_outright"], days_ago=24,
          note="The same survey was paid in 2024 as a conference version; the journal "
               "version is not a new publication under the scheme"),
    Paper("DEMO-2025-0013", "karthik.s@college.edu",
          "Adversarially Robust Malware Classification Using Byte-Level Embeddings",
          "IEEE Access", 2025, ["file", "withdraw"], days_ago=9),
    Paper("DEMO-2025-0014", "faculty@college.edu",
          "Attention-Based Fusion of Multispectral Imagery for Crop Disease Detection",
          "IEEE Access", 2025, ["contest"], days_ago=5,
          note="This is the extended journal version with a new dataset and new "
               "experiments; the earlier payment was for the conference paper"),
]

#: Who sits at each desk in the demo.
_DESK = {
    "clear": "research@college.edu",
    "hold": "research@college.edu",
    "return": "research@college.edu",
    "reject_outright": "principal@college.edu",
    "principal": "principal@college.edu",
    "director": "director@college.edu",
    "pay": "finance@college.edu",
}


def _journal(title: str) -> dict[str, Any]:
    for jt, issn, eissn, sjr, cats, snip in DEMO_JOURNALS:
        if jt == title:
            parsed = parse_categories_field(cats)
            best = min((c["quartile"] for c in parsed if c["quartile"]), default=None)
            return {"title": jt, "issn": issn, "snip": snip, "quartile": best, "sjr": sjr}
    raise KeyError(title)


def seed_journals() -> int:
    for title, issn, eissn, sjr, cats, snip in DEMO_JOURNALS:
        raw = {"title": title, "issn": issn, "eissn": eissn, "sjr": sjr,
               "categories": cats, "demo": True}
        ScimagoJournal.objects.update_or_create(
            issn=issn,
            year=SCIMAGO_YEAR,
            defaults={
                "title": title,
                "eissn": eissn,
                "sjr": sjr,
                "categories_json": json.dumps(parse_categories_field(cats)),
                "raw_json": json.dumps(raw),
            },
        )
        SnipSource.objects.update_or_create(
            print_issn=issn,
            year=SNIP_YEAR,
            defaults={
                "title": title,
                "e_issn": eissn,
                "snip": snip,
                "sjr": sjr,
                "raw_json": json.dumps({**raw, "snip": snip}),
            },
        )
    return len(DEMO_JOURNALS)


def demo_accounts() -> list[tuple]:
    """In the shape the seed command's account loop takes."""
    rows = list(DEMO_STAFF)
    for i, (email, name, dept, staff_id, designation) in enumerate(DEMO_FACULTY, start=1):
        rows.append((
            email, DEMO_FACULTY_PASSWORD, name, Role.FACULTY, dept,
            f"EMP-{staff_id[4:]}", staff_id, f"BIO-{staff_id[4:]}", designation,
        ))
    return rows


def _exists(paper: Paper, owner: User) -> bool:
    if paper.key:
        return Claim.objects.filter(ticket_number=paper.key).exists()
    return Claim.objects.filter(owner=owner, paper_title=paper.title).exists()


class _History:
    """ClaimAction rows written oldest first, each back-dated to its step."""

    def __init__(self, claim: Claim, start):
        self.claim = claim
        self.at = start

    def step(self, actor: User, action: str, from_status, to_status, note=None, *, days=1):
        self.at = self.at + timedelta(days=days)
        row = ClaimAction.objects.create(
            claim=self.claim, actor=actor, from_status=from_status,
            to_status=to_status, action=action, note=note,
        )
        # auto_now_add ignores a value passed in, so the date is set after.
        ClaimAction.objects.filter(pk=row.pk).update(created_at=self.at)
        return self.at


def _create_paper(paper: Paper, people: dict[str, User], apply_calc, index: int) -> Claim:
    owner = people[paper.owner]
    journal = _journal(paper.journal)
    start = timezone.now() - timedelta(days=paper.days_ago)
    total, position = paper.authors
    claim = Claim.objects.create(
        owner=owner,
        status=ClaimStatus.DRAFT,
        ticket_number=paper.key or None,
        paper_title=paper.title,
        journal_title=journal["title"],
        issn=journal["issn"],
        # 10.5555 is the DOI prefix set aside for examples: no demo paper can
        # be mistaken for, or collide with, a real one.
        doi=f"10.5555/demo.{paper.year}.{index:04d}",
        publication_year=paper.year,
        publication_date=f"{paper.year}-0{1 + index % 9}-15",
        publication_type="Journal",
        aggregation_type="Journal",
        indexing_level="Scopus",
        yukthi_id=f"YK-DEMO-{index:04d}",
        staff_id=owner.staff_id,
        biometric_id=owner.biometric_id,
        designation=owner.designation,
        total_authors=total,
        author_position=position,
        affiliation_ok=True,
        engineering_class="Engineering",
        # The verified columns, as the lookup against the seeded tables fills
        # them. The amount is computed from these and nothing else.
        quartile=journal["quartile"],
        quartile_source="SCIMAGO",
        scimago_verified=True,
        scimago_sjr=journal["sjr"],
        scimago_dataset_year=SCIMAGO_YEAR,
        snip=journal["snip"],
        snip_source="SNIP_DUMP",
        snip_year=SNIP_YEAR,
        indexing_status="Indexed",
        linkage_status="Linked",
        verification_ok=True,
    )
    ClaimAttachment.objects.create(
        claim=claim, kind=AttachmentKind.PUBLISHED_PAPER,
        url=f"/media/claims/demo-{index:04d}-paper.pdf",
        filename="published-paper.pdf", size_bytes=412_000, uploaded_by=owner,
    )
    for ref in ("12", "27"):
        ClaimAttachment.objects.create(
            claim=claim, kind=AttachmentKind.SEC_REFERENCE,
            url=f"/media/claims/demo-{index:04d}-ref{ref}.pdf",
            filename=f"sec-reference-{ref}.pdf", size_bytes=180_000,
            ref_number=ref, ref_title="An earlier paper from the college",
            uploaded_by=owner,
        )
    apply_calc(claim)
    claim.save()

    history = _History(claim, start)
    history.step(owner, "CREATE_DRAFT", None, ClaimStatus.DRAFT, days=0)
    at = start
    for step in paper.path:
        desk = people.get(_DESK.get(step, ""), owner)
        if step in ("file", "contest"):
            contested = step == "contest"
            if contested:
                _mark_contested(claim, owner, paper.note)
            at = history.step(
                owner, "CONTEST_FORWARD" if contested else "SUBMIT",
                ClaimStatus.DRAFT, ClaimStatus.SUBMITTED,
                paper.note if contested else None,
            )
            claim.status = ClaimStatus.SUBMITTED
            claim.submitted_at = at
        elif step == "hold":
            at = history.step(desk, "HOLD", claim.status, claim.status, paper.note)
            claim.on_hold, claim.hold_reason = True, paper.note
            claim.held_by, claim.held_at = desk, at
        elif step == "return":
            at = history.step(desk, "REJECT", claim.status, ClaimStatus.REJECTED, paper.note, days=3)
            claim.status, claim.status_note = ClaimStatus.REJECTED, paper.note
        elif step == "clear":
            at = history.step(desk, "CLEAR", claim.status, ClaimStatus.CLEARED, days=3)
            claim.status, claim.cleared_by, claim.cleared_at = ClaimStatus.CLEARED, desk, at
        elif step == "principal":
            at = history.step(
                desk, "PRINCIPAL_APPROVE", claim.status, ClaimStatus.PRINCIPAL_APPROVED, days=4
            )
            claim.status = ClaimStatus.PRINCIPAL_APPROVED
            claim.principal_approved_by, claim.principal_approved_at = desk, at
            # As the live step does: a different pair of eyes from the desk
            # that cleared it is the second signature.
            claim.second_approved_by, claim.second_approved_at = desk, at
        elif step == "director":
            at = history.step(
                desk, "DIRECTOR_APPROVE", claim.status, ClaimStatus.DIRECTOR_APPROVED, days=3
            )
            claim.status = ClaimStatus.DIRECTOR_APPROVED
            claim.director_approved_by, claim.director_approved_at = desk, at
        elif step == "pay":
            at = history.step(desk, "MARK_PAID", claim.status, ClaimStatus.PAID, days=5)
            claim.status, claim.paid_at = ClaimStatus.PAID, at
            claim.payout_month = date(at.year, at.month, 1)
        elif step == "reject_outright":
            at = history.step(
                desk, "REJECT_OUTRIGHT", claim.status, ClaimStatus.REJECTED, paper.note, days=2
            )
            claim.status, claim.status_note = ClaimStatus.REJECTED, paper.note
            claim.rejected_outright = True
            claim.cleared_by = claim.cleared_at = None
        elif step == "withdraw":
            at = history.step(owner, "WITHDRAW", claim.status, ClaimStatus.DRAFT, days=2)
            claim.status = ClaimStatus.DRAFT
        else:  # pragma: no cover - a typo in PAPERS
            raise ValueError(f"Unknown demo step {step!r}")
    claim.save()

    if claim.status == ClaimStatus.PAID:
        PaidLedger.objects.create(
            claim=claim,
            payout_month=claim.payout_month,
            department=owner.department,
            faculty_name=owner.name,
            staff_id=claim.staff_id,
            biometric_id=claim.biometric_id,
            paper_title=claim.paper_title,
            journal_title=claim.journal_title,
            amount=claim.remuneration or 0,
            voucher_number=f"DEMO-V-{index:04d}",
        )
    return claim


def _mark_contested(claim: Claim, owner: User, note: str | None) -> None:
    """The flags `_submit_claim` sets when a claimant forwards past a
    payment-history match: the match itself, and who set it aside."""
    earlier = (
        Claim.objects.filter(owner=owner, status=ClaimStatus.PAID)
        .exclude(pk=claim.pk)
        .order_by("paid_at")
        .first()
    )
    match = {
        "source": "claim",
        "claim_id": earlier.id if earlier else None,
        "ticket_number": earlier.ticket_number if earlier else None,
        "title": earlier.paper_title if earlier else None,
        "amount": earlier.remuneration if earlier else None,
        "matched_on": "title",
    }
    issue = "Payment history may already include this paper"
    claim.duplicate_warning = True
    claim.duplicate_matches_json = json.dumps([match])
    claim.contest_forward = True
    claim.contest_note = note
    claim.verification_ok = False
    claim.verification_snapshot_json = json.dumps({"issues": [issue]})
    claim.override_duplicate = True
    claim.override_reason = note
    claim.override_by = owner
    claim.override_at = timezone.now()


def seed_demo_college(people: dict[str, User], apply_calc) -> tuple[int, int]:
    """Create whichever demo papers do not exist yet. Returns (created, kept)."""
    created = kept = 0
    for index, paper in enumerate(PAPERS, start=1):
        owner = people[paper.owner]
        if _exists(paper, owner):
            kept += 1
            continue
        with transaction.atomic():
            _create_paper(paper, people, apply_calc, index)
        created += 1
    return created, kept
