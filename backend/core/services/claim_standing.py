"""Has this person already claimed, or been paid for, this paper?

The one place that answers it. Before this module the answer lived in four
places that each knew a little: the lookup box knew the person's own DOIs, the
Scopus picker knew their own EIDs, the payment-history check knew only what had
already been *paid*, and nothing knew a second claim filed beside a first that
was still in the chain. So a paper could be filed twice in the same week and
nobody was told until Finance had paid both.

Two different answers come out, and they are kept apart:

* `own_standing` is what the claimant is told, in plain words, at the moment
  they pick the paper. It never names a desk or a colleague: the stage is the
  faculty stage ("Being checked by the college"), and a co-author's claim is
  not mentioned at all.
* `routing_notes` is what the research cell is told, as an automatic
  DUPLICATE flag, when a claim is filed: another author at the college has also
  claimed this paper, or this person has a claim with a similar title. The
  policy pays co-authors by author position, so a co-author's claim is never
  refused -- but two people claiming the *same* position is one claim too
  many, and the cell sees it before anything moves.
"""
from __future__ import annotations

from typing import Any

from django.db.models import Q

from core.models import Claim, ClaimStatus, PriorPayment, User
from core.services.normalize import normalize_doi, normalize_title, titles_rough_match
from core.visibility import faculty_stage

#: Statuses a claim holds the paper in. A draft can be dropped and a claim that
#: was sent back is edited and filed again as itself, so neither "holds" it in
#: the sense of the database constraint (see Claim.Meta).
FILED = (
    ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED,
    ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.HOD_APPROVED, ClaimStatus.RESEARCH_APPROVED,
    ClaimStatus.FINANCE_APPROVED,
)


def _month(d) -> str | None:
    return d.strftime("%B %Y") if d else None


def _match_q(doi: str | None, eid: str | None, title_key: str) -> Q:
    q = Q()
    if doi:
        q |= Q(doi__iexact=doi)
    if eid:
        q |= Q(eid=eid)
    if title_key:
        # A title decides only where a DOI cannot: a conference paper and its
        # journal extension share a title and are two papers. So when this
        # paper has a DOI, only a claim with no DOI can be matched by title;
        # when it has none, any claim with the same title is the same paper.
        by_title = Q(normalized_title=title_key)
        q |= by_title & (Q(doi__isnull=True) | Q(doi="")) if doi else by_title
    return q


def _claim_answer(c: Claim) -> dict[str, Any]:
    stage = faculty_stage(c.status, rejected_outright=bool(c.rejected_outright), ticket_number=c.ticket_number, status_note=c.status_note)
    base = {
        "claim_id": c.id,
        "ticket_number": c.ticket_number,
        "stage": stage,
        "is_draft": c.status == ClaimStatus.DRAFT,
        "paid_month": None,
    }
    number = f"claim {c.ticket_number}" if c.ticket_number else "one of your claims"
    if c.status == ClaimStatus.PAID:
        month = _month(c.payout_month)
        return {**base, "code": "paid", "blocks": True, "paid_month": c.payout_month.strftime("%Y-%m") if c.payout_month else None,
                "message": f"You were paid for this paper{' in ' + month if month else ''} ({number}). A paper is paid once."}
    if c.status == ClaimStatus.DRAFT:
        # Told, never refused: a draft is unfinished work, and a submit that
        # failed its checks leaves one behind. Only a filed claim holds a paper.
        return {**base, "code": "draft", "blocks": False,
                "message": "This paper is already one of your drafts. Open it to carry on."}
    return {**base, "code": "filed", "blocks": True,
            "message": f"You have already claimed this paper ({number}). It is {stage.lower()}."}


def own_standing(
    owner: User | None,
    *,
    doi: str | None = None,
    eid: str | None = None,
    title: str | None = None,
    exclude_claim_id: str | None = None,
) -> dict[str, Any] | None:
    """What the claimant is told about this paper, or None when it is free.

    Order matters: the person's own claim first (they can open it), then the
    college's payment record (they cannot, so it only says when).
    """
    if owner is None:
        return None
    d = normalize_doi(doi)
    key = normalize_title(title)
    if not key_ok(key):
        key = ""  # "Introduction" is not evidence that two claims are one paper
    cond = _match_q(d, eid, key)
    if not cond:
        return None
    # A sent-back or not-accepted claim never holds the paper: it can always be
    # filed again (the database rule leaves REJECTED out for the same reason).
    qs = Claim.objects.filter(cond, owner=owner).exclude(status=ClaimStatus.REJECTED)
    if exclude_claim_id:
        qs = qs.exclude(pk=exclude_claim_id)
    # The one that matters most: paid beats filed beats draft.
    def rank(c: Claim) -> tuple[int, float]:
        order = 0 if c.status == ClaimStatus.PAID else 2 if c.status == ClaimStatus.DRAFT else 1
        return order, -c.created_at.timestamp()

    found = sorted(qs.only("id", "ticket_number", "status", "rejected_outright", "payout_month", "created_at"),
                   key=rank)
    if found:
        return _claim_answer(found[0])
    return paid_before(owner, doi=d, title_key=key)


def paid_before(owner: User, *, doi: str | None, title_key: str) -> dict[str, Any] | None:
    """The same person, the same paper, already on the payment record.

    The record is the old workbook's payments (`PriorPayment`; its orphan
    ledger rows are written from the same sheet). Matched on DOI, or on an
    exact title with the person's own staff id: never on a fuzzy title,
    because a wrong "you were paid" stops a real claim.
    """
    staff = (owner.staff_id or "").strip().lower()
    if not staff:
        return None
    prior = PriorPayment.objects.filter(employee_id__iexact=staff).order_by("-paid_at")
    hit = None
    if doi:
        hit = prior.filter(doi__iexact=doi).first()
    if hit is None and key_ok(title_key):
        hit = prior.filter(normalized_title=title_key).first()
    if hit is None:
        return None
    month = _month(hit.paid_at)
    return {
        "code": "paid_before", "blocks": True, "claim_id": None, "ticket_number": None,
        "stage": "Paid", "is_draft": False,
        "paid_month": hit.paid_at.strftime("%Y-%m") if hit.paid_at else None,
        "message": f"The college's payment record shows this paper was paid to you"
                   f"{' in ' + month if month else ''}. A paper is paid once.",
    }


def key_ok(key: str) -> bool:
    """A title key long enough that an exact match means something."""
    return len(key) >= 16


def routing_notes(claim: Claim) -> list[dict[str, Any]]:
    """Doubts the research cell should hear about, for a claim just filed.

    Each note is `{auto_key, note}` for `flags.raise_flag(kind=DUPLICATE)`.
    Never blocks, never reaches the claimant, the Director or Finance.
    """
    notes: list[dict[str, Any]] = []
    d = normalize_doi(claim.doi)
    if d:
        others = (Claim.objects.filter(doi__iexact=d).exclude(pk=claim.pk).exclude(owner_id=claim.owner_id)
                  .exclude(status__in=[ClaimStatus.DRAFT, ClaimStatus.REJECTED]).select_related("owner"))
        for o in others[:10]:
            same_slot = bool(claim.author_position and o.author_position == claim.author_position
                             and claim.total_authors == o.total_authors)
            who = f"{o.owner.name} ({o.ticket_number or 'no number yet'})"
            if same_slot:
                note = (f"Another author at the college, {who}, has also claimed this paper and gave the same "
                        f"author position ({claim.author_position} of {claim.total_authors}). Two people "
                        "cannot both be that author. Check who it is before either is paid.")
            else:
                note = (f"Another author at the college, {who}, has also claimed this paper "
                        f"(author {o.author_position} of {o.total_authors}; this claim is author "
                        f"{claim.author_position} of {claim.total_authors}). Co-authors are paid by author "
                        "position, so this is allowed. Check the positions agree.")
            notes.append({"auto_key": f"coauthor:{o.pk}", "note": note, "same_slot": same_slot})
    key = normalize_title(claim.paper_title)
    if key:
        mine = (Claim.objects.filter(owner_id=claim.owner_id).exclude(pk=claim.pk)
                .exclude(status__in=[ClaimStatus.DRAFT, ClaimStatus.REJECTED]))
        for o in mine[:200]:
            if d and normalize_doi(o.doi) == d:
                continue  # the constraint and the lookup deal with that case
            if titles_rough_match(claim.paper_title, o.paper_title):
                notes.append({
                    "auto_key": f"similar-title:{o.pk}",
                    "note": f"The same person has another claim ({o.ticket_number or 'no number yet'}) "
                            f"with a very similar title: \"{(o.paper_title or '')[:120]}\". "
                            "It may be the same paper filed twice, or a conference and a journal version.",
                    "same_slot": False,
                })
    return notes
