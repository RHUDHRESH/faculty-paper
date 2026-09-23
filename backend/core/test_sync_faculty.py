"""The account sync reads email cells the ERP actually contains."""
from django.core.management import call_command
from django.test import TestCase

from core.management.commands.sync_faculty_users import pick_email
from core.models import FacultyMaster, User


class PickEmailTests(TestCase):
    def test_the_college_address_wins_over_a_personal_one(self):
        self.assertEqual(
            pick_email("rohini@gmail.com, rohinim@saveetha.ac.in"), "rohinim@saveetha.ac.in"
        )
        self.assertEqual(
            pick_email("indhu@saveetha.ac.in & indhu@gmail.com"), "indhu@saveetha.ac.in"
        )
        self.assertEqual(pick_email("a@yahoo.co.in hod.ece@saveetha.ac.in"), "hod.ece@saveetha.ac.in")

    def test_a_single_personal_address_is_kept(self):
        self.assertEqual(pick_email("  Someone@Gmail.com "), "someone@gmail.com")

    def test_a_cell_with_no_address_gives_nothing(self):
        self.assertIsNone(pick_email("m.phil., ph.d.,"))
        self.assertIsNone(pick_email(""))


class SyncPasswordTests(TestCase):
    def test_every_new_account_gets_its_own_password(self):
        for i in range(3):
            FacultyMaster.objects.create(
                staff_id=f"T{i}", name=f"Person {i}", email=f"p{i}@saveetha.ac.in", department="CSE"
            )
        call_command("sync_faculty_users", verbosity=0)
        hashes = set(User.objects.filter(email__startswith="p").values_list("password", flat=True))
        self.assertEqual(len(hashes), 3)
        self.assertTrue(all(u.must_change_password for u in User.objects.filter(email__startswith="p")))
