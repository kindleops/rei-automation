-- PROPOSED ONLY — ROLLBACK: restores agent.ops_health_snapshot exactly as in
-- PROPOSED_20261012140000_intel_runtime.sql (no deliveries field). The handler then
-- reports followup_no_response_heartbeat_at as 'unverified' (never stale on age < 24 h).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_rollback.sql
create or replace function agent.ops_health_snapshot(p_overdue_minutes integer default 15, p_processing_stale_minutes integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, agent
as $$
declare v_keys jsonb; v_overdue integer; v_stuck integer;
begin
  select coalesce(jsonb_object_agg(key, left(value, 64)), '{}'::jsonb) into v_keys
    from public.system_control
   where key = any (array['queue_processor_heartbeat_at','campaign_feeder_heartbeat_at','followup_no_response_heartbeat_at',
                          'seller_state_reconcile_heartbeat_at','webhook_delivery_recovery_last_at',
                          'queue_processor_mode','queue_execution_mode','queue_emergency_stop_at']);
  select count(*)::int into v_overdue from (
    select 1 from public.send_queue
     where queue_status in ('queued','retry') and scheduled_for < now() - make_interval(mins => greatest(p_overdue_minutes, 1))
     limit 1000) s;
  select count(*)::int into v_stuck from (
    select 1 from public.send_queue
     where queue_status = 'processing' and scheduled_for < now() - make_interval(mins => greatest(p_processing_stale_minutes, 1))
     limit 1000) s;
  return jsonb_build_object('at', now(), 'keys', v_keys,
    'queue', jsonb_build_object('overdue_queued_or_retry', v_overdue, 'stale_processing', v_stuck, 'cap', 1000,
                                'overdue_minutes', p_overdue_minutes, 'processing_stale_minutes', p_processing_stale_minutes));
end
$$;
