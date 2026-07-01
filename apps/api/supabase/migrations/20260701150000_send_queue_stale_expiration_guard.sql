-- Severity-1 containment: block premature stale_runnable_row_expired on future-scheduled rows.
-- Defense in depth for scheduled/queued rows and any writer (API cron, cockpit, legacy deploy).

CREATE TABLE IF NOT EXISTS public.send_queue_lifecycle_guard_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_row_id uuid NOT NULL,
  event_type text NOT NULL,
  previous_queue_status text,
  attempted_queue_status text,
  scheduled_for timestamptz,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  caller_route text,
  deploy_sha text,
  audit_payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS send_queue_lifecycle_guard_events_row_idx
  ON public.send_queue_lifecycle_guard_events (queue_row_id, blocked_at DESC);

CREATE INDEX IF NOT EXISTS send_queue_lifecycle_guard_events_type_idx
  ON public.send_queue_lifecycle_guard_events (event_type, blocked_at DESC);

CREATE OR REPLACE FUNCTION public.guard_send_queue_stale_expiration()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_blocked boolean := false;
  v_reason text := null;
BEGIN
  IF NEW.queue_status = 'expired'
     AND NEW.failed_reason = 'stale_runnable_row_expired'
     AND (
       OLD.queue_status IN ('scheduled', 'queued')
       OR (OLD.scheduled_for IS NOT NULL AND OLD.scheduled_for > NOW())
       OR OLD.sent_at IS NOT NULL
       OR NULLIF(trim(OLD.provider_message_id), '') IS NOT NULL
       OR NULLIF(trim(OLD.textgrid_message_id), '') IS NOT NULL
       OR (OLD.is_locked IS TRUE AND OLD.queue_status = 'processing')
     ) THEN
    v_blocked := true;
    IF OLD.queue_status IN ('scheduled', 'queued') THEN
      v_reason := 'scheduled_or_queued_containment';
    ELSIF OLD.scheduled_for IS NOT NULL AND OLD.scheduled_for > NOW() THEN
      v_reason := 'future_scheduled_for';
    ELSIF OLD.sent_at IS NOT NULL
       OR NULLIF(trim(OLD.provider_message_id), '') IS NOT NULL
       OR NULLIF(trim(OLD.textgrid_message_id), '') IS NOT NULL THEN
      v_reason := 'send_evidence_present';
    ELSE
      v_reason := 'active_processing_lease';
    END IF;

    INSERT INTO public.send_queue_lifecycle_guard_events (
      queue_row_id,
      event_type,
      previous_queue_status,
      attempted_queue_status,
      scheduled_for,
      caller_route,
      deploy_sha,
      audit_payload
    ) VALUES (
      OLD.id,
      'FUTURE_ROW_EXPIRATION_BLOCKED',
      OLD.queue_status,
      NEW.queue_status,
      OLD.scheduled_for,
      COALESCE(NEW.metadata->>'lifecycle_caller_route', NULL),
      COALESCE(NEW.metadata->>'lifecycle_deploy_sha', NULL),
      jsonb_build_object(
        'block_reason', v_reason,
        'now', NOW(),
        'old_scheduled_for', OLD.scheduled_for,
        'old_scheduled_for_utc', OLD.scheduled_for_utc,
        'old_failed_reason', OLD.failed_reason
      )
    );

    NEW.queue_status := OLD.queue_status;
    NEW.failed_reason := OLD.failed_reason;
    NEW.is_locked := OLD.is_locked;
    NEW.lock_token := OLD.lock_token;
    NEW.locked_at := OLD.locked_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_send_queue_stale_expiration ON public.send_queue;
CREATE TRIGGER guard_send_queue_stale_expiration
  BEFORE UPDATE ON public.send_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_send_queue_stale_expiration();

CREATE OR REPLACE FUNCTION public.apply_send_queue_stale_expiration(
  p_row_id uuid,
  p_stale_cutoff timestamptz,
  p_caller_route text DEFAULT NULL,
  p_deploy_sha text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  UPDATE public.send_queue AS sq
  SET
    queue_status = 'expired',
    failed_reason = 'stale_runnable_row_expired',
    is_locked = false,
    lock_token = null,
    locked_at = null,
    metadata = COALESCE(sq.metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'lifecycle_caller_route', p_caller_route,
      'lifecycle_deploy_sha', p_deploy_sha,
      'stale_expired_at', NOW()
    ),
    updated_at = NOW()
  WHERE sq.id = p_row_id
    AND sq.queue_status NOT IN ('scheduled', 'queued')
    AND sq.sent_at IS NULL
    AND NULLIF(trim(sq.provider_message_id), '') IS NULL
    AND NULLIF(trim(sq.textgrid_message_id), '') IS NULL
    AND NOT (sq.is_locked IS TRUE AND sq.queue_status = 'processing')
    AND (
      sq.scheduled_for IS NULL
      OR (
        sq.scheduled_for <= NOW()
        AND sq.scheduled_for <= p_stale_cutoff
      )
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'applied', false,
      'blocked', true,
      'row_id', p_row_id
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', true,
    'blocked', false,
    'row_id', p_row_id
  );
END;
$$;