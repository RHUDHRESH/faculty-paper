"""Connect Google Calendar: the consent hand-off, the encrypted token, the sync.

Google is never called. The Calendar client is replaced by `FakeGoogle`, which
keeps events in a dict and answers 404/410 the way Google does for something
that is gone, and the two network steps of the consent flow (the code exchange
and the ID-token check) are replaced at their seams. Every secret here is a
placeholder invented for the test.
"""
from __future__ import annotations

import itertools
import json
from datetime import date, time, timedelta
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlparse

import httplib2
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from google.auth.exceptions import RefreshError
from googleapiclient.errors import HttpError

from core.models import CalendarEvent, GoogleCalendarLink, Role, User
from core.services import google_calendar as gc

CONFIGURED = dict(
    GOOGLE_OAUTH_CLIENT_ID="test-client.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET="test-secret-not-real",
    APP_BASE_URL="https://site.test",
)
TODAY = date(2026, 10, 7)
GRANTED = " ".join(gc.SCOPES)

#: The real builder, kept before any test replaces `gc.build_service`.
REAL_BUILD_SERVICE = gc.build_service


def http_error(status: int, reason: str = "") -> HttpError:
    resp = httplib2.Response({"status": str(status)})
    return HttpError(resp, json.dumps({"error": {"code": status, "message": reason}}).encode())


class _Req:
    def __init__(self, fn):
        self.fn = fn

    def execute(self, http=None, num_retries=0):
        return self.fn()


class FakeGoogle:
    """The few Calendar calls the sync makes, over dicts."""

    def __init__(self):
        self.calendars_by_id: dict[str, dict] = {}
        self.events_by_calendar: dict[str, dict[str, dict]] = {}
        self.gone: set[str] = set()
        self.calls: list[tuple] = []
        self._ids = itertools.count(1)

    def count(self, verb: str) -> int:
        return sum(1 for c in self.calls if c[0] == verb)

    def all_events(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for events in self.events_by_calendar.values():
            out.update(events)
        return out

    def _calendar(self, calendar_id):
        if calendar_id not in self.events_by_calendar:
            raise http_error(404, "Not Found")
        return self.events_by_calendar[calendar_id]

    # ---- service.calendars() ----
    def calendars(self):
        g = self

        class Calendars:
            def insert(self, body):
                def run():
                    cid = f"cal{next(g._ids)}@group.calendar.google.com"
                    g.calls.append(("calendar.insert", body))
                    g.calendars_by_id[cid] = body
                    g.events_by_calendar[cid] = {}
                    return {"id": cid, **body}

                return _Req(run)

            def get(self, calendarId):
                def run():
                    g.calls.append(("calendar.get", calendarId))
                    g._calendar(calendarId)
                    return {"id": calendarId, **g.calendars_by_id.get(calendarId, {})}

                return _Req(run)

            def delete(self, calendarId):
                def run():
                    g.calls.append(("calendar.delete", calendarId))
                    g._calendar(calendarId)
                    del g.events_by_calendar[calendarId]
                    return ""

                return _Req(run)

        return Calendars()

    # ---- service.events() ----
    def events(self):
        g = self

        class Events:
            def insert(self, calendarId, body):
                def run():
                    g.calls.append(("insert", calendarId, body))
                    events = g._calendar(calendarId)
                    eid = f"ev{next(g._ids)}"
                    events[eid] = body
                    return {"id": eid, "etag": f'"{eid}"', **body}

                return _Req(run)

            def patch(self, calendarId, eventId, body):
                def run():
                    g.calls.append(("patch", calendarId, eventId, body))
                    events = g._calendar(calendarId)
                    if eventId in g.gone:
                        raise http_error(410, "Resource has been deleted")
                    if eventId not in events:
                        raise http_error(404, "Not Found")
                    events[eventId] = body
                    return {"id": eventId, **body}

                return _Req(run)

            def delete(self, calendarId, eventId):
                def run():
                    g.calls.append(("delete", calendarId, eventId))
                    events = g._calendar(calendarId)
                    if eventId in g.gone:
                        raise http_error(410, "Resource has been deleted")
                    if eventId not in events:
                        raise http_error(404, "Not Found")
                    del events[eventId]
                    return ""

                return _Req(run)

        return Events()


def make_user(email, role=Role.FACULTY, department="ECE", **kw):
    return User.objects.create_user(
        email=email, password="p", name=email.split("@")[0], role=role, department=department, **kw
    )


def make_event(creator, title="Seminar on indexing", **kw):
    fields = dict(
        title=title, kind=CalendarEvent.Kind.MEETING, starts_on=date(2026, 10, 20),
        visibility="PUBLIC", created_by=creator,
    )
    fields.update(kw)
    return CalendarEvent.objects.create(**fields)


def link_for(user, **kw):
    fields = dict(
        user=user, google_email="teacher@gmail.com", calendar_id="",
        refresh_token_enc=gc.encrypt("1//placeholder-refresh-token"), scope=GRANTED,
    )
    fields.update(kw)
    return GoogleCalendarLink.objects.create(**fields)


#: These tests make a lot of users and none of them is about hashing.
FAST_HASH = dict(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])


@override_settings(**FAST_HASH)
class _Base(TestCase):
    """Two people in ECE-and-elsewhere, the office, a fake Google and a fixed today."""

    def setUp(self):
        self.office = make_user("gc-office@x.edu", Role.RESEARCH_CELL, department=None)
        self.me = make_user("gc-me@x.edu", staff_id="S-GC-1")
        self.other = make_user("gc-other@x.edu", department="MECH", staff_id="S-GC-2")
        self.fake = FakeGoogle()
        for patcher in (
            mock.patch.object(gc, "build_service", return_value=self.fake),
            mock.patch.object(gc, "local_today", return_value=TODAY),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def client_for(self, user):
        c = Client()
        c.force_login(user)
        return c


# ---------------------------------------------------------------------------
# The refresh token at rest
# ---------------------------------------------------------------------------


class TokenEncryptionTests(TestCase):
    def test_round_trip_and_not_plaintext(self):
        secret = "1//0g-placeholder-refresh-token"
        stored = gc.encrypt(secret)
        self.assertNotIn(secret, stored)
        self.assertEqual(gc.decrypt(stored), secret)
        # Fernet adds a random IV: the same text never encrypts the same way twice.
        self.assertNotEqual(gc.encrypt(secret), stored)

    def test_a_different_secret_key_cannot_read_it(self):
        stored = gc.encrypt("1//placeholder")
        with override_settings(SECRET_KEY="a-different-key"):
            with self.assertRaises(gc.NeedsReconnect):
                gc.decrypt(stored)

    def test_garbage_is_a_reconnect_not_a_crash(self):
        with self.assertRaises(gc.NeedsReconnect):
            gc.decrypt("not-a-token")


# ---------------------------------------------------------------------------
# State: signed, short-lived, bound to the person and the session
# ---------------------------------------------------------------------------


@override_settings(**CONFIGURED)
class ConnectFlowTests(_Base):
    def start(self, client):
        r = client.get("/api/calendar/google/connect")
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()["url"]
        return url, parse_qs(urlparse(url).query)

    def test_consent_url_asks_for_the_narrow_scope_offline_with_consent(self):
        url, q = self.start(self.client_for(self.me))
        self.assertTrue(url.startswith("https://accounts.google.com/"))
        self.assertEqual(q["client_id"], [CONFIGURED["GOOGLE_OAUTH_CLIENT_ID"]])
        self.assertEqual(q["redirect_uri"], ["https://site.test/api/calendar/google/callback"])
        self.assertEqual(q["access_type"], ["offline"])
        self.assertEqual(q["prompt"], ["consent"])
        self.assertEqual(q["response_type"], ["code"])
        scopes = q["scope"][0].split()
        self.assertIn("https://www.googleapis.com/auth/calendar.app.created", scopes)
        # Never the broad scope that reads the rest of somebody's calendars.
        self.assertNotIn("https://www.googleapis.com/auth/calendar", scopes)
        self.assertEqual(q["code_challenge_method"], ["S256"])
        # x.edu is not the college's Google domain here: no hint, Google's own chooser.
        self.assertNotIn("login_hint", q)

    @override_settings(GOOGLE_HOSTED_DOMAIN="x.edu")
    def test_a_college_google_address_goes_straight_to_its_account(self):
        _, q = self.start(self.client_for(self.me))
        self.assertEqual(q["login_hint"], [self.me.email])

    def test_state_is_signed_and_names_the_person(self):
        _, q = self.start(self.client_for(self.me))
        data = gc.read_state(q["state"][0])
        self.assertEqual(data["u"], self.me.pk)

    def test_tampered_state_is_refused(self):
        _, q = self.start(self.client_for(self.me))
        state = q["state"][0]
        flipped = state[:-1] + ("A" if state[-1] != "A" else "B")
        with self.assertRaises(gc.StateError):
            gc.read_state(flipped)

    def test_state_expires(self):
        _, q = self.start(self.client_for(self.me))
        real = timezone.now().timestamp()
        with mock.patch("django.core.signing.time.time", return_value=real + gc.STATE_MAX_AGE + 5):
            with self.assertRaises(gc.StateError):
                gc.read_state(q["state"][0])

    def test_connect_is_off_when_the_secret_is_missing(self):
        with override_settings(GOOGLE_OAUTH_CLIENT_SECRET=""):
            r = self.client_for(self.me).get("/api/calendar/google/connect")
        self.assertEqual(r.status_code, 409)
        self.assertIn("not switched on", r.json()["detail"].lower())

    def test_refused_while_viewing_as_somebody(self):
        c = self.client_for(self.me)
        session = c.session
        session["impersonator_id"] = self.office.pk
        session.save()
        self.assertEqual(c.get("/api/calendar/google/connect").status_code, 403)


@override_settings(**CONFIGURED)
class CallbackTests(_Base):
    def setUp(self):
        super().setUp()
        for patcher in (
            mock.patch.object(
                gc, "_exchange_code",
                return_value={"refresh_token": "1//fresh-refresh", "id_token": "jwt", "scope": GRANTED},
            ),
            mock.patch.object(gc, "_verified_email", return_value="teacher@gmail.com"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def begin(self, client):
        url = client.get("/api/calendar/google/connect").json()["url"]
        return parse_qs(urlparse(url).query)["state"][0]

    def finish(self, client, state, **extra):
        return client.get("/api/calendar/google/callback", {"code": "auth-code", "state": state, **extra})

    def test_happy_path_links_the_account_makes_the_calendar_and_syncs(self):
        make_event(self.office, "Faculty research meeting")
        make_event(self.office, "Only for MECH", visibility="DEPARTMENT", department="MECH")
        c = self.client_for(self.me)
        r = self.finish(c, self.begin(c))
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], "/calendar?google=connected")

        link = GoogleCalendarLink.objects.get(user=self.me)
        self.assertEqual(link.google_email, "teacher@gmail.com")
        self.assertNotIn("1//fresh-refresh", link.refresh_token_enc)
        self.assertEqual(gc.decrypt(link.refresh_token_enc), "1//fresh-refresh")
        self.assertFalse(link.needs_reconnect)
        self.assertEqual(self.fake.count("calendar.insert"), 1)
        calendar_body = next(call[1] for call in self.fake.calls if call[0] == "calendar.insert")
        self.assertEqual(calendar_body["summary"], "Saveetha Publications")
        self.assertEqual(
            calendar_body["description"],
            "Deadlines, payouts, seminars and events from the college publications site",
        )
        self.assertEqual(calendar_body["timeZone"], "Asia/Kolkata")
        self.assertEqual(link.calendar_id, next(iter(self.fake.events_by_calendar)))
        # The first sync ran: what I may see is in the calendar, what I may not is not.
        titles = {e["summary"] for e in self.fake.all_events().values()}
        self.assertIn("Faculty research meeting", titles)
        self.assertNotIn("Only for MECH", titles)
        self.assertIsNotNone(link.last_synced_at)

    def test_a_first_sync_that_fails_still_leaves_them_connected_with_the_reason(self):
        c = self.client_for(self.me)
        state = self.begin(c)
        with mock.patch.object(gc, "sync_link", side_effect=RuntimeError("boom")):
            r = self.finish(c, state)
        self.assertEqual(r["Location"], "/calendar?google=connected")
        link = GoogleCalendarLink.objects.get(user=self.me)
        self.assertIn("sync", link.last_error.lower())
        self.assertNotIn("boom", link.last_error)

    def test_a_second_connect_reuses_the_calendar(self):
        c = self.client_for(self.me)
        self.finish(c, self.begin(c))
        self.finish(c, self.begin(c))
        self.assertEqual(self.fake.count("calendar.insert"), 1)
        self.assertEqual(GoogleCalendarLink.objects.filter(user=self.me).count(), 1)

    def test_reconnecting_clears_the_needs_reconnect_mark(self):
        link_for(self.me, calendar_id="", needs_reconnect=True, last_error="Connect again.")
        c = self.client_for(self.me)
        self.finish(c, self.begin(c))
        link = GoogleCalendarLink.objects.get(user=self.me)
        self.assertFalse(link.needs_reconnect)
        self.assertEqual(link.last_error, "")

    def test_a_different_google_account_starts_a_fresh_calendar(self):
        link_for(self.me, google_email="old@gmail.com", calendar_id="old-cal", event_map={"e-1": {"id": "x", "hash": "h"}})
        c = self.client_for(self.me)
        with mock.patch.object(gc.requests, "post"):  # revoking the old account's token
            self.finish(c, self.begin(c))
        link = GoogleCalendarLink.objects.get(user=self.me)
        self.assertEqual(link.google_email, "teacher@gmail.com")
        self.assertNotEqual(link.calendar_id, "old-cal")
        self.assertNotIn("e-1", link.event_map)

    def test_a_tampered_state_links_nothing(self):
        c = self.client_for(self.me)
        state = self.begin(c)
        r = self.finish(c, state[:-2] + "xx")
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r["Location"].startswith("/calendar?google=failed&why="))
        self.assertFalse(GoogleCalendarLink.objects.exists())
        self.assertEqual(self.fake.calls, [])

    def test_a_state_cannot_be_used_twice(self):
        c = self.client_for(self.me)
        state = self.begin(c)
        self.assertEqual(self.finish(c, state)["Location"], "/calendar?google=connected")
        again = self.finish(c, state)
        self.assertTrue(again["Location"].startswith("/calendar?google=failed"))

    def test_a_state_started_by_somebody_else_is_refused(self):
        state = self.begin(self.client_for(self.other))
        mine = self.client_for(self.me)
        self.begin(mine)  # I have my own pending connect, with its own nonce
        r = self.finish(mine, state)
        self.assertTrue(r["Location"].startswith("/calendar?google=failed"))
        self.assertFalse(GoogleCalendarLink.objects.exists())

    def test_my_own_state_from_another_browser_session_is_refused(self):
        """Same person, same signature, different session: the nonce is what ties
        the link to the browser that started it."""
        state = self.begin(self.client_for(self.me))
        elsewhere = self.client_for(self.me)
        self.begin(elsewhere)  # that session has a pending connect of its own
        r = self.finish(elsewhere, state)
        self.assertTrue(r["Location"].startswith("/calendar?google=failed"))
        self.assertFalse(GoogleCalendarLink.objects.exists())

    def test_saying_no_on_googles_screen_is_not_an_error_page(self):
        c = self.client_for(self.me)
        self.begin(c)
        r = c.get("/api/calendar/google/callback", {"error": "access_denied"})
        self.assertEqual(r.status_code, 302)
        self.assertIn("google=failed", r["Location"])
        self.assertIn("why=", r["Location"])
        self.assertFalse(GoogleCalendarLink.objects.exists())

    def test_the_reason_is_the_servers_own_sentence_word_for_word(self):
        c = self.client_for(self.me)
        self.begin(c)
        r = c.get("/api/calendar/google/callback", {"error": "access_denied"})
        why = parse_qs(urlparse(r["Location"]).query)["why"][0]
        self.assertEqual(why, gc.WHY_DENIED)

    def test_every_reason_the_way_back_can_give_is_on_the_pages_allowlist(self):
        """The page prints a `why` only if it is on its list, so a link somebody
        else wrote cannot put words on it (frontend2/.../calendar/google.tsx).
        A sentence changed here and not there would silently become the generic one."""
        from pathlib import Path

        from django.conf import settings
        from core.api import google_calendar as api_module

        page = Path(settings.BASE_DIR).parent / "frontend2" / "src" / "pages" / "calendar" / "google.tsx"
        if not page.exists():
            self.skipTest("the frontend is not beside the backend here")
        source = page.read_text(encoding="utf-8")
        sentences = [
            gc.WHY_STATE, gc.WHY_DENIED, gc.WHY_NO_CALENDAR, gc.WHY_NO_REFRESH, gc.WHY_EXCHANGE,
            api_module.NOT_SWITCHED_ON, api_module.VIEWING_AS, api_module.SIGN_IN_AGAIN,
            "Google could not confirm which account this is. Please try again.",
            "Google did not say which account this is. Please try again.",
        ]
        for sentence in sentences:
            self.assertIn(sentence, source)

    def test_no_refresh_token_means_no_link(self):
        c = self.client_for(self.me)
        state = self.begin(c)
        with mock.patch.object(gc, "_exchange_code", return_value={"id_token": "jwt", "scope": GRANTED}):
            r = self.finish(c, state)
        self.assertTrue(r["Location"].startswith("/calendar?google=failed"))
        self.assertFalse(GoogleCalendarLink.objects.exists())

    def test_the_calendar_box_left_unticked_means_no_link(self):
        c = self.client_for(self.me)
        state = self.begin(c)
        unticked = {
            "refresh_token": "1//x", "id_token": "jwt",
            "scope": "openid https://www.googleapis.com/auth/userinfo.email",
        }
        with mock.patch.object(gc, "_exchange_code", return_value=unticked):
            r = self.finish(c, state)
        self.assertTrue(r["Location"].startswith("/calendar?google=failed"))
        self.assertIn("calendar", r["Location"].lower())
        self.assertFalse(GoogleCalendarLink.objects.exists())

    def test_google_failing_the_exchange_says_so_plainly(self):
        c = self.client_for(self.me)
        state = self.begin(c)
        with mock.patch.object(gc, "_exchange_code", side_effect=RuntimeError("boom")):
            r = self.finish(c, state)
        self.assertTrue(r["Location"].startswith("/calendar?google=failed&why="))
        self.assertNotIn("boom", r["Location"])

    def test_a_signed_out_browser_is_sent_back_not_shown_json(self):
        r = Client().get("/api/calendar/google/callback", {"code": "x", "state": "y"})
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r["Location"].startswith("/calendar?google=failed"))


@override_settings(**CONFIGURED)
class ExchangeTests(TestCase):
    def test_the_real_flow_sends_the_code_verifier_secret_and_redirect(self):
        """The real google-auth-oauthlib Flow, with only the HTTP call to Google replaced."""
        sent = {}

        def fake_request(session, method, url, **kw):
            sent.update(method=method, url=url, **kw)
            body = json.dumps({
                "access_token": "at", "refresh_token": "1//rt", "id_token": "jwt",
                "expires_in": 3600, "token_type": "Bearer", "scope": GRANTED,
            })
            return mock.Mock(status_code=200, text=body, headers={})

        request = SimpleNamespace(get_host=lambda: "site.test", scheme="https")
        with mock.patch("requests_oauthlib.OAuth2Session.request", fake_request):
            tokens = gc._exchange_code(request, "the-code", "v" * 64)
        self.assertEqual(tokens["refresh_token"], "1//rt")
        self.assertEqual(sent["method"], "POST")
        self.assertEqual(sent["url"], "https://oauth2.googleapis.com/token")
        self.assertEqual(sent["data"]["code"], "the-code")
        self.assertEqual(sent["data"]["code_verifier"], "v" * 64)
        self.assertEqual(sent["data"]["redirect_uri"], "https://site.test/api/calendar/google/callback")
        self.assertEqual(sent["auth"].username, CONFIGURED["GOOGLE_OAUTH_CLIENT_ID"])
        self.assertEqual(sent["auth"].password, "test-secret-not-real")

    def test_a_short_grant_is_not_thrown_away_by_the_library(self):
        """If the person unticks a box Google returns fewer scopes; the library
        would raise 'Scope has changed'. We want to read the list and say why."""
        def fake_request(session, method, url, **kw):
            body = json.dumps({
                "access_token": "at", "refresh_token": "1//rt", "expires_in": 3600,
                "token_type": "Bearer", "scope": "openid",
            })
            return mock.Mock(status_code=200, text=body, headers={})

        request = SimpleNamespace(get_host=lambda: "site.test", scheme="https")
        with mock.patch("requests_oauthlib.OAuth2Session.request", fake_request):
            tokens = gc._exchange_code(request, "c", "v" * 64)
        self.assertEqual(tokens["scope"], "openid")


# ---------------------------------------------------------------------------
# Status and permissions
# ---------------------------------------------------------------------------


class StatusTests(_Base):
    def test_unconfigured_still_offers_the_subscribe_link(self):
        with override_settings(GOOGLE_OAUTH_CLIENT_ID="", GOOGLE_OAUTH_CLIENT_SECRET=""):
            r = self.client_for(self.me).get("/api/calendar/google/status")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["configured"])
        self.assertFalse(body["connected"])
        self.assertIsNone(body["google_email"])
        self.assertIsNone(body["calendar_name"])
        self.assertIsNone(body["last_synced"])
        self.assertIsNone(body["error"])
        self.assertTrue(body["subscribe_url"].startswith("https://calendar.google.com/calendar/r?cid=webcal"))

    def test_the_id_alone_is_not_configured(self):
        with override_settings(GOOGLE_OAUTH_CLIENT_ID="x.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET=""):
            self.assertFalse(self.client_for(self.me).get("/api/calendar/google/status").json()["configured"])

    @override_settings(**CONFIGURED)
    def test_configured_but_not_connected(self):
        body = self.client_for(self.me).get("/api/calendar/google/status").json()
        self.assertTrue(body["configured"])
        self.assertFalse(body["connected"])
        self.assertIsNone(body["error"])

    @override_settings(**CONFIGURED)
    def test_connected_shows_the_account_the_calendar_and_when(self):
        link_for(self.me, calendar_id="cal-1", last_synced_at=timezone.now())
        body = self.client_for(self.me).get("/api/calendar/google/status").json()
        self.assertTrue(body["connected"])
        self.assertEqual(body["google_email"], "teacher@gmail.com")
        self.assertEqual(body["calendar_name"], "Saveetha Publications")
        self.assertIsNotNone(body["last_synced"])
        self.assertIsNone(body["error"])
        self.assertFalse(body["needs_reconnect"])

    @override_settings(**CONFIGURED)
    def test_status_never_returns_a_token(self):
        link_for(self.me)
        raw = self.client_for(self.me).get("/api/calendar/google/status").content.decode()
        self.assertNotIn("refresh", raw.lower())
        self.assertNotIn("1//placeholder", raw)

    @override_settings(**CONFIGURED)
    def test_my_status_is_mine_alone(self):
        link_for(self.other)
        self.assertFalse(self.client_for(self.me).get("/api/calendar/google/status").json()["connected"])

    @override_settings(**CONFIGURED)
    def test_anonymous_gets_401_everywhere_it_should(self):
        c = Client()
        self.assertEqual(c.get("/api/calendar/google/status").status_code, 401)
        self.assertEqual(c.get("/api/calendar/google/connect").status_code, 401)
        self.assertEqual(c.post("/api/calendar/google/sync").status_code, 401)
        self.assertEqual(c.post("/api/calendar/google/disconnect").status_code, 401)


# ---------------------------------------------------------------------------
# What goes to Google
# ---------------------------------------------------------------------------


@override_settings(**CONFIGURED, **FAST_HASH)
class BodyTests(TestCase):
    def setUp(self):
        self.office = make_user("gb-office@x.edu", Role.RESEARCH_CELL, department=None)

    def test_an_all_day_span_ends_the_day_after_in_googles_terms(self):
        e = make_event(self.office, "Q3 submission window", kind="SUBMISSION_WINDOW",
                       starts_on=date(2026, 10, 12), ends_on=date(2026, 10, 24))
        body = gc.event_body(e)
        self.assertEqual(body["start"], {"date": "2026-10-12"})
        self.assertEqual(body["end"], {"date": "2026-10-25"})

    def test_a_single_all_day_event_is_one_day(self):
        body = gc.event_body(make_event(self.office, starts_on=date(2026, 10, 15)))
        self.assertEqual(body["start"], {"date": "2026-10-15"})
        self.assertEqual(body["end"], {"date": "2026-10-16"})

    def test_a_timed_event_carries_the_colleges_zone(self):
        e = make_event(self.office, starts_on=date(2026, 10, 9), starts_at=time(10, 0), ends_at=time(11, 30))
        body = gc.event_body(e)
        self.assertEqual(body["start"], {"dateTime": "2026-10-09T10:00:00", "timeZone": "Asia/Kolkata"})
        self.assertEqual(body["end"], {"dateTime": "2026-10-09T11:30:00", "timeZone": "Asia/Kolkata"})

    def test_a_timed_event_with_no_end_lasts_an_hour(self):
        e = make_event(self.office, starts_on=date(2026, 10, 9), starts_at=time(23, 30))
        body = gc.event_body(e)
        self.assertEqual(body["end"], {"dateTime": "2026-10-10T00:30:00", "timeZone": "Asia/Kolkata"})

    def test_venue_becomes_the_location_when_the_model_has_one(self):
        e = make_event(self.office)
        self.assertNotIn("location", gc.event_body(e))
        e.venue = "Seminar hall, Block C"  # the other builder's field, simulated
        self.assertEqual(gc.event_body(e)["location"], "Seminar hall, Block C")

    def test_description_links_back_to_the_site_and_names_the_kind(self):
        e = make_event(self.office, description="Bring your Scopus ID.", starts_on=date(2026, 10, 20))
        body = gc.event_body(e)
        self.assertIn("Bring your Scopus ID.", body["description"])
        self.assertIn("Meeting", body["description"])
        self.assertIn("https://site.test/calendar?date=2026-10-20", body["description"])
        self.assertEqual(body["source"]["url"], "https://site.test/calendar?date=2026-10-20")

    def test_an_unknown_kind_reads_as_event(self):
        e = make_event(self.office)
        e.kind = "SOMETHING_NEW"
        self.assertEqual(gc.kind_label(e.kind), "Event")
        self.assertNotIn("SOMETHING_NEW", gc.event_body(e)["description"])

    def test_a_record_entry_goes_by_title_and_date_never_the_amount(self):
        entry = {
            "id": "record-paid-2026-10", "kind": "PAID", "kind_label": "Payments made",
            "title": "12 papers paid for", "starts_on": "2026-10-01", "whole_month": True,
            "amount": 987654.0, "count": 12, "claim_id": None, "titles": [], "url": None,
        }
        body = gc.record_body(entry)
        self.assertEqual(body["summary"], "12 papers paid for")
        self.assertEqual(body["start"], {"date": "2026-10-01"})
        self.assertEqual(body["end"], {"date": "2026-11-01"})
        self.assertNotIn("987654", json.dumps(body))

    def test_the_college_run_is_a_payment_run_to_a_teacher(self):
        entry = {
            "id": "record-payout-2026-10", "kind": "PAYOUT", "kind_label": "Payout run",
            "title": "College payout run", "starts_on": "2026-10-01", "whole_month": False,
        }
        self.assertEqual(gc.record_body(entry)["summary"], "College payment run")

    def test_equal_content_hashes_equal_and_a_change_does_not(self):
        e = make_event(self.office)
        a = gc.content_hash(gc.event_body(e))
        self.assertEqual(a, gc.content_hash(gc.event_body(e)))
        e.title = "Renamed"
        self.assertNotEqual(a, gc.content_hash(gc.event_body(e)))


# ---------------------------------------------------------------------------
# The sync
# ---------------------------------------------------------------------------


@override_settings(**CONFIGURED)
class SyncTests(_Base):
    def setUp(self):
        super().setUp()
        self.link = link_for(self.me)

    def sync(self):
        return gc.sync_link(GoogleCalendarLink.objects.get(pk=self.link.pk))

    def titles(self):
        return sorted(e["summary"] for e in self.fake.all_events().values())

    def test_sends_exactly_what_the_person_may_see_in_the_next_year(self):
        make_event(self.office, "College seminar")
        make_event(self.me, "My private reminder", visibility="PRIVATE")
        make_event(self.other, "Somebody else's private", visibility="PRIVATE")
        make_event(self.office, "Own department", visibility="DEPARTMENT", department="ECE")
        make_event(self.office, "Other department", visibility="DEPARTMENT", department="MECH")
        make_event(self.office, "Office only", visibility="OFFICE")
        make_event(self.office, "Long ago", starts_on=date(2026, 9, 1))
        make_event(self.office, "Too far ahead", starts_on=date(2027, 10, 9))
        make_event(self.office, "Still running", starts_on=date(2026, 10, 1), ends_on=date(2026, 10, 9))
        self.sync()
        self.assertEqual(
            self.titles(),
            ["College seminar", "My private reminder", "Own department", "Still running"],
        )

    def test_the_second_run_makes_no_write_calls(self):
        make_event(self.office, "College seminar")
        make_event(self.me, "My private reminder", visibility="PRIVATE")
        self.sync()
        self.assertEqual(self.fake.count("insert"), 2)
        before = len(self.fake.calls)
        second = self.sync()
        later = {call[0] for call in self.fake.calls[before:]}
        self.assertEqual(later - {"calendar.get"}, set(), later)
        self.assertEqual(self.fake.count("calendar.insert"), 1)
        self.assertEqual((second["created"], second["updated"], second["deleted"]), (0, 0, 0))

    def test_a_changed_event_is_patched_and_only_that_one(self):
        e = make_event(self.office, "College seminar")
        make_event(self.office, "Untouched", starts_on=date(2026, 10, 22))
        self.sync()
        e.title = "College seminar, new hall"
        e.save()
        result = self.sync()
        self.assertEqual((result["created"], result["updated"], result["deleted"]), (0, 1, 0))
        self.assertEqual(self.fake.count("patch"), 1)
        self.assertIn("College seminar, new hall", self.titles())
        self.assertNotIn("College seminar", self.titles())

    def test_a_deleted_event_is_removed_from_google(self):
        e = make_event(self.office, "College seminar")
        make_event(self.office, "Stays", starts_on=date(2026, 10, 22))
        self.sync()
        e.delete()
        result = self.sync()
        self.assertEqual(result["deleted"], 1)
        self.assertEqual(self.titles(), ["Stays"])
        self.assertEqual(len(GoogleCalendarLink.objects.get(pk=self.link.pk).event_map), 1)

    def test_an_event_that_stops_being_visible_is_removed(self):
        e = make_event(self.office, "Own department", visibility="DEPARTMENT", department="ECE")
        self.sync()
        self.assertEqual(self.titles(), ["Own department"])
        e.department = "MECH"
        e.save()
        self.sync()
        self.assertEqual(self.titles(), [])

    def test_an_event_deleted_in_google_comes_back_when_it_changes(self):
        make_event(self.office, "College seminar")
        self.sync()
        gid = next(iter(self.fake.all_events()))
        cal = next(iter(self.fake.events_by_calendar))
        del self.fake.events_by_calendar[cal][gid]
        self.fake.gone.add(gid)  # Google answers 410 for what was deleted
        CalendarEvent.objects.update(title="College seminar (moved)")
        self.sync()
        self.assertEqual(self.titles(), ["College seminar (moved)"])

    def test_a_404_on_patch_recreates(self):
        make_event(self.office, "College seminar")
        self.sync()
        cal = next(iter(self.fake.events_by_calendar))
        self.fake.events_by_calendar[cal].clear()
        CalendarEvent.objects.update(title="Renamed")
        self.sync()
        self.assertEqual(self.titles(), ["Renamed"])

    def test_deleting_what_google_already_dropped_is_fine(self):
        e = make_event(self.office, "College seminar")
        self.sync()
        cal = next(iter(self.fake.events_by_calendar))
        self.fake.events_by_calendar[cal].clear()
        e.delete()
        result = self.sync()
        self.assertEqual(result["deleted"], 1)
        self.assertEqual(GoogleCalendarLink.objects.get(pk=self.link.pk).last_error, "")

    def test_a_calendar_removed_in_google_is_made_again_with_everything_in_it(self):
        make_event(self.office, "College seminar")
        self.sync()
        old = GoogleCalendarLink.objects.get(pk=self.link.pk).calendar_id
        del self.fake.events_by_calendar[old]
        self.sync()
        link = GoogleCalendarLink.objects.get(pk=self.link.pk)
        self.assertNotEqual(link.calendar_id, old)
        self.assertEqual(self.fake.count("calendar.insert"), 2)
        self.assertEqual(self.titles(), ["College seminar"])

    def test_the_map_is_saved_as_it_goes_so_a_crash_halfway_does_not_duplicate(self):
        make_event(self.office, "First", starts_on=date(2026, 10, 20))
        make_event(self.office, "Second", starts_on=date(2026, 10, 21))
        real = self.fake.events
        calls = {"n": 0}

        class Boom(Exception):
            pass

        def events():
            ev = real()
            insert = ev.insert

            def counted(calendarId, body):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise Boom()
                return insert(calendarId, body)

            ev.insert = counted
            return ev

        with mock.patch.object(self.fake, "events", events):
            with self.assertRaises(Boom):
                self.sync()
        self.assertEqual(len(GoogleCalendarLink.objects.get(pk=self.link.pk).event_map), 1)
        self.sync()
        self.assertEqual(self.titles(), ["First", "Second"])

    def test_records_the_time_and_clears_an_old_error(self):
        GoogleCalendarLink.objects.filter(pk=self.link.pk).update(last_error="Google is busy.")
        self.sync()
        link = GoogleCalendarLink.objects.get(pk=self.link.pk)
        self.assertIsNotNone(link.last_synced_at)
        self.assertEqual(link.last_error, "")

    def test_a_record_entry_from_the_calendar_api_is_sent(self):
        entry = {
            "id": "record-cutoff-2026-10", "kind": "CUTOFF", "kind_label": "Filing cutoff",
            "title": "Filing cutoff for this month's payout", "starts_on": "2026-10-25",
            "whole_month": False,
        }
        with mock.patch("core.api.calendar._record", return_value=[entry]):
            self.sync()
        self.assertEqual(self.titles(), ["Filing cutoff for this month's payment"])


@override_settings(**CONFIGURED)
class ReconnectTests(_Base):
    def setUp(self):
        super().setUp()
        self.link = link_for(self.me, calendar_id="cal-1")
        # A calendar that exists on Google's side, for the cases that get as far as an event call.
        self.fake.calendars_by_id["cal-1"] = {}
        self.fake.events_by_calendar["cal-1"] = {}

    def sync(self):
        return gc.sync_link(GoogleCalendarLink.objects.get(pk=self.link.pk))

    def test_a_revoked_token_marks_the_link_and_does_not_crash(self):
        with mock.patch.object(gc, "build_service", side_effect=gc.NeedsReconnect("revoked")):
            result = self.sync()
        link = GoogleCalendarLink.objects.get(pk=self.link.pk)
        self.assertTrue(link.needs_reconnect)
        self.assertIn("connect", link.last_error.lower())
        self.assertTrue(result["needs_reconnect"])

    def test_invalid_grant_from_googles_refresh_is_a_reconnect(self):
        from google.oauth2.credentials import Credentials

        err = RefreshError("invalid_grant: Token has been expired or revoked.", {"error": "invalid_grant"})
        with mock.patch.object(Credentials, "refresh", side_effect=err):
            with self.assertRaises(gc.NeedsReconnect):
                REAL_BUILD_SERVICE(GoogleCalendarLink.objects.get(pk=self.link.pk))

    def test_other_refresh_trouble_is_not_a_reconnect(self):
        from google.oauth2.credentials import Credentials

        err = RefreshError("Unable to reach the token endpoint", {})
        with mock.patch.object(Credentials, "refresh", side_effect=err):
            with self.assertRaises(gc.GoogleUnavailable):
                REAL_BUILD_SERVICE(GoogleCalendarLink.objects.get(pk=self.link.pk))

    def test_the_real_builder_makes_a_calendar_v3_client_without_a_network_call(self):
        """Wiring check against the real library: discovery is read from the
        document shipped with it, and a refresh is the only thing replaced."""
        from google.oauth2.credentials import Credentials

        def fake_refresh(creds, request):
            creds.token = "access-token"

        with mock.patch.object(Credentials, "refresh", fake_refresh):
            service = REAL_BUILD_SERVICE(GoogleCalendarLink.objects.get(pk=self.link.pk))
        request = service.events().insert(calendarId="cal-1", body={"summary": "x"})
        self.assertIn("/calendars/cal-1/events", request.uri)
        self.assertEqual(request.method, "POST")

    def test_a_401_from_the_calendar_api_is_a_reconnect(self):
        make_event(self.office, "College seminar")
        with mock.patch.object(self.fake, "events") as events:
            events.return_value.insert.return_value.execute.side_effect = http_error(401, "Invalid Credentials")
            self.sync()
        self.assertTrue(GoogleCalendarLink.objects.get(pk=self.link.pk).needs_reconnect)

    def test_a_busy_google_stops_the_run_and_says_to_wait(self):
        make_event(self.office, "College seminar")
        with mock.patch.object(self.fake, "events") as events:
            events.return_value.insert.return_value.execute.side_effect = http_error(403, "Rate Limit Exceeded")
            self.sync()
        link = GoogleCalendarLink.objects.get(pk=self.link.pk)
        self.assertFalse(link.needs_reconnect)
        self.assertIn("busy", link.last_error.lower())

    def test_one_event_google_refuses_does_not_stop_the_rest(self):
        make_event(self.office, "Fine", starts_on=date(2026, 10, 20))
        make_event(self.office, "Refused", starts_on=date(2026, 10, 21))
        real = self.fake.events

        def events():
            ev = real()
            insert = ev.insert

            def picky(calendarId, body):
                if body["summary"] == "Refused":
                    return mock.Mock(execute=mock.Mock(side_effect=http_error(400, "Invalid value")))
                return insert(calendarId, body)

            ev.insert = picky
            return ev

        with mock.patch.object(self.fake, "events", events):
            result = self.sync()
        self.assertEqual(sorted(e["summary"] for e in self.fake.all_events().values()), ["Fine"])
        self.assertEqual(result["failed"], 1)
        self.assertIn("1", GoogleCalendarLink.objects.get(pk=self.link.pk).last_error)

    def test_status_shows_the_error_and_that_it_needs_a_reconnect(self):
        GoogleCalendarLink.objects.filter(pk=self.link.pk).update(
            needs_reconnect=True, last_error="Google no longer lets us in. Connect again."
        )
        body = self.client_for(self.me).get("/api/calendar/google/status").json()
        self.assertTrue(body["connected"])
        self.assertTrue(body["needs_reconnect"])
        self.assertIn("Connect again", body["error"])

    def test_the_daily_run_skips_links_waiting_for_a_reconnect(self):
        GoogleCalendarLink.objects.filter(pk=self.link.pk).update(needs_reconnect=True)
        make_event(self.office, "College seminar")
        gc.sync_all()
        self.assertEqual(self.fake.calls, [])

    def test_the_daily_run_carries_on_past_one_persons_failure(self):
        other_link = link_for(self.other, calendar_id="")
        make_event(self.office, "College seminar")
        real = gc.sync_link

        def flaky(link, **kw):
            if link.user_id == self.me.pk:
                raise RuntimeError("one bad apple")
            return real(link, **kw)

        with mock.patch.object(gc, "sync_link", flaky):
            summary = gc.sync_all()
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["synced"], 1)
        self.assertIsNotNone(GoogleCalendarLink.objects.get(pk=other_link.pk).last_synced_at)


@override_settings(**CONFIGURED)
class SyncEndpointTests(_Base):
    def test_sync_now_runs_and_reports(self):
        link_for(self.me)
        make_event(self.office, "College seminar")
        r = self.client_for(self.me).post("/api/calendar/google/sync")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 1)
        self.assertTrue(r.json()["status"]["connected"])

    def test_sync_now_without_a_link_is_a_plain_409(self):
        r = self.client_for(self.me).post("/api/calendar/google/sync")
        self.assertEqual(r.status_code, 409)

    def test_sync_now_after_reconnect_needed_says_so(self):
        link_for(self.me, needs_reconnect=True, last_error="Google no longer lets us in. Connect again.")
        r = self.client_for(self.me).post("/api/calendar/google/sync")
        self.assertEqual(r.status_code, 409)
        self.assertIn("connect", r.json()["detail"].lower())

    def test_sync_now_when_it_goes_wrong_says_so_without_the_traceback(self):
        link_for(self.me)
        with mock.patch.object(gc, "sync_link", side_effect=RuntimeError("secret internals")):
            r = self.client_for(self.me).post("/api/calendar/google/sync")
        self.assertEqual(r.status_code, 502)
        self.assertNotIn("secret internals", r.content.decode())


@override_settings(**CONFIGURED)
class DisconnectTests(_Base):
    def setUp(self):
        super().setUp()
        make_event(self.office, "College seminar")
        link_for(self.me)
        gc.sync_link(GoogleCalendarLink.objects.get(user=self.me))

    def test_revokes_the_token_deletes_the_calendar_and_the_row(self):
        cal = GoogleCalendarLink.objects.get(user=self.me).calendar_id
        with mock.patch.object(gc.requests, "post") as post:
            post.return_value = mock.Mock(status_code=200)
            r = self.client_for(self.me).post("/api/calendar/google/disconnect")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(GoogleCalendarLink.objects.filter(user=self.me).exists())
        self.assertEqual(self.fake.count("calendar.delete"), 1)
        self.assertNotIn(cal, self.fake.events_by_calendar)
        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://oauth2.googleapis.com/revoke")
        self.assertEqual(kwargs["data"]["token"], "1//placeholder-refresh-token")
        self.assertIsNotNone(kwargs.get("timeout"))

    def test_google_being_unreachable_still_disconnects(self):
        with mock.patch.object(gc.requests, "post", side_effect=OSError("offline")):
            with mock.patch.object(gc, "build_service", side_effect=gc.GoogleUnavailable("offline")):
                r = self.client_for(self.me).post("/api/calendar/google/disconnect")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(GoogleCalendarLink.objects.filter(user=self.me).exists())

    def test_a_link_already_needing_reconnect_can_still_be_removed(self):
        GoogleCalendarLink.objects.filter(user=self.me).update(needs_reconnect=True)
        with mock.patch.object(gc, "build_service", side_effect=gc.NeedsReconnect("revoked")):
            with mock.patch.object(gc.requests, "post"):
                r = self.client_for(self.me).post("/api/calendar/google/disconnect")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(GoogleCalendarLink.objects.filter(user=self.me).exists())

    def test_disconnecting_when_not_connected_is_fine(self):
        self.assertEqual(self.client_for(self.other).post("/api/calendar/google/disconnect").status_code, 200)

    def test_one_person_cannot_disconnect_another(self):
        link_for(self.other)
        with mock.patch.object(gc.requests, "post"):
            self.client_for(self.me).post("/api/calendar/google/disconnect")
        self.assertTrue(GoogleCalendarLink.objects.filter(user=self.other).exists())


# ---------------------------------------------------------------------------
# Keeping it fresh
# ---------------------------------------------------------------------------


@override_settings(**CONFIGURED)
class FreshnessTests(_Base):
    def add(self, user, **kw):
        body = {"title": "A new seminar", "kind": "MEETING", "starts_on": "2026-10-20"}
        body.update(kw)
        return self.client_for(user).post("/api/calendar", data=json.dumps(body), content_type="application/json")

    def test_nobody_linked_means_nothing_is_queued(self):
        with mock.patch("django_q.tasks.async_task") as queue:
            self.assertEqual(self.add(self.me).status_code, 200)
        queue.assert_not_called()

    def test_a_private_reminder_queues_only_its_owner(self):
        link_for(self.me)
        link_for(self.other)
        with mock.patch("django_q.tasks.async_task") as queue:
            self.add(self.me, visibility="PRIVATE")
        queue.assert_called_once()
        self.assertEqual(queue.call_args.args[0], "core.tasks.sync_google_calendars")
        self.assertEqual(sorted(queue.call_args.args[1]), [self.me.pk])

    def test_a_college_event_queues_everyone_linked(self):
        link_for(self.me)
        link_for(self.other)
        with mock.patch("django_q.tasks.async_task") as queue:
            self.add(self.office, visibility="PUBLIC")
        self.assertEqual(sorted(queue.call_args.args[1]), sorted([self.me.pk, self.other.pk]))

    def test_a_department_event_queues_that_department_and_the_office(self):
        link_for(self.me)       # ECE
        link_for(self.other)    # MECH
        link_for(self.office)
        with mock.patch("django_q.tasks.async_task") as queue:
            self.add(self.office, visibility="DEPARTMENT", department="ECE")
        self.assertEqual(sorted(queue.call_args.args[1]), sorted([self.me.pk, self.office.pk]))

    def test_a_link_waiting_for_a_reconnect_is_not_queued(self):
        link_for(self.me, needs_reconnect=True)
        with mock.patch("django_q.tasks.async_task") as queue:
            self.add(self.office, visibility="PUBLIC")
        queue.assert_not_called()

    def test_editing_and_deleting_queue_too_and_a_delete_names_who_saw_it(self):
        link_for(self.me)
        eid = self.add(self.me, visibility="PRIVATE").json()["id"]
        c = self.client_for(self.me)
        with mock.patch("django_q.tasks.async_task") as queue:
            r = c.patch(
                f"/api/calendar/{eid}",
                data=json.dumps({"title": "Renamed", "starts_on": "2026-10-21", "kind": "OTHER"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(queue.call_count, 1)
            r = c.delete(f"/api/calendar/{eid}")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(queue.call_count, 2)
            self.assertEqual(queue.call_args.args[1], [self.me.pk])

    def test_the_queue_being_down_does_not_break_adding_an_event(self):
        link_for(self.me)
        with mock.patch("django_q.tasks.async_task", side_effect=RuntimeError("broker down")):
            r = self.add(self.me, visibility="PRIVATE")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(CalendarEvent.objects.filter(title="A new seminar").exists())

    def test_the_audience_rule_matches_the_calendars_own_visibility_rule(self):
        """`may_see` re-states `_visible_events` in Python so one query can pick
        the audience. If the two ever disagree somebody is missed or over-synced."""
        from core.api.calendar import _visible_events

        hod = make_user("gc-hod@x.edu", Role.HOD, department="ECE")
        people = [self.office, self.me, self.other, hod]
        for vis, dept in (("PUBLIC", None), ("PRIVATE", None), ("DEPARTMENT", "ECE"),
                          ("DEPARTMENT", "MECH"), ("OFFICE", None)):
            for creator in (self.office, self.me):
                e = make_event(creator, f"{vis}-{dept}-{creator.pk}", visibility=vis, department=dept)
                for p in people:
                    self.assertEqual(
                        gc.may_see(p, e),
                        _visible_events(p).filter(pk=e.pk).exists(),
                        (vis, dept, creator.email, p.email),
                    )


class ScheduleTests(TestCase):
    def test_the_daily_sync_is_registered_by_the_migration(self):
        from django_q.models import Schedule

        s = Schedule.objects.get(name="google-calendar-sync-daily")
        self.assertEqual(s.func, "core.tasks.sync_google_calendars")
        self.assertEqual(s.schedule_type, "D")
        self.assertEqual(s.repeats, -1)

    def test_the_task_function_runs_the_pass(self):
        from core import tasks

        with mock.patch.object(gc, "sync_all", return_value={"synced": 0}) as run:
            self.assertEqual(tasks.sync_google_calendars(), {"synced": 0})
            tasks.sync_google_calendars(["u1"])
        run.assert_any_call(None)
        run.assert_any_call(["u1"])


# ---------------------------------------------------------------------------
# A request must not wait on a long sync, and two syncs must not double up
# ---------------------------------------------------------------------------


@override_settings(**CONFIGURED)
class BudgetTests(_Base):
    def test_a_long_sync_stops_at_its_budget_and_the_next_run_finishes_it(self):
        link = link_for(self.me)
        for i in range(5):
            make_event(self.office, f"Event {i}", starts_on=date(2026, 10, 20 + i))
        ticks = itertools.count(0, 100)
        with mock.patch.object(gc, "_clock", side_effect=lambda: next(ticks)):
            result = gc.sync_link(GoogleCalendarLink.objects.get(pk=link.pk), budget=150)
        self.assertTrue(result["partial"])
        done = len(self.fake.all_events())
        self.assertTrue(0 < done < 5, done)
        # A partial run is not "synced": the page must not say it is up to date.
        self.assertIsNone(GoogleCalendarLink.objects.get(pk=link.pk).last_synced_at)

        later = gc.sync_link(GoogleCalendarLink.objects.get(pk=link.pk))
        self.assertFalse(later["partial"])
        self.assertEqual(len(self.fake.all_events()), 5)
        self.assertEqual(self.fake.count("insert"), 5)  # nothing sent twice

    def test_the_background_run_has_no_budget(self):
        link = link_for(self.me)
        for i in range(5):
            make_event(self.office, f"Event {i}", starts_on=date(2026, 10, 20 + i))
        ticks = itertools.count(0, 1000)
        with mock.patch.object(gc, "_clock", side_effect=lambda: next(ticks)):
            result = gc.sync_link(GoogleCalendarLink.objects.get(pk=link.pk))
        self.assertFalse(result["partial"])
        self.assertEqual(len(self.fake.all_events()), 5)


@override_settings(**CONFIGURED)
class PartialHandOffTests(_Base):
    PARTIAL = {"created": 1, "updated": 0, "deleted": 0, "failed": 0, "partial": True,
               "busy": False, "error": None, "needs_reconnect": False}

    def test_a_connect_whose_first_sync_ran_out_of_time_queues_the_rest(self):
        with mock.patch.object(gc, "_exchange_code", return_value={"refresh_token": "1//r", "id_token": "j", "scope": GRANTED}), \
                mock.patch.object(gc, "_verified_email", return_value="teacher@gmail.com"):
            c = self.client_for(self.me)
            state = parse_qs(urlparse(c.get("/api/calendar/google/connect").json()["url"]).query)["state"][0]
            with mock.patch.object(gc, "sync_link", return_value=self.PARTIAL) as sync, \
                    mock.patch("django_q.tasks.async_task") as queue:
                r = c.get("/api/calendar/google/callback", {"code": "x", "state": state})
        self.assertEqual(r["Location"], "/calendar?google=connected")
        self.assertIsNotNone(sync.call_args.kwargs.get("budget"))
        queue.assert_called_once()
        self.assertEqual(queue.call_args.args[1], [self.me.pk])

    def test_sync_now_that_ran_out_of_time_says_so_and_queues_the_rest(self):
        link_for(self.me)
        with mock.patch.object(gc, "sync_link", return_value=self.PARTIAL) as sync, \
                mock.patch("django_q.tasks.async_task") as queue:
            r = self.client_for(self.me).post("/api/calendar/google/sync")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["partial"])
        self.assertIsNotNone(sync.call_args.kwargs.get("budget"))
        self.assertEqual(queue.call_args.args[1], [self.me.pk])

    def test_sync_now_while_another_sync_runs_says_to_wait(self):
        link_for(self.me)
        busy = {**self.PARTIAL, "partial": False, "busy": True}
        with mock.patch.object(gc, "sync_link", return_value=busy):
            r = self.client_for(self.me).post("/api/calendar/google/sync")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["busy"])


@override_settings(**CONFIGURED)
class LockTests(_Base):
    def setUp(self):
        super().setUp()
        self.link = link_for(self.me)

    def fresh(self):
        return GoogleCalendarLink.objects.get(pk=self.link.pk)

    def test_a_sync_already_running_is_not_doubled(self):
        GoogleCalendarLink.objects.filter(pk=self.link.pk).update(sync_started_at=timezone.now())
        make_event(self.office, "College seminar")
        result = gc.sync_link(self.fresh())
        self.assertTrue(result["busy"])
        self.assertEqual(self.fake.calls, [])
        self.assertTrue(self.fresh().resync)

    def test_a_lock_left_by_a_crashed_run_is_ignored_after_a_while(self):
        stale = timezone.now() - timedelta(minutes=gc.LOCK_MINUTES + 5)
        GoogleCalendarLink.objects.filter(pk=self.link.pk).update(sync_started_at=stale)
        make_event(self.office, "College seminar")
        result = gc.sync_link(self.fresh())
        self.assertFalse(result["busy"])
        self.assertEqual(self.fake.count("insert"), 1)

    def test_the_lock_is_let_go_afterwards_and_when_the_run_blows_up(self):
        gc.sync_link(self.fresh())
        self.assertIsNone(self.fresh().sync_started_at)
        with mock.patch.object(gc, "desired_bodies", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                gc.sync_link(self.fresh())
        self.assertIsNone(self.fresh().sync_started_at)

    def test_an_edit_that_lands_mid_sync_is_picked_up_by_the_run_in_progress(self):
        make_event(self.office, "First", starts_on=date(2026, 10, 20))
        real = self.fake.events
        arrived = {"done": False}

        def events():
            ev = real()
            insert = ev.insert

            def noisy(calendarId, body):
                if not arrived["done"]:
                    arrived["done"] = True
                    make_event(self.office, "Second", starts_on=date(2026, 10, 21))
                    nested = gc.sync_link(self.fresh())  # what the queued task would do
                    assert nested["busy"], nested
                return insert(calendarId, body)

            ev.insert = noisy
            return ev

        with mock.patch.object(self.fake, "events", events):
            gc.sync_link(self.fresh())
        self.assertEqual(sorted(e["summary"] for e in self.fake.all_events().values()), ["First", "Second"])
        self.assertEqual(self.fake.count("insert"), 2)
        self.assertFalse(self.fresh().resync)

    def test_the_daily_run_skips_a_person_whose_sync_is_running_without_failing(self):
        GoogleCalendarLink.objects.filter(pk=self.link.pk).update(sync_started_at=timezone.now())
        summary = gc.sync_all()
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(self.fake.calls, [])


@override_settings(**CONFIGURED)
class TimeoutTests(TestCase):
    def test_google_is_not_waited_on_for_a_minute(self):
        """The Calendar client's own default is 60 s and the token call's is 120:
        both longer than the 120 s a web request is allowed."""
        from google.oauth2.credentials import Credentials

        user = make_user("gt-me@x.edu")
        link = link_for(user)
        seen = {}

        def fake_refresh(creds, request):
            creds.token = "access-token"
            seen["request"] = request

        with mock.patch.object(Credentials, "refresh", fake_refresh):
            service = REAL_BUILD_SERVICE(link)
        self.assertEqual(service._http.http.timeout, gc.HTTP_TIMEOUT)
        # The refresh goes through a caller that asks for the short timeout too.
        sent = {}

        class Recorder:
            def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kw):
                sent["timeout"] = timeout
                return mock.Mock(status=200, data=b"{}", headers={})

        with mock.patch.object(gc, "GoogleRequest", Recorder):
            seen["request"] = None
            wrapped = gc._timed_request()
            wrapped("https://oauth2.googleapis.com/token", method="POST", body=b"", headers={})
        self.assertEqual(sent["timeout"], gc.HTTP_TIMEOUT)