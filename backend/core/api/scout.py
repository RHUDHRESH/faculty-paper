"""Research scout: POST starts a run (or returns today's), GET polls it.

See core.services.scout. One fresh answer per person is reused for 24 hours;
at most ``scout.DAILY_LIMIT`` runs per person per day. No money, no usage.

The scout searches the web through Claude and so cannot run on any other
provider. There, both routes answer ``{"available": false, "moved_to":
"/compass"}`` with a 200, and the screen goes to the research compass, which
works on every provider and with none.
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

#: What the scout says where it cannot run: where its work is done instead.
MOVED = {"available": False, "moved_to": "/compass"}


class ScoutIn(Schema):
    refresh: bool = False


def _on_claude() -> bool:
    return scout.ai.provider_name() == "anthropic" and not scout.anthropic_provider.missing_settings()


def _latest(user) -> ScoutRun | None:
    """The newest run, with one that no worker ever picked up marked failed.

    Without this, a run queued while the worker was down kept the page on
    "Scouting..." forever.
    """
    run = ScoutRun.objects.filter(user=user).first()
    if run and run.status == ScoutRun.Status.QUEUED and run.created_at < timezone.now() - STUCK_AFTER:
        run.status, run.error, run.error_code = ScoutRun.Status.FAILED, "The scout did not start. Try again.", "stuck"
        run.finished_at = timezone.now()
        run.save()
    return run


@api.get("/scout", auth=session_auth)
def scout_latest(request: HttpRequest):
    user = require_user(request)
    if not _on_claude():
        return dict(MOVED)
    return hod.without_money(scout.as_payload(_latest(user), user))


@api.post("/scout", auth=session_auth)
def scout_start(request: HttpRequest, payload: ScoutIn | None = None):
    user = require_user(request)
    # Say so now, rather than queue a run that can only fail in the worker and
    # leave the page on "Scouting..." -- and spend one of today's runs doing it.
    if not _on_claude():
        return dict(MOVED)
    latest = _latest(user)
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
