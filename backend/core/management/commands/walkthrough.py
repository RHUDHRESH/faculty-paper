"""Walk a paper from filing to payment, printing what each desk sees.

Run against a throwaway database, never the live one -- it creates accounts
and moves money, and doing that to real records to prove a point would be
worse than not proving it:

    python backend/manage.py test core.tests.WalkthroughTest

This exists because "632 tests pass" is an assertion about the suite, not a
thing anybody can read. This prints the actual chain, desk by desk, with the
real amounts the real formula produced.
"""

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Explains how to run the end-to-end walkthrough safely."

    def handle(self, *args, **options):
        self.stdout.write(
            "The walkthrough runs as a test, so it gets a throwaway database:\n\n"
            "    python backend/manage.py test core.tests.WalkthroughTest -v 2\n\n"
            "Running it against the live database would create accounts and "
            "mark real claims paid."
        )
