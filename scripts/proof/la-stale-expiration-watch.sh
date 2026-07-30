#!/bin/bash
set -euo pipefail

# Credentials must come from the environment — never hardcode them here.
# SUPABASE_DB_URL          full Postgres connection string (postgresql://user:pass@host:port/db)
# QUEUE_ENGINE_SHARED_SECRET  shared secret for /api/internal/queue/run
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL must be set}"
: "${QUEUE_ENGINE_SHARED_SECRET:?QUEUE_ENGINE_SHARED_SECRET must be set}"

CID="${CAMPAIGN_ID:-b821cb13-deeb-4ab4-9505-01dbcdaa136d}"
API="${API_BASE_URL:-https://api-steel-three-96.vercel.app}"

echo "START $(date -u)"
for i in $(seq 1 20); do
  curl -s -X POST "$API/api/internal/queue/run" \
    -H "x-queue-engine-secret: $QUEUE_ENGINE_SHARED_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"campaign_id\":\"$CID\"}" >/dev/null || true
  METRICS=$(psql "$SUPABASE_DB_URL" -t -A -c "
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
