set -euo pipefail
export PGPASSFILE=~/.pgpass
P="psql -h db.lcppdrmrdfblstpcbgpf.supabase.co -U postgres -d postgres -P pager=off -tA"
T='V2_2B_LEGACY_THREAD'

echo "--- insert a 90-day-old UNENROLLED thread, already past due ---"
$P -c "insert into seller_followup_state (thread_key, property_id, objective, next_follow_up_at, cadence_profile, status)
 values ('$T','V2_2B_PROP','ownership', now() - interval '90 days','standard','active')
 on conflict (thread_key, objective) do update set next_follow_up_at=excluded.next_follow_up_at, enrolled_at=null;" >/dev/null

echo "--- scheduler due query (enrolled only) must NOT see it ---"
$P -c "select 'scheduler_sees='||count(*) from seller_followup_state
 where enrolled_at is not null and resolved_at is null and status in ('active','due') and next_follow_up_at <= now();"
$P -c "select 'row_exists_but_unenrolled='||count(*)||' enrolled_at_is_null='||(enrolled_at is null)::text
 from seller_followup_state where thread_key='$T' group by enrolled_at;"

echo "--- naive time-only query WOULD have seen it (why the boundary matters) ---"
$P -c "select 'naive_time_only_query_sees='||count(*) from seller_followup_state
 where next_follow_up_at <= now() and resolved_at is null;"

echo "--- explicit controlled enrollment ---"
$P -c "update seller_followup_state set enrolled_at=now(), activation_source='controlled_enrollment', policy_version='v2_2b_profile_cadence_v1'
 where thread_key='$T';" >/dev/null
$P -c "select 'after_enrollment_scheduler_sees='||count(*) from seller_followup_state
 where enrolled_at is not null and resolved_at is null and status in ('active','due') and next_follow_up_at <= now();"

echo "--- profile columns round-trip ---"
$P -c "update seller_followup_state set cadence_profile='urgent', cadence_profile_reason='verified_future_auction_date',
 cadence_profile_source='verified_property_event', cadence_profile_verified_at=now(), cadence_profile_expires_at=now()+interval '10 days'
 where thread_key='$T';" >/dev/null
$P -c "select 'profile='||cadence_profile||' reason='||cadence_profile_reason||' expires_in_days='||round(extract(epoch from (cadence_profile_expires_at-now()))/86400)::text from seller_followup_state where thread_key='$T';"

echo "--- CLEANUP ---"
$P -c "delete from seller_followup_state where thread_key='$T';" >/dev/null
$P -c "select 'table_total='||count(*) from seller_followup_state;"
