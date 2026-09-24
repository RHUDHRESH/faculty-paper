"""The API package: one module per section of the former core/api.py.

The star imports below run in the order the sections appeared in the
original file, and that order is what decides route registration
order -- django-ninja resolves the first matching path, so sections
registered earlier win. Do not reorder these imports without
re-checking the route table (scripts/dump_routes.py).

Every public and private name of every module is re-exported here so
`from core.api import anything` keeps working for callers and tests.
"""

from __future__ import annotations

from core.api.common import *  # noqa: F401,F403
from core.api.schemas import *  # noqa: F401,F403
from core.api.deps import *  # noqa: F401,F403
from core.api.auth import *  # noqa: F401,F403
from core.api.profile_requests import *  # noqa: F401,F403
from core.api.lookups import *  # noqa: F401,F403
from core.api.teams import *  # noqa: F401,F403
from core.api.claims import *  # noqa: F401,F403
from core.api.journals import *  # noqa: F401,F403
from core.api.director import *  # noqa: F401,F403
from core.api.desks import *  # noqa: F401,F403
from core.api.dashboard import *  # noqa: F401,F403
from core.api.discussions import *  # noqa: F401,F403
from core.api.calendar import *  # noqa: F401,F403
from core.api.notes import *  # noqa: F401,F403
from core.api.accreditation import *  # noqa: F401,F403
from core.api.data_removal import *  # noqa: F401,F403
from core.api.collaborate import *  # noqa: F401,F403
from core.api.discover import *  # noqa: F401,F403
from core.api.hod import *  # noqa: F401,F403
from core.api.hod_planning import *  # noqa: F401,F403
from core.api.data_explorer import *  # noqa: F401,F403
from core.api.budget import *  # noqa: F401,F403
from core.api.duplicates import *  # noqa: F401,F403
from core.api.superadmin import *  # noqa: F401,F403
from core.api.operations import *  # noqa: F401,F403
from core.api.admin import *  # noqa: F401,F403
from core.api.masters import *  # noqa: F401,F403
from core.api.finance import *  # noqa: F401,F403
from core.api.institution import *  # noqa: F401,F403
from core.api.restore import *  # noqa: F401,F403
from core.api.my_payments import *  # noqa: F401,F403
from core.api.flags import *  # noqa: F401,F403
from core.api.rewards import *  # noqa: F401,F403
