#!/bin/sh
set -e
python manage.py migrate --noinput
python manage.py collectstatic --noinput 2>/dev/null || true
exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers 2
