"""A search engine for this college's own publishing, built rather than bought.

One box, four things behind it:

    papers   Crossref + OpenAlex + Scopus, merged and de-duplicated by DOI,
             returned in the shape the claim form already consumes.
    venues   our own 32,000 Scimago rows and 32,000 SNIP rows first, OpenAlex
             Sources second, filterable by field and quartile -- an index
             lookup where the AI venue finder takes ninety-one seconds.
    people   colleagues and stated research interests: who has published on
             this and who to work with.
    tickets  our own claims: has this paper been filed here already.
    engine   one query fanned out to all of it, grouped and ranked, with every
             source reporting itself whether it answered or not.

Four rules run through every module, and each is enforced in one place rather
than remembered in several:

  *Money-blindness* lives in `money.py`. The only amount this package can emit
  is the one on an already-filed ticket, and for a head of department that key
  is omitted rather than zeroed -- then everything still leaves through
  `hod.without_money` anyway.

  *The model proposes, the database disposes* lives in `resolve.py`. Nothing
  named by an outside source is shown with a quartile, a SNIP or an amount
  until it has been found in our own tables; what does not resolve comes back
  separately with no numbers on it.

  *Bounded and degrading* lives in `upstream.py`. Two timeouts and a wall-clock
  budget per fan-out; failures are collected and named, never raised.

  *Cache the upstream, never the answer* also lives in `upstream.py`. Raw
  third-party payloads are cached; resolution and pricing are redone on every
  request, for the viewer who asked.

No new secrets. Crossref and OpenAlex are keyless; Scopus uses the key already
in settings and is simply not asked when there is not one.
"""

from core.services.search.engine import KINDS, search  # noqa: F401

__all__ = ["search", "KINDS"]
