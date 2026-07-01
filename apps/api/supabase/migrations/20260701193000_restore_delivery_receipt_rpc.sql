-- Restore full reconcile_delivery_receipt RPC (monotonic state machine) with UUID ids.

DROP FUNCTION IF EXISTS public.reconcile_delivery_receipt(
  text, text, text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb, uuid, timestamptz
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
  v_reconciled_event_id uuid := NULL;
  v_reconciled_thread_key text := NULL;
  v_queue_status_terminal text;
BEGIN
  IF coalesce(trim(p_provider_message_sid), '') = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'skipped', 'missing_provider_message_sid'
    );
  END IF;

  v_incoming_delivery_rank := public.delivery_status_rank(p_incoming_delivery_status);
  v_queue_status_terminal := CASE
    WHEN v_incoming_delivery_rank >= 90 THEN 'failed_transport'
    ELSE coalesce(nullif(trim(p_incoming_delivery_status), ''), 'failed_transport')
  END;

  FOR v_event IN
    SELECT
      id,
      thread_key,
      queue_id,
      metadata,
      delivery_status,
      provider_delivery_status,
      raw_carrier_status,
      sent_at,
      delivered_at,
      failed_at,
      error_message,
      failure_reason,
      failure_bucket
    FROM public.message_events
    WHERE provider_message_sid = p_provider_message_sid
    FOR UPDATE
  LOOP
    v_current_delivery_rank := greatest(
      public.delivery_status_rank(v_event.delivery_status),
      CASE WHEN v_event.delivered_at IS NOT NULL THEN 100 ELSE 0 END
    );
    v_final_delivery_rank := greatest(v_current_delivery_rank, v_incoming_delivery_rank);

    v_final_delivery_status := CASE
      WHEN v_final_delivery_rank >= 100 THEN 'delivered'
      WHEN v_final_delivery_rank >= 90 THEN 'failed'
      ELSE 'sent'
    END;

    v_final_provider_status := v_event.provider_delivery_status;
    IF coalesce(trim(p_provider_status), '') <> '' THEN
      IF greatest(
        public.delivery_status_rank(v_event.provider_delivery_status),
        CASE WHEN v_event.delivered_at IS NOT NULL OR lower(coalesce(v_event.delivery_status, '')) = 'delivered' THEN 100 ELSE 0 END
      ) < greatest(
        public.delivery_status_rank(p_provider_status),
        CASE WHEN v_final_delivery_status = 'delivered' THEN 100 ELSE 0 END
      ) THEN
        v_final_provider_status := p_provider_status;
      ELSIF v_final_provider_status IS NULL THEN
        v_final_provider_status := p_provider_status;
      END IF;
    END IF;

    v_final_raw_carrier_status := v_event.raw_carrier_status;
    IF coalesce(trim(p_raw_carrier_status), '') <> '' THEN
      IF greatest(
        public.delivery_status_rank(v_event.raw_carrier_status),
        CASE WHEN v_event.delivered_at IS NOT NULL THEN 100 ELSE 0 END
      ) <= greatest(
        public.delivery_status_rank(p_raw_carrier_status),
        CASE WHEN v_final_delivery_status = 'delivered' THEN 100 ELSE 0 END
      ) THEN
        v_final_raw_carrier_status := p_raw_carrier_status;
      ELSIF v_final_raw_carrier_status IS NULL THEN
        v_final_raw_carrier_status := p_raw_carrier_status;
      END IF;
    END IF;

    v_merged_sent_at := coalesce(v_event.sent_at, p_sent_at, p_now);
    v_merged_delivered_at := CASE
      WHEN v_final_delivery_status = 'delivered' THEN coalesce(v_event.delivered_at, p_delivered_at, p_now)
      ELSE v_event.delivered_at
    END;

    IF v_merged_delivered_at IS NOT NULL AND v_merged_sent_at IS NOT NULL AND v_merged_delivered_at < v_merged_sent_at THEN
      v_merged_delivered_at := v_merged_sent_at;
    END IF;

    UPDATE public.message_events
    SET
      provider_delivery_status = v_final_provider_status,
      raw_carrier_status = v_final_raw_carrier_status,
      delivery_status = v_final_delivery_status,
      sent_at = v_merged_sent_at,
      delivered_at = v_merged_delivered_at,
      failed_at = CASE
        WHEN v_final_delivery_status = 'failed' THEN coalesce(v_event.failed_at, p_failed_at, p_now)
        WHEN v_final_delivery_status IN ('delivered', 'sent') THEN NULL
        ELSE v_event.failed_at
      END,
      error_message = CASE
        WHEN v_final_delivery_status = 'failed' THEN coalesce(nullif(trim(p_failure_reason), ''), v_event.error_message)
        WHEN v_final_delivery_status IN ('delivered', 'sent') THEN NULL
        ELSE v_event.error_message
      END,
      failure_reason = CASE
        WHEN v_final_delivery_status = 'failed' THEN coalesce(nullif(trim(p_failure_reason), ''), v_event.failure_reason)
        WHEN v_final_delivery_status IN ('delivered', 'sent') THEN NULL
        ELSE v_event.failure_reason
      END,
      failure_bucket = CASE
        WHEN v_final_delivery_status = 'failed' THEN coalesce(nullif(trim(p_failure_bucket), ''), v_event.failure_bucket)
        WHEN v_final_delivery_status IN ('delivered', 'sent') THEN NULL
        ELSE v_event.failure_bucket
      END,
      metadata = CASE
        WHEN v_final_delivery_status = 'failed' AND p_failure_metadata IS NOT NULL THEN
          coalesce(v_event.metadata, '{}'::jsonb) || p_failure_metadata
        ELSE v_event.metadata
      END,
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
    FOR UPDATE
  LOOP
    v_current_delivery_rank := greatest(
      public.delivery_status_rank(v_queue.queue_status),
      CASE WHEN v_queue.delivered_at IS NOT NULL OR lower(coalesce(v_queue.delivery_confirmed, '')) IN ('confirmed', 'true', '✅ confirmed') THEN 100 ELSE 0 END
    );
    v_final_delivery_rank := greatest(v_current_delivery_rank, v_incoming_delivery_rank);

    v_final_delivery_status := CASE
      WHEN v_final_delivery_rank >= 100 THEN 'delivered'
      WHEN v_final_delivery_rank >= 90 THEN 'failed'
      ELSE 'sent'
    END;

    v_merged_sent_at := coalesce(v_queue.sent_at, p_sent_at, p_now);
    v_merged_delivered_at := CASE
      WHEN v_final_delivery_status = 'delivered' THEN coalesce(v_queue.delivered_at, p_delivered_at, p_now)
      ELSE v_queue.delivered_at
    END;

    IF v_merged_delivered_at IS NOT NULL AND v_merged_sent_at IS NOT NULL AND v_merged_delivered_at < v_merged_sent_at THEN
      v_merged_delivered_at := v_merged_sent_at;
    END IF;

    UPDATE public.send_queue
    SET
      queue_status = CASE
        WHEN v_final_delivery_status = 'delivered' THEN 'delivered'
        WHEN v_final_delivery_status = 'failed' THEN v_queue_status_terminal
        WHEN v_final_delivery_status = 'sent' THEN 'sent'
        ELSE v_queue.queue_status
      END,
      sent_at = v_merged_sent_at,
      delivered_at = v_merged_delivered_at,
      failed_reason = CASE
        WHEN v_final_delivery_status = 'delivered' THEN NULL
        WHEN v_final_delivery_status = 'failed' THEN coalesce(nullif(trim(p_failure_reason), ''), v_queue.failed_reason)
        ELSE v_queue.failed_reason
      END,
      delivery_confirmed = CASE
        WHEN v_final_delivery_status = 'delivered' THEN 'confirmed'
        WHEN v_final_delivery_status = 'failed' THEN 'failed'
        ELSE v_queue.delivery_confirmed
      END,
      textgrid_message_id = coalesce(v_queue.textgrid_message_id, p_provider_message_sid),
      updated_at = p_now,
      metadata = CASE
        WHEN v_final_delivery_status = 'failed' AND p_failure_metadata IS NOT NULL THEN
          coalesce(v_queue.metadata, '{}'::jsonb) || p_failure_metadata
        ELSE v_queue.metadata
      END
    WHERE id = v_queue.id;

    v_send_queue_updated := v_send_queue_updated + 1;
  END LOOP;

  IF v_reconciled_thread_key IS NOT NULL AND v_reconciled_event_id IS NOT NULL THEN
    SELECT *
    INTO v_thread
    FROM public.inbox_thread_state
    WHERE thread_key = v_reconciled_thread_key
    FOR UPDATE;

    IF FOUND
      AND lower(coalesce(v_thread.latest_direction, '')) = 'outbound'
      AND (
        v_thread.latest_message_event_id IS NULL
        OR v_thread.latest_message_event_id::text = v_reconciled_event_id::text
      )
    THEN
      SELECT delivery_status
      INTO v_final_delivery_status
      FROM public.message_events
      WHERE id = v_reconciled_event_id;

      UPDATE public.inbox_thread_state
      SET
        latest_delivery_status = v_final_delivery_status,
        updated_at = p_now
      WHERE thread_key = v_reconciled_thread_key;

      v_inbox_threads_updated := 1;
    END IF;
  END IF;

  IF p_webhook_log_id IS NOT NULL THEN
    UPDATE public.webhook_log
    SET
      processed = true,
      processed_at = p_now,
      error_message = NULL
    WHERE id = p_webhook_log_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'provider_message_sid', p_provider_message_sid,
    'final_delivery_status', v_final_delivery_status,
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