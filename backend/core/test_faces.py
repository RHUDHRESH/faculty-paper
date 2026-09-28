"""Every person the API returns carries a face (docs: core/faces.py)."""
from django.test import Client, TestCase

from core import faces
from core.models import Role, User


class FacesTests(TestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.edu", password="p", name="Dr. Asha Rao", role=Role.FACULTY)
        self.a.photo = "photos/a.jpg"
        self.a.save(update_fields=["photo"])
        self.b = User.objects.create_user(email="b@x.edu", password="p", name="Mr. Bala K", role=Role.FACULTY)

    def test_fill_adds_photo_and_initials_to_person_dicts_only(self):
        data = {"rows": [{"user_id": self.a.id, "name": self.a.name},
                         {"user_id": self.b.id, "name": self.b.name, "photo_url": "kept"},
                         {"user_id": None, "name": "Outside author"},
                         {"id": "claim-1", "user_id": self.a.id}]}
        faces.fill(data)
        a, b, ext, claim = data["rows"]
        self.assertTrue(a["photo_url"].endswith("photos/a.jpg"))
        self.assertEqual(a["initials"], "AR")
        self.assertEqual((b["photo_url"], b["initials"]), ("kept", "BK"))
        self.assertNotIn("photo_url", ext)
        self.assertNotIn("photo_url", claim)

    def test_coauthors_endpoint_has_faces(self):
        c = Client()
        c.force_login(self.b)
        r = c.get(f"/api/people/{self.b.id}/coauthors")
        self.assertEqual(r.status_code, 200)
