"""sign-in, sessions, passwords.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _notify_admin_users, api, logger, session_auth
from core.api.schemas import LoginIn
from core.api.deps import _google_link, _me_dict, _user_dict
from core.api.common import require_user

import json
import re
import time
import uuid as uuid_lib
from typing import Optional
from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.db import IntegrityError, transaction
from django.http import HttpRequest
from django.utils import timezone
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


_GOOGLE_UNVERIFIED = "That Google sign-in could not be verified. Try again."
_GOOGLE_TAKEN = (
    "That Google account already belongs to another account here, so it cannot "
    "be linked to this one. Choose a different Google account."
)


def _verified_google_claims(credential: str) -> dict:
    """The claims of a Google ID token minted for us, or an HttpError.

    Verified server-side against Google's public keys, with our own client id
    as the audience. The token the browser hands over is the only thing that
    crosses, and a token minted for somebody else's application will not
    verify against ours -- which is the whole reason this is not "trust the
    email the client sent us". Signing in and linking both come through here,
    so neither can be looser than the other.
    """
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token

    client_id = (getattr(settings, "GOOGLE_OAUTH_CLIENT_ID", "") or "").strip()
    if not client_id:
        raise HttpError(503, "Google sign-in is not configured on this server.")

    try:
        claims = google_id_token.verify_oauth2_token(
            credential, google_requests.Request(), client_id
        )
    except Exception:
        # Deliberately not echoed back. The reasons a token fails to verify
        # (expired, wrong audience, bad signature) are useful to an attacker
        # and useless to the person in front of the screen.
        logger.warning("google_token_rejected")
        raise HttpError(401, _GOOGLE_UNVERIFIED)

    if not claims.get("email_verified"):
        raise HttpError(403, "That Google account has no verified email address.")
    return claims


#: Said to somebody whose Google account opens nothing here.
GOOGLE_NOT_LINKED = (
    "This Google account is not linked to an account here. Sign in with your "
    "email and password, then link Google from your profile."
)


@api.post("/auth/google", auth=None)
def auth_google(request: HttpRequest, payload: GoogleSignInIn):
    """Sign in with a Google ID token, into an account that already exists.

    A Google account somebody linked from their profile is found by its
    subject id first, and is let in whatever its domain: they chose it while
    signed in with their password, which is how about fourteen staff with
    only a personal Gmail get Google sign-in at all. Anything else falls back
    to the address on record, whatever its domain, and the first such
    sign-in links the Google account so it keeps working if the address
    later changes.

    **No account is ever created here.** An address Google recognises and this
    college does not is refused. Accounts carry staff ids, biometric ids and a
    Scopus link; they decide who gets paid, and letting anybody with a Google
    account mint one would put a payable identity behind a free signup form.
    """
    claims = _verified_google_claims(payload.credential)

    sub = str(claims.get("sub") or "")
    user = User.objects.filter(google_sub=sub).first() if sub else None
    via = "linked"
    if user is None:
        # Not linked yet: the address on record is the link. Google has
        # verified the address belongs to whoever holds this token, and the
        # account was issued to that address -- college or personal Gmail
        # alike -- so the first Google sign-in links it for good.
        via = "email"
        email = (claims.get("email") or "").strip().lower()
        user = User.objects.filter(email__iexact=email).first() if email else None
        if user is None:
            raise HttpError(403, GOOGLE_NOT_LINKED)
        if user.active and not user.google_sub and sub:
            user.google_sub = sub
            user.google_email = email
            user.google_linked_at = timezone.now()
            try:
                with transaction.atomic():
                    user.save(update_fields=["google_sub", "google_email", "google_linked_at", "updated_at"])
                via = "email, linked now"
            except IntegrityError:
                raise HttpError(409, _GOOGLE_TAKEN)
    if not user.active:
        raise HttpError(403, "That account is not active.")

    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    clear_login_lockout(user.email)
    AuditLog.objects.create(
        actor=user, action="LOGIN_GOOGLE", entity="User", entity_id=user.id,
        detail_json=json.dumps({"via": via}),
    )
    return _me_dict(request, user)


@api.post("/auth/google/link", auth=session_auth)
def link_google(request: HttpRequest, payload: GoogleSignInIn):
    """Let a Google account sign in to the account already signed in here.

    The hosted domain is deliberately not required. This session was opened
    with the account's own password, so choosing a personal Gmail is the
    owner's explicit decision rather than a stranger's claim -- and it is the
    only way the staff who have no college Google account get it at all.

    Refused (409) when that Google account already opens another account
    here, or when its address *is* another account's email: otherwise that
    colleague pressing "Continue with Google" with their own college account
    would land in this one. Neither refusal says whose account it is.
    """
    u = require_user(request)
    claims = _verified_google_claims(payload.credential)
    sub = str(claims.get("sub") or "")
    if not sub:
        raise HttpError(401, _GOOGLE_UNVERIFIED)
    email = (claims.get("email") or "").strip().lower()

    taken = User.objects.filter(google_sub=sub).exclude(pk=u.pk).exists() or (
        bool(email) and User.objects.filter(email__iexact=email).exclude(pk=u.pk).exists()
    )
    if taken:
        raise HttpError(409, _GOOGLE_TAKEN)

    if u.google_sub == sub:
        return {"google": _google_link(u)}

    replaced = u.google_email if u.google_sub else None
    u.google_sub = sub
    u.google_email = email or None
    u.google_linked_at = timezone.now()
    try:
        with transaction.atomic():
            u.save(update_fields=["google_sub", "google_email", "google_linked_at", "updated_at"])
    except IntegrityError:
        # Two accounts linking the same Google account at the same moment:
        # the unique column decides, and the loser is told what the check
        # above would have told them.
        raise HttpError(409, _GOOGLE_TAKEN)
    AuditLog.objects.create(
        actor=u, action="GOOGLE_LINKED", entity="User", entity_id=u.id,
        detail_json=json.dumps({"google_email": email, "replaced": replaced}),
    )
    return {"google": _google_link(u)}


@api.delete("/auth/google/link", auth=session_auth)
def unlink_google(request: HttpRequest):
    """Stop a linked Google account signing in here. The password is untouched."""
    u = require_user(request)
    if u.google_sub:
        AuditLog.objects.create(
            actor=u, action="GOOGLE_UNLINKED", entity="User", entity_id=u.id,
            detail_json=json.dumps({"google_email": u.google_email}),
        )
        u.google_sub = None
        u.google_email = None
        u.google_linked_at = None
        u.save(update_fields=["google_sub", "google_email", "google_linked_at", "updated_at"])
    return {"google": None}


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


class SelfDetailsIn(Schema):
    """The details a person changes without asking anybody. Only these.

    Anything else in the body is refused outright (422) rather than dropped:
    a client that sends a staff id here and reads back a 200 would believe it
    had been saved.
    """

    model_config = {"extra": "forbid"}

    phone: Optional[str] = None
    #: A few lines on the public profile.
    bio: Optional[str] = None
    #: Attributes no claim to anybody -- unlike the Scopus link, which does,
    #: and so stays with the super admin.
    orcid_id: Optional[str] = None


#: What a phone number may look like: digits, with the spaces, dashes,
#: brackets and leading plus people actually type. Loose on purpose -- it is a
#: number somebody rings, not a key anything is matched on.
_PHONE_SHAPE = re.compile(r"^\+?[0-9 ()\-.]+$")

#: Long enough for a sentence about what somebody works on and why; a profile
#: is not a CV.
BIO_MAX_CHARS = 600

_ORCID_SHAPE = re.compile(r"^(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dX])$")


def _clean_bio(raw: Optional[str]) -> Optional[str]:
    text = (raw or "").strip()
    if len(text) > BIO_MAX_CHARS:
        raise HttpError(400, f"Keep it under {BIO_MAX_CHARS} characters — this one is {len(text)}.")
    return text or None


def _clean_orcid(raw: Optional[str]) -> Optional[str]:
    """An ORCID iD in its canonical form, or None; a 400 when the checksum is wrong.

    Accepts the bare iD or the orcid.org link people copy from their browser.
    The last character is an ISO 7064 check digit, so a typo in any of the
    other fifteen is caught here rather than printed as somebody's link.
    """
    text = (raw or "").strip()
    if not text:
        return None
    text = re.sub(r"^https?://(www\.)?orcid\.org/", "", text, flags=re.IGNORECASE).upper()
    match = _ORCID_SHAPE.match(text.replace(" ", ""))
    if not match:
        raise HttpError(400, "An ORCID iD is sixteen characters, like 0000-0002-1825-0097.")
    digits = "".join(match.groups())
    total = 0
    for ch in digits[:-1]:
        total = (total + int(ch)) * 2
    check = (12 - total % 11) % 11
    if digits[-1] != ("X" if check == 10 else str(check)):
        raise HttpError(400, "That ORCID iD does not add up — check it against orcid.org.")
    return "-".join(match.groups())


def _clean_phone(raw: Optional[str]) -> Optional[str]:
    value = " ".join((raw or "").split())
    if not value:
        return None
    digits = sum(ch.isdigit() for ch in value)
    if not _PHONE_SHAPE.match(value) or not 7 <= digits <= 15 or len(value) > 32:
        raise HttpError(
            400,
            "That does not look like a phone number. Use digits, with spaces, "
            "dashes or a leading + if you like — for example +91 98400 12345.",
        )
    return value


@api.patch("/auth/profile/self", auth=session_auth)
def update_own_details(request: HttpRequest, payload: SelfDetailsIn):
    """Change the details that are nobody's business but your own.

    `SelfDetailsIn` is the allow-list: nothing on it is paid on, checked
    against, or decides who sees what. Everything that does goes through
    /auth/profile/correction instead.
    """
    u = require_user(request)
    data = payload.dict(exclude_unset=True)
    if "phone" in data:
        data["phone"] = _clean_phone(data["phone"])
    if "bio" in data:
        data["bio"] = _clean_bio(data["bio"])
    if "orcid_id" in data:
        data["orcid_id"] = _clean_orcid(data["orcid_id"])
    changed = sorted(k for k, v in data.items() if getattr(u, k) != v)
    if changed:
        for k in changed:
            setattr(u, k, data[k])
        u.save(update_fields=[*changed, "updated_at"])
        AuditLog.objects.create(
            actor=u,
            action="PROFILE_SELF_UPDATE",
            entity="User",
            entity_id=u.id,
            # Which fields, not what they now say: a phone number does not
            # belong in a log every oversight role can read.
            detail_json=json.dumps({"fields": changed}),
        )
    return _user_dict(u)


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
    # Not a profile correction, but it belongs in the same super-admin-only
    # tier, and for the same reason the rest are here. Being marked research
    # faculty with a quota of four means four papers a year are paid nothing.
    # The research cell processes the claims that decides the outcome of, so
    # it cannot also set it.
    "faculty_type",
    "research_quota",
    "research_quota_note",
}

#: Decisions about the post rather than lines on the profile. Nobody sets
#: them for themselves, and until now nobody could even ask: somebody wrongly
#: marked research faculty -- papers zeroed up to the quota -- had no route
#: but an email. They go through the same queue, to a super admin only, and
#: approving one runs the account editor's own checks (one head per
#: department, no appointing yourself).
ACCOUNT_REQUESTABLE = {
    "role": "Role",
    "faculty_type": "Faculty type",
    "research_quota": "Research quota",
}

#: Every field a person may ask to have changed.
REQUESTABLE = {**CORRECTABLE, **ACCOUNT_REQUESTABLE}

#: Requests only a super admin may decide, and only a super admin is told
#: about. The role is here although the research cell may set most roles in
#: the account editor: a request is somebody asking for their own post, and
#: that is the super admin's call.
SUPER_ADMIN_DECIDES = IDENTITY_FIELDS | {"role"}

#: The research-post fields. The research coordinator runs the research
#: programme and sets these too -- whether somebody is research faculty and
#: how many papers a year their post already expects. The research cell does
#: not: it clears the claims the quota decides the outcome of.
RESEARCH_POST_FIELDS = frozenset({"faculty_type", "research_quota", "research_quota_note"})


def may_set_field(role: str, field: str) -> bool:
    """Whether this role may write a super-admin-tier profile field."""
    if role == Role.SUPER_ADMIN:
        return True
    return role == Role.RESEARCH_COORDINATOR and field in RESEARCH_POST_FIELDS


def _requested_value(field: str, raw: str) -> str:
    """`raw` in the form the field is stored in, or a 400 saying what is wanted.

    Checked when asked, not only when approved: a request for a role nothing
    recognises would otherwise sit in the queue until a super admin found out
    it could never be applied.
    """
    if field == "role":
        from core.api.admin import ASSIGNABLE_ROLES

        value = raw.upper()
        if value not in ASSIGNABLE_ROLES:
            raise HttpError(400, "That is not a role anybody here can hold.")
        return value
    if field == "faculty_type":
        value = raw.upper()
        if value not in ("REGULAR", "RESEARCH"):
            raise HttpError(400, "Faculty type is either regular or research.")
        return value
    if field == "research_quota":
        if not re.fullmatch(r"[0-9]{1,3}", raw):
            raise HttpError(400, "A research quota is a whole number of papers a year.")
        return str(int(raw))
    return raw


@api.post("/auth/profile/correction", auth=session_auth)
def request_profile_correction(request: HttpRequest, payload: CorrectionRequestIn):
    """Ask an admin to change a detail you cannot change yourself.

    Without this, "the research cell owns your profile" means "chase somebody by
    email and hope" — so the details stay wrong and the claim stays blocked.
    """
    u = require_user(request)
    field = (payload.field or "").strip()
    proposed = (payload.proposed or "").strip()
    if field not in REQUESTABLE:
        raise HttpError(400, "That is not a profile detail you can request a change to")
    if not proposed:
        raise HttpError(400, "Say what it should be")
    proposed = _requested_value(field, proposed)
    label = REQUESTABLE[field]

    current = getattr(u, field, None)
    # A quota of 0 is a value, not a blank.
    current_text = "" if current is None else str(current)
    if current_text.strip() == proposed:
        raise HttpError(400, f"{label} already says that.")

    # One open request per field. Asking twice because nothing visibly
    # happened should not put two of the same thing in the queue.
    existing = ProfileChangeRequest.objects.filter(
        user=u, field=field, status=ProfileChangeRequest.State.PENDING
    ).first()
    if existing:
        existing.proposed_value = proposed
        existing.note = (payload.note or "").strip()[:500] or None
        existing.current_value = current_text
        existing.save()
        req = existing
    else:
        req = ProfileChangeRequest.objects.create(
            user=u,
            field=field,
            current_value=current_text,
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
            "label": label,
            "current": current_text,
            "proposed": proposed,
            "note": (payload.note or "").strip()[:500],
        }),
    )
    _notify_admin_users(
        f"Profile correction requested · {u.name or u.email}",
        f"{label}: “{current_text or 'not set'}” → “{proposed}”",
        "/admin/profile-requests",
        # Only a super admin can action an identity change, so only a super
        # admin is told about one -- a notification the reader cannot act on
        # trains them to ignore the rest.
        super_admin_only=field in SUPER_ADMIN_DECIDES,
    )
    return {
        "ok": True,
        "id": req.id,
        "field": field,
        "label": label,
        "proposed": proposed,
        "status": req.status,
    }




__all__ = [
    'ACCOUNT_REQUESTABLE',
    'CORRECTABLE',
    'ClerkSignInIn',
    'CorrectionRequestIn',
    'FIELD_LABELS',
    'GoogleSignInIn',
    'IDENTITY_FIELDS',
    'ProfileUpdateIn',
    'REQUESTABLE',
    'SUPER_ADMIN_DECIDES',
    'RESEARCH_POST_FIELDS',
    'may_set_field',
    'BIO_MAX_CHARS',
    '_clean_bio',
    '_clean_orcid',
    'SelfDetailsIn',
    '_GOOGLE_TAKEN',
    '_GOOGLE_UNVERIFIED',
    '_LOGIN_HINT_AFTER',
    '_LOGIN_LOCKOUT_SECONDS',
    '_LOGIN_MAX_FAILURES',
    '_PHONE_SHAPE',
    '_clean_phone',
    '_client_ip',
    '_login_throttle_key',
    '_login_unlock_epoch',
    '_requested_value',
    '_verified_google_claims',
    'auth_clerk',
    'auth_google',
    'auth_login',
    'auth_logout',
    'auth_me',
    'clear_login_lockout',
    'clerk_config',
    'csrf',
    'google_config',
    'link_google',
    'request_profile_correction',
    'unlink_google',
    'update_own_details',
    'update_profile',
]
