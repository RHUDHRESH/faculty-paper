"""Every call that leaves this machine, and what happens when it does not come back.

Three rules, applied in one place so no source can quietly opt out of them:

**Bounded.** Two timeouts, not one. A connect timeout of four seconds catches
an upstream that is unreachable; a read timeout catches one that accepted the
connection and then went quiet, which is the failure that actually happens to
Crossref. On top of both, the fan-out has a wall-clock budget: whatever has not
answered by then is abandoned and reported as a failure, so the slowest source
sets the floor on the response time rather than the ceiling.

**Polite.** Crossref and OpenAlex both run a "polite pool" -- send a real
`User-Agent` with an address they can reach you at, and you are routed to
faster, less contended infrastructure. It is free, it is the only thing they
ask in return for a keyless API, and it is the difference between a search that
answers in a second and one that answers in fifteen.

**Degrading.** `fan_out` collects exceptions instead of raising them. One
source being down returns the others' results plus a named failure; every
source being down returns an empty result set that says so. The caller never
sees a stack trace where a search should have been, and -- just as important --
a thin result set is never mistaken for a thin field, because the response
always says who was asked and who did not answer.

**Cached, but only here.** Only the raw upstream payload is cached, never the
resolved and priced output. That is deliberate on two counts: a cached result
would pin a journal's quartile to whatever our tables said half an hour ago,
and it would put a rupee figure computed for one person's author position into
a store the next person reads from. Resolution and pricing happen fresh on
every request, against the database, for the viewer who asked.
"""

from __future__ import annotations

import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any, Callable

import httpx
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

#: An unreachable host should cost four seconds, not the read budget.
CONNECT_TIMEOUT = 4.0
#: A host that answers and then stalls. Generous enough for Crossref under
#: load, short enough that a stalled source is not the whole search.
READ_TIMEOUT = 10.0
#: Wall clock for a whole fan-out, whatever it contains. Past this the
#: stragglers are abandoned and named.
FANOUT_BUDGET = 14.0

#: How long a raw upstream payload stays good.
#:
#: Half an hour for bibliographic search. A DOI's title, journal and authors do
#: not change; what changes is which papers exist, and a paper registered in
#: the last thirty minutes is not what somebody filing a claim or picking a
#: venue is looking for. Thirty minutes also happens to cover a filing session
#: -- the same query gets retyped four or five times while somebody narrows it
#: down -- so the repeat is free and the rate limit is never approached.
WORKS_TTL = 60 * 30
#: A day for journal metadata. A journal's name, ISSN and publisher change on
#: the scale of years, and the venue search is the latency-critical one: this
#: is the cache that turns a ninety-second question into an index lookup.
VENUE_TTL = 60 * 60 * 24

_CACHE_PREFIX = "search:v1"

#: Where an upstream should write if this application misbehaves. Published in
#: every outbound request; override with SEARCH_CONTACT_EMAIL in settings.
DEFAULT_CONTACT = "joyalisacerp@gmail.com"


def contact() -> str:
    """The address Crossref and OpenAlex are given to reach us on.

    Overridable from settings without being a secret -- it is published in
    every request header by design, which is the whole deal: Crossref asks for
    a contact and gives better service to requests that carry one.

    `DEFAULT_FROM_EMAIL` is deliberately not used as the fallback. It is
    `noreply@faculty-paper.local` here, and a `.local` address is not reachable
    from outside -- sending it would be claiming to be contactable while
    supplying an address that bounces, which is worse for the polite pool than
    sending nothing.
    """
    return getattr(settings, "SEARCH_CONTACT_EMAIL", "") or DEFAULT_CONTACT


def user_agent() -> str:
    return f"SECPublicationPortal/1.0 (+mailto:{contact()})"


def _timeout(read: float) -> httpx.Timeout:
    return httpx.Timeout(read, connect=CONNECT_TIMEOUT)


def get_json(
    url: str,
    params: dict[str, Any] | None = None,
    *,
    read_timeout: float = READ_TIMEOUT,
    headers: dict[str, str] | None = None,
) -> Any:
    """One bounded, polite GET returning parsed JSON. Raises on anything else.

    Raising is right here: the caller is always a source function running
    inside `fan_out`, whose job is to turn the exception into a named failure.
    """
    merged = {"User-Agent": user_agent(), "Accept": "application/json"}
    merged.update(headers or {})
    with httpx.Client(
        timeout=_timeout(read_timeout), headers=merged, follow_redirects=True
    ) as client:
        response = client.get(url, params=params)
        response.raise_for_status()
        return response.json()


def cache_key(*parts: Any) -> str:
    """A bounded key. Queries are free text and can be any length or alphabet."""
    raw = "|".join(str(p) for p in parts)
    return f"{_CACHE_PREFIX}:{hashlib.sha1(raw.encode('utf-8')).hexdigest()}"


def cached(key: str, ttl: int, produce: Callable[[], Any]) -> Any:
    """Memoise a successful upstream payload. Failures are never cached.

    `produce` raising means nothing is stored, so a source having a bad minute
    does not poison the next thirty. The sentinel matters: an upstream that
    legitimately returns an empty list should be remembered as empty rather
    than re-fetched on every keystroke.
    """
    hit = cache.get(key, _MISS)
    if hit is not _MISS:
        return hit
    value = produce()
    cache.set(key, value, ttl)
    return value


class _Missing:
    __slots__ = ()


_MISS = _Missing()


def fan_out(
    tasks: dict[str, Callable[[], Any]],
    *,
    budget: float = FANOUT_BUDGET,
) -> tuple[dict[str, Any], dict[str, BaseException | None]]:
    """Run every task at once; return what answered and what went wrong.

    Returns `(results, errors)`. `results` holds one entry per task that
    finished cleanly. `errors` maps a task name to the exception it raised, or
    to `None` when it was still running when the budget expired -- the caller
    turns both into the reader-facing `sources[]` entry, because deciding what
    a failure *means* is a presentation question and this module has no
    business answering it.

    The pool is shut down without waiting. A source still stuck on a socket
    after the budget has expired must not hold the response open -- its thread
    is left to die on its own timeout.
    """
    if not tasks:
        return {}, {}

    results: dict[str, Any] = {}
    errors: dict[str, BaseException | None] = {}

    pool = ThreadPoolExecutor(max_workers=len(tasks))
    try:
        futures = {pool.submit(fn): name for name, fn in tasks.items()}
        # Waiting on all of them with a timeout is what gives the fan-out its
        # single wall-clock budget: whatever is still pending when it expires
        # is a failure, not a delay.
        done, pending = wait(futures, timeout=budget)
        for future in done:
            name = futures[future]
            try:
                results[name] = future.result()
            except Exception as exc:
                logger.warning("search source failed: %s", name, exc_info=True)
                errors[name] = exc
        for future in pending:
            future.cancel()
            logger.warning("search source abandoned after %.0fs: %s", budget, futures[future])
            errors[futures[future]] = None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    return results, errors
