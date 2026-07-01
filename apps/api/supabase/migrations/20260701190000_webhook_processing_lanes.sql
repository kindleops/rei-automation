-- Webhook processing lanes: indexes + processed-state semantics columns.

ALTER TABLE public.webhook_log
  ADD COLUMN IF NOT EXISTS processor_version text;

ALTER TABLE public.webhook_log
  ADD COLUMN IF NOT EXISTS deployed_sha text;

ALTER TABLE public.webhook_log
  ADD COLUMN IF NOT EXISTS reconciliation_execution_id uuid;

ALTER TABLE public.webhook_log
  ADD COLUMN IF NOT EXISTS processing_result jsonb;

ALTER TABLE public.webhook_log
  ADD COLUMN IF NOT EXISTS matched_record_id text;

ALTER TABLE public.webhook_log
  ADD COLUMN IF NOT EXISTS processing_error_code text;

CREATE INDEX IF NOT EXISTS idx_webhook_log_provider_message_sid
  ON public.webhook_log (provider_message_sid)
  WHERE provider_message_sid IS NOT NULL AND trim(provider_message_sid) <> '';

CREATE INDEX IF NOT EXISTS idx_webhook_log_unprocessed_inbound
  ON public.webhook_log (created_at ASC)
  WHERE processed = false AND lower(COALESCE(event_type, '')) = 'inbound';

CREATE INDEX IF NOT EXISTS idx_webhook_log_unprocessed_delivery_v2
  ON public.webhook_log (event_type, created_at ASC)
  WHERE processed = false
    AND lower(COALESCE(event_type, '')) IN ('delivery', 'status', 'outbound');

CREATE INDEX IF NOT EXISTS idx_webhook_log_unprocessed_by_sid
  ON public.webhook_log (provider_message_sid, created_at ASC)
  WHERE processed = false AND provider_message_sid IS NOT NULL;