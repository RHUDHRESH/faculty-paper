"""College-wide figures, worked out once and shared until something changes.

The home screens of the office, the Principal and the Director each open with
figures about the whole college -- the fault checks, the publication report --
that are identical for every one of those readers and cost tens of queries to
work out. On the free plan the API has a tenth of a CPU, so the second person
to open a home screen was paying the full price again for the same numbers.

The rule is that nobody sees a figure a write has already changed:

* every saved or deleted row of this app moves a generation counter
  (`post_save` / `post_delete`, wired in `CoreConfig.ready`), and
* every write request moves it too (`BumpOnWriteMiddleware`), which covers the
  bulk `.update()` calls that send no signal.

The generation is part of the cache key, so a moved counter makes every stored
figure unreachable at once. The short expiry is the backstop for the one path
neither can see: the job worker is a separate process with its own memory, and
an import it runs is visible here within `AGGREGATE_CACHE_SECONDS`.

Only figures that are the same for every reader allowed to see them belong
here. Anything that depends on who is asking stays uncached.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

from django.conf import settings
from django.core.cache import cache

_GENERATION = "aggregates:generation"
_SAFE = {"GET", "HEAD", "OPTIONS"}


def _seconds() -> int:
    return int(getattr(settings, "AGGREGATE_CACHE_SECONDS", 30))


def generation() -> int:
    value = cache.get(_GENERATION)
    if value is None:
        cache.add(_GENERATION, 1, None)
        value = cache.get(_GENERATION, 1)
    return int(value)


def bump(*_args: Any, **_kwargs: Any) -> None:
    """Make every stored figure stale. Cheap: one in-memory increment."""
    try:
        cache.incr(_GENERATION)
    except ValueError:
        cache.set(_GENERATION, 2, None)


def cached(name: str, params: dict[str, Any], compute: Callable[[], Any]) -> Any:
    """`compute()`, or what it returned last time for the same `params`.

    `params` must hold everything the answer depends on; it is part of the key.
    """
    ttl = _seconds()
    if ttl <= 0:
        return compute()
    digest = hashlib.sha1(
        json.dumps(params, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]
    key = f"aggregates:{name}:{generation()}:{digest}"
    hit = cache.get(key)
    if hit is not None:
        return hit
    value = compute()
    cache.set(key, value, ttl)
    return value


class BumpOnWriteMiddleware:
    """A write request of any kind moves the generation once it has run."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.method not in _SAFE:
            bump()
        return response
