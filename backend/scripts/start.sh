#!/usr/bin/env bash
# Render start command: migrations, the django-q2 job worker, then gunicorn.
#
# The free tier has no separate worker service, so qcluster shares this
# container. If it dies with the container (deploy, idle spin-down), the ORM
# broker re-delivers queued work on the next boot and the 5-minute
# recover-stale-batches schedule resumes anything killed mid-run.
set -euo pipefail

python manage.py migrate --noinput

python manage.py qcluster &

exec gunicorn config.wsgi:application --bind "0.0.0.0:${PORT}" --workers 2 --timeout 300
