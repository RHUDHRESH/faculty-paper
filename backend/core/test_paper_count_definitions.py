"""The two college paper totals agree, or differ only by their stated definition.

The leaderboard footer ("N papers ... from the M by current faculty") and the
college tab of My research ("published K papers") both print a college total.
They count different things on purpose, so each label says which. This pins
the one relationship between them: the leaderboard's figure is the college's
minus the papers no current faculty member wrote (a leaver, an officer).
"""

from __future__ import annotations

from datetime import date

from django.core.cache import cache
from django.test import TestCase

from core.models import Publication, Role, User
from core.services import honours_board, research_picture
from core.test_honours_board import TODAY, on, pub


class PaperCountDefinitionTests(TestCase):
    def setUp(self):
        cache.clear()
        honours_board.forget()
        research_picture._SHARED.update(sig=None, college=None)
        self.addCleanup(research_picture._SHARED.update, sig=None, college=None)
        mk = lambda n, role=Role.FACULTY, active=True: User.objects.create_user(  # noqa: E731
            email=f"{n}@x.edu", password=None, name=n.title(), role=role, department="ECE", active=active)
        self.current, self.left, self.officer = mk("current"), mk("left", active=False), mk("officer", Role.PRINCIPAL)
        on(pub("By current", date(2025, 7, 1)), self.current, 1)
        shared = pub("By current and left", date(2025, 8, 1))
        on(shared, self.current, 1)
        on(shared, self.left, 2)
        on(pub("Only a leaver", date(2024, 8, 1)), self.left, 1)
        on(pub("Only an officer", date(2024, 9, 1)), self.officer, 1)
        on(pub("Outside the college", date(2024, 9, 1)), None, 1)

    def test_leaderboard_total_is_the_colleges_minus_papers_no_current_faculty_wrote(self):
        board = honours_board.board(category="score", period="all", on=TODAY)
        college = research_picture.college_research(self.current)["totals"]["papers"]
        current = board["method"]["papers_in_record"]
        self.assertEqual((current, college), (2, 4))
        only_others = Publication.objects.filter(title__in=["Only a leaver", "Only an officer"]).count()
        self.assertEqual(college - current, only_others)
        self.assertEqual(board["totals"]["papers"], current)
