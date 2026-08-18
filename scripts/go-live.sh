#!/usr/bin/env bash
#
# Everything that has to happen after `gcloud auth login`, in order, with a
# stop at each point where it could go wrong.
#
#   bash scripts/go-live.sh              # deploy the API and check it
#   bash scripts/go-live.sh --rebuild    # ...then rebuild the database from the workbook
#
# The rebuild is destructive: it clears production claims, payments and faculty
# accounts and reloads them from the workbook. It is opt-in for that reason, and
# it stops to make you confirm.
set -euo pipefail

GCLOUD="/c/Users/SEC/gcloud-sdk/google-cloud-sdk/bin/gcloud"
SERVICE="faculty-paper-api"
REGION="asia-south1"
FRONTEND="https://faculty-paper-rhudhreshs-projects.vercel.app"
WORKBOOK="../data/Publication_Processing_ERP_V3.0.xlsx"
REBUILD=0
[[ "${1:-}" == "--rebuild" ]] && REBUILD=1

say() { printf "\n\033[1m== %s\033[0m\n" "$*"; }
die() { printf "\n\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

say "1. Checking you are signed in"
"$GCLOUD" auth print-access-token >/dev/null 2>&1 \
  || die "Not signed in. Run:  gcloud auth login"
echo "   signed in as $("$GCLOUD" config get-value account 2>/dev/null)"

say "2. Running the test suites"
( cd backend && python manage.py test core 2>&1 | tail -3 )
( cd frontend && npx tsc --noEmit --incremental false ) || die "Type errors — not deploying."

say "3. Deploying the API to Cloud Run"
"$GCLOUD" run deploy "$SERVICE" --source backend --region "$REGION" --quiet

say "4. Checking the live API"
python - <<'PY'
import json, urllib.request
FE = "https://faculty-paper-rhudhreshs-projects.vercel.app"
h = json.load(urllib.request.urlopen(FE + "/api/health"))
print(f"   revision {h.get('git')}  db={h.get('db')}  worker={h['worker']['alive']}")
assert h.get("ok"), "health check failed"
PY

if [[ $REBUILD -eq 1 ]]; then
  say "5. Rebuilding production from the workbook"
  cat <<'WARN'
   This DELETES every claim, payment and faculty account in production and
   reloads them from the workbook. Take a Neon branch or snapshot first.

   Press Enter to continue, or Ctrl-C to stop.
WARN
  read -r _
  ( cd backend && python manage.py rebuild_from_erp "$WORKBOOK" \
      --confirm --credentials-out ../faculty-credentials.csv )
  say "6. Checking the numbers the app now reports"
  python audit/verify_rebuild.py
else
  say "5. Skipping the database rebuild (pass --rebuild to include it)"
fi

say "Done"
echo "   frontend  $FRONTEND"
echo "   api       $("$GCLOUD" run services describe "$SERVICE" --region "$REGION" --format='value(status.url)' 2>/dev/null)"
