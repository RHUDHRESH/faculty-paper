"""Print the registered route table of core.api in registration order.

Used to prove the api.py -> package split moved every endpoint without
changing paths, methods or their order: dump before the split, dump after,
diff. Order matters -- django-ninja resolves the first matching path, so a
changed order can silently reroute /claims/bulk-clear to /claims/{id}.

Run from the repo root:  python scripts/dump_routes.py
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from core.api import api  # noqa: E402


def main() -> None:
    count = 0
    # Resolution order in django-ninja is the insertion order of
    # router.path_operations, and within a path the order of its operations.
    for _prefix, router in api._routers:
        for path, view in router.path_operations.items():
            for op in view.operations:
                methods = ",".join(sorted(op.methods))
                fn = getattr(op.view_func, "__name__", "?")
                print(f"{path}\t{methods}\t{fn}\t{op.operation_id}")
                count += 1
    print(f"# {count} route operations", file=sys.stderr)


if __name__ == "__main__":
    main()
