"""Queue the one-time data fills after a deploy (called by scripts/start.sh).

Does nothing unless settings.DATA_FILL_ON_DEPLOY (env DATA_FILL_ON_DEPLOY)
holds a run id the database has not seen: see core.services.data_fill.
"""
from django.core.management.base import BaseCommand

from core.services import data_fill


class Command(BaseCommand):
    help = "Queue the safe data fills once for the run id in DATA_FILL_ON_DEPLOY."

    def handle(self, *args, **opts):
        self.stdout.write(f"data fill after deploy: {data_fill.queue_once_after_deploy()}")
