#!/usr/bin/env bash
# Deploy helpers for Faculty Publication Ticket ERP
# Usage:
#   ./scripts/deploy.sh frontend   # Vercel (interactive login if needed)
#   ./scripts/deploy.sh backend    # Print Render checklist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cmd="${1:-}"

case "$cmd" in
  frontend)
    cd "$ROOT/frontend"
    echo "Building frontend…"
    npm run build
    if ! vercel whoami >/dev/null 2>&1; then
      echo "Not logged into Vercel. Run: vercel login"
      echo "Then: cd frontend && vercel --prod"
      exit 1
    fi
    echo "Deploying to Vercel…"
    vercel --prod --yes
    echo ""
    echo "Set VITE_API_BASE to your Render API URL in Vercel project env, then redeploy."
    ;;
  backend)
    cat <<'EOF'
Render backend deploy
=====================
1. Push this repo to GitHub (git remote + push).
2. https://dashboard.render.com → New → Blueprint → select repo (uses render.yaml)
   OR New Web Service:
      - Root: backend
      - Build: pip install -r requirements.txt && python manage.py collectstatic --noinput
      - Start: gunicorn config.wsgi:application --bind 0.0.0.0:$PORT
3. Add Postgres (or attach DATABASE_URL).
4. Env vars:
      DJANGO_SECRET_KEY=<random>
      DJANGO_DEBUG=false
      CROSS_SITE_COOKIES=true
      CORS_ALLOWED_ORIGINS=https://YOUR.vercel.app
      CSRF_TRUSTED_ORIGINS=https://YOUR.vercel.app
      SCOPUS_API_KEY=<key>
      DJANGO_ALLOWED_HOSTS=.onrender.com
5. After live: Render Shell → python manage.py migrate && python manage.py seed
6. Put API URL into Vercel VITE_API_BASE and redeploy frontend.
EOF
    ;;
  *)
    echo "Usage: $0 frontend|backend"
    exit 1
    ;;
esac
