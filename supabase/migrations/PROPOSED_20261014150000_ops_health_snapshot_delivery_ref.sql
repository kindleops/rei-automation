-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
-- Requires PROPOSED_20261012140000_intel_runtime.sql (R2 runtime) applied first.
--
-- 8.5.15 — ops.health_check false alarm. followup_no_response_heartbeat_at is written
-- per provider-confirmed delivery receipt (delivery-triggered-followup.js), not by a
-- cron lane, so a fixed 30-minute age flagged it "stale" every night when nothing is
-- delivered. agent.ops_health_snapshot gains ONE read-only field:
--   deliveries.last_delivered_at = max(public.send_queue.delivered_at) over 7 days
-- (served by idx_send_queue_delivered_at, a partial btree on delivered_at desc).
-- The handler (handlers/ops-health-check.js) judges the heartbeat against it: stale
-- only when a delivery landed > 15 min after the heartbeat.
-- Same signature ⇒ CREATE OR REPLACE keeps the existing EXECUTE grants
-- (agent_api, service_role); SECURITY DEFINER + pinned search_path unchanged.
-- Writes nothing; no table, index or grant is created.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql
-- Rollback: PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
create or replace function agent.ops_health_snapshot(p_overdue_minutes integer default 15, p_processing_stale_minutes integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, agent
as $$
declare v_keys jsonb; v_overdue integer; v_stuck integer; v_delivered timestamptz;
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
  -- newest provider-confirmed delivery (idx_send_queue_delivered_at: btree (delivered_at desc)
  -- where delivered_at is not null ⇒ one index probe). Reference for the event-driven
  -- followup_no_response_heartbeat_at; null = no delivery in the last 7 days.
  select max(delivered_at) into v_delivered from public.send_queue
   where delivered_at is not null and delivered_at > now() - interval '7 days';
  return jsonb_build_object('at', now(), 'keys', v_keys,
    'deliveries', jsonb_build_object('last_delivered_at', v_delivered),
    'queue', jsonb_build_object('overdue_queued_or_retry', v_overdue, 'stale_processing', v_stuck, 'cap', 1000,
                                'overdue_minutes', p_overdue_minutes, 'processing_stale_minutes', p_processing_stale_minutes));
end
$$;
