"""Optional outbound email notifications (disabled unless EMAIL_NOTIFICATIONS=true)."""
from __future__ import annotations

import logging

from django.conf import settings
from django.core.mail import send_mail

logger = logging.getLogger("core.notifications")


def email_enabled() -> bool:
    return bool(getattr(settings, "EMAIL_NOTIFICATIONS", False))


def send_optional_email(to: str | None, subject: str, body: str) -> None:
    if not email_enabled() or not to:
        return
    try:
        send_mail(
            subject=subject,
            message=body,
            from_email=getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@localhost"),
            recipient_list=[to],
            fail_silently=True,
        )
    except Exception:
        logger.exception("email_failed to=%s subject=%s", to, subject)
