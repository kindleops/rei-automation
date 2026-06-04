#!/usr/bin/env bash
#
# Migration replay gate — proves apps/api/supabase/migrations/ is replayable
# from zero. Run against a THROWAWAY database only (it drops & recreates public).
#
# Usage:
#   DB_URL='postgresql://…' ./replay-validate.sh
#
# Exit non-zero on ANY failed statement or object-count mismatch. This is the
# control that prevents the migration history from drifting out of "reproducible
# from zero" again (the root cause of the pre-baseline breakage).
set -euo pipefail

: "${DB_URL:?set DB_URL to a throwaway Postgres/Supabase-branch connection string}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$HERE/../migrations"

# Minimum objects the baseline must produce (sanity floor, not exact — exact
# counts are environment-sensitive once forward migrations accumulate).
MIN_TABLES="${MIN_TABLES:-117}"
REQUIRED_TABLES=(campaigns properties prospects phones master_owners send_queue message_events campaign_target_graph)
REQUIRED_FUNCS=(campaign_transition_status campaign_recompute_progress campaign_acquire_execution_lock)

psql_q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -tA "$@"; }

echo "==> wiping public (throwaway)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

echo "==> replaying migrations in lexical order"
fail=0
for f in $(ls "$MIG"/*.sql | sort); do
  echo "----- $(basename "$f")"
  if ! psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" 1>/dev/null; then
    echo "FAILED: $(basename "$f")" >&2
    fail=1
    break
  fi
done
[ "$fail" -eq 0 ] || { echo "REPLAY FAILED (a migration errored)"; exit 1; }

echo "==> asserting object counts"
TABLES=$(psql_q -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';")
echo "tables=$TABLES (min $MIN_TABLES)"
[ "$TABLES" -ge "$MIN_TABLES" ] || { echo "table count below floor"; exit 1; }

for t in "${REQUIRED_TABLES[@]}"; do
  ok=$(psql_q -c "select (to_regclass('public.$t') is not null);")
  [ "$ok" = "t" ] || { echo "MISSING TABLE: $t"; exit 1; }
done
for fn in "${REQUIRED_FUNCS[@]}"; do
  ok=$(psql_q -c "select (to_regproc('public.$fn') is not null);")
  [ "$ok" = "t" ] || { echo "MISSING FUNCTION: $fn"; exit 1; }
done

echo "==> checking duplicate version prefixes (must be unique)"
DUPS=$(ls "$MIG" | grep -E '\.sql$' | sed -E 's/_.*//' | sort | uniq -d || true)
[ -z "$DUPS" ] || { echo "DUPLICATE MIGRATION VERSIONS: $DUPS"; exit 1; }

echo "✅ replay-from-zero OK: $TABLES tables, all required objects present, unique versions."
