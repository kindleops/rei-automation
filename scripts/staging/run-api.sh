#!/bin/sh
# Start the REI Automation API against the isolated staging branch — only.
#   scripts/staging/run-api.sh            (port 3201)
# • verifies staging identity first (scripts/staging/guard.mjs) — refuses otherwise;
# • starts from an EMPTY environment (env -i): no production secret, SMS,
#   CRM or campaign credential can be inherited; outbound email is forced off
#   and seller emails go to the capture sink (optionally a staging inbox copy);
# • generates the portal/ops/token secrets once into the gitignored env file.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVF="$ROOT/apps/api/.env.scheduling-staging.local"
git -C "$ROOT" check-ignore -q "$ENVF" || { echo "REFUSED: env file not gitignored" >&2; exit 2; }
node "$ROOT/scripts/staging/guard.mjs" "$ENVF" || exit 2

gen() { grep -q "^$1=" "$ENVF" || printf '%s=%s\n' "$1" "$2" >> "$ENVF"; }
gen STAGING_PORTAL_SECRET "$(openssl rand -hex 32)"
gen STAGING_CODE_PEPPER "$(openssl rand -hex 32)"
gen STAGING_OPS_SECRET "$(openssl rand -hex 32)"
gen STAGING_CRON_SECRET "$(openssl rand -hex 32)"
gen STAGING_TOKEN_KEY "$(openssl rand -base64 32)"
gen STAGING_SCHEDULING_CLIENT_SECRETS "{\"second_brand_test\":\"$(openssl rand -hex 32)\"}"
v() { grep "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }

mkdir -p /tmp/sched-cert/emails
cd "$ROOT/apps/api"
exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=development NEXT_TELEMETRY_DISABLED=1 \
  SUPABASE_URL="$(v STAGING_SUPABASE_URL)" SUPABASE_SERVICE_ROLE_KEY="$(v STAGING_SUPABASE_SERVICE_ROLE_KEY)" \
  SELLER_PORTAL_ENABLED=1 SELLER_PORTAL_INTERNAL_SECRET="$(v STAGING_PORTAL_SECRET)" SELLER_PORTAL_CODE_PEPPER="$(v STAGING_CODE_PEPPER)" \
  SELLER_PORTAL_PUBLIC_BASE_URL=http://localhost:3113 SELLER_PORTAL_SIGNIN_MIN_MS=0 \
  SELLER_PORTAL_EMAIL_ENABLED=1 SELLER_PORTAL_EMAIL_CAPTURE_DIR=/tmp/sched-cert/emails STAGING_EMAIL_RECIPIENT="$(v STAGING_EMAIL_RECIPIENT)" \
  BREVO_PROMINENT_API_KEY="$(v BREVO_PROMINENT_API_KEY)" EMAIL_SEND_ENABLED=false \
  OPS_DASHBOARD_SECRET="$(v STAGING_OPS_SECRET)" CRON_SECRET="$(v STAGING_CRON_SECRET)" INTERNAL_API_SECRET="$(v STAGING_OPS_SECRET)" \
  SCHEDULING_TOKEN_KEYS="{\"s1\":\"$(v STAGING_TOKEN_KEY)\"}" SCHEDULING_TOKEN_ACTIVE_KEY=s1 SCHEDULING_ALLOW_TEST_TYPES=1 SCHEDULING_CLIENT_SECRETS="$(v STAGING_SCHEDULING_CLIENT_SECRETS)" \
  SCHEDULING_OPS_APP_URL=http://localhost:5174 \
  GOOGLE_CALENDAR_CLIENT_ID="$(v GOOGLE_CALENDAR_CLIENT_ID)" GOOGLE_CALENDAR_CLIENT_SECRET="$(v GOOGLE_CALENDAR_CLIENT_SECRET)" \
  GOOGLE_CALENDAR_REDIRECT_URI="$(v GOOGLE_CALENDAR_REDIRECT_URI)" GOOGLE_CALENDAR_WEBHOOK_URL="$(v GOOGLE_CALENDAR_WEBHOOK_URL)" \
  PODIO_CLIENT_ID=staging-disabled PODIO_CLIENT_SECRET=staging-disabled PODIO_USERNAME=staging-disabled PODIO_PASSWORD=staging-disabled \
  BUYER_WEBHOOK_SECRET="$(v STAGING_OPS_SECRET)" APP_BASE_URL=http://localhost:3201 \
  npx next dev --port 3201
