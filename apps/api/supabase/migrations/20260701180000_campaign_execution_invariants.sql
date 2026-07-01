-- System-wide campaign execution invariants: delivery webhook UUID handling + queue write guards.

-- Fix reconcile_delivery_receipt to accept UUID webhook_log ids.
DROP FUNCTION IF EXISTS public.reconcile_delivery_receipt(
  text, text, text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb, bigint, timestamptz
);

CREATE OR REPLACE FUNCTION public.reconcile_delivery_receipt(
  p_provider_message_sid text,
  p_provider_status text,
  p_raw_carrier_status text,
  p_incoming_delivery_status text,
  p_sent_at timestamptz DEFAULT NULL,
  p_delivered_at timestamptz DEFAULT NULL,
  p_failed_at timestamptz DEFAULT NULL,
  p_failure_reason text DEFAULT NULL,
  p_failure_bucket text DEFAULT NULL,
  p_failure_metadata jsonb DEFAULT NULL,
  p_webhook_log_id uuid DEFAULT NULL,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event record;
  v_queue record;
  v_thread record;
  v_current_delivery_rank integer;
  v_incoming_delivery_rank integer;
  v_final_delivery_rank integer;
  v_final_delivery_status text;
  v_final_provider_status text;
  v_final_raw_carrier_status text;
  v_merged_sent_at timestamptz;
  v_merged_delivered_at timestamptz;
  v_message_events_updated integer := 0;
  v_send_queue_updated integer := 0;
  v_inbox_threads_updated integer := 0;
  v_reconciled_event_id uuid;
  v_reconciled_thread_key text;
  v_terminal_queue_status text;
BEGIN
  IF p_provider_message_sid IS NULL OR trim(p_provider_message_sid) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_provider_message_sid');
  END IF;

  v_incoming_delivery_rank := public.delivery_status_rank(p_incoming_delivery_status);

  FOR v_event IN
    SELECT *
    FROM public.message_events
    WHERE provider_message_sid = p_provider_message_sid
  LOOP
    v_current_delivery_rank := public.delivery_status_rank(v_event.delivery_status);
    v_final_delivery_rank := GREATEST(v_current_delivery_rank, v_incoming_delivery_rank);
    v_final_delivery_status := CASE
      WHEN v_final_delivery_rank >= 100 THEN 'delivered'
      WHEN v_final_delivery_rank >= 90 THEN 'failed'
      ELSE COALESCE(v_event.delivery_status, 'sent')
    END;

    UPDATE public.message_events
    SET
      delivery_status = v_final_delivery_status,
      provider_delivery_status = COALESCE(p_provider_status, provider_delivery_status),
      raw_carrier_status = COALESCE(p_raw_carrier_status, raw_carrier_status),
      sent_at = COALESCE(sent_at, p_sent_at),
      delivered_at = CASE WHEN v_final_delivery_status = 'delivered' THEN COALESCE(delivered_at, p_delivered_at, p_now) ELSE delivered_at END,
      failed_at = CASE WHEN v_final_delivery_status = 'failed' THEN COALESCE(failed_at, p_failed_at, p_now) ELSE failed_at END,
      failure_reason = CASE WHEN v_final_delivery_status = 'failed' THEN COALESCE(p_failure_reason, failure_reason) ELSE failure_reason END,
      updated_at = p_now
    WHERE id = v_event.id;

    v_message_events_updated := v_message_events_updated + 1;
    v_reconciled_event_id := v_event.id;
    v_reconciled_thread_key := v_event.thread_key;
  END LOOP;

  FOR v_queue IN
    SELECT *
    FROM public.send_queue
    WHERE provider_message_id = p_provider_message_sid
       OR textgrid_message_id = p_provider_message_sid
  LOOP
    v_terminal_queue_status := CASE
      WHEN lower(p_incoming_delivery_status) = 'delivered' THEN 'delivered'
      WHEN lower(p_incoming_delivery_status) IN ('failed', 'undelivered', 'error', 'delivery_failed') THEN 'failed_transport'
      ELSE v_queue.queue_status
    END;

    UPDATE public.send_queue
    SET
      queue_status = CASE
        WHEN v_queue.queue_status IN ('sent', 'delivered', 'failed_transport', 'carrier_blocked', 'expired', 'cancelled') THEN v_terminal_queue_status
        ELSE v_queue.queue_status
      END,
      delivered_at = CASE WHEN lower(p_incoming_delivery_status) = 'delivered' THEN COALESCE(delivered_at, p_delivered_at, p_now) ELSE delivered_at END,
      delivery_confirmed = CASE WHEN lower(p_incoming_delivery_status) = 'delivered' THEN true ELSE delivery_confirmed END,
      updated_at = p_now
    WHERE id = v_queue.id
      AND v_queue.sent_at IS NOT NULL;

    v_send_queue_updated := v_send_queue_updated + 1;
  END LOOP;

  IF p_webhook_log_id IS NOT NULL THEN
    UPDATE public.webhook_log
    SET processed = true, processed_at = p_now, error_message = NULL
    WHERE id = p_webhook_log_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'provider_message_sid', p_provider_message_sid,
    'final_delivery_status', COALESCE(v_final_delivery_status, p_incoming_delivery_status),
    'message_events_updated', v_message_events_updated,
    'send_queue_updated', v_send_queue_updated,
    'inbox_threads_updated', v_inbox_threads_updated,
    'reconciled_event_id', v_reconciled_event_id,
    'reconciled_thread_key', v_reconciled_thread_key
  );
EXCEPTION
  WHEN OTHERS THEN
    IF p_webhook_log_id IS NOT NULL THEN
      UPDATE public.webhook_log
      SET error_message = left(SQLERRM, 2000)
      WHERE id = p_webhook_log_id;
    END IF;
    RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_delivery_receipt(
  text, text, text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb, uuid, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_send_queue_execution_mode()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.metadata->>'no_send')::boolean IS TRUE
       AND (NEW.metadata->>'confirm_live')::boolean IS TRUE
       AND COALESCE(NEW.metadata->>'launch_mode', '') <> 'proof_hydration_no_send' THEN
      INSERT INTO public.send_queue_lifecycle_guard_events (
        queue_row_id, event_type, previous_queue_status, attempted_queue_status,
        scheduled_for, audit_payload
      ) VALUES (
        COALESCE(NEW.id, gen_random_uuid()),
        'CONTRADICTORY_EXECUTION_MODE_BLOCKED',
        NULL,
        NEW.queue_status,
        NEW.scheduled_for,
        jsonb_build_object('reason', 'proof_and_live_flags')
      );
      RAISE EXCEPTION 'send_queue_contradictory_execution_mode';
    END IF;

    IF (NEW.metadata->>'execution_mode') IN ('immediate_live', 'scheduled_live')
       AND (
         (NEW.metadata->>'no_send')::boolean IS TRUE
         OR (NEW.metadata->>'proof_hydration')::boolean IS TRUE
       ) THEN
      INSERT INTO public.send_queue_lifecycle_guard_events (
        queue_row_id, event_type, previous_queue_status, attempted_queue_status,
        scheduled_for, audit_payload
      ) VALUES (
        COALESCE(NEW.id, gen_random_uuid()),
        'LIVE_EXECUTION_MODE_WITH_PROOF_FLAGS',
        NULL,
        NEW.queue_status,
        NEW.scheduled_for,
        jsonb_build_object('execution_mode', NEW.metadata->>'execution_mode')
      );
      RAISE EXCEPTION 'send_queue_live_mode_with_proof_flags';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.queue_status IN ('sent', 'delivered')
       AND (OLD.sent_at IS NOT NULL OR NULLIF(trim(OLD.provider_message_id), '') IS NOT NULL)
       AND NEW.queue_status IN ('queued', 'scheduled', 'pending', 'processing', 'sending') THEN
      INSERT INTO public.send_queue_lifecycle_guard_events (
        queue_row_id, event_type, previous_queue_status, attempted_queue_status,
        scheduled_for, audit_payload
      ) VALUES (
        OLD.id,
        'SENT_ROW_REVERT_BLOCKED',
        OLD.queue_status,
        NEW.queue_status,
        OLD.scheduled_for,
        jsonb_build_object('reason', 'sent_evidence_immutable')
      );
      NEW.queue_status := OLD.queue_status;
      NEW.sent_at := OLD.sent_at;
      NEW.provider_message_id := OLD.provider_message_id;
      NEW.textgrid_message_id := OLD.textgrid_message_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_send_queue_execution_mode ON public.send_queue;
CREATE TRIGGER guard_send_queue_execution_mode
  BEFORE INSERT OR UPDATE ON public.send_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_send_queue_execution_mode();