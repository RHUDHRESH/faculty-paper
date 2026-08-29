"""sign-in, sessions, passwords.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _notify_admin_users, api, logger, session_auth
from core.api.schemas import LoginIn
from core.api.deps import _me_dict, _user_dict, require_user

import json
import time
import uuid as uuid_lib
from typing import Optional
from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.http import HttpRequest
from django.middleware.csrf import get_token
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, ProfileChangeRequest, Role, User

# ---------- auth ----------


@api.get("/auth/csrf")
def csrf(request: HttpRequest):
    return {"csrfToken": get_token(request)}


#: Failed sign-ins per (email, source IP) before the account is briefly locked.
_LOGIN_MAX_FAILURES = 10
_LOGIN_LOCKOUT_SECONDS = 15 * 60
#: After this many misses the error starts telling the person how to recover.
_LOGIN_HINT_AFTER = 3


def _login_unlock_epoch(email: str) -> str:
    from django.core.cache import cache

    return str(cache.get(f"login-unlock:{email}", "0"))


def clear_login_lockout(email: str) -> None:
    """Unlock an account immediately — used by the admin password resets.

    Rotating the epoch orphans every failure counter for the email without
    needing to know which IPs the failures came from.
    """
    from django.core.cache import cache

    cache.set(
        f"login-unlock:{email.strip().lower()}",
        uuid_lib.uuid4().hex,
        _LOGIN_LOCKOUT_SECONDS * 2,
    )


def _client_ip(request: HttpRequest) -> str:
    """The address a proxy vouched for, not the one the client claimed.

    X-Forwarded-For is a list the client writes the first entry of and each
    proxy appends to, so the leftmost value is attacker-controlled. Taking it
    meant a fresh header per request produced a fresh lockout bucket every
    time, and the ten-attempt limit never fired -- unlimited password guessing
    against 508 accounts, several of which can move money.

    The rightmost entry is the one our own proxy wrote, so it is the last one
    nobody downstream could forge.
    """
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.META.get("REMOTE_ADDR", "")


def _login_throttle_key(request: HttpRequest, email: str) -> str:
    # The email is in the key as well as the address, so a rotating proxy pool
    # still cannot get more than the allowance for the account it is guessing.
    return f"login-fail:{_login_unlock_epoch(email)}:{email}:{_client_ip(request)}"


@api.post("/auth/login")
def auth_login(request: HttpRequest, payload: LoginIn):
    import time as _time

    from django.core.cache import cache

    email = payload.email.strip().lower()
    key = _login_throttle_key(request, email)
    state = cache.get(key) or {"n": 0, "ts": 0.0}
    now = _time.time()
    if state["n"] >= _LOGIN_MAX_FAILURES:
        remaining = int(max(0.0, state["ts"] + _LOGIN_LOCKOUT_SECONDS - now))
        if remaining > 0:
            minutes = max(1, -(-remaining // 60))
            logger.warning("login_throttled email=%s remaining=%ss", email, remaining)
            raise HttpError(
                429,
                f"Too many failed sign-ins — locked for about {minutes} more "
                f"minute{'s' if minutes != 1 else ''}. The research cell can reset "
                "your password to unlock it immediately.",
            )
        state = {"n": 0, "ts": 0.0}
    user = authenticate(request, username=email, password=payload.password)
    if not user:
        state = {"n": state["n"] + 1, "ts": now}
        cache.set(key, state, _LOGIN_LOCKOUT_SECONDS)
        if state["n"] >= _LOGIN_MAX_FAILURES:
            logger.warning("login_failed_lockout email=%s", email)
        if state["n"] >= _LOGIN_HINT_AFTER:
            raise HttpError(
                401,
                "Invalid credentials. Forgotten your password? "
                "The research cell can reset it for you.",
            )
        raise HttpError(401, "Invalid credentials")
    if not getattr(user, "active", True):
        raise HttpError(403, "Inactive account")
    cache.delete(key)
    login(request, user)
    return _user_dict(user)


class GoogleSignInIn(Schema):
    #: The ID token the browser got from Google Identity Services.
    credential: str


@api.get("/auth/google/config", auth=None)
def google_config(request: HttpRequest):
    """What the sign-in page needs to draw the Google button, or why it cannot.

    Answered rather than left to fail: with no client id configured the button
    would render, be pressed, and do nothing, which reads as the account being
    broken. The page asks first and shows the password form alone instead.
    """
    client_id = (getattr(settings, "GOOGLE_OAUTH_CLIENT_ID", "") or "").strip()
    return {
        "enabled": bool(client_id),
        "client_id": client_id or None,
        "hosted_domain": (getattr(settings, "GOOGLE_HOSTED_DOMAIN", "") or "").strip() or None,
    }


@api.post("/auth/google", auth=None)
def auth_google(request: HttpRequest, payload: GoogleSignInIn):
    """Sign in with a Google ID token, into an account that already exists.

    Verified server-side against Google's public keys, with our own client id
    as the audience. The token the browser hands over is the only thing that
    crosses, and a token minted for somebody else's application will not
    verify against ours -- which is the whole reason this is not "trust the
    email the client sent us".

    **No account is ever created here.** An address Google recognises and this
    college does not is refused. Accounts carry staff ids, biometric ids and a
    Scopus link; they decide who gets paid, and letting anybody with a Google
    account mint one would put a payable identity behind a free signup form.
    """
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token

    client_id = (getattr(settings, "GOOGLE_OAUTH_CLIENT_ID", "") or "").strip()
    if not client_id:
        raise HttpError(503, "Google sign-in is not configured on this server.")

    try:
        claims = google_id_token.verify_oauth2_token(
            payload.credential, google_requests.Request(), client_id
        )
    except Exception:
        # Deliberately not echoed back. The reasons a token fails to verify
        # (expired, wrong audience, bad signature) are useful to an attacker
        # and useless to the person in front of the screen.
        logger.warning("google_signin_rejected")
        raise HttpError(401, "That Google sign-in could not be verified. Try again.")

    if not claims.get("email_verified"):
        raise HttpError(403, "That Google account has no verified email address.")

    hosted = (getattr(settings, "GOOGLE_HOSTED_DOMAIN", "") or "").strip()
    if hosted and (claims.get("hd") or "").lower() != hosted.lower():
        raise HttpError(403, f"Sign in with your {hosted} account.")

    email = (claims.get("email") or "").strip().lower()
    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        raise HttpError(
            403,
            f"There is no account here for {email}. Ask the research cell to "
            "create one — signing in with Google does not make one.",
        )
    if not user.active:
        raise HttpError(403, "That account is not active.")

    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    clear_login_lockout(user.email)
    AuditLog.objects.create(
        actor=user, action="LOGIN_GOOGLE", entity="User", entity_id=user.id
    )
    return _me_dict(request, user)


class ClerkSignInIn(Schema):
    #: The session token the browser got from Clerk.
    token: str


@api.get("/auth/clerk/config", auth=None)
def clerk_config(request: HttpRequest):
    """What the sign-in page needs to start Clerk, or why it cannot.

    Answered rather than left to fail, for the same reason as the Google one:
    a button that renders, is pressed, and does nothing reads as the account
    being broken rather than the feature being off.
    """
    key = (getattr(settings, "CLERK_PUBLISHABLE_KEY", "") or "").strip()
    return {"enabled": bool(key), "publishable_key": key or None}


@api.post("/auth/clerk", auth=None)
def auth_clerk(request: HttpRequest, payload: ClerkSignInIn):
    """Sign in with a Clerk session token, into an account that already exists.

    Clerk is the front door and nothing more. It establishes that somebody is
    who they say they are; everything about what they may then do -- the role,
    the department, whether they see a rupee figure at all -- stays in our own
    user table, because every one of those is part of deciding who gets paid.

    The token is verified against the instance's published signing keys, and
    its issuer is checked: a perfectly valid token from somebody else's Clerk
    instance is still somebody else's token.

    **No account is ever created here**, exactly as with Google. An address
    Clerk recognises and this college does not is refused. Accounts carry
    staff ids, biometric ids and a Scopus link, and putting a payable identity
    behind a free signup form is not a thing that can be allowed.
    """
    from core import clerk as clerk_auth

    key = (getattr(settings, "CLERK_PUBLISHABLE_KEY", "") or "").strip()
    if not key:
        raise HttpError(503, "Clerk sign-in is not configured on this server.")

    try:
        claims = clerk_auth.verify_clerk_token(payload.token, key)
    except clerk_auth.ClerkError as exc:
        logger.warning("clerk_signin_rejected")
        raise HttpError(401, str(exc))

    email = clerk_auth.email_from_claims(claims)
    if not email:
        # Clerk's default session token carries no email; it is added by a JWT
        # template. Say so, because the alternative is a sign-in that verifies
        # perfectly and then fails to match anybody, which reads as the
        # account being missing rather than the instance being unconfigured.
        raise HttpError(
            403,
            "That Clerk sign-in carried no email address, so it cannot be "
            "matched to an account here. The Clerk session token needs an "
            "email claim.",
        )

    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        raise HttpError(
            403,
            f"There is no account here for {email}. Ask the research cell to "
            "create one — signing in with Clerk does not make one.",
        )
    if not user.active:
        raise HttpError(403, "That account is not active.")

    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    clear_login_lockout(user.email)
    AuditLog.objects.create(
        actor=user, action="LOGIN_CLERK", entity="User", entity_id=user.id
    )
    return _me_dict(request, user)


@api.post("/auth/logout", auth=session_auth)
def auth_logout(request: HttpRequest):
    logout(request)
    return {"ok": True}


@api.get("/auth/me", auth=session_auth)
def auth_me(request: HttpRequest):
    u = require_user(request)
    # Carries the impersonation banner: a viewer must always be able to tell
    # whose session they are looking at.
    return _me_dict(request, u)


class ProfileUpdateIn(Schema):
    """Nothing on a profile is self-service any more.

    staff_id, biometric_id and department were already server-owned: they decide
    who gets paid and where the ticket sits. Name, designation and the Scopus
    link have joined them, because they are equally identity — a Scopus link
    pointed at somebody else's profile is how a claim gets attributed to the
    wrong author. Every field is changed by a super admin via
    PATCH /admin/users/{id}; a claimant raises a correction request instead.
    """

    #: Retained so an existing client gets a clear refusal rather than a 422.
    name: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None


class CorrectionRequestIn(Schema):
    field: str
    proposed: str
    note: Optional[str] = None


@api.patch("/auth/profile", auth=session_auth)
def update_profile(request: HttpRequest, payload: ProfileUpdateIn):
    """Refused for everyone but a super admin.

    Every field on a profile is identity: the name on the payment, the
    designation on the claim, and the Scopus link that decides which author's
    record a paper is checked against. A claimant editing their own is how a
    claim ends up attributed to somebody else.
    """
    u = require_user(request)
    if u.role != Role.SUPER_ADMIN:
        raise HttpError(
            403,
            "Profile details are set by the research cell. Use "
            "“Request a correction” and an admin will action it.",
        )
    data = payload.dict(exclude_unset=True)
    changed = {k: v for k, v in data.items() if getattr(u, k, None) != v}
    for k, v in data.items():
        setattr(u, k, v)
    u.save()
    if changed:
        AuditLog.objects.create(
            actor=u,
            action="PROFILE_UPDATE",
            entity="User",
            entity_id=u.id,
            detail_json=json.dumps({"fields": sorted(changed)}),
        )
    return _user_dict(u)


#: What a claimant may ask to have corrected. Anything not here is not a
#: profile field they can even see.
CORRECTABLE = {
    "name": "Full name",
    "department": "Department",
    "designation": "Designation",
    "staff_id": "Staff ID",
    "biometric_id": "Biometric ID",
    "scopus_author_url": "Scopus author link",
    "scopus_author_id": "Scopus author ID",
}


#: Of those, the ones only a super admin may write -- on the profile page and
#: on the admin user editor alike. Department is deliberately absent: it is
#: routing rather than identity, and the research cell moves people between
#: departments as a matter of course.
#: How a field is named back to somebody who was refused it.
FIELD_LABELS = {
    **{k: v.lower() for k, v in CORRECTABLE.items()},
    "faculty_type": "whether this is a research post",
    "research_quota": "the research quota",
    "research_quota_note": "the research quota note",
}

IDENTITY_FIELDS = frozenset(CORRECTABLE) - {"department"} | {
    # Not a correctable field — a claimant cannot even ask for it — but it
    # belongs in the same super-admin-only tier, and for the same reason the
    # rest are here. Being marked research faculty with a quota of four means
    # four papers a year are paid nothing. The research cell processes the
    # claims that decides the outcome of, so it cannot also set it.
    "faculty_type",
    "research_quota",
    "research_quota_note",
}


@api.post("/auth/profile/correction", auth=session_auth)
def request_profile_correction(request: HttpRequest, payload: CorrectionRequestIn):
    """Ask an admin to change a detail you cannot change yourself.

    Without this, "the research cell owns your profile" means "chase somebody by
    email and hope" — so the details stay wrong and the claim stays blocked.
    """
    u = require_user(request)
    field = (payload.field or "").strip()
    proposed = (payload.proposed or "").strip()
    if field not in CORRECTABLE:
        raise HttpError(400, "That is not a profile detail you can request a change to")
    if not proposed:
        raise HttpError(400, "Say what it should be")

    current = getattr(u, field, None)
    if str(current or "").strip() == proposed:
        raise HttpError(400, f"{CORRECTABLE[field]} already says that.")

    # One open request per field. Asking twice because nothing visibly
    # happened should not put two of the same thing in the queue.
    existing = ProfileChangeRequest.objects.filter(
        user=u, field=field, status=ProfileChangeRequest.State.PENDING
    ).first()
    if existing:
        existing.proposed_value = proposed
        existing.note = (payload.note or "").strip()[:500] or None
        existing.current_value = str(current or "")
        existing.save()
        req = existing
    else:
        req = ProfileChangeRequest.objects.create(
            user=u,
            field=field,
            current_value=str(current or ""),
            proposed_value=proposed,
            note=(payload.note or "").strip()[:500] or None,
        )

    AuditLog.objects.create(
        actor=u,
        action="PROFILE_CORRECTION_REQUEST",
        entity="User",
        entity_id=u.id,
        detail_json=json.dumps({
            "request_id": req.id,
            "field": field,
            "label": CORRECTABLE[field],
            "current": str(current or ""),
            "proposed": proposed,
            "note": (payload.note or "").strip()[:500],
        }),
    )
    _notify_admin_users(
        f"Profile correction requested · {u.name or u.email}",
        f"{CORRECTABLE[field]}: “{current or 'not set'}” → “{proposed}”",
        "/admin/profile-requests",
        # Only a super admin can action an identity change, so only a super
        # admin is told about one -- a notification the reader cannot act on
        # trains them to ignore the rest.
        super_admin_only=field in IDENTITY_FIELDS,
    )
    return {
        "ok": True,
        "id": req.id,
        "field": field,
        "label": CORRECTABLE[field],
        "proposed": proposed,
        "status": req.status,
    }




__all__ = [
    'CORRECTABLE',
    'ClerkSignInIn',
    'CorrectionRequestIn',
    'FIELD_LABELS',
    'GoogleSignInIn',
    'IDENTITY_FIELDS',
    'ProfileUpdateIn',
    '_LOGIN_HINT_AFTER',
    '_LOGIN_LOCKOUT_SECONDS',
    '_LOGIN_MAX_FAILURES',
    '_client_ip',
    '_login_throttle_key',
    '_login_unlock_epoch',
    'auth_clerk',
    'auth_google',
    'auth_login',
    'auth_logout',
    'auth_me',
    'clear_login_lockout',
    'clerk_config',
    'csrf',
    'google_config',
    'request_profile_correction',
    'update_profile',
]
