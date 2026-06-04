-- Campaign target graph refresh: concurrency guard + stale-run reaper.
--
-- Problem (observed 2026-06-02: 3 orphaned status='started' runs):
--   refresh_campaign_target_graph_stage_start() TRUNCATEs the shared
--   campaign_target_graph_stage table and inserts a fresh 'started' run with no
--   guard. The batch functions only mark a run 'failed' inside a SQL EXCEPTION
--   handler -- that handler does NOT fire when the owning ops-runner process dies
--   (network drop, SIGKILL, crash), so the run stays 'started' forever. A later
--   start() then truncates the stage out from under any still-live run.
--
-- Fix:
--   1. reap_stale_campaign_target_graph_refresh_runs(idle): mark 'started' runs
--      with no batch progress within `idle` as 'failed'. Staleness is measured by
--      LAST BATCH ACTIVITY, not run start, because a healthy full refresh runs
--      ~70 min while batches complete every few seconds -- so "no batch in N min"
--      reliably means the process is dead, independent of total run length.
--   2. refresh_campaign_target_graph_stage_start(): take a transaction advisory
--      lock (serialize starts), reap stale runs, then REFUSE to start -- and refuse
--      to TRUNCATE -- while a fresh run is still in flight. Only then truncate and
--      open a new run. Signature is unchanged so the existing ops runner keeps
--      working; a genuine fresh start after a clean finish proceeds as before.

CREATE OR REPLACE FUNCTION public.reap_stale_campaign_target_graph_refresh_runs(
  p_max_idle interval DEFAULT interval '10 minutes'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reaped integer := 0;
BEGIN
  WITH activity AS (
    SELECT
      r.id,
      GREATEST(
        r.started_at,
        COALESCE(
          (SELECT max(b.finished_at)
             FROM public.campaign_target_graph_refresh_batches b
            WHERE b.run_id = r.id),
          r.started_at
        )
      ) AS last_activity_at
    FROM public.campaign_target_graph_refresh_runs r
    WHERE r.status = 'started'
  ),
  stale AS (
    SELECT id FROM activity WHERE last_activity_at < now() - p_max_idle
  ),
  updated AS (
    UPDATE public.campaign_target_graph_refresh_runs r
    SET
      status = 'failed',
      finished_at = now(),
      error_message = COALESCE(r.error_message, 'reaped: no batch progress within idle window'),
      metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object(
        'failure_reason', 'reaped_stale_started_run',
        'reaped_at', to_jsonb(now()),
        'reap_max_idle', p_max_idle::text
      )
    FROM stale
    WHERE r.id = stale.id
    RETURNING r.id
  )
  SELECT count(*)::integer INTO v_reaped FROM updated;

  RETURN v_reaped;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_start()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_active_run_id uuid;
  v_active_started_at timestamptz;
BEGIN
  -- Serialize concurrent starts so two refreshes cannot both pass the guard and
  -- TRUNCATE the shared stage table. Held until the transaction commits/rolls back.
  PERFORM pg_advisory_xact_lock(hashtext('campaign_target_graph_refresh_start'));

  -- Clear runs whose owning process died (orphaned 'started' rows).
  PERFORM public.reap_stale_campaign_target_graph_refresh_runs();

  -- Refuse to start (and refuse to truncate) if a refresh is genuinely in flight.
  SELECT r.id, r.started_at
    INTO v_active_run_id, v_active_started_at
    FROM public.campaign_target_graph_refresh_runs r
   WHERE r.status = 'started'
   ORDER BY r.started_at DESC
   LIMIT 1;

  IF v_active_run_id IS NOT NULL THEN
    RAISE EXCEPTION
      'campaign target graph refresh already in progress (run % started %); wait for it to finish or reap it before starting a new run',
      v_active_run_id, v_active_started_at
      USING ERRCODE = 'lock_not_available';
  END IF;

  TRUNCATE TABLE public.campaign_target_graph_stage;

  INSERT INTO public.campaign_target_graph_refresh_runs (status, metadata)
  VALUES (
    'started',
    jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_start',
      'refresh_strategy', 'staged_property_offset_batches',
      'graph_path', 'properties_master_owners_prospects_phones',
      'graph_refresh_scope', 'partial',
      'fallback_enabled', false,
      'direct_core_only', true
    )
  )
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reap_stale_campaign_target_graph_refresh_runs(interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_stage_start() TO service_role;
