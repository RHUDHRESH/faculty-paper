"""The college picture is rebuilt off the request path when it is only old.

On the free host a rebuild takes longer than gunicorn's timeout, so a person
whose request happened to land at the ten-minute mark used to wait for it.
"""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from core.services import research_picture as picture


class OldButUnchanged(TestCase):
    def setUp(self):
        picture._SHARED.update(sig=None, at=0.0, college=None)
        self.addCleanup(picture._SHARED.update, sig=None, at=0.0, college=None)

    def test_an_old_copy_is_served_while_a_new_one_is_built(self):
        first, second = object(), object()
        with mock.patch.object(picture, "_signature", return_value=("same",)), \
                mock.patch.object(picture, "_College", side_effect=[first, second]), \
                mock.patch.object(picture.threading, "Thread") as thread:
            self.assertIs(picture.shared_college(), first)
            picture._SHARED["at"] -= picture._MAX_AGE + 1
            self.assertIs(picture.shared_college(), first)  # no wait
            thread.assert_called_once()
            target, args = thread.call_args.kwargs["target"], thread.call_args.kwargs["args"]
            target(*args)  # what the thread would do
        self.assertIs(picture._SHARED["college"], second)
        self.assertFalse(picture._REBUILD.locked())

    def test_a_changed_record_is_built_at_once(self):
        first, second = object(), object()
        with mock.patch.object(picture, "_College", side_effect=[first, second]), \
                mock.patch.object(picture.threading, "Thread") as thread:
            with mock.patch.object(picture, "_signature", return_value=("before",)):
                self.assertIs(picture.shared_college(), first)
            with mock.patch.object(picture, "_signature", return_value=("after a harvest",)):
                self.assertIs(picture.shared_college(), second)
            thread.assert_not_called()
