-- Phase 2A — Campaign lifecycle state machine.
--
-- Adds deterministic execution state to public.campaigns and a server-side
-- transition function that enforces legal edges under an advisory lock. This is
-- the single concurrency-safe entry point for changing a campaign's lifecycle
-- status, so activation cannot race, double-insert, or replay.
--
-- Live sending remains gated by the existing flags (auto_send_enabled,
-- confirm_live, AUTOMATION/WORKFLOW_LIVE_SENDS_ENABLED). This migration only
-- governs STATE, not whether real SMS are sent.

-- ---------------------------------------------------------------------------
-- 1. Execution columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,            -- operator target activation time
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,            -- when it entered "scheduled"
  ADD COLUMN IF NOT EXISTS activating_at timestamptz,           -- when activation began
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,            -- when it went live
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_transition_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_transition_from text,
  ADD COLUMN IF NOT EXISTS last_transition_reason text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS activation_attempt_count integer NOT NULL DEFAULT 0,
  -- execution metadata / progress counters (Phase 2C writes these; default 0)
  ADD COLUMN IF NOT EXISTS queued_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replied_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS positive_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opt_out_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_synced_at timestamptz,
  -- resumable hydration checkpoint (Phase 2B)
  ADD COLUMN IF NOT EXISTS hydration_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- activation-worker mutex (survives across transactions, unlike advisory locks)
  ADD COLUMN IF NOT EXISTS execution_lock_token uuid,
  ADD COLUMN IF NOT EXISTS execution_lock_owner text,
  ADD COLUMN IF NOT EXISTS execution_heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON public.campaigns (status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_for
  ON public.campaigns (scheduled_for)
  WHERE scheduled_for IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Legal transition table (data, not code) so the edge set is inspectable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaign_status_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO public.campaign_status_transitions (from_status, to_status) VALUES
  -- canonical happy path (per spec)
  ('draft',      'previewed'),
  ('previewed',  'scheduled'),
  ('scheduled',  'activating'),
  ('activating', 'active'),
  ('active',     'paused'),
  ('paused',     'active'),
  ('active',     'completed'),
  ('failed',     'paused'),
  ('completed',  'archived'),
  -- pragmatic, intent-preserving additions
  ('draft',      'scheduled'),   -- skip explicit preview
  ('draft',      'archived'),
  ('previewed',  'draft'),       -- back to editing
  ('previewed',  'archived'),
  ('scheduled',  'draft'),       -- unschedule
  ('scheduled',  'paused'),      -- hold a scheduled launch
  ('scheduled',  'archived'),
  ('activating', 'failed'),      -- activation error
  ('activating', 'paused'),      -- operator aborts mid-activation
  ('active',     'failed'),      -- runtime failure
  ('paused',     'scheduled'),
  ('paused',     'completed'),
  ('paused',     'archived'),
  ('failed',     'activating'),  -- retry activation
  ('failed',     'archived')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Transition function — the only concurrency-safe way to change status.
--    Takes a per-campaign advisory lock, validates the edge, stamps the
--    relevant timestamp, and records the transition. Same->same is an
--    idempotent no-op (replay/activation safety).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaign_transition_status(
  p_campaign_id uuid,
  p_to_status   text,
  p_reason      text DEFAULT NULL,
  p_scheduled_for timestamptz DEFAULT NULL
) RETURNS public.campaigns
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.campaigns;
  v_from_raw text;
  v_from text;
  v_to   text := lower(btrim(p_to_status));
  v_allowed boolean;
BEGIN
  IF v_to IS NULL OR v_to = '' THEN
    RAISE EXCEPTION 'campaign_transition: target status required'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize all lifecycle changes for this campaign.
  PERFORM pg_advisory_xact_lock(hashtext('campaign_lifecycle'), hashtext(p_campaign_id::text));

  SELECT * INTO v_row FROM public.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_transition: campaign % not found', p_campaign_id
      USING ERRCODE = 'P0002';
  END IF;

  v_from_raw := lower(btrim(coalesce(v_row.status, 'draft')));
  -- Canonicalize legacy readiness markers onto lifecycle states so saved
  -- campaigns transition correctly (backward compatibility).
  v_from := CASE v_from_raw
              WHEN 'ready'          THEN 'previewed'
              WHEN 'live_limited'   THEN 'active'
              WHEN 'started'        THEN 'activating'
              WHEN 'live_scheduled' THEN 'scheduled'
              ELSE v_from_raw END;

  -- Idempotent no-op: re-issuing the current state never errors (core of
  -- idempotent activation protection). If the stored value was a legacy alias,
  -- canonicalize it in place rather than leaving it stale.
  IF v_from = v_to THEN
    IF v_from_raw <> v_to THEN
      UPDATE public.campaigns
        SET status = v_to, updated_at = now()
        WHERE id = p_campaign_id
        RETURNING * INTO v_row;
    END IF;
    RETURN v_row;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.campaign_status_transitions
    WHERE from_status = v_from AND to_status = v_to
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal_campaign_transition: % -> %', v_from, v_to
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.campaigns SET
    status                 = v_to,
    last_transition_from   = v_from,
    last_transition_reason = p_reason,
    last_transition_at     = now(),
    updated_at             = now(),
    scheduled_for          = CASE WHEN v_to = 'scheduled'
                                  THEN coalesce(p_scheduled_for, scheduled_for, now())
                                  ELSE scheduled_for END,
    scheduled_at           = CASE WHEN v_to = 'scheduled'  THEN now() ELSE scheduled_at END,
    activating_at          = CASE WHEN v_to = 'activating' THEN now() ELSE activating_at END,
    activation_attempt_count = CASE WHEN v_to = 'activating'
                                    THEN activation_attempt_count + 1
                                    ELSE activation_attempt_count END,
    activated_at           = CASE WHEN v_to = 'active'
                                  THEN coalesce(activated_at, now())
                                  ELSE activated_at END,
    paused_at              = CASE WHEN v_to = 'paused'    THEN now() ELSE paused_at END,
    completed_at           = CASE WHEN v_to = 'completed' THEN now() ELSE completed_at END,
    failed_at              = CASE WHEN v_to = 'failed'    THEN now() ELSE failed_at END,
    failure_reason         = CASE WHEN v_to = 'failed'    THEN p_reason ELSE failure_reason END,
    archived_at            = CASE WHEN v_to = 'archived'  THEN now() ELSE archived_at END
  WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Execution-lock primitives — activation-worker mutex.
--    The advisory lock above only spans a transaction; queue hydration runs
--    across many transactions, so we need a persisted, TTL'd lease so two
--    workers cannot hydrate the same campaign concurrently.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaign_acquire_execution_lock(
  p_campaign_id uuid,
  p_token       uuid,
  p_owner       text DEFAULT NULL,
  p_ttl_seconds integer DEFAULT 120
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_token uuid;
  v_beat  timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('campaign_exec_lock'), hashtext(p_campaign_id::text));

  SELECT execution_lock_token, execution_heartbeat_at
    INTO v_token, v_beat
    FROM public.campaigns WHERE id = p_campaign_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Acquire if free, if we already own it (re-entrant), or if the lease is stale.
  IF v_token IS NULL
     OR v_token = p_token
     OR v_beat IS NULL
     OR v_beat < now() - make_interval(secs => p_ttl_seconds) THEN
    UPDATE public.campaigns
      SET execution_lock_token = p_token,
          execution_lock_owner = p_owner,
          execution_heartbeat_at = now()
      WHERE id = p_campaign_id;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.campaign_renew_execution_lock(
  p_campaign_id uuid,
  p_token       uuid
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.campaigns
    SET execution_heartbeat_at = now()
    WHERE id = p_campaign_id AND execution_lock_token = p_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.campaign_release_execution_lock(
  p_campaign_id uuid,
  p_token       uuid
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.campaigns
    SET execution_lock_token = NULL,
        execution_lock_owner = NULL,
        execution_heartbeat_at = NULL
    WHERE id = p_campaign_id AND execution_lock_token = p_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
