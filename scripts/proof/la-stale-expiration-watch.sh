#!/bin/bash
set -euo pipefail

# Credentials must come from the environment — never hardcode them here.
# LC_RO_OPS_DIAG_DB_URL_FILE  0600 file with the role-enforced read-only diagnostics URL
#                          (rc-8.5.21-c; the metrics read goes through
#                          scripts/lib/prod-db-credentials.mjs, which verifies the role)
# QUEUE_ENGINE_SHARED_SECRET  shared secret for /api/internal/queue/run
: "${LC_RO_OPS_DIAG_DB_URL_FILE:?LC_RO_OPS_DIAG_DB_URL_FILE must be set}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${QUEUE_ENGINE_SHARED_SECRET:?QUEUE_ENGINE_SHARED_SECRET must be set}"

CID="${CAMPAIGN_ID:-b821cb13-deeb-4ab4-9505-01dbcdaa136d}"
API="${API_BASE_URL:-https://api-steel-three-96.vercel.app}"

echo "START $(date -u)"
for i in $(seq 1 20); do
  curl -s -X POST "$API/api/internal/queue/run" \
    -H "x-queue-engine-secret: $QUEUE_ENGINE_SHARED_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"campaign_id\":\"$CID\"}" >/dev/null || true
  METRICS=$(node "$ROOT/scripts/lib/prod-db-credentials.mjs" psql ops_diag -t -A -c "
    SELECT
      COUNT(*) FILTER (WHERE failed_reason='stale_runnable_row_expired'),
      COUNT(*) FILTER (WHERE queue_status='scheduled'),
      COUNT(*) FILTER (WHERE sent_at IS NOT NULL),
      COUNT(*) FILTER (WHERE failed_reason='stale_runnable_row_expired' AND updated_at > NOW() - interval '25 minutes')
    FROM send_queue WHERE campaign_id='$CID';")
  echo "[$(date -u +%H:%M:%S)] iter=$i metrics(stale_total,scheduled,sent,recent_stale)=$METRICS"
  sleep 60
done
echo "END $(date -u)"
