"""Personal API tokens: create, verify, rate-limit, count.

A token lets one person read their own data from Excel, Google Sheets, Python
or Power BI. It runs as that person with exactly that person's permissions,
reads only (the router that accepts it has no write route), and can be revoked
by its owner or a super admin at any time.

Only a SHA-256 of the secret is stored. The secret is 40 url-safe characters
from `secrets` (240 bits), so a plain digest is enough: there is nothing to
brute-force and no key to lose when SECRET_KEY rotates.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from datetime import timedelta
from typing import Any

from django.core.cache import cache
from django.db.models import F
from django.utils import timezone

from core.models import ApiToken, ApiTokenUsage, Role, SystemSetting, User
from core.services import rbac

TOKEN_PREFIX = "sec_"
SECRET_CHARS = 40
#: Characters of the secret kept in the clear, so a person can tell tokens apart.
PREFIX_LEN = 8

SCOPES = ("read:papers", "read:claims", "read:payments", "read:faculty", "read:teams")

SCOPE_LABELS = {
    "read:papers": "Papers: the publication record",
    "read:claims": "Claims: incentive claims you may see",
    "read:payments": "Payments: the paid ledger",
    "read:faculty": "Faculty: the directory and Scopus links",
    "read:teams": "Teams: final-year project teams",
}

DEFAULT_LIFETIME_DAYS = 365
MAX_LIFETIME_DAYS = 730
MAX_ACTIVE_TOKENS = 20
#: Requests per token per minute.
RATE_LIMIT = 60
RATE_WINDOW = 60

SETTING_KEY = "api_access"


# ------------------------------------------------------------------ scopes --


def scopes_for_role(role: str) -> list[str]:
    """The scopes a role may hold: what it can read in the app itself.

    A head of department is money-blind, and `/payments` is nothing but money,
    so that scope is not offered to one (the app refuses a head its money
    screens the same way).
    """
    out = list(SCOPES)
    if role == Role.HOD:
        out.remove("read:payments")
    return out


def clean_scopes(role: str, scopes: Any) -> list[str]:
    allowed = scopes_for_role(role)
    if not isinstance(scopes, (list, tuple)) or not scopes:
        raise ValueError("Choose at least one thing the token may read.")
    seen: list[str] = []
    for s in scopes:
        if s not in SCOPES:
            raise ValueError(f"{s!r} is not something a token can read.")
        if s not in allowed:
            raise ValueError("Your role cannot read that, so a token cannot either.")
        if s not in seen:
            seen.append(s)
    return seen


# --------------------------------------------------------- the role switch --


def _off_roles() -> set[str]:
    row = SystemSetting.objects.filter(key=SETTING_KEY).first()
    value = row.value if row and isinstance(row.value, dict) else {}
    off = value.get("off") or []
    return {r for r in off if isinstance(r, str)}


def access_by_role() -> dict[str, bool]:
    """Every role, and whether its people may use API tokens. Default on."""
    off = _off_roles()
    return {role.value: role.value not in off for role in Role}


def role_enabled(role: str) -> bool:
    return role not in _off_roles()


def set_role_enabled(role: str, enabled: bool, actor: User | None) -> None:
    if role not in Role.values:
        raise ValueError("That is not a role.")
    off = _off_roles()
    if enabled:
        off.discard(role)
    else:
        off.add(role)
    SystemSetting.objects.update_or_create(
        key=SETTING_KEY, defaults={"value": {"off": sorted(off)}, "updated_by": actor}
    )


# ------------------------------------------------------------------ tokens --


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def new_secret() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(48)[:SECRET_CHARS]


def create(user: User, name: str, scopes: Any, expires_in_days: int | None = None) -> tuple[ApiToken, str]:
    """A new token and its secret. The secret exists only in this return value."""
    name = (name or "").strip()
    if not 1 <= len(name) <= 80:
        raise ValueError("Give the token a name of 1 to 80 characters.")
    cleaned = clean_scopes(user.role, scopes)
    days = DEFAULT_LIFETIME_DAYS if expires_in_days is None else int(expires_in_days)
    if not 1 <= days <= MAX_LIFETIME_DAYS:
        raise ValueError(f"A token lasts between 1 and {MAX_LIFETIME_DAYS} days.")
    if active_for(user).count() >= MAX_ACTIVE_TOKENS:
        raise ValueError(f"You have {MAX_ACTIVE_TOKENS} active tokens. Revoke one first.")
    secret = new_secret()
    token = ApiToken.objects.create(
        user=user,
        name=name,
        prefix=secret[:PREFIX_LEN],
        secret_hash=hash_secret(secret),
        scopes=cleaned,
        expires_at=timezone.now() + timedelta(days=days),
    )
    return token, secret


def active_for(user: User):
    now = timezone.now()
    return ApiToken.objects.filter(user=user, revoked_at__isnull=True).exclude(expires_at__lte=now)


def status_of(token: ApiToken) -> str:
    if token.revoked_at:
        return "revoked"
    if token.expires_at and token.expires_at <= timezone.now():
        return "expired"
    return "active"


def revoke(token: ApiToken, actor: User) -> None:
    if token.revoked_at:
        return
    token.revoked_at = timezone.now()
    token.revoked_by = actor
    token.save(update_fields=["revoked_at", "revoked_by"])


class TokenRefused(Exception):
    """The presented token cannot be used. `status` is the HTTP status."""

    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers or {}


def find(secret: str) -> ApiToken | None:
    """The token a presented secret belongs to, compared in constant time."""
    if not secret.startswith(TOKEN_PREFIX) or len(secret) != len(TOKEN_PREFIX) + SECRET_CHARS:
        return None
    digest = hash_secret(secret)
    token = ApiToken.objects.select_related("user").filter(secret_hash=digest).first()
    if token is None or not hmac.compare_digest(token.secret_hash, digest):
        return None
    return token


def check(token: ApiToken) -> User:
    """The token's user, or `TokenRefused` saying why not."""
    if token.revoked_at:
        raise TokenRefused(401, "This token has been revoked.")
    if token.expires_at and token.expires_at <= timezone.now():
        raise TokenRefused(401, "This token has expired. Create a new one.")
    user = token.user
    if not user.active:
        raise TokenRefused(401, "This account is no longer active.")
    if not role_enabled(user.role):
        raise TokenRefused(403, "API access is switched off for your role.")
    return user


def rate_limit(token: ApiToken) -> None:
    """60 requests a minute per token, fixed window, with Retry-After."""
    epoch = int(time.time()) // RATE_WINDOW
    key = f"apitoken:rate:{token.pk}:{epoch}"
    try:
        seen = cache.incr(key)
    except ValueError:
        cache.set(key, 1, RATE_WINDOW + 5)
        seen = 1
    if seen > RATE_LIMIT:
        wait = max(1, int((epoch + 1) * RATE_WINDOW - time.time()))
        raise TokenRefused(
            429,
            f"That is more than {RATE_LIMIT} requests a minute. Try again in {wait} seconds.",
            {"Retry-After": str(wait)},
        )


def record_use(token: ApiToken, ip: str) -> None:
    """Count one request. `update()` and `bulk_create` send no signal, so a
    request never makes the shared college figures stale."""
    now = timezone.now()
    ApiToken.objects.filter(pk=token.pk).update(
        last_used_at=now, last_used_ip=(ip or "")[:64], use_count=F("use_count") + 1
    )
    day = timezone.localdate()
    changed = ApiTokenUsage.objects.filter(token=token, day=day).update(count=F("count") + 1)
    if not changed:
        ApiTokenUsage.objects.bulk_create(
            [ApiTokenUsage(token=token, day=day, count=0)], ignore_conflicts=True
        )
        ApiTokenUsage.objects.filter(token=token, day=day).update(count=F("count") + 1)


def usage_by_day(token: ApiToken, days: int = 30) -> list[dict[str, Any]]:
    since = timezone.localdate() - timedelta(days=days)
    return [
        {"day": d.isoformat(), "count": n}
        for d, n in ApiTokenUsage.objects.filter(token=token, day__gte=since)
        .order_by("day")
        .values_list("day", "count")
    ]


def to_dict(token: ApiToken, *, owner: bool = False) -> dict[str, Any]:
    """A token as listed. Never the secret or its hash."""
    out = {
        "id": token.id,
        "name": token.name,
        "prefix": token.prefix,
        "scopes": list(token.scopes or []),
        "status": status_of(token),
        "created_at": token.created_at.isoformat(),
        "last_used_at": token.last_used_at.isoformat() if token.last_used_at else None,
        "use_count": token.use_count,
        "expires_at": token.expires_at.isoformat() if token.expires_at else None,
        "revoked_at": token.revoked_at.isoformat() if token.revoked_at else None,
    }
    if owner:
        out["last_used_ip"] = token.last_used_ip or None
    return out


def office_can_see_all(role: str) -> bool:
    return role == Role.SUPER_ADMIN and rbac.can_admin_portal(role)
