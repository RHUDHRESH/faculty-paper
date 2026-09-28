"""Research scout: POST starts a run (or returns today's), GET polls it.

See core.services.scout. One fresh answer per person is reused for 24 hours;
at most ``scout.DAILY_LIMIT`` runs per person per day. No money, no usage.
"""

from __future__ import annotations

from datetime import timedelta

from django.http import HttpRequest
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.models import ScoutRun
from core.services import scout


STUCK_AFTER = timedelta(minutes=15)


class ScoutIn(Schema):
    refresh: bool = False


@api.get("/scout", auth=session_auth)
def scout_latest(request: HttpRequest):
    user = require_user(request)
    run = ScoutRun.objects.filter(user=user).first()
    return hod.without_money(scout.as_payload(run, user))


@api.post("/scout", auth=session_auth)
def scout_start(request: HttpRequest, payload: ScoutIn | None = None):
    user = require_user(request)
    # Say so now, rather than queue a run that can only fail in the worker and
    # leave the page on "Scouting..." -- and spend one of today's runs doing it.
    if scout.ai.provider_name() != "anthropic" or scout.anthropic_provider.missing_settings():
        raise HttpError(503, "The research scout is not switched on here yet. The research office can turn it on.")
    latest = ScoutRun.objects.filter(user=user).first()
    if latest and latest.status == ScoutRun.Status.QUEUED and latest.created_at < timezone.now() - STUCK_AFTER:
        # Nothing picked it up; let the person try again instead of waiting forever.
        latest.status, latest.error, latest.error_code = ScoutRun.Status.FAILED, "The scout did not start.", "stuck"
        latest.finished_at = timezone.now()
        latest.save()
    if latest and latest.status in (ScoutRun.Status.QUEUED, ScoutRun.Status.RUNNING):
        return scout.as_payload(latest, user)
    fresh = scout.fresh_run(user)
    if fresh and not (payload and payload.refresh):
        return hod.without_money(scout.as_payload(fresh, user))
    if scout.runs_today(user) >= scout.DAILY_LIMIT:
        raise HttpError(429, f"You have used today's {scout.DAILY_LIMIT} scout runs. Try again tomorrow.")
    run = ScoutRun.objects.create(user=user)
    from django_q.tasks import async_task

    async_task("core.tasks.run_scout", run.id, timeout=600)
    return scout.as_payload(run, user)


__all__ = ["scout_latest", "scout_start"]
