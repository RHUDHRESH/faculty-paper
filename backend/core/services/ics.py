"""iCalendar (RFC 5545) output for the subscription feed.

Hand-written rather than a dependency: the feed needs VEVENTs with stable
UIDs, all-day and timed dates, text escaping and line folding, and nothing
else. Timed events are written in UTC so no VTIMEZONE block is needed.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone as dt_tz
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone

DOMAIN = "faculty-paper"


def escape(text: str) -> str:
    """TEXT value escaping, RFC 5545 §3.3.11."""
    return (
        (text or "")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
        .replace("\r", "\\n")
    )


def fold(line: str) -> str:
    """Lines longer than 75 octets are folded with CRLF + space (§3.1),
    never splitting a UTF-8 character."""
    out: list[str] = []
    current = ""
    size = 0
    limit = 75
    for ch in line:
        n = len(ch.encode("utf-8"))
        if size + n > limit:
            out.append(current)
            current, size, limit = ch, n, 74  # continuation lines lose one to the space
        else:
            current += ch
            size += n
    out.append(current)
    return "\r\n ".join(out)


def _utc(d: date, t: time) -> str:
    local = datetime.combine(d, t).replace(tzinfo=ZoneInfo(settings.TIME_ZONE))
    return local.astimezone(dt_tz.utc).strftime("%Y%m%dT%H%M%SZ")


def vevent(
    uid: str,
    summary: str,
    starts_on: date,
    ends_on: Optional[date] = None,
    starts_at: Optional[time] = None,
    ends_at: Optional[time] = None,
    description: Optional[str] = None,
    categories: Optional[str] = None,
) -> list[str]:
    lines = ["BEGIN:VEVENT", f"UID:{uid}@{DOMAIN}", "DTSTAMP:" + timezone.now().astimezone(dt_tz.utc).strftime("%Y%m%dT%H%M%SZ")]
    if starts_at is None:
        # All-day: DTEND is exclusive, so the day after the last day.
        lines.append(f"DTSTART;VALUE=DATE:{starts_on:%Y%m%d}")
        lines.append(f"DTEND;VALUE=DATE:{(ends_on or starts_on) + timedelta(days=1):%Y%m%d}")
    else:
        lines.append("DTSTART:" + _utc(starts_on, starts_at))
        end_time = ends_at or (datetime.combine(date.min, starts_at) + timedelta(hours=1)).time()
        end_day = ends_on or starts_on
        if ends_at is None and end_time < starts_at:
            end_day += timedelta(days=1)
        lines.append("DTEND:" + _utc(end_day, end_time))
    lines.append("SUMMARY:" + escape(summary))
    if description:
        lines.append("DESCRIPTION:" + escape(description))
    if categories:
        lines.append("CATEGORIES:" + escape(categories))
    lines.append("END:VEVENT")
    return lines


def from_event(e: Any) -> list[str]:
    return vevent(
        f"event-{e.id}", e.title, e.starts_on, e.ends_on, e.starts_at, e.ends_at,
        e.description, e.get_kind_display(),
    )


def from_record(r: dict[str, Any]) -> list[str]:
    """A record entry, by its title and date only: the amount stays behind."""
    start = date.fromisoformat(r["starts_on"])
    end = None
    if r.get("whole_month"):
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    return vevent(r["id"], r["title"], start, end, categories=r.get("kind_label"))


def calendar(events: Iterable[list[str]], name: str) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:-//{DOMAIN}//calendar feed//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:" + escape(name),
        "X-PUBLISHED-TTL:PT1H",
    ]
    for ev in events:
        lines.extend(ev)
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(line) for line in lines) + "\r\n"
