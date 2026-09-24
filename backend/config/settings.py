import os
from pathlib import Path
from urllib.parse import urlparse, unquote

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BASE_DIR.parent

load_dotenv(ROOT_DIR / ".env")
load_dotenv(BASE_DIR / ".env")

# The release this build came from. scripts and the upgrade guide key on it;
# /api/health reports it so "which version is live" has an answer.
try:
    APP_VERSION = (ROOT_DIR / "VERSION").read_text(encoding="utf-8").strip() or "dev"
except OSError:
    APP_VERSION = "dev"

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
#
# Tuned for the free plan: 512 MB and a tenth of a CPU shared with gunicorn.
#   recycle / max_rss  the worker is replaced after 20 jobs, or after any job
#                      that left it above ~180 MB -- an ERP import or a
#                      restore reads a whole workbook into memory, and a
#                      worker that keeps that heap competes with gunicorn for
#                      the same 512 MB until the container is killed.
#   guard_cycle        the sentinel checks on its processes every 5 s rather
#                      than twice a second (the default): on a tenth of a CPU,
#                      idle wake-ups are time taken from requests.
#   poll               the ORM broker looks for queued jobs every 15 s.
Q_CLUSTER = {
    "name": "faculty_paper",
    "workers": 1,  # shares one small container with gunicorn
    "recycle": int(os.getenv("Q_RECYCLE", "20")),
    "max_rss": int(os.getenv("Q_MAX_RSS_KB", "180000")),
    "guard_cycle": int(os.getenv("Q_GUARD_CYCLE", "5")),
    "timeout": 3300,
    "retry": 3600,
    "max_attempts": 2,
    "orm": "default",
    "poll": 15,
    "catch_up": False,
    "sync": os.getenv("Q_SYNC", "false").lower() == "true",
}

MIDDLEWARE = [
    "core.log.RequestIdMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # Last, so it runs after the view: a write request makes the shared
    # college-wide figures stale (core/services/aggregate_cache.py).
    "core.services.aggregate_cache.BumpOnWriteMiddleware",
]

# How long a college-wide figure (the fault checks, the publication report) is
# shared between readers when nothing has been written. Writes in this process
# end it at once; this bounds only what the job worker changes. 0 turns it off.
AGGREGATE_CACHE_SECONDS = int(os.getenv("AGGREGATE_CACHE_SECONDS", "30"))

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
    socket_dir = None
    if parsed.query:
        from urllib.parse import parse_qs

        qs = parse_qs(parsed.query)
        sslmode = (qs.get("sslmode") or [None])[0]
        if sslmode:
            opts["sslmode"] = sslmode
        # libpq spells a unix socket as ?host=/dir, which is how Cloud SQL is
        # reached from Cloud Run. Reading the hostname alone left HOST empty and
        # the connection fell back to a default socket that does not exist.
        socket_dir = (qs.get("host") or [None])[0]
    host = socket_dir or parsed.hostname or ""
    # Supabase always needs SSL
    if "supabase" in host and "sslmode" not in opts:
        opts["sslmode"] = "require"
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": name,
        "USER": unquote(parsed.username or ""),
        "PASSWORD": unquote(parsed.password or ""),
        "HOST": host,
        # A socket has no port, and passing one makes libpq try TCP instead.
        "PORT": "" if socket_dir else str(parsed.port or 5432),
        "OPTIONS": opts,
    }


# Kill a single runaway SQL statement after this many milliseconds. Off by
# default: the monthly batch and the ERP import legitimately run long
# transactions, and they share these settings through the job worker. When
# set, set it on the API service's environment; the honest default for that
# deployment is 120000, and a query a report needs that runs longer than two
# minutes should be an index or a job, not a held connection.
_db_statement_timeout = int(os.getenv("DB_STATEMENT_TIMEOUT", "0"))

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
            # DJANGO_SQLITE_PATH lets a scratch instance run beside the
            # developer's real local database -- what the setup-wizard check
            # does, and what a product smoke test wants.
            "NAME": Path(os.getenv("DJANGO_SQLITE_PATH") or (BASE_DIR / "db.sqlite3")),
        }
    }
elif _db_url.startswith("postgres"):
    DATABASES = {"default": _database_from_url(_db_url)}
    DATABASES["default"]["CONN_MAX_AGE"] = int(os.getenv("CONN_MAX_AGE", "60"))
    DATABASES["default"]["CONN_HEALTH_CHECKS"] = True
    if _db_statement_timeout > 0:
        # Postgres's server-side statement_timeout, set per connection at
        # connect time. libpq takes it through the options parameter; the
        # value is milliseconds.
        DATABASES["default"]["OPTIONS"]["options"] = (
            f"-c statement_timeout={_db_statement_timeout}"
        )
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
elif os.getenv("S3_BUCKET_NAME", "").strip():
    # Any S3-compatible store -- Cloudflare R2 on the free deployment. Private
    # bucket, same authenticated /media view; credentials come from
    # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, never from this file.
    _default_storage = {
        "BACKEND": "storages.backends.s3.S3Storage",
        "OPTIONS": {
            "bucket_name": os.getenv("S3_BUCKET_NAME", "").strip(),
            "endpoint_url": os.getenv("S3_ENDPOINT_URL", "").strip() or None,
            "region_name": os.getenv("S3_REGION", "auto"),
            "default_acl": None,
            "querystring_auth": True,
            "file_overwrite": False,
            # Supabase Storage (and some R2 setups) need path-style URLs.
            "addressing_style": os.getenv("S3_ADDRESSING_STYLE", "").strip() or None,
        },
    }
elif os.getenv("DJANGO_MEDIA_STORAGE", "").strip().lower() == "db":
    # No disk and no object store (Render free): files live in Postgres,
    # beside the claims they belong to. See core/storage_db.py.
    _default_storage = {"BACKEND": "core.storage_db.DatabaseStorage"}
else:
    _default_storage = {"BACKEND": "django.core.files.storage.FileSystemStorage"}
MEDIA_IN_DATABASE = os.getenv("DJANGO_MEDIA_STORAGE", "").strip().lower() == "db"
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME", "").strip()

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
# Preview hosts, when somebody deliberately asks for them.
#
# This used to default to r"https://.*\.(vercel|netlify)\.app", which -- with
# CORS_ALLOW_CREDENTIALS on -- made every site anybody can deploy to Vercel or
# Netlify in five minutes a trusted origin holding this application's session.
# An attacker page could read /api/auth/csrf and then post to any mutating
# endpoint with the victim's cookie attached.
#
# SESSION_COOKIE_SAMESITE="Lax" blocked it in the default configuration, which
# is why it went unnoticed. But CROSS_SITE_COOKIES=true sets SameSite=None,
# and that flag is required by exactly the deployment this regex was added for
# -- a Vercel frontend against a Cloud Run backend. The safeguard was absent
# precisely where the regex was meant to be used.
#
# There is no default now. A preview host is opted into by name.
_cors_regex = os.getenv("CORS_ORIGIN_REGEX", "").strip()
if _cors_regex:
    CORS_ALLOWED_ORIGIN_REGEXES = [_cors_regex]

CSRF_TRUSTED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CSRF_TRUSTED_ORIGINS",
        # 5173 is the old frontend's dev port, 5174 the rebuilt one's. Both
        # are listed because both are run against this server during the
        # changeover, and an untrusted origin fails every mutating request
        # with a bare "CSRF check Failed" that reads like a permissions
        # problem rather than a missing line of configuration.
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:5174,http://127.0.0.1:5174",
    ).split(",")
    if o.strip()
]
# Preview hosts are unique per deploy, so CSRF needs the wildcard that CORS
# gets from its regex. Same reasoning as above: trusting every site on a public
# hosting platform is not a default anybody should get by accident, so this is
# opted into rather than assumed.
if os.getenv("TRUST_PREVIEW_HOSTS", "false").lower() in ("1", "true", "yes"):
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

SCOPUS_API_KEY = os.getenv("SCOPUS_API_KEY") or os.getenv("ELSEVIER_API_KEY") or ""
# Optional. The filing form's paper lookup reads one work by DOI from OpenAlex,
# which is free without a key; a key only raises the daily budget the title
# search falls back on when Crossref is down (core/services/paper_lookup.py).
OPENALEX_API_KEY = os.getenv("OPENALEX_API_KEY", "")

# Gemini, for the two discovery features. Absent is a supported state: the
# endpoints report that the feature is off rather than failing, which is the
# normal condition on a developer machine.
# Inference runs on this machine. The discovery features read a faculty
# member's unpublished title and abstract and their whole publication history,
# and the previous arrangement posted all of it to a hosted API in exchange for
# a key. Nothing here needs an account, a key or a quota, and nothing leaves
# the loopback interface.
#
# There are three providers -- "ollama" for a developer laptop, "harness" for
# the college's own inference service on Google Cloud, "openai" for a hosted
# model over the OpenAI-compatible API (see below) -- plus "none". An unknown
# value is refused rather than quietly resolved -- a typo in a deployment
# variable should stop the feature, not silently change where the text goes.
#
# Left empty, the provider is chosen from what is configured (core/services/
# ai.py `provider_name`): AI_API_KEY set means "openai"; otherwise
# AI_DEFAULT_PROVIDER. That default is "ollama" on a developer machine and
# "none" in production, so a live site with no key reports "not set up"
# rather than a daemon on 127.0.0.1 that was never going to be there. A
# production deployment that really does run Ollama beside the API says
# AI_PROVIDER=ollama explicitly.
AI_PROVIDER = (os.getenv("AI_PROVIDER") or "").strip().lower()
AI_DEFAULT_PROVIDER = "ollama" if DEBUG else "none"

# The hosted provider. Any service speaking OpenAI's chat-completions API:
# Groq (https://api.groq.com/openai/v1), Gemini's compatibility endpoint
# (https://generativelanguage.googleapis.com/v1beta/openai), OpenRouter, or an
# Ollama elsewhere (http://host:11434/v1). Unlike the two providers below,
# this sends a faculty member's draft title and abstract to that service --
# the price of AI on a free 512 MB instance, and said on screen. DEPLOY.md
# has the values to paste for the free tiers.
AI_API_KEY = (os.getenv("AI_API_KEY") or "").strip()
AI_BASE_URL = (os.getenv("AI_BASE_URL") or "").strip()
AI_MODEL = (os.getenv("AI_MODEL") or "").strip()
# Optional quicker model for the one interactive caller (the thread
# assistant). Unset, AI_MODEL serves both tiers.
AI_FAST_MODEL = (os.getenv("AI_FAST_MODEL") or "").strip()
AI_TIMEOUT_SECONDS = int(os.getenv("AI_TIMEOUT_SECONDS", "60"))
OLLAMA_BASE_URL = (os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").strip()
#
# Two models, not one, and the reason is measured rather than stylistic.
# Everything runs on the CPU here, so speed is a function of parameter count:
# the 12b tag generates at about 4.5 tokens a second, which is fine for a
# feature somebody starts and waits a minute for, and unusable for one that
# answers a question in a discussion thread while they watch.
#
# OLLAMA_MODEL is the considered one -- the venue search, the directions, the
# openings. OLLAMA_FAST_MODEL is the interactive one. A caller picks with
# `ai.ask_json(..., fast=True)`; nothing picks by itself, because which
# features can afford which wait is a product judgement, not a runtime one.
OLLAMA_MODEL = (os.getenv("OLLAMA_MODEL") or "gemma4:12b").strip()
OLLAMA_FAST_MODEL = (os.getenv("OLLAMA_FAST_MODEL") or "gemma3:4b").strip()

# How long Ollama holds each model in memory after it answers.
#
# Asymmetric on purpose, and the asymmetry is the whole point of having two.
# Measured on this machine: 8.90 GB for the 12b and 2.88 GB for the small one,
# 11.78 GB together, with 7.5 GB still free. They fit -- but the margin is not
# so large that both should be pinned, so they are not weighted equally. The
# fast model is held long because its entire value is being warm when somebody
# types and a reload costs 3.1s of a five-second answer. The considered one is
# let go sooner because its 6.4s reload lands on a request that already takes
# a minute and a half, which makes releasing 8.9 GB nearly free.
#
# Left as strings so Ollama parses them ("30m", "0" to unload immediately,
# "-1" to pin forever).
OLLAMA_KEEP_ALIVE = (os.getenv("OLLAMA_KEEP_ALIVE") or "2m").strip()
OLLAMA_FAST_KEEP_ALIVE = (os.getenv("OLLAMA_FAST_KEEP_ALIVE") or "30m").strip()

# The second provider: the college's own inference harness -- a purpose-built
# service for the Gemma models, deployed on Google Cloud next to the API and
# reached over a private address. It exists so the features that need a model
# do not depend on a developer's laptop, while the property that started this
# still holds: the college's unpublished work is sent to hardware the college
# controls, and to nothing else. There is deliberately no third-party
# provider in this list, and an unknown AI_PROVIDER still stops the feature
# rather than silently changing where the text goes.
#
# Google Cloud and Vercel are the only outside services this deployment
# uses; the harness is our own container on Cloud Run (GPU) or a GCE VM, and
# its weights are pulled from our own bucket at startup. See harness/README.md.
HARNESS_BASE_URL = (os.getenv("HARNESS_BASE_URL") or "http://127.0.0.1:8300").strip()
# Shared secret on deployments where the harness is not behind IAM -- sent as
# X-Harness-Token on every call. Unset means the harness is trusted by network
# position (Cloud Run ingress=internal), which is the intended arrangement.
HARNESS_TOKEN = (os.getenv("HARNESS_TOKEN") or "").strip()
HARNESS_MODEL = (os.getenv("HARNESS_MODEL") or "gemma-3-12b-it-q4_k_m").strip()
HARNESS_FAST_MODEL = (os.getenv("HARNESS_FAST_MODEL") or "gemma-3-4b-it-q4_k_m").strip()
HARNESS_TIMEOUT_SECONDS = int(os.getenv("HARNESS_TIMEOUT_SECONDS", "240"))
# The harness holds each slot in memory for this long after it answers, the
# same two-tier asymmetry as the Ollama settings above.
HARNESS_KEEP_ALIVE = (os.getenv("HARNESS_KEEP_ALIVE") or "10m").strip()
HARNESS_FAST_KEEP_ALIVE = (os.getenv("HARNESS_FAST_KEEP_ALIVE") or "30m").strip()

# ---------------------------------------------------------------------------
# Rate limits on the expensive endpoints, per account, in a fixed window.
#
# These guard two kinds of cost: the harness's GPU minutes (every AI answer
# is compute somebody pays for) and the report exports (a workbook over
# 3,236 publications is seconds of CPU and a chunk of memory per click).
# The counter lives in the process cache; gunicorn runs one worker, so one
# process is the whole deployment. If workers ever multiply, the caps become
# per-worker -- core/api/common.py says so next to the implementation.
AI_DAILY_LIMIT = int(os.getenv("AI_DAILY_LIMIT", "100"))
AGENT_DAILY_LIMIT = int(os.getenv("AGENT_DAILY_LIMIT", "50"))
SEARCH_DAILY_LIMIT = int(os.getenv("SEARCH_DAILY_LIMIT", "200"))
EXPORT_HOURLY_LIMIT = int(os.getenv("EXPORT_HOURLY_LIMIT", "40"))

# "json" makes every log line one JSON object -- severity, message, request
# id, traceback -- which is what Cloud Logging and Error Reporting parse
# best. Default follows the environment: json in production, text on a laptop.
LOG_FORMAT = (os.getenv("LOG_FORMAT") or ("text" if DEBUG else "json")).strip().lower()

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
    "filters": {
        "request_id": {"()": "core.log.RequestIdFilter"},
    },
    "formatters": {
        "verbose": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
        # One JSON object per line: Cloud Logging parses severity and the
        # trace field natively, Error Reporting groups the tracebacks, and
        # the request id ties every line of one request together.
        "json": {"()": "core.log.JsonFormatter"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": LOG_FORMAT if LOG_FORMAT in ("json",) else "verbose",
            "filters": ["request_id"],
        }
    },
    "loggers": {
        "core": {"handlers": ["console"], "level": os.getenv("LOG_LEVEL", "INFO")},
        "core.api": {"handlers": ["console"], "level": os.getenv("LOG_LEVEL", "INFO")},
        "core.log": {"handlers": ["console"], "level": os.getenv("LOG_LEVEL", "INFO")},
    },
}


# ---------------------------------------------------------------------------
# Sign in with Google
#
# Only the client id, which is not a secret -- the browser gets an ID token
# from Google and the server verifies it against Google's public keys with
# this as the audience. There is no client secret and no callback URL to
# register beyond the origin, because no OAuth code exchange happens here.
#
# Unset means the feature is off: /auth/google/config answers `enabled: false`
# and the sign-in page draws the password form on its own.
#: Clerk, when it is the front door. The *publishable* key only -- it is not
#: a secret, it is already in the browser, and the instance's JWKS address is
#: derivable from it, so verifying a Clerk sign-in needs nothing else. There
#: is deliberately no CLERK_SECRET_KEY setting: a secret that is never read
#: cannot be leaked by anything here.
CLERK_PUBLISHABLE_KEY = os.getenv("CLERK_PUBLISHABLE_KEY", "")

GOOGLE_OAUTH_CLIENT_ID = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "")

# Optional. Set to a Workspace domain to refuse anything else even where an
# account exists with, say, a gmail address.
GOOGLE_HOSTED_DOMAIN = os.getenv("GOOGLE_HOSTED_DOMAIN", "")
