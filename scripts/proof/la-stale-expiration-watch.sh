#!/bin/bash
set -euo pipefail
export PGPASSWORD='Realestate11697.'
CID="b821cb13-deeb-4ab4-9505-01dbcdaa136d"
API="https://api-steel-three-96.vercel.app"
QSECRET="56ff4188c49f80435d6b759cedb745463787263c55c78533de1e01bdfc83ec01"

echo "START $(date -u)"
for i in $(seq 1 20); do
  curl -s -X POST "$API/api/internal/queue/run" \
    -H "x-queue-engine-secret: $QSECRET" \
    -H "Content-Type: application/json" \
    -d "{\"campaign_id\":\"$CID\"}" >/dev/null || true
  METRICS=$(psql "postgresql://postgres@db.lcppdrmrdfblstpcbgpf.supabase.co:5432/postgres" -t -A -c "
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