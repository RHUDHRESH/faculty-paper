#!/usr/bin/env bash
# Container entrypoint: migrations, gunicorn, and -- once gunicorn is up -- the
# django-q2 job worker.
#
# qcluster shares this container rather than running as a second paid service.
# If it is killed, the ORM broker re-delivers on the next boot and the 5-minute
# recover-stale-batches schedule resumes anything interrupted mid-run.
#
# On Render's free plan the container has a tenth of a CPU and is put to sleep
# when idle, so this script runs on the first request after every nap and the
# person who sent it waits for all of it. Two things keep that short:
#
#   * `migrate --skip-checks`: the system checks run again when gunicorn loads
#     the app, so running them here as well only doubled the wait. Migrations
#     still apply before anything is served.
#   * the job worker starts QCLUSTER_DELAY seconds after gunicorn, not beside
#     it. Both load all of Django, which on a tenth of a CPU is most of the
#     boot; loading them one after the other lets the web process answer first.
set -euo pipefail

python manage.py migrate --noinput --skip-checks

( sleep "${QCLUSTER_DELAY:-30}"; exec python manage.py qcluster ) &

# The access log comes from core.log's middleware as one structured JSON
# line per request -- severity, request id, trace, user, duration -- which
# is what Cloud Logging can query and Error Reporting can join. Gunicorn's
# own plain-text access log would be a second, worse copy of the same facts,
# so it is off and the error log stays.
exec gunicorn config.wsgi:application \
  --bind "0.0.0.0:${PORT:-8080}" \
  --workers 1 --threads 8 \
  --timeout 120 --keep-alive 5 \
  --access-logfile none --error-logfile -
