-- Campaign launch execution contract
--
-- Additive columns required for campaign_target_graph-backed launches and
-- first-class send_queue audit rows.

ALTER TABLE public.campaign_targets
  ADD COLUMN IF NOT EXISTS prospect_id text;

ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS phone_id text;

CREATE INDEX IF NOT EXISTS idx_campaign_targets_prospect_id
  ON public.campaign_targets (prospect_id);

CREATE INDEX IF NOT EXISTS idx_send_queue_phone_id
  ON public.send_queue (phone_id)
  WHERE sent_at IS NULL;

NOTIFY pgrst, 'reload schema';
