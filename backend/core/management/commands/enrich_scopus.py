"""Prepare claim SNIP/quartile from the ERP dumps, then Scopus for leftovers.

    python manage.py enrich_scopus
    python manage.py enrich_scopus --skip-api
    python manage.py enrich_scopus --issn-limit 50
"""
from __future__ import annotations

from collections import defaultdict

from django.core.management.base import BaseCommand
from django.db.models import Q

from core.models import Claim, SnipSource, User
from core.services.normalize import normalize_issn
from core.services.scopus import ScopusError, author_profile_url, lookup_serial_by_issn


def issn_keys(raw: str | None) -> set[str]:
    n = normalize_issn(raw)
    if not n:
        text = (raw or "").strip()
        if not text:
            return set()
        n = text
    bare = n.replace("-", "").replace(" ", "").upper()
    hyphen = f"{bare[:4]}-{bare[4:]}" if len(bare) == 8 else n.upper()
    return {n.upper(), bare, hyphen}


class Command(BaseCommand):
    help = "Backfill SNIP from SNIP_2025 dump, then Elsevier Scopus for remaining ISSNs"

    def add_arguments(self, parser):
        parser.add_argument("--skip-api", action="store_true", help="Dump only; do not call Scopus")
        parser.add_argument("--issn-limit", type=int, default=0, help="Max distinct ISSNs to send to Scopus (0=all)")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        dry = opts["dry_run"]
        dump_hits, dump_claims = self._backfill_from_dump(dry)
        self.stdout.write(self.style.SUCCESS(
            f"SNIP dump: {dump_hits} ISSNs matched, {dump_claims} claims updated"
        ))

        urls = self._faculty_scopus_urls(dry)
        self.stdout.write(self.style.SUCCESS(f"Faculty Scopus profile URLs filled: {urls}"))

        if opts["skip_api"]:
            return

        api_issns, api_claims = self._backfill_from_scopus(opts["issn_limit"] or 0, dry)
        self.stdout.write(self.style.SUCCESS(
            f"Scopus API: {api_issns} ISSNs looked up, {api_claims} claims updated"
        ))
        remaining = (
            Claim.objects.filter(Q(snip__isnull=True) | Q(snip=0))
            .exclude(issn__isnull=True)
            .exclude(issn="")
            .count()
        )
        self.stdout.write(f"Claims still missing SNIP (with ISSN): {remaining}")

    def _snip_index(self) -> dict[str, tuple[float, int | None]]:
        index: dict[str, tuple[float, int | None]] = {}
        for row in SnipSource.objects.exclude(snip=None).iterator():
            year = row.year
            for raw in (row.print_issn, row.e_issn):
                for key in issn_keys(raw):
                    index.setdefault(key, (row.snip, year))
        return index

    def _backfill_from_dump(self, dry: bool) -> tuple[int, int]:
        index = self._snip_index()
        qs = Claim.objects.filter(Q(snip__isnull=True) | Q(snip=0)).exclude(
            snip_source="MANUAL"
        )
        by_issn: dict[str, list[str]] = defaultdict(list)
        for claim in qs.only("id", "issn").iterator():
            keys = issn_keys(claim.issn)
            hit = None
            for k in keys:
                if k in index:
                    hit = index[k]
                    break
            if hit is None:
                continue
            by_issn[claim.issn or ""].append(claim.id)

        claims_n = 0
        issn_n = 0
        for issn, ids in by_issn.items():
            hit = None
            for k in issn_keys(issn):
                if k in index:
                    hit = index[k]
                    break
            if hit is None:
                continue
            snip, year = hit
            issn_n += 1
            claims_n += len(ids)
            if not dry:
                Claim.objects.filter(id__in=ids).update(
                    snip=snip, snip_year=year, snip_source="SNIP_DUMP"
                )
        return issn_n, claims_n

    def _faculty_scopus_urls(self, dry: bool) -> int:
        n = 0
        qs = User.objects.exclude(scopus_author_id=None).exclude(scopus_author_id="")
        qs = qs.filter(Q(scopus_author_url__isnull=True) | Q(scopus_author_url=""))
        for row in qs.iterator():
            url = author_profile_url(row.scopus_author_id)
            if not url:
                continue
            n += 1
            if not dry:
                row.scopus_author_url = url
                row.save(update_fields=["scopus_author_url"])
        return n

    def _backfill_from_scopus(self, limit: int, dry: bool) -> tuple[int, int]:
        missing = (
            Claim.objects.filter(Q(snip__isnull=True) | Q(snip=0))
            .exclude(snip_source="MANUAL")
            .exclude(issn__isnull=True)
            .exclude(issn="")
        )
        unique: list[str] = []
        seen: set[str] = set()
        for issn in missing.values_list("issn", flat=True).distinct():
            keys = frozenset(issn_keys(issn))
            if keys & seen:
                continue
            seen |= keys
            unique.append(issn)
            if limit and len(unique) >= limit:
                break

        issn_n = 0
        claims_n = 0
        for issn in unique:
            try:
                serial = lookup_serial_by_issn(issn)
            except ScopusError as exc:
                self.stderr.write(self.style.WARNING(f"{issn}: {exc}"))
                continue
            if not serial or serial.get("snip") is None:
                continue
            issn_n += 1
            keys = issn_keys(issn)
            q = Q()
            for k in keys:
                q |= Q(issn__iexact=k)
            ids = list(
                Claim.objects.filter(q)
                .filter(Q(snip__isnull=True) | Q(snip=0))
                .exclude(snip_source="MANUAL")
                .values_list("id", flat=True)
            )
            claims_n += len(ids)
            if not dry and ids:
                Claim.objects.filter(id__in=ids).update(
                    snip=serial["snip"],
                    snip_year=serial.get("snip_year"),
                    snip_source="SCOPUS",
                )
            self.stdout.write(f"  {issn} SNIP={serial['snip']} -> {len(ids)} claims")
        return issn_n, claims_n
