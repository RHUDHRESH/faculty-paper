"""/api/auth/me says whether the login is a placeholder office seat (a .local address)."""
from django.test import Client, TestCase

from core.models import Role, User


class PlaceholderMeTests(TestCase):
    def _me(self, email, role):
        u = User.objects.create_user(email=email, password="pass", name="Someone", role=role)
        c = Client()
        c.force_login(u)
        return c.get("/api/auth/me").json()

    def test_local_domain_is_placeholder(self):
        self.assertIs(self._me("director@saveetha.local", Role.DIRECTOR)["placeholder"], True)

    def test_real_domain_is_not(self):
        self.assertIs(self._me("ravi@saveetha.com", Role.FACULTY)["placeholder"], False)

    def test_local_in_name_only_is_not(self):
        self.assertIs(self._me("local@saveetha.edu", Role.FACULTY)["placeholder"], False)
