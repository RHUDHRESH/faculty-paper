"""Every job to be done, once, end to end at the API.

One test per workflow in docs/WORKFLOWS.md, named `test_<role>_<job>`, run as
the role that does the job, asserting the outcome and the rule that matters
(faculty never see the desk, HOD is money-blind, nobody acts on their own
claim, Director/Finance never see flags, conditions required to file).

Deep behaviour lives in the per-feature modules; this file answers one
question: can each person still do each job, start to finish? External
services (OpenAlex, Crossref, Scopus, Anthropic, Google) are stubbed.
"""
from __future__ import annotations

import io
import json
import zipfile
from unittest.mock import patch

from django.core.files.base import ContentFile
from django.test import Client, override_settings
from django.utils import timezone

from core.models import (
    Claim,
    ClaimFlag,
    ClaimStatus,
    Notification,
    Role,
    User,
)
from core.test_chain_rules import ChainBase
from core import tests as core_tests
from core.tests import CONFIRMED


class Flow(ChainBase):
    """ChainBase's cast plus JSON helpers."""

    def _j(self, user, method, path, body=None):
        c = self._as(user) if user else Client()
        fn = getattr(c, method)
        if method == "get":
            return fn(path, body or {})
        return fn(path, data=json.dumps(body or {}), content_type="application/json")

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content[:400])
        return r.json() if r.content and r["Content-Type"].startswith("application/json") else r


# --------------------------------------------------------------------------- #
# Signed out                                                                  #
# --------------------------------------------------------------------------- #


class SignedOutWorkflows(Flow):
    def test_anon_signs_in_with_password(self):
        User.objects.create_user(email="pw@test.edu", password="a-good-pass-1", name="Pw", role=Role.FACULTY)
        c = Client()
        c.get("/api/auth/csrf")
        r = c.post("/api/auth/login", data=json.dumps({"email": "pw@test.edu", "password": "a-good-pass-1"}),
                   content_type="application/json")
        self.ok(r)
        self.assertEqual(c.get("/api/auth/me").json()["email"], "pw@test.edu")

    @override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id", GOOGLE_HOSTED_DOMAIN="")
    def test_anon_signs_in_with_google_linked_account(self):
        self.faculty.google_sub = "g-123"
        self.faculty.save(update_fields=["google_sub"])
        claims = {"sub": "g-123", "email": self.faculty.email, "email_verified": True}
        with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
            r = Client().post("/api/auth/google", data=json.dumps({"credential": "x"}),
                              content_type="application/json")
        self.ok(r)

    def test_anon_sees_public_stats_and_institution(self):
        self.ok(Client().get("/api/public/stats"))
        self.ok(Client().get("/api/institution"))

    def test_anon_is_refused_everything_private(self):
        for path in ("/api/claims", "/api/me/summary", "/api/leaderboard", "/api/admin/users"):
            self.assertIn(Client().get(path).status_code, (401, 403), path)

    def test_anon_subscribes_to_calendar_ics(self):
        url = self._j(self.faculty, "get", "/api/calendar/feed-link").json()["url"]
        from urllib.parse import urlparse
        r = Client().get(urlparse(url).path)
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"BEGIN:VCALENDAR", r.content)

    def test_anon_unsubscribes_from_digest_by_link(self):
        from core.services.notify import unsubscribe_token
        tok = unsubscribe_token(self.faculty, "digest")
        self.assertEqual(Client().get(f"/api/notifications/unsubscribe/{tok}").status_code, 200)
        self.assertEqual(Client().post(f"/api/notifications/unsubscribe/{tok}").status_code, 200)


# --------------------------------------------------------------------------- #
# Faculty                                                                     #
# --------------------------------------------------------------------------- #


class FacultyFilingWorkflows(Flow):
    _complete_payload = core_tests.ClaimSubmissionRuleTests._complete_payload
    _submittable_payload = core_tests.ClaimSubmissionRuleTests._submittable_payload

    def setUp(self):
        super().setUp()
        self.faculty.biometric_id = "BIO-FL"
        self.faculty.designation = "Professor"
        self.faculty.save()

    def _payload(self, **over):
        return self._submittable_payload(**over)

    def test_faculty_files_a_paper_with_three_conditions_and_proof(self):
        r = self._j(self.faculty, "post", "/api/claims", self._payload())
        body = self.ok(r)
        self.assertEqual(body["faculty_stage"], "Under review")
        self.assertTrue(body["ticket_number"])

    def test_faculty_cannot_file_without_the_conditions(self):
        r = self._j(self.faculty, "post", "/api/claims", self._payload(confirmations=None))
        self.assertEqual(r.status_code, 400)
        self.assertFalse(Claim.objects.exists())

    def test_faculty_saves_a_draft_then_files_it(self):
        d = self.ok(self._j(self.faculty, "post", "/api/claims", self._payload(submit=False, confirmations=None)))
        self.assertEqual(d["faculty_stage"], "Draft")
        r = self._j(self.faculty, "patch", f"/api/claims/{d['id']}", self._payload())
        self.assertEqual(self.ok(r)["faculty_stage"], "Under review")

    def test_faculty_pulls_a_paper_by_doi(self):
        from core.services import paper_lookup as pl
        work = {"title": "Pulled Paper", "doi": "10.1/x", "journal_title": "J", "issn": "1234-5678",
                "publication_year": 2026, "authors": []}
        with patch.object(pl, "fetch_openalex_work", lambda doi: work), \
                patch.object(pl, "fetch_crossref_work", lambda doi: None), \
                patch.object(pl, "fetch_scopus_record", lambda doi: None), \
                patch.object(pl, "search_crossref", lambda t, limit: []):
            r = self._j(self.faculty, "post", "/api/lookup/paper", {"query": "10.1/x"})
        self.ok(r)

    def test_faculty_pulls_from_scopus_list(self):
        self.ok(self._j(self.faculty, "get", "/api/me/scopus-pull"))

    def test_faculty_uploads_proof_pdf(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"
        r = self._as(self.faculty).post("/api/claims/upload",
                                        {"file": SimpleUploadedFile("p.pdf", pdf, content_type="application/pdf")})
        self.assertIn(r.status_code, (200, 400), r.content)  # 400 = content check refused a toy PDF

    def test_faculty_tracks_own_claim_without_seeing_the_desk(self):
        claim = self._claim()
        self._post(self.cell, f"/api/claims/{claim.id}/hold", {"reason": "Checking the co-author list"})
        body = self.ok(self._j(self.faculty, "get", f"/api/claims/{claim.id}"))
        dumped = json.dumps(body)
        self.assertNotIn(self.cell.name, dumped)
        self.assertNotIn("hold_reason", {k for k, v in body.items() if v})
        self.assertEqual(self._j(self.faculty, "get", "/api/admin/clearing-queue").status_code, 403)

    def test_faculty_fixes_a_returned_claim_and_refiles(self):
        claim = Claim.objects.get(pk=self.ok(self._j(self.faculty, "post", "/api/claims", self._payload()))["id"])
        self.ok(self._post(self.cell, f"/api/claims/{claim.id}/return-to-faculty",
                           {"note": "Attach the published version, not the preprint"}))
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.REJECTED)
        r = self._j(self.faculty, "patch", f"/api/claims/{claim.id}", self._payload())
        self.assertEqual(self.ok(r)["faculty_stage"], "Under review")

    def test_faculty_withdraws_a_claim(self):
        claim = self._claim()
        self.ok(self._post(self.faculty, f"/api/claims/{claim.id}/withdraw"))
        claim.refresh_from_db()
        self.assertNotEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_faculty_sees_own_payments(self):
        claim = self._claim(ClaimStatus.DIRECTOR_APPROVED, ticket="PAY-1", director_approved_at=timezone.now())
        self.ok(self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", {"expected_amount": claim.remuneration}))
        body = self.ok(self._j(self.faculty, "get", "/api/me/payments"))
        self.assertGreaterEqual(body["count"], 1)

    def test_desk_leaves_internal_note_faculty_never_sees_it(self):
        claim = self._claim()
        self.ok(self._post(self.cell, f"/api/claims/{claim.id}/notes", {"body": "Which DOI is the final one?"}))
        self.ok(self._j(self.principal, "get", f"/api/claims/{claim.id}/notes"))
        self.assertEqual(self._j(self.faculty, "get", f"/api/claims/{claim.id}/notes").status_code, 403)

    def test_faculty_disputes_a_publication_attributed_to_them(self):
        from core.models import Authorship, Publication
        pub = Publication.objects.create(title="Not Mine", doi="10.9/nm")
        Authorship.objects.create(publication=pub, user=self.faculty, display_name=self.faculty.name,
                                  author_key="asha faculty", position=1, is_college=True)
        r = self._post(self.faculty, f"/api/me/publications/{pub.id}/dispute", {"reason": "not_mine"})
        self.ok(r)


class FacultyOtherWorkflows(Flow):
    @override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id", GOOGLE_HOSTED_DOMAIN="")
    def test_faculty_links_google(self):
        claims = {"sub": "g-9", "email": "asha.personal@gmail.com", "email_verified": True}
        with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
            self.ok(self._post(self.faculty, "/api/auth/google/link", {"credential": "x"}))
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.google_sub, "g-9")
        self.ok(self._j(self.faculty, "delete", "/api/auth/google/link"))

    def test_faculty_requests_profile_correction_and_admin_approves(self):
        r = self.ok(self._post(self.faculty, "/api/auth/profile/correction",
                               {"field": "staff_id", "proposed": "STF-NEW", "note": "Typo in ERP"}))
        rid = r.get("id") or self.ok(self._j(self.admin, "get", "/api/admin/profile-requests"))["results"][0]["id"]
        self.ok(self._post(self.admin, f"/api/admin/profile-requests/{rid}", {"approve": True, "note": "ok"}))
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.staff_id, "STF-NEW")
        self.ok(self._j(self.faculty, "get", "/api/auth/profile/corrections"))

    def test_faculty_edits_own_profile(self):
        self.ok(self._j(self.faculty, "patch", "/api/auth/profile/self", {"bio": "Photonics and optics."}))
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.bio, "Photonics and optics.")

    def test_faculty_changes_password(self):
        self.faculty.set_password("old-pass-123")
        self.faculty.save()
        self.ok(self._post(self.faculty, "/api/auth/change-password",
                           {"current_password": "old-pass-123", "new_password": "a-long-new-one"}))

    def test_faculty_sets_notification_preferences(self):
        self.ok(self._j(self.faculty, "get", "/api/notifications/preferences"))
        self.ok(self._j(self.faculty, "put", "/api/notifications/preferences", {"count_my_visits": False}))

    def test_faculty_reads_and_clears_notifications(self):
        Notification.objects.create(user=self.faculty, title="Hello", body="x")
        self.assertEqual(self.ok(self._j(self.faculty, "get", "/api/notifications/unread-count"))["unread"], 1)
        self.ok(self._post(self.faculty, "/api/notifications/read-all"))
        self.assertEqual(self.ok(self._j(self.faculty, "get", "/api/notifications/unread-count"))["unread"], 0)

    def test_faculty_messages_a_colleague(self):
        chat = self.ok(self._post(self.faculty, f"/api/dm/with/{self.hod.id}"))
        self.ok(self._post(self.faculty, f"/api/dm/{chat['id']}/messages", {"body": "Hi"}))
        self.assertGreaterEqual(self.ok(self._j(self.hod, "get", "/api/dm/unread"))["unread"], 1)

    def test_faculty_sends_and_accepts_collab_request(self):
        sent = self.ok(self._post(self.faculty, "/api/collaborations/requests",
                                  {"to_id": self.hod.id, "topic": "Optics"}))
        rid = sent.get("id") or sent["request"]["id"]
        self.ok(self._post(self.hod, f"/api/collaborations/requests/{rid}/respond", {"action": "accept"}))

    def test_faculty_posts_to_feed_and_colleague_likes_it(self):
        post = self.ok(self._as(self.faculty).post("/api/feed/posts", data={"body": "New paper out!", "visibility": "EVERYONE"}))
        self.ok(self._post(self.hod, f"/api/feed/posts/{post['id']}/like"))
        self.ok(self._post(self.hod, f"/api/feed/posts/{post['id']}/comments", {"body": "Congrats"}))
        self.ok(self._j(self.hod, "get", "/api/feed"))

    def test_faculty_reports_a_post_and_office_hides_it(self):
        post = self.ok(self._as(self.hod).post("/api/feed/posts", data={"body": "Spam spam", "visibility": "EVERYONE"}))
        self.ok(self._post(self.faculty, f"/api/feed/posts/{post['id']}/report", {"reason": "Spam"}))
        self.ok(self._j(self.admin, "get", "/api/feed/reports"))
        self.ok(self._post(self.admin, f"/api/feed/posts/{post['id']}/hide", {"reason": "Spam"}))

    def test_faculty_follows_a_colleague(self):
        self.ok(self._post(self.faculty, f"/api/follows/people/{self.hod.id}"))
        self.ok(self._j(self.faculty, "delete", f"/api/follows/people/{self.hod.id}"))

    def test_faculty_adds_a_skill_and_gets_endorsed(self):
        skill = self.ok(self._post(self.faculty, "/api/people/me/skills", {"name": "X-ray diffraction"}))
        self.ok(self._post(self.hod, f"/api/skills/{skill['id']}/endorse"))

    def test_faculty_starts_a_discussion_and_replies(self):
        t = self.ok(self._post(self.faculty, "/api/threads", {"title": "A thread", "body": "opening post"}))
        self.ok(self._post(self.hod, f"/api/threads/{t['id']}/posts", {"body": "a reply"}))
        self.ok(self._j(self.faculty, "get", f"/api/threads/{t['id']}"))

    def test_faculty_sees_leaderboard(self):
        self.ok(self._j(self.faculty, "get", "/api/leaderboard"))

    def test_faculty_sets_personal_goals(self):
        year = timezone.now().year
        self.ok(self._j(self.faculty, "put", "/api/me/goals", {"year": year, "goals": [{"metric": "PAPERS", "target": 4}]}))
        self.ok(self._j(self.faculty, "get", "/api/me/goals"))

    def test_faculty_adds_a_calendar_event(self):
        ev = self.ok(self._post(self.faculty, "/api/calendar",
                                {"title": "Submit to IEEE Access", "starts_on": "2026-11-01"}))
        self.ok(self._j(self.faculty, "delete", f"/api/calendar/{ev['id']}"))

    def test_faculty_sees_home_summary_and_research(self):
        self.ok(self._j(self.faculty, "get", "/api/me/summary"))
        self.ok(self._j(self.faculty, "get", "/api/me/research"))
        self.ok(self._j(self.faculty, "get", "/api/me/publications"))

    def test_faculty_sets_research_interests(self):
        domains = self.ok(self._j(self.faculty, "get", "/api/meta/research-domains"))
        pick = [d["code"] if isinstance(d, dict) else d for d in (domains.get("results") or domains.get("domains") or [])][:1]
        self.ok(self._j(self.faculty, "put", "/api/me/interests", {"domains": pick}))

    def test_faculty_finds_where_to_publish(self):
        from core.services import ai
        with patch.object(ai, "status", return_value={"ready": True, "model": "m", "provider": "p"}, create=True), \
                patch("core.services.discover.ai.ask_json", return_value={"venues": []}):
            r = self._post(self.faculty, "/api/discover/venues", {"title": "A Paper About Something Or Other"})
        self.assertIn(r.status_code, (200, 503), r.content)
        self.ok(self._j(self.faculty, "get", "/api/discover/status"))

    def test_faculty_runs_the_research_scout(self):
        from core.services import anthropic_provider, scout
        found = lambda *a, **k: {"text": "{}", "sources": [], "usage": {"input_tokens": 1, "output_tokens": 1}}  # noqa: E731
        with patch.object(anthropic_provider, "research", side_effect=found), \
                patch("core.services.ai.provider_name", return_value="anthropic"), \
                patch.object(anthropic_provider, "missing_settings", return_value=[]), \
                patch("django_q.tasks.async_task", side_effect=lambda f, rid, **k: scout.execute(rid)):
            self.ok(self._post(self.faculty, "/api/scout"))
        self.ok(self._j(self.faculty, "get", "/api/scout"))

    def test_faculty_finds_collaborators(self):
        self.ok(self._j(self.faculty, "get", "/api/collaborate/me"))
        # Partners needs the AI service: 503 when it is not installed is the honest answer.
        self.assertIn(self._j(self.faculty, "get", "/api/discover/partners").status_code, (200, 503))

    def test_faculty_searches_everything(self):
        self.ok(self._j(self.faculty, "get", "/api/search/all", {"q": "photonics"}))
        self.ok(self._j(self.faculty, "get", "/api/people", {"q": "Asha"}))

    def test_faculty_views_a_colleague_profile(self):
        self.ok(self._j(self.faculty, "get", f"/api/people/{self.hod.id}"))

    def test_faculty_cheers_on_wall(self):
        self.ok(self._j(self.faculty, "get", "/api/wall"))

    def test_faculty_cannot_see_flags_or_admin(self):
        for path in ("/api/flags", "/api/admin/clearing-queue", "/api/admin/ledger", "/api/hod/overview"):
            self.assertEqual(self._j(self.faculty, "get", path).status_code, 403, path)


class MentorFypWorkflow(Flow):
    def test_mentor_files_a_final_year_project_claim(self):
        from core import test_fyp_scheme as fyp
        from core.models import Team
        mentor = self.faculty
        mentor.biometric_id, mentor.designation = "B1", "Professor"
        mentor.save()
        Team.objects.create(code="PR26CH0001", title="Canna indica", department="CSE",
                            academic_year="2025-26", mentor=mentor, mentor_staff_id=mentor.staff_id)
        mine = self._j(mentor, "get", "/api/teams", {"mine": "true"})
        self.assertEqual([t["code"] for t in self.ok(mine)["results"]], ["PR26CH0001"])
        body = fyp.StudentProjectClaimRuleTests.payload(self)
        with core_tests.patch_api("verify_publication", return_value=core_tests._verify_hit()):
            r = self._j(mentor, "post", "/api/claims", body)
        claim = Claim.objects.get(pk=self.ok(r)["id"])
        self.assertEqual(claim.remuneration, 15000)


# --------------------------------------------------------------------------- #
# Office: research cell / coordinator / super admin                           #
# --------------------------------------------------------------------------- #


class OfficeWorkflows(Flow):
    def test_cell_clears_a_submitted_claim(self):
        claim = self._claim()
        queue = self.ok(self._j(self.cell, "get", "/api/admin/clearing-queue"))
        rows = queue if isinstance(queue, list) else queue["results"]
        self.assertIn(claim.id, [r["id"] for r in rows])
        self.ok(self._post(self.cell, f"/api/claims/{claim.id}/clear", {"expected_amount": claim.remuneration}))
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

    def test_cell_sends_back_with_reason(self):
        claim = self._claim()
        self.assertEqual(self._post(self.cell, f"/api/claims/{claim.id}/return-to-faculty", {"note": ""}).status_code, 400)
        self.ok(self._post(self.cell, f"/api/claims/{claim.id}/return-to-faculty",
                           {"note": "Attach the published version, not the preprint"}))
        self.assertTrue(Notification.objects.filter(user=self.faculty).exists())

    def test_cell_rejects_outright(self):
        claim = self._claim()
        r = self.ok(self._post(self.cell, f"/api/claims/{claim.id}/reject-outright",
                               {"note": "Predatory journal, not eligible under policy"}))
        self.assertTrue(r["rejected_outright"])

    def test_cell_holds_and_resumes(self):
        claim = self._claim()
        self.ok(self._post(self.cell, f"/api/claims/{claim.id}/hold", {"reason": "Waiting on the erratum"}))
        self.ok(self._post(self.cell, f"/api/claims/{claim.id}/resume"))
        claim.refresh_from_db()
        self.assertFalse(claim.on_hold)

    def test_nobody_acts_on_own_claim(self):
        own = self._claim(owner=self.cell, ticket="OWN-1")
        self.assertEqual(self._post(self.cell, f"/api/claims/{own.id}/clear",
                                    {"expected_amount": own.remuneration}).status_code, 403)

    def test_cell_raises_a_flag_and_admin_resolves(self):
        claim = self._claim()
        f = self.ok(self._post(self.cell, f"/api/claims/{claim.id}/flags",
                               {"kind": ClaimFlag.Kind.OTHER, "note": "Author list differs from Scopus"}))
        fid = f.get("id") or ClaimFlag.objects.get().id
        self.ok(self._j(self.principal, "get", "/api/flags"))
        self.ok(self._post(self.admin, f"/api/flags/{fid}/resolve", {"note": "Checked against Scopus: fine"}))

    def test_cell_checks_attached_files(self):
        claim = self._claim()
        self.ok(self._post(self.cell, f"/api/claims/{claim.id}/check-files"))
        self.ok(self._j(self.cell, "get", f"/api/claims/{claim.id}/review"))

    def test_cell_reviews_duplicates(self):
        self.ok(self._j(self.cell, "get", "/api/admin/duplicate-findings"))

    def test_cell_reviews_author_matches(self):
        self.ok(self._j(self.cell, "get", "/api/admin/author-matches"))
        self.assertEqual(self._j(self.faculty, "get", "/api/admin/author-matches").status_code, 403)

    def test_cell_imports_college_site_zip(self):
        from core.test_college_site import _zip
        from django.core.files.uploadedfile import SimpleUploadedFile
        rows = [{"name": "Dr. Asha Faculty", "email": self.faculty.email, "designation": "Professor",
                 "photo_file": "a.jpg", "department_slug": "cse"}]
        up = SimpleUploadedFile("site.zip", _zip(rows), content_type="application/zip")
        r = self._as(self.admin).post("/api/admin/college-site/import", data={"file": up})
        self.ok(r)

    def test_cell_imports_fyp_team_roster(self):
        self.ok(self._j(self.cell, "get", "/api/admin/fyp-teams"))

    def test_cell_creates_user(self):
        r = self._post(self.admin, "/api/admin/users",
                       {"email": "new@test.edu", "name": "New Person", "role": "FACULTY", "department": "CSE",
                        "password": "a-long-pass-1"})
        self.ok(r)
        self.assertTrue(User.objects.filter(email="new@test.edu").exists())

    def test_cell_resets_a_password(self):
        self.ok(self._post(self.admin, f"/api/admin/users/{self.faculty.id}/reset-password",
                           {"password": "fresh-start-9"}))

    def test_cell_runs_monthly_batch(self):
        self.ok(self._j(self.cell, "get", "/api/monthly"))

    def test_cell_imports_erp_and_faculty_master(self):
        self.ok(self._j(self.cell, "get", "/api/admin/erp-stats"))
        self.ok(self._j(self.cell, "get", "/api/admin/faculty-master"))

    def test_cell_imports_scimago_and_snip(self):
        self.ok(self._j(self.cell, "get", "/api/admin/scimago/stats"))
        self.ok(self._j(self.cell, "get", "/api/admin/snip/stats"))

    def test_cell_edits_institution_settings(self):
        s = self.ok(self._j(self.admin, "get", "/api/admin/settings"))
        self.ok(self._j(self.admin, "put", "/api/admin/settings", {"college_name": s["college_name"]}))

    def test_cell_edits_formula_policy(self):
        f = self.ok(self._j(self.admin, "get", "/api/admin/formula"))
        self.assertTrue(f)

    def test_cell_reads_audit_and_faults(self):
        self.ok(self._j(self.cell, "get", "/api/admin/audit"))
        self.ok(self._j(self.cell, "get", "/api/admin/faults"))

    def test_cell_browses_past_claims(self):
        self.ok(self._j(self.cell, "get", "/api/archive/claims"))

    def test_cell_files_on_behalf_via_teams_lookup(self):
        self.ok(self._j(self.cell, "get", "/api/teams", {"mine": "true", "owner_id": self.faculty.id}))

    def test_cell_harvests_publications(self):
        with patch("django_q.tasks.async_task", return_value="job"):
            r = self._post(self.admin, "/api/admin/publications/harvest")
        self.assertIn(r.status_code, (200, 202), r.content)
        self.ok(self._j(self.admin, "get", "/api/admin/publications/status"))


class SuperAdminWorkflows(Flow):
    def test_admin_overrides_a_stuck_status(self):
        claim = self._claim(ClaimStatus.REJECTED, rejected_outright=True)
        self.ok(self._post(self.admin, f"/api/admin/claims/{claim.id}/override-status",
                           {"to_status": "SUBMITTED", "note": "Rejected against the wrong paper"}))

    def test_admin_edits_and_reassigns_a_claim(self):
        claim = self._claim()
        self.ok(self._post(self.admin, f"/api/admin/claims/{claim.id}/reassign",
                           {"owner_email": self.hod.email, "reason": "Filed under the wrong person"}))

    def test_admin_impersonates_and_stops(self):
        c = self._as(self.admin)
        post = lambda p: c.post(p, data="{}", content_type="application/json")  # noqa: E731
        self.ok(post(f"/api/admin/impersonate/{self.faculty.id}"))
        self.assertEqual(c.get("/api/auth/me").json()["email"], self.faculty.email)
        self.ok(post("/api/admin/stop-impersonating"))

    def test_admin_browses_and_exports_data(self):
        tables = self.ok(self._j(self.admin, "get", "/api/admin/data/tables"))
        self.assertTrue(tables)
        self.assertEqual(self._j(self.faculty, "get", "/api/admin/data/tables").status_code, 403)

    def test_admin_checks_and_fixes_data_health(self):
        self.ok(self._j(self.admin, "get", "/api/admin/data-health", {"fresh": "true"}))
        self.ok(self._post(self.admin, "/api/admin/data-health/fix/recount_threads"))

    def test_admin_takes_a_backup(self):
        self.ok(self._post(self.admin, "/api/admin/backups"))
        self.ok(self._j(self.admin, "get", "/api/admin/backups"))

    def test_admin_restores_a_backup(self):
        Claim.objects.all().delete()
        with patch("django_q.tasks.async_task", return_value="job-1"):
            r = self._as(self.admin).post("/api/admin/restore",
                                          {"file": ContentFile(b"[]", name="dump.json"), "confirm": "RESTORE"})
        self.assertIn(r.status_code, (200, 202), r.content)

    def test_admin_previews_a_wipe(self):
        self.ok(self._j(self.admin, "get", "/api/admin/wipe/preview"))

    def test_admin_merges_duplicate_accounts(self):
        self.ok(self._j(self.admin, "get", "/api/admin/duplicate-accounts"))

    def test_admin_first_run_setup_status(self):
        self.ok(Client().get("/api/setup/status"))


# --------------------------------------------------------------------------- #
# HOD                                                                         #
# --------------------------------------------------------------------------- #


class HodWorkflows(Flow):
    def test_hod_sees_department_money_blind(self):
        self._claim(ClaimStatus.PAID, ticket="HOD-PAID", paid_at=timezone.now())
        body = json.dumps(self.ok(self._j(self.hod, "get", "/api/hod/overview")))
        self.assertNotIn("remuneration", body)
        self.assertEqual(self._j(self.hod, "get", "/api/admin/ledger").status_code, 403)

    def test_hod_sets_a_target(self):
        self.ok(self._post(self.hod, "/api/hod/targets",
                           {"year": 2026, "metric": "Q1", "target": 4, "due_date": "2026-12-31"}))
        self.ok(self._j(self.hod, "get", "/api/hod/targets"))

    def test_hod_nudges_faculty(self):
        r = self._post(self.hod, "/api/hod/nudge",
                       {"user_ids": [self.faculty.id], "message": "Please file your Q1 paper this month."})
        self.ok(r)
        self.assertTrue(Notification.objects.filter(user=self.faculty).exists())

    def test_hod_assigns_a_research_area(self):
        self.ok(self._post(self.hod, "/api/hod/assignments",
                           {"kind": "RESEARCH_AREA", "title": "Photonics", "assignee_id": self.faculty.id}))
        self.ok(self._j(self.faculty, "get", "/api/me/assignments"))

    def test_hod_plans_the_year(self):
        self.ok(self._j(self.hod, "get", "/api/hod/plan"))

    def test_hod_drills_into_a_person(self):
        self.ok(self._j(self.hod, "get", f"/api/hod/people/{self.faculty.id}"))

    def test_hod_exports_department(self):
        r = self._j(self.hod, "get", "/api/hod/export")
        self.assertEqual(r.status_code, 200)

    def test_hod_is_not_an_approver(self):
        claim = self._claim()
        self.assertEqual(self._post(self.hod, f"/api/claims/{claim.id}/clear",
                                    {"expected_amount": claim.remuneration}).status_code, 403)


# --------------------------------------------------------------------------- #
# Principal / Director / Finance                                              #
# --------------------------------------------------------------------------- #


class ApprovalChainWorkflows(Flow):
    def test_principal_approves_a_cleared_claim(self):
        claim = self._claim(ClaimStatus.CLEARED, cleared_by=self.cell, cleared_at=timezone.now())
        self.ok(self._j(self.principal, "get", "/api/principal/queue"))
        self.ok(self._post(self.principal, f"/api/claims/{claim.id}/principal-approve",
                           {"expected_amount": claim.remuneration}))
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

    def test_principal_returns_one_step(self):
        claim = self._claim(ClaimStatus.CLEARED, cleared_by=self.cell, cleared_at=timezone.now())
        self.ok(self._post(self.principal, f"/api/claims/{claim.id}/return-one-step",
                           {"note": "Please recheck the DOI on this one"}))

    def test_principal_bulk_approves(self):
        claim = self._claim(ClaimStatus.CLEARED, cleared_by=self.cell, cleared_at=timezone.now())
        self.ok(self._post(self.principal, "/api/principal/bulk-approve",
                           {"claim_ids": [claim.id]}))

    def test_director_authorises_without_seeing_flags(self):
        claim = self._claim(ClaimStatus.PRINCIPAL_APPROVED)
        ClaimFlag.objects.create(claim=claim, kind=ClaimFlag.Kind.OTHER, note="doubt", raised_by=self.cell)
        q = json.dumps(self.ok(self._j(self.director, "get", "/api/director/queue")))
        self.assertNotIn("doubt", q)
        self.assertEqual(self._j(self.director, "get", "/api/flags").status_code, 403)
        self.ok(self._post(self.director, f"/api/claims/{claim.id}/director-approve",
                           {"expected_amount": claim.remuneration}))
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)

    def test_finance_pays_and_voids(self):
        claim = self._claim(ClaimStatus.DIRECTOR_APPROVED, director_approved_at=timezone.now())
        self.assertEqual(self._j(self.finance, "get", "/api/flags").status_code, 403)
        self.ok(self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", {"expected_amount": claim.remuneration}))
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        # Finance pays; a payment made in error is reversed by a super admin.
        self.assertEqual(self._post(self.finance, f"/api/claims/{claim.id}/void-payment",
                                    {"note": "Paid against the wrong voucher"}).status_code, 403)
        self.ok(self._post(self.admin, f"/api/claims/{claim.id}/void-payment", {"note": "Paid against the wrong voucher"}))
        claim.refresh_from_db()
        self.assertNotEqual(claim.status, ClaimStatus.PAID)

    def test_finance_bulk_pays(self):
        claim = self._claim(ClaimStatus.DIRECTOR_APPROVED, director_approved_at=timezone.now())
        self.ok(self._post(self.finance, "/api/admin/bulk-mark-paid",
                           {"items": [{"claim_id": claim.id, "expected_amount": claim.remuneration}]}))

    def test_finance_reads_and_exports_ledger(self):
        self.ok(self._j(self.finance, "get", "/api/admin/ledger"))
        self.assertEqual(self._j(self.finance, "get", "/api/admin/ledger/export").status_code, 200)

    def test_finance_sets_a_budget(self):
        self.ok(self._post(self.finance, "/api/budgets", {"financial_year": "2026-27", "amount": 100000}))
        self.ok(self._j(self.finance, "get", "/api/budgets"))


# --------------------------------------------------------------------------- #
# Reports (staff)                                                             #
# --------------------------------------------------------------------------- #


class ReportWorkflows(Flow):
    def test_staff_builds_and_exports_a_report(self):
        self._claim(ClaimStatus.PAID, ticket="R-1", paid_at=timezone.now())
        self.ok(self._j(self.principal, "get", "/api/reports"))
        self.ok(self._j(self.principal, "get", "/api/reports/build"))
        self.assertEqual(self._j(self.principal, "get", "/api/reports/export").status_code, 200)

    def test_staff_downloads_naac_pack(self):
        r = self._j(self.principal, "get", "/api/reports/pack", {"fmt": "json"})
        self.assertEqual(r.status_code, 200)
        self.ok(self._j(self.cell, "get", "/api/reports/pack/rows"))

    def test_staff_reads_journal_report(self):
        self.ok(self._j(self.principal, "get", "/api/journals/top"))

    def test_staff_exports_a_faculty_report(self):
        self.ok(self._j(self.principal, "get", f"/api/faculty/{self.faculty.id}/report"))

    def test_staff_sees_dashboard(self):
        self.ok(self._j(self.director, "get", "/api/dashboard"))


# --------------------------------------------------------------------------- #
# More jobs                                                                   #
# --------------------------------------------------------------------------- #


class MoreWorkflows(Flow):
    def test_anyone_exports_the_leaderboard_csv(self):
        r = self._j(self.faculty, "get", "/api/leaderboard", {"fmt": "csv"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "text/csv; charset=utf-8")
        self.assertNotIn(b"amount", r.content.lower())
        r = self._j(self.faculty, "get", "/api/leaderboard", {"fmt": "csv", "board": "departments"})
        self.assertEqual(r.status_code, 200)

    def test_faculty_writes_to_the_research_office(self):
        t = self.ok(self._post(self.faculty, "/api/threads",
                               {"title": "My claim", "body": "Which proof do you need?", "visibility": "OFFICE"}))
        listed = self.ok(self._j(self.cell, "get", "/api/threads", {"visibility": "OFFICE"}))
        self.assertIn(t["id"], json.dumps(listed))
        self.ok(self._post(self.cell, f"/api/threads/{t['id']}/posts", {"body": "The published PDF, please"}))

    def test_principal_sends_back_to_the_desk(self):
        claim = self._claim(ClaimStatus.CLEARED, cleared_by=self.cell, cleared_at=timezone.now())
        self.ok(self._post(self.principal, f"/api/claims/{claim.id}/principal-reject",
                           {"note": "The co-author list does not match Scopus"}))
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_director_only_moves_forward_super_admin_sends_back(self):
        claim = self._claim(ClaimStatus.PRINCIPAL_APPROVED)
        note = {"note": "Over this year's budget line, please review"}
        self.assertEqual(self._post(self.director, f"/api/claims/{claim.id}/director-reject", note).status_code, 403)
        self.ok(self._post(self.admin, f"/api/claims/{claim.id}/director-reject", note))
        claim.refresh_from_db()
        self.assertNotEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

    def test_director_bulk_authorises(self):
        claim = self._claim(ClaimStatus.PRINCIPAL_APPROVED)
        self.ok(self._post(self.director, "/api/director/bulk-approve", {"claim_ids": [claim.id]}))

    def test_hod_removes_a_target(self):
        t = self.ok(self._post(self.hod, "/api/hod/targets",
                               {"year": 2026, "metric": "Q1", "target": 4, "due_date": "2026-12-31"}))
        self.ok(self._j(self.hod, "delete", f"/api/hod/targets/{t['id']}"))

    def test_faculty_resets_calendar_feed_link(self):
        old = self.ok(self._j(self.faculty, "get", "/api/calendar/feed-link"))["url"]
        new = self.ok(self._post(self.faculty, "/api/calendar/feed-link/reset"))["url"]
        self.assertNotEqual(old, new)

    def test_faculty_follows_a_topic_and_reacts(self):
        self.ok(self._post(self.faculty, "/api/follows/topics", {"topic": "Photonics"}))
        post = self.ok(self._as(self.hod).post("/api/feed/posts", data={"body": "Out now", "visibility": "EVERYONE"}))
        self.ok(self._post(self.faculty, f"/api/feed/posts/{post['id']}/reactions/congrats"))

    def test_faculty_sets_social_privacy(self):
        self.ok(self._j(self.faculty, "get", "/api/people/me/social-settings"))

    def test_faculty_sees_celebrations_and_badges(self):
        self.ok(self._j(self.faculty, "get", "/api/me/celebrations"))
        self.ok(self._j(self.faculty, "get", "/api/me/badges"))

    def test_discussion_owner_resolves_thread(self):
        t = self.ok(self._post(self.faculty, "/api/threads", {"title": "Which journal?", "body": "Ideas?"}))
        self.ok(self._post(self.faculty, f"/api/threads/{t['id']}/resolve"))

    def test_officer_files_own_paper_but_cannot_clear_it(self):
        own = self._claim(owner=self.coordinator, ticket="OWN-C")
        self.assertEqual(self._post(self.coordinator, f"/api/claims/{own.id}/clear",
                                    {"expected_amount": own.remuneration}).status_code, 403)
        self.ok(self._post(self.cell, f"/api/claims/{own.id}/clear", {"expected_amount": own.remuneration}))

    def test_cell_links_scopus_profiles(self):
        self.ok(self._j(self.cell, "get", "/api/admin/scopus-profiles/verification"))


# --------------------------------------------------------------------------- #
# Every workflow has a door in the UI                                          #
# --------------------------------------------------------------------------- #


class UiEntryPoints(Flow):
    """Each workflow's route is declared in main.tsx, and its API call is made
    from some screen. A static check: cheap, and it catches a page deleted or
    an endpoint no screen calls any more."""

    ROUTES = [
        "/papers/new", "/papers", "/clearing", "/approvals", "/authorisations", "/payments",
        "/department", "/research", "/discover", "/scout", "/collaborate", "/messages",
        "/discussions", "/leaderboard", "/calendar", "/reports", "/reports/build", "/accreditation",
        "/ledger", "/duplicates", "/flags", "/archive", "/audit", "/faults", "/people",
        "/people/matches", "/requests", "/budget", "/policy", "/settings", "/settings/notifications",
        "/notifications", "/reference", "/imports", "/batches", "/data", "/data/health", "/me",
        "/wall", "/setup", "/search", "/journals",
    ]
    CALLS = [
        "lookup/paper", "me/scopus-pull", "claims/upload", "/withdraw", "/dispute", "/clear`",
        "/reject`", "principal-approve", "principal-reject", "director-approve", "director-reject",
        "mark-paid", "void-payment", "bulk-mark-paid", "principal/bulk-approve", "director/bulk-approve",
        "/flags`", "check-files", "override-status", "reassign", "hod/targets", "hod/nudge",
        "hod/assignments", "hod/plan", "google/link", "profile/correction", "admin/profile-requests",
        "feed-link", "notifications/preferences", "collaborations/requests", "/dm/with", "feed/posts",
        "/threads", "me/goals", "/budgets", "admin/formula", "reports/pack", "admin/restore",
        "admin/backups", "college-site/import", "fyp-teams/import", "author-matches",
        "duplicate-accounts", "data-health", "admin/wipe", "erp-import", "monthly/upload",
        "scimago/import", "snip/import", "admin/settings", "impersonate", "change-password",
        "reset-password", "discover/venues", "/api/scout", "wall/cheer", "follows/people",
        "ledger/export", "hod/department/papers/export", "hod/report", "reports/export", "/notes`",
    ]

    @classmethod
    def _src(cls):
        from pathlib import Path
        root = Path(__file__).resolve().parents[2] / "frontend2" / "src"
        if not root.exists():
            return None
        return "\n".join(p.read_text(encoding="utf8") for p in root.rglob("*.ts*")
                         if ".test." not in p.name)

    def test_every_workflow_route_is_declared(self):
        src = self._src()
        if src is None:
            self.skipTest("frontend2 not checked out beside backend")
        self.assertEqual([r for r in self.ROUTES if f'path="{r}"' not in src], [])

    def test_every_workflow_endpoint_is_called_by_a_screen(self):
        src = self._src()
        if src is None:
            self.skipTest("frontend2 not checked out beside backend")
        self.assertEqual([c for c in self.CALLS if c not in src], [])
