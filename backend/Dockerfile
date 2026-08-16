# Cloud Run image. Built from the backend/ directory (see cloudbuild via
# `gcloud run deploy --source backend`), so the build context is this folder.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# libpq for psycopg; no build toolchain needed since every wheel is binary.
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Static files are baked into the image and served by whitenoise. The dummy
# key and sqlite fallback exist only so this build step can import settings;
# the real values arrive as Cloud Run environment variables at runtime.
RUN DJANGO_DEBUG=true DJANGO_SECRET_KEY=build-only \
    python manage.py collectstatic --noinput

EXPOSE 8080
CMD ["bash", "scripts/start.sh"]
