"""Look through everything the college has already paid for, and group the repeats.

Duplicate detection has only ever run at submission time, so the 3,000-odd
payments imported from the ERP were never checked against each other at all.
This sweeps them, and records what it finds as something a person has to
decide about rather than as a number in a report.

Two kinds of group, deliberately kept apart:

- SAME_PERSON: one faculty member paid more than once for the same paper.
  Nearly always wrong, and the money at issue is the second and later
  payments.
- CROSS_PERSON: one paper paid to several faculty. Usually right -- they are
  co-authors, and the scheme pays each by author position -- so these are
  recorded for visibility and are not, on their own, a finding against
  anybody.

Matching is by DOI where both rows carry one, and by normalised title
otherwise. Title matching is the weaker of the two and will group papers that
share a title, which is exactly why the output is a review queue.
"""
from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import Claim, ClaimStatus, DuplicateFinding, PriorPayment
from core.services.normalize import normalize_title


def _norm_doi(doi: str | None) -> str:
    d = (doi or "").strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if d.startswith(prefix):
            d = d[len(prefix):]
    return d.strip("/")


class Command(BaseCommand):
    help = "Group already-paid records by paper and record the repeats for review."

    def add_arguments(self, parser):
        parser.add_argument(
            "--min-amount",
            type=float,
            default=0.0,
            help="Ignore groups whose repeat value is below this (default: report all).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be recorded without writing findings.",
        )
        parser.add_argument(
            "--reset",
            action="store_true",
            help="Delete findings nobody has reviewed before sweeping again.",
        )

    def handle(self, *args, **opts):
        rows: list[dict[str, Any]] = []

        for c in (
            Claim.objects.filter(status=ClaimStatus.PAID)
            .exclude(paper_title="")
            .select_related("owner")
            .values(
                "id", "ticket_number", "paper_title", "doi", "remuneration",
                "payout_month", "owner_id", "owner__name", "owner__department",
            )
        ):
            rows.append({
                "source": "claim",
                "id": c["id"],
                "reference": c["ticket_number"],
                "title": c["paper_title"],
                "doi": c["doi"],
                "amount": c["remuneration"] or 0,
                "when": c["payout_month"].strftime("%Y-%m") if c["payout_month"] else None,
                "person_key": c["owner_id"],
                "person": c["owner__name"],
                "department": c["owner__department"],
            })

        # The ERP import wrote each historical payment into both tables, so
        # every PriorPayment row currently has a Claim carrying the same
        # reference. Counting both would report every payment as its own
        # duplicate. Only orphans -- ledger rows with no claim behind them --
        # are added, which is what keeps a repeat spanning the two tables
        # visible without inventing one.
        claim_refs = {
            r for r in Claim.objects.values_list("ticket_number", flat=True) if r
        }
        for m in PriorPayment.objects.exclude(paper_title="").values(
            "id", "claim_ref", "paper_title", "doi", "amount_paid", "paid_at",
            "faculty_name", "employee_id",
        ):
            if (m["claim_ref"] or "") in claim_refs:
                continue
            rows.append({
                "source": "prior",
                "id": m["id"],
                "reference": m["claim_ref"],
                "title": m["paper_title"],
                "doi": m["doi"],
                "amount": m["amount_paid"] or 0,
                "when": m["paid_at"].strftime("%Y-%m") if m["paid_at"] else None,
                # No user account behind an imported row, so the person is the
                # name as the sheet spelt it, folded for comparison.
                "person_key": (m["employee_id"] or m["faculty_name"] or "").strip().lower(),
                "person": m["faculty_name"],
                "department": None,
            })

        self.stdout.write(f"Scanning {len(rows):,} paid records…")

        groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for r in rows:
            doi = _norm_doi(r["doi"])
            if doi:
                key = ("doi", doi)
            else:
                title = normalize_title(r["title"])
                if not title:
                    continue
                key = ("title", title)
            groups[key].append(r)

        same_person: list[tuple] = []
        cross_person: list[tuple] = []
        for (matched_on, key), members in groups.items():
            if len(members) < 2:
                continue
            by_person: dict[Any, list[dict]] = defaultdict(list)
            for m in members:
                by_person[m["person_key"]].append(m)
            for person_key, theirs in by_person.items():
                if len(theirs) > 1:
                    same_person.append((matched_on, key, person_key, theirs))
            if len(by_person) > 1:
                cross_person.append((matched_on, key, None, members))

        def summarise(members: list[dict]) -> tuple[float, float]:
            amounts = sorted((m["amount"] or 0) for m in members)
            # The largest is treated as the payment that was due; everything
            # under it is what is at issue. Taking the first chronologically
            # would understate it when the repeat was the larger of the two.
            return sum(amounts), sum(amounts[:-1])

        min_amount = opts["min_amount"]
        written = 0
        skipped_small = 0
        report_same, report_cross = [], []

        for kind, found, bucket in (
            (DuplicateFinding.Kind.SAME_PERSON, same_person, report_same),
            (DuplicateFinding.Kind.CROSS_PERSON, cross_person, report_cross),
        ):
            for matched_on, key, person_key, members in found:
                total, extra = summarise(members)
                if kind == DuplicateFinding.Kind.SAME_PERSON and extra < min_amount:
                    skipped_small += 1
                    continue
                bucket.append((total, extra, members))
                if opts["dry_run"]:
                    continue
                with transaction.atomic():
                    DuplicateFinding.objects.update_or_create(
                        kind=kind,
                        match_key=key[:512],
                        faculty_name=(members[0]["person"] or "")[:255],
                        defaults={
                            "matched_on": matched_on,
                            "paper_title": members[0]["title"],
                            "rows_json": json.dumps(members, default=str),
                            "payment_count": len(members),
                            "total_amount": round(total, 2),
                            "extra_amount": round(extra, 2),
                        },
                    )
                written += 1

        if opts["reset"] and not opts["dry_run"]:
            removed = DuplicateFinding.objects.filter(
                status=DuplicateFinding.Status.OPEN
            ).exclude(
                match_key__in=[k for _, k, _, _ in same_person + cross_person]
            ).delete()
            self.stdout.write(f"Cleared {removed[0]} stale unreviewed findings")

        same_total = sum(e for _, e, _ in report_same)
        cross_total = sum(t for t, _, _ in report_cross)

        self.stdout.write("")
        self.stdout.write(self.style.WARNING(
            f"Same person paid more than once: {len(report_same)} papers, "
            f"Rs {same_total:,.2f} in repeat payments"
        ))
        self.stdout.write(
            f"One paper across several people: {len(report_cross)} papers, "
            f"Rs {cross_total:,.2f} paid in total (co-authors, usually correct)"
        )
        if skipped_small:
            self.stdout.write(f"({skipped_small} groups below the Rs {min_amount:,.0f} floor)")

        self.stdout.write("")
        self.stdout.write("Largest repeats:")
        for total, extra, members in sorted(report_same, key=lambda x: -x[1])[:10]:
            who = members[0]["person"] or "unknown"
            self.stdout.write(f"  Rs {extra:>12,.2f}  {who} — {(members[0]['title'] or '')[:56]}")
            for m in sorted(members, key=lambda x: x["when"] or ""):
                self.stdout.write(
                    f"                 {m['reference'] or m['id'][:8]}  "
                    f"Rs {m['amount']:>10,.2f}  {m['when'] or '—'}"
                )

        if opts["dry_run"]:
            self.stdout.write(self.style.NOTICE("\\nDry run — nothing was written."))
        else:
            self.stdout.write(self.style.SUCCESS(f"\\n{written} findings recorded for review."))
