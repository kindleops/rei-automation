set -euo pipefail
export PGPASSFILE=~/.pgpass
P="psql -h db.lcppdrmrdfblstpcbgpf.supabase.co -U postgres -d postgres -P pager=off -tA"
T='V2_2_SYNTHETIC_THREAD'

echo "--- connection 1: schedule S2 follow-up (+3d) ---"
$P -c "insert into seller_followup_state (thread_key, property_id, objective, origin_stage, next_follow_up_at, cadence_key, attempt_count)
 values ('$T','V2_2_SYNTHETIC_PROP','offer_interest','offer_interest', now() + interval '3 days','stage_s2_3d',1)
 on conflict (thread_key, objective) do update set next_follow_up_at=excluded.next_follow_up_at;" >/dev/null
$P -c "select 'scheduled_at='||to_char(next_follow_up_at,'YYYY-MM-DD HH24:MI') from seller_followup_state where thread_key='$T';"

echo "--- connection 2 (fresh): reads the SAME due time ---"
$P -c "select 'c2_reads='||to_char(next_follow_up_at,'YYYY-MM-DD HH24:MI')||' objective='||objective||' status='||status from seller_followup_state where thread_key='$T';"

echo "--- idempotency: 10 concurrent scheduler runs ---"
for i in $(seq 1 10); do
  $P -c "insert into seller_followup_state (thread_key, property_id, objective, next_follow_up_at, cadence_key)
   values ('$T','V2_2_SYNTHETIC_PROP','offer_interest', now() + interval '3 days','stage_s2_3d')
   on conflict (thread_key, objective) do update set updated_at=now();" >/dev/null &
done
wait
$P -c "select 'rows_after_10_concurrent='||count(*) from seller_followup_state where thread_key='$T' and objective='offer_interest';"

echo "--- seller replies: objective resolved ---"
$P -c "update seller_followup_state set resolved_at=now(), status='resolved', next_follow_up_at=null, resolved_by_message_id='msg-synthetic'
 where thread_key='$T' and objective='offer_interest';" >/dev/null

echo "--- connection 3 (fresh): stale work is ineligible ---"
$P -c "select 'c3_eligible_due_rows='||count(*) from seller_followup_state
 where thread_key='$T' and resolved_at is null and status in ('active','due') and next_follow_up_at is not null;"
$P -c "select 'c3_sees_resolved='||status||' next_follow_up_at_is_null='||(next_follow_up_at is null)::text from seller_followup_state where thread_key='$T';"

echo "--- a NEW objective after advancement gets its own row ---"
$P -c "insert into seller_followup_state (thread_key, property_id, objective, origin_stage, next_follow_up_at, cadence_key)
 values ('$T','V2_2_SYNTHETIC_PROP','asking_price','asking_price', now() + interval '24 hours','stage_s3_24h')
 on conflict (thread_key, objective) do nothing;" >/dev/null
$P -c "select 'objectives='||string_agg(objective||':'||status,', ' order by objective) from seller_followup_state where thread_key='$T';"

echo "--- CLEANUP ---"
$P -c "delete from seller_followup_state where thread_key='$T';" >/dev/null
$P -c "select 'remaining='||count(*)||' table_total='||(select count(*) from seller_followup_state) from seller_followup_state where thread_key='$T';"
