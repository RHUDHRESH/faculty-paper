"""Verifying a Clerk session token, without holding a Clerk secret.

Clerk is the front door here and nothing more. It decides that somebody is
who they say they are; this system still decides what they may do, because
the role, the department, the staff id and the Scopus link all live in our
own user table and every one of them is part of deciding who gets paid.

The verification is deliberately keyless. A Clerk session token is an RS256
JWT, its signing keys are published at the instance's JWKS endpoint, and the
address of that endpoint is derivable from the *publishable* key -- which is
not a secret and is already in the browser. So `CLERK_SECRET_KEY` is not read
here, is not in the settings, and is not needed: there is no path through
this module that could leak it, because it never arrives.

What the token proves is that Clerk authenticated an email address. What it
does not prove is that the address belongs to anybody at this college, so
`auth_clerk` matches it against an account that already exists and refuses
anything else. No account is ever created from a sign-in.
"""

from __future__ import annotations

import base64
import binascii
import logging
import threading
import time
from typing import Any
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

#: How long a fetched key set is trusted before it is fetched again. Clerk
#: rotates signing keys, and a cache that never expires turns a rotation into
#: an outage that looks like "nobody can sign in and nothing changed".
_JWKS_TTL_SECONDS = 60 * 60

#: Clock skew allowed on `exp` and `nbf`. A user's machine and ours are not
#: synchronised, and a few seconds either way should not be a failed sign-in.
_LEEWAY_SECONDS = 30

_jwks_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_jwks_lock = threading.Lock()


class ClerkError(Exception):
    """Something about the token or the configuration is wrong.

    Carried back to the caller as a flat refusal. The distinction between
    "expired", "wrong signature" and "wrong instance" is useful to somebody
    probing the endpoint and useless to the person in front of the screen.
    """


def frontend_api_from_publishable_key(publishable_key: str) -> str:
    """The instance's frontend API host, read out of the publishable key.

    A publishable key is `pk_test_` or `pk_live_` followed by the host in
    base64 with a `$` terminator -- so the key alone is enough to find the
    instance, and no second setting has to be kept in step with it. Getting
    those two out of step is exactly how an instance ends up verifying tokens
    against a different instance's keys.
    """
    key = (publishable_key or "").strip()
    for prefix in ("pk_test_", "pk_live_"):
        if key.startswith(prefix):
            encoded = key[len(prefix) :]
            break
    else:
        raise ClerkError("A Clerk publishable key starts with pk_test_ or pk_live_.")

    try:
        # Base64 without padding is normal here; add the most that could be
        # missing, since the decoder ignores any excess.
        decoded = base64.b64decode(encoded + "==").decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise ClerkError("That Clerk publishable key could not be read.") from exc

    host = decoded.rstrip("$").strip()
    if not host or "/" in host or " " in host:
        raise ClerkError("That Clerk publishable key does not name an instance.")
    return host


def jwks_url(publishable_key: str) -> str:
    return f"https://{frontend_api_from_publishable_key(publishable_key)}/.well-known/jwks.json"


def _fetch_jwks(url: str) -> dict[str, Any]:
    try:
        res = requests.get(url, timeout=10)
        res.raise_for_status()
        return res.json()
    except Exception as exc:  # noqa: BLE001 - any failure here is the same failure
        raise ClerkError("Could not reach Clerk to check the sign-in.") from exc


def _jwks(url: str, *, force: bool = False) -> dict[str, Any]:
    now = time.time()
    if not force:
        with _jwks_lock:
            cached = _jwks_cache.get(url)
        if cached and now - cached[0] < _JWKS_TTL_SECONDS:
            return cached[1]

    data = _fetch_jwks(url)
    with _jwks_lock:
        _jwks_cache[url] = (now, data)
    return data


def _signing_key(token: str, url: str):
    """The key this token says it was signed with, refetching once if unknown.

    The refetch is the point. A key id we have never seen is the ordinary
    appearance of a key rotation, and treating it as a bad token would lock
    everybody out until the cache happened to expire.
    """
    import jwt

    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as exc:
        raise ClerkError("That sign-in could not be read.") from exc
    if not kid:
        raise ClerkError("That sign-in could not be read.")

    for force in (False, True):
        keys = _jwks(url, force=force).get("keys") or []
        for key in keys:
            if key.get("kid") == kid:
                return jwt.PyJWK(key).key
    raise ClerkError("That sign-in was not signed by this Clerk instance.")


def verify_clerk_token(token: str, publishable_key: str) -> dict[str, Any]:
    """Check a Clerk session token and return its claims.

    Signature, expiry and issuer are all checked. The issuer especially: a
    perfectly valid token from somebody else's Clerk instance is still a
    token from somebody else's Clerk instance, and without this it would
    open a session here.
    """
    import jwt

    if not token or not token.strip():
        raise ClerkError("No sign-in was supplied.")

    host = frontend_api_from_publishable_key(publishable_key)
    url = f"https://{host}/.well-known/jwks.json"
    key = _signing_key(token.strip(), url)

    try:
        claims = jwt.decode(
            token.strip(),
            key=key,
            algorithms=["RS256"],
            leeway=_LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "iss"], "verify_aud": False},
        )
    except jwt.PyJWTError as exc:
        logger.warning("clerk_token_rejected")
        raise ClerkError("That sign-in could not be verified.") from exc

    issuer = urlparse(str(claims.get("iss") or "")).netloc
    if issuer != host:
        logger.warning("clerk_token_wrong_issuer")
        raise ClerkError("That sign-in came from a different Clerk instance.")

    return claims


def email_from_claims(claims: dict[str, Any]) -> str | None:
    """The address Clerk authenticated, wherever this instance puts it.

    Clerk's default session token is deliberately small and need not carry an
    email at all -- it is added by a JWT template, and instances differ in
    what they call it. Several shapes are tried rather than one, because the
    failure otherwise is a sign-in that verifies perfectly and then cannot be
    matched to anybody, which reads as the account being missing.
    """
    for field in ("email", "email_address", "primary_email_address", "user_email"):
        value = claims.get(field)
        if isinstance(value, str) and "@" in value:
            return value.strip().lower()

    # Some templates nest the whole user object.
    user = claims.get("user")
    if isinstance(user, dict):
        for field in ("email", "email_address", "primary_email_address"):
            value = user.get(field)
            if isinstance(value, str) and "@" in value:
                return value.strip().lower()

    return None
