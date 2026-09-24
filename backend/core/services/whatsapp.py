"""WhatsApp for money alerts, through Meta's WhatsApp Cloud API. Off unless configured.

Nothing here runs until the college sets both ``WHATSAPP_TOKEN`` and
``WHATSAPP_PHONE_ID`` (a WhatsApp Business phone number on a Meta app), and
then only for a person who has opted in on their notification settings and
has a phone number on file. It carries the money and status kinds only
(`Kind.whatsapp` in core.services.notify).

A message a business starts has to use a template Meta has approved, so this
sends ``WHATSAPP_TEMPLATE`` with two body variables -- the headline and the
detail -- rather than free text. The template has to be created and approved
in Meta's WhatsApp Manager before anything is delivered; until it is, Meta
refuses the send, which is logged and costs the in-app alert nothing.
"""
from __future__ import annotations

import logging
import re

import httpx
from django.conf import settings

logger = logging.getLogger("core.notifications")

GRAPH = "https://graph.facebook.com"
#: WhatsApp refuses template variables with newlines, tabs or long runs of
#: spaces, and caps their length.
_PARAM_LIMIT = 1000


def enabled() -> bool:
    return bool(getattr(settings, "WHATSAPP_TOKEN", "") and getattr(settings, "WHATSAPP_PHONE_ID", ""))


def normalise_phone(raw: str | None) -> str | None:
    """A phone number as WhatsApp wants it: country code and digits, no plus.

    Ten digits are read as an Indian mobile number, which is what the profile
    screen collects; a leading 0 is a trunk prefix and is dropped.
    """
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10:
        digits = "91" + digits
    return digits if 11 <= len(digits) <= 15 else None


def _param(text: str) -> str:
    return " ".join((text or "").split())[:_PARAM_LIMIT] or "-"


def send_alert(user, headline: str, detail: str) -> bool:
    """Send one alert to `user` on WhatsApp, if everything allows it. Never raises."""
    if not enabled():
        return False
    from core.models import NotificationSettings

    if not NotificationSettings.objects.filter(user=user, whatsapp_opt_in=True).exists():
        return False
    phone = normalise_phone(getattr(user, "phone", None))
    if not phone:
        return False
    url = f"{GRAPH}/{settings.WHATSAPP_API_VERSION}/{settings.WHATSAPP_PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": phone,
        "type": "template",
        "template": {
            "name": settings.WHATSAPP_TEMPLATE,
            "language": {"code": settings.WHATSAPP_TEMPLATE_LANG},
            "components": [
                {
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": _param(headline)},
                        {"type": "text", "text": _param(detail)},
                    ],
                }
            ],
        },
    }
    try:
        response = httpx.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {settings.WHATSAPP_TOKEN}"},
            timeout=10.0,
        )
        response.raise_for_status()
    except Exception:
        logger.warning("whatsapp_failed user=%s", getattr(user, "pk", None), exc_info=True)
        return False
    return True
