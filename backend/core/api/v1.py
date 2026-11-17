"""/api/v1: the read-only data API for personal tokens.

A separate NinjaAPI on purpose. The app's own API (`core.api.common.api`) uses
the session cookie and nothing else, and this one uses a bearer token and
nothing else, so a token can never reach a session endpoint and a session can
never reach these. There is no POST, PUT, PATCH or DELETE here to reach.

Each request runs as the token's user and is shaped by
`core.services.api_v1`, which applies the app's own visibility rules.
`GET /api/v1/meta` is the one route a signed-in browser may also read (it is
documentation, and the docs page has no token to send).
"""
from __future__ import annotations

from typing import Any

from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils.text import slugify
from ninja import NinjaAPI
from ninja.errors import HttpError
from ninja.security import HttpBearer, SessionAuth

from core.models import ApiToken, User
from core.services import api_tokens, api_v1
from core.services.exporters import CONTENT_TYPES


def _client_ip(request: HttpRequest) -> str:
    """The address our own proxy wrote (the rightmost hop), as the sign-in does."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    hops = [h.strip() for h in forwarded.split(",") if h.strip()]
    if hops:
        return hops[-1]
    return request.META.get("REMOTE_ADDR", "")


class TokenAuth(HttpBearer):
    """`Authorization: Bearer sec_...`. The only way into this API."""

    def authenticate(self, request: HttpRequest, token: str) -> ApiToken:
        row = api_tokens.find(token.strip())
        if row is None:
            raise api_tokens.TokenRefused(401, "That token is not valid.")
        user = api_tokens.check(row)
        api_tokens.rate_limit(row)
        api_tokens.record_use(row, _client_ip(request))
        request.user = user  # type: ignore[assignment]
        request.api_token = row  # type: ignore[attr-defined]
        return row


class _BrowserOrToken(SessionAuth):
    """For /meta only: a signed-in browser may read the documentation."""

    def authenticate(self, request: HttpRequest, key: str | None) -> Any:
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated and user.active:
            return user
        return None


v1 = NinjaAPI(
    title="Faculty Paper data API",
    version="1",
    urls_namespace="api_v1",
    docs_url=None,
    openapi_url=None,
    auth=TokenAuth(),
)


@v1.exception_handler(api_tokens.TokenRefused)
def _refused(request: HttpRequest, exc: api_tokens.TokenRefused) -> HttpResponse:
    response = JsonResponse({"detail": exc.message}, status=exc.status)
    for key, value in exc.headers.items():
        response[key] = value
    if exc.status == 401:
        response["WWW-Authenticate"] = "Bearer"
    response["Cache-Control"] = "no-store"
    return response


def _viewer(request: HttpRequest) -> tuple[User, ApiToken | None]:
    token = getattr(request, "api_token", None)
    return (token.user if token else request.user), token  # type: ignore[return-value]


def _serve(request: HttpRequest, kind: str):
    viewer, token = _viewer(request)
    scope = api_v1.FIELDS[kind]["scope"]
    if token is not None and scope not in (token.scopes or []):
        raise api_tokens.TokenRefused(403, f"This token cannot read {kind}. It needs the {scope} scope.")
    if scope not in api_tokens.scopes_for_role(viewer.role):
        raise api_tokens.TokenRefused(403, f"Your role cannot read {kind}.")
    params = api_v1.parse(request.GET)
    rows, total = api_v1.fetch(kind, viewer, params)

    query = request.GET.copy()
    has_next = params.page * params.page_size < total
    next_url = None
    if has_next:
        query["page"] = str(params.page + 1)
        next_url = f"{request.build_absolute_uri(request.path)}?{query.urlencode()}"

    if params.fmt == "json":
        response = JsonResponse(
            {"data": rows, "page": params.page, "page_size": params.page_size, "total": total, "next": next_url},
            json_dumps_params={"ensure_ascii": False},
        )
    else:
        body = api_v1.render_file(kind, viewer, rows, params.fmt)
        response = HttpResponse(body, content_type=CONTENT_TYPES[params.fmt])
        response["Content-Disposition"] = f'attachment; filename="{slugify(kind)}.{params.fmt}"'
        response["X-Total-Count"] = str(total)
        if next_url:
            response["Link"] = f'<{next_url}>; rel="next"'
    response["Cache-Control"] = "private, no-store"
    return response


@v1.get("/meta", auth=[TokenAuth(), _BrowserOrToken()])
def meta(request: HttpRequest):
    """Every endpoint, its parameters and its fields (the FIELDS registry)."""
    viewer, _token = _viewer(request)
    if viewer is None or not getattr(viewer, "is_authenticated", False):
        raise HttpError(401, "Unauthorized")
    response = JsonResponse(api_v1.meta_for(viewer))
    response["Cache-Control"] = "private, no-store"
    return response


@v1.get("/papers")
def papers(request: HttpRequest):
    return _serve(request, "papers")


@v1.get("/claims")
def claims(request: HttpRequest):
    return _serve(request, "claims")


@v1.get("/payments")
def payments(request: HttpRequest):
    return _serve(request, "payments")


@v1.get("/faculty")
def faculty(request: HttpRequest):
    return _serve(request, "faculty")


@v1.get("/teams")
def teams(request: HttpRequest):
    return _serve(request, "teams")


__all__ = ["v1", "TokenAuth"]
