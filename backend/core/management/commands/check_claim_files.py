"""Read the PDFs on claims already in the system, and flag the ones that do not match.

New filings are read as they are filed (core.services.content_check). This is
the backfill for everything filed before that, and the way to re-read a claim
on demand. A file already read is skipped unless --force; a flag already
raised is never raised twice. The super admin is told once, at the end, if
anything was flagged -- not once per claim.

Drafts are read but never flagged: nobody but their author can see them.
"""
from __future__ import annotations

import logging

from django.core.management.base import BaseCommand

from core.models import Claim, ClaimStatus
from core.services.content_check import check_claim_files

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Read the PDFs attached to claims and flag the ones that do not match the claim."

    def add_arguments(self, parser):
        parser.add_argument("--claim", action="append", default=[], help="Only this claim id (repeatable).")
        parser.add_argument("--status", default=None, help="Only claims at this status, e.g. PAID.")
        parser.add_argument("--force", action="store_true", help="Read files again even if already read.")
        parser.add_argument("--limit", type=int, default=0, help="Stop after this many claims.")

    def handle(self, *args, **opts):
        # Only our own uploads can be read; an imported claim's proof is a
        # link to somebody's drive, which is not ours to fetch.
        claims = (
            Claim.objects.filter(
                attachments__url__startswith="/media/claims/", attachments__url__endswith=".pdf"
            )
            .distinct()
            .order_by("created_at")
        )
        if opts["claim"]:
            claims = claims.filter(pk__in=opts["claim"])
        if opts["status"]:
            claims = claims.filter(status=opts["status"])
        ids = list(claims.values_list("pk", flat=True))
        if opts["limit"]:
            ids = ids[: opts["limit"]]

        files = raised = failed = 0
        outcomes: dict[str, int] = {}
        for claim_id in ids:
            try:
                checks, flagged = check_claim_files(claim_id, force=opts["force"], notify=False)
            except Exception:  # noqa: BLE001 -- one claim must not end a backfill of thousands
                logger.exception("check_claim_files_failed claim=%s", claim_id)
                failed += 1
                continue
            files += len(checks)
            raised += flagged
            for check in checks:
                outcomes[check.outcome] = outcomes.get(check.outcome, 0) + 1

        summary = ", ".join(f"{n} {k.lower().replace('_', ' ')}" for k, n in sorted(outcomes.items()))
        self.stdout.write(
            f"Read {files} file{'s' if files != 1 else ''} on {len(ids)} claim"
            f"{'s' if len(ids) != 1 else ''}"
            + (f" ({summary})" if summary else "")
            + f"; {raised} flag{'s' if raised != 1 else ''} raised."
        )
        if failed:
            self.stdout.write(
                f"{failed} claim{' ' if failed == 1 else 's '}could not be read — see the log; "
                "run the command again for those with --claim."
            )
        if raised:
            from core.api.common import _notify_admin_users

            _notify_admin_users(
                f"File check: {raised} flag{'s' if raised != 1 else ''} raised",
                "Claims whose published paper does not carry its own title or DOI, "
                "or has no text to read. Nothing was held back; each one is waiting under Flags.",
                "/flags?kind=CONTENT_MISMATCH",
                super_admin_only=True,
            )
        # Drafts are counted above but never flagged; say so, because a
        # backfill that reads 500 files and flags none of the drafts among
        # them would otherwise look like it had missed them.
        drafts = Claim.objects.filter(pk__in=ids, status=ClaimStatus.DRAFT).count()
        if drafts:
            self.stdout.write(f"{drafts} of those claims are drafts: read, never flagged.")
