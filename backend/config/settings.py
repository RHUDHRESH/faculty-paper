import os
from pathlib import Path
from urllib.parse import urlparse, unquote

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BASE_DIR.parent

load_dotenv(ROOT_DIR / ".env")
load_dotenv(BASE_DIR / ".env")

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", os.getenv("AUTH_SECRET", "dev-insecure-change-me"))
DEBUG = os.getenv("DJANGO_DEBUG", "true").lower() in ("1", "true", "yes")
if not DEBUG and SECRET_KEY in ("dev-insecure-change-me", "", "changeme"):
    raise RuntimeError("DJANGO_SECRET_KEY must be set to a strong value when DJANGO_DEBUG=false")
ALLOWED_HOSTS = [
    h.strip()
    for h in os.getenv(
        "DJANGO_ALLOWED_HOSTS",
        # .run.app covers Cloud Run's generated service URLs.
        "localhost,127.0.0.1,.run.app",
    ).split(",")
    if h.strip()
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "django_q",
    "core",
]

# Background jobs: django-q2 on the ORM broker — no Redis, and the qcluster
# process shares the container with gunicorn (scripts/start.sh) rather than
# running as a second paid service. Q_SYNC=true runs tasks inline (tests/dev).
Q_CLUSTER = {
    "name": "faculty_paper",
    "workers": 1,  # shares one small container with gunicorn
    "timeout": 3300,
    "retry": 3600,
    "max_attempts": 2,
    "orm": "default",
    "poll": 15,
    "catch_up": False,
    "sync": os.getenv("Q_SYNC", "false").lower() == "true",
}

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"


def _database_from_url(url: str) -> dict:
    """Parse postgres URL including Supabase (sslmode=require)."""
    parsed = urlparse(url)
    name = (parsed.path or "/").lstrip("/") or "postgres"
    # strip query from path if any
    if "?" in name:
        name = name.split("?", 1)[0]
    opts = {}
    if parsed.query:
        from urllib.parse import parse_qs

        qs = parse_qs(parsed.query)
        sslmode = (qs.get("sslmode") or [None])[0]
        if sslmode:
            opts["sslmode"] = sslmode
    # Supabase always needs SSL
    host = parsed.hostname or ""
    if "supabase" in host and "sslmode" not in opts:
        opts["sslmode"] = "require"
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": unquote(parsed.username or ""),
        "PASSWORD": unquote(parsed.password or ""),
        "HOST": host,
        "PORT": str(parsed.port or 5432),
        "OPTIONS": opts,
    }


_db_url = (
    os.getenv("DJANGO_DATABASE_URL")
    or os.getenv("DATABASE_URL")
    or os.getenv("SUPABASE_DB_URL")
    or ""
).strip()

_use_sqlite = os.getenv("DJANGO_USE_SQLITE", "").lower() in ("1", "true", "yes")
# Local default: SQLite when no DATABASE_URL (production always sets DATABASE_URL)
if not _use_sqlite and not _db_url and os.getenv("DJANGO_FORCE_POSTGRES", "").lower() not in (
    "1",
    "true",
    "yes",
):
    # Fail loudly rather than silently starting on an empty local SQLite file:
    # a production deploy that loses DATABASE_URL should not come up looking
    # like a working install with no data in it.
    if not DEBUG:
        raise RuntimeError(
            "DATABASE_URL is not set and DJANGO_DEBUG=false. Set DATABASE_URL, "
            "or set DJANGO_USE_SQLITE=true if SQLite really is intended."
        )
    _use_sqlite = True

if _use_sqlite:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }
elif _db_url.startswith("postgres"):
    DATABASES = {"default": _database_from_url(_db_url)}
    DATABASES["default"]["CONN_MAX_AGE"] = int(os.getenv("CONN_MAX_AGE", "60"))
    DATABASES["default"]["CONN_HEALTH_CHECKS"] = True
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.getenv("DJANGO_DB_NAME", "faculty_django"),
            "USER": os.getenv("DJANGO_DB_USER", "faculty"),
            "PASSWORD": os.getenv("DJANGO_DB_PASSWORD", "faculty"),
            "HOST": os.getenv("DJANGO_DB_HOST", "127.0.0.1"),
            "PORT": os.getenv("DJANGO_DB_PORT", "5432"),
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Kolkata"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "/media/"
MEDIA_ROOT = Path(os.getenv("DJANGO_MEDIA_ROOT") or (BASE_DIR / "media"))

# Uploaded evidence outlives a deploy only if it is written somewhere that
# survives one. A container filesystem does not: on Cloud Run it is in-memory
# and discarded with the instance, so every claim's proof PDFs would vanish
# while the ticket still lists them. Setting GS_BUCKET_NAME stores them in
# Google Cloud Storage instead; files stay private and are served through the
# existing authenticated /media view, never by a public bucket URL.
GS_BUCKET_NAME = os.getenv("GS_BUCKET_NAME", "").strip()
if GS_BUCKET_NAME:
    _default_storage = {
        "BACKEND": "storages.backends.gcloud.GoogleCloudStorage",
        "OPTIONS": {
            "bucket_name": GS_BUCKET_NAME,
            "default_acl": None,  # bucket is uniform-access and private
            "querystring_auth": False,
            "max_memory_size": 10 * 1024 * 1024,
        },
    }
else:
    _default_storage = {"BACKEND": "django.core.files.storage.FileSystemStorage"}

STORAGES = {
    "default": _default_storage,
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_USER_MODEL = "core.User"

CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]
CORS_ALLOW_CREDENTIALS = True
# Allow Vercel and Netlify preview/prod hosts when set
_cors_regex = os.getenv("CORS_ORIGIN_REGEX", r"https://.*\.(vercel|netlify)\.app")
if _cors_regex:
    CORS_ALLOWED_ORIGIN_REGEXES = [_cors_regex]

CSRF_TRUSTED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CSRF_TRUSTED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]
# Preview hosts are unique per deploy. CORS already allows them via regex;
# CSRF does not, so login from a preview (or a -self / Netlify alias) 403s.
for _csrf_host in ("https://*.vercel.app", "https://*.netlify.app"):
    if _csrf_host not in CSRF_TRUSTED_ORIGINS:
        CSRF_TRUSTED_ORIGINS.append(_csrf_host)

_cross_site = os.getenv("CROSS_SITE_COOKIES", "false").lower() in ("1", "true", "yes")
if _cross_site:
    SESSION_COOKIE_SAMESITE = "None"
    CSRF_COOKIE_SAMESITE = "None"
else:
    SESSION_COOKIE_SAMESITE = "Lax"
    CSRF_COOKIE_SAMESITE = "Lax"
# Secure follows the environment, not the cookie's SameSite mode. Tying it to
# CROSS_SITE_COOKIES meant the same-origin production deployment handed out a
# finance session cookie with no Secure flag, so a first visit over plain http
# (before HSTS is known) would put it on the wire in clear.
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG

SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = False
CSRF_COOKIE_NAME = "csrftoken"

SCOPUS_API_KEY = os.getenv("SCOPUS_API_KEY", "")

# Production hardening
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = os.getenv("SECURE_SSL_REDIRECT", "true").lower() in ("1", "true", "yes")
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"
    X_FRAME_OPTIONS = "DENY"
    SESSION_COOKIE_AGE = int(os.getenv("SESSION_COOKIE_AGE", str(60 * 60 * 12)))  # 12h
    # Sliding expiry used to rewrite the session row on every GET, which on
    # Neon added a second round-trip to every click. 12h from last login is enough.
    SESSION_SAVE_EVERY_REQUEST = False
    # HSTS: modest default so a misconfigured deploy is recoverable; raise via
    # env once the domain has been stable on HTTPS for a while.
    SECURE_HSTS_SECONDS = int(os.getenv("SECURE_HSTS_SECONDS", str(60 * 60 * 24 * 30)))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = os.getenv(
        "SECURE_HSTS_INCLUDE_SUBDOMAINS", "false"
    ).lower() in ("1", "true", "yes")

# Optional email notifications (off by default — set EMAIL_NOTIFICATIONS=true)
EMAIL_NOTIFICATIONS = os.getenv("EMAIL_NOTIFICATIONS", "false").lower() in ("1", "true", "yes")
DEFAULT_FROM_EMAIL = os.getenv("DEFAULT_FROM_EMAIL", "noreply@faculty-paper.local")
EMAIL_BACKEND = os.getenv(
    "EMAIL_BACKEND",
    "django.core.mail.backends.console.EmailBackend"
    if DEBUG
    else "django.core.mail.backends.smtp.EmailBackend",
)
EMAIL_HOST = os.getenv("EMAIL_HOST", "")
EMAIL_PORT = int(os.getenv("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = os.getenv("EMAIL_USE_TLS", "true").lower() in ("1", "true", "yes")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        }
    },
    "loggers": {
        "core": {"handlers": ["console"], "level": os.getenv("LOG_LEVEL", "INFO")},
        "core.api": {"handlers": ["console"], "level": os.getenv("LOG_LEVEL", "INFO")},
    },
}
