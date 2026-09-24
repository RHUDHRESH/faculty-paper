"""Who looked at whose profile, told plainly and never counted twice.

Call `record_profile_view(viewer, viewed)` wherever a profile is opened (or
POST /api/profile-views from the page). It records nothing when:

- somebody looks at their own profile;
- the viewer has switched off "Let people know when I view their profile"
  (NotificationSettings.share_profile_views) -- then the view is not stored at
  all, so there is nothing to leak later;
- the same viewer already looked at the same person today.

The person viewed hears about it as one line a week that names who looked --
"Ravi and Asha viewed your profile" -- and can switch that kind off. Names, not
a teaser count: a "3 people viewed your profile" that hides who is there to
bring you back to the app, which is the pattern this product does not use.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.utils import timezone

from core.models import ProfileView, User
from core.services.notify import notify, settings_for


def _day_start(now):
    return timezone.localtime(now).replace(hour=0, minute=0, second=0, microsecond=0)


def record_profile_view(viewer: User | None, viewed: User | None, now=None) -> ProfileView | None:
    """Record one view and tell the person viewed. Returns the view, or None."""
    if viewer is None or viewed is None or viewer.pk == viewed.pk:
        return None
    if not settings_for(viewer).share_profile_views:
        return None
    now = now or timezone.now()
    if ProfileView.objects.filter(viewer=viewer, viewed=viewed, at__gte=_day_start(now)).exists():
        return None
    view = ProfileView.objects.create(viewer=viewer, viewed=viewed, at=now)
    year, week, _ = timezone.localtime(now).isocalendar()
    notify(
        viewed,
        "profile_view",
        verb="viewed your profile",
        actor=viewer,
        href="/me",
        group_key=f"profile_view:{year}-{week:02d}",
    )
    return view


def recent_viewers(user: User, days: int = 30) -> dict[str, Any]:
    """The distinct people who looked at `user` in the last `days` days."""
    since = timezone.now() - timedelta(days=days)
    seen: dict[str, dict[str, Any]] = {}
    for view in (
        ProfileView.objects.filter(viewed=user, at__gte=since)
        .select_related("viewer")
        .order_by("-at")
    ):
        if view.viewer_id in seen or not view.viewer.active:
            continue
        seen[view.viewer_id] = {
            "id": view.viewer_id,
            "name": view.viewer.name or view.viewer.email,
            "department": view.viewer.department or "",
            "at": view.at.isoformat(),
        }
    return {"days": days, "count": len(seen), "viewers": list(seen.values())}
