#!/usr/bin/env bash
# Cloud Run entrypoint: migrations, the django-q2 job worker, then gunicorn.
#
# qcluster shares this container rather than running as a second paid service.
# Cloud Run throttles CPU outside requests, so the service is deployed with
# --no-cpu-throttling and --min-instances=1 to keep the worker alive; if it is
# killed anyway, the ORM broker re-delivers on the next boot and the 5-minute
# recover-stale-batches schedule resumes anything interrupted mid-run.
set -euo pipefail

python manage.py migrate --noinput

python manage.py qcluster &

exec gunicorn config.wsgi:application \
  --bind "0.0.0.0:${PORT:-8080}" \
  --workers 1 --threads 8 \
  --timeout 120 --keep-alive 5 \
  --access-logfile - --error-logfile -
