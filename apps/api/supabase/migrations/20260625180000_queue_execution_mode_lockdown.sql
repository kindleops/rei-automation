-- Production canary lockdown: execution mode, global lock, authorizations, audits.

INSERT INTO public.system_control (key, value)
VALUES ('queue_execution_mode', 'stopped')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.queue_global_execution_lock (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  owner_type text,
  lock_token uuid,
  lock_owner text,
  canary_run_id text,
  heartbeat_at timestamptz,
  acquired_at timestamptz,
  CONSTRAINT queue_global_execution_lock_owner_type_check
    CHECK (owner_type IS NULL OR owner_type IN ('unrestricted', 'scoped_canary'))
);

INSERT INTO public.queue_global_execution_lock (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.queue_canary_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canary_run_id text NOT NULL UNIQUE,
  campaign_id uuid NOT NULL,
  queue_row_ids jsonb NOT NULL,
  authorization_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS queue_canary_authorizations_campaign_idx
  ON public.queue_canary_authorizations (campaign_id);

CREATE INDEX IF NOT EXISTS queue_canary_authorizations_expires_idx
  ON public.queue_canary_authorizations (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.queue_canary_execution_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canary_run_id text NOT NULL,
  campaign_id uuid NOT NULL,
  processing_run_id uuid NOT NULL,
  validate_only boolean NOT NULL DEFAULT false,
  requested_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  claimed_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  dispatched_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded jsonb NOT NULL DEFAULT '[]'::jsonb,
  queue_execution_mode text,
  emergency_stop_active boolean,
  authorization_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  audit_payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS queue_canary_execution_audits_run_idx
  ON public.queue_canary_execution_audits (canary_run_id);

CREATE OR REPLACE FUNCTION public.queue_acquire_global_execution_lock(
  p_owner_type text,
  p_token uuid,
  p_owner text DEFAULT NULL,
  p_canary_run_id text DEFAULT NULL,
  p_ttl_seconds integer DEFAULT 300
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner_type text;
  v_token uuid;
  v_beat timestamptz;
BEGIN
  IF p_owner_type NOT IN ('unrestricted', 'scoped_canary') THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(91422501, 1);

  SELECT owner_type, lock_token, heartbeat_at
    INTO v_owner_type, v_token, v_beat
    FROM public.queue_global_execution_lock
    WHERE id = 1
    FOR UPDATE;

  IF v_owner_type IS NULL
     OR v_token IS NULL
     OR v_beat IS NULL
     OR v_token = p_token
     OR v_beat < now() - make_interval(secs => p_ttl_seconds) THEN
    UPDATE public.queue_global_execution_lock
      SET owner_type = p_owner_type,
          lock_token = p_token,
          lock_owner = p_owner,
          canary_run_id = p_canary_run_id,
          heartbeat_at = now(),
          acquired_at = now()
      WHERE id = 1;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_release_global_execution_lock(
  p_token uuid
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.queue_global_execution_lock
    SET owner_type = NULL,
        lock_token = NULL,
        lock_owner = NULL,
        canary_run_id = NULL,
        heartbeat_at = NULL,
        acquired_at = NULL
    WHERE id = 1 AND lock_token = p_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;