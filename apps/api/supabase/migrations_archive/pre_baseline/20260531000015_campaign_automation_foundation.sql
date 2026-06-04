-- Campaign Automation Foundation
-- Phase 1: campaign-backed target snapshots, send windows, queue plans, and audit logs.
-- This migration is additive. The existing public.campaign_targets table is preserved
-- for the Discord targeting console and extended with automation-target columns.

CREATE OR REPLACE FUNCTION public.campaign_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  status text DEFAULT 'draft',
  objective text,
  candidate_source text DEFAULT 'v_feeder_candidates_fast',
  market text,
  state text,
  language_policy text DEFAULT 'auto',
  agent_persona text,
  daily_cap int,
  total_cap int,
  batch_max int,
  market_cap int,
  per_sender_cap int,
  send_interval_seconds int,
  contact_window_start text,
  contact_window_end text,
  auto_queue_enabled boolean DEFAULT false,
  auto_send_enabled boolean DEFAULT false,
  auto_reply_mode text DEFAULT 'disabled',
  emergency_stop_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'ready', 'live_limited', 'paused', 'completed', 'archived')),
  CONSTRAINT campaigns_auto_reply_mode_check
    CHECK (auto_reply_mode IN ('disabled', 'dry_run'))
);

CREATE TABLE IF NOT EXISTS public.campaign_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  filter_type text,
  field text NOT NULL,
  operator text NOT NULL,
  value jsonb DEFAULT 'null'::jsonb,
  label text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaign_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key text UNIQUE,
  campaign_name text,
  market text,
  asset_type text,
  strategy text,
  language text DEFAULT 'auto',
  source_view_id bigint,
  source_view_name text,
  daily_cap int DEFAULT 50,
  status text DEFAULT 'draft',
  created_by_discord_user_id text,
  approved_by_discord_user_id text,
  last_scan_summary jsonb DEFAULT '{}'::jsonb,
  last_scan_at timestamptz,
  last_launched_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.campaign_targets
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS master_owner_id text,
  ADD COLUMN IF NOT EXISTS property_id text,
  ADD COLUMN IF NOT EXISTS phone_id text,
  ADD COLUMN IF NOT EXISTS to_phone_number text,
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS property_address text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS priority_score numeric,
  ADD COLUMN IF NOT EXISTS identity_status text,
  ADD COLUMN IF NOT EXISTS routing_status text,
  ADD COLUMN IF NOT EXISTS suppression_status text,
  ADD COLUMN IF NOT EXISTS template_status text,
  ADD COLUMN IF NOT EXISTS target_status text DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS block_reason text;

ALTER TABLE public.campaign_targets
  ALTER COLUMN campaign_key DROP NOT NULL,
  ALTER COLUMN market DROP NOT NULL,
  ALTER COLUMN asset_type DROP NOT NULL,
  ALTER COLUMN strategy DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.campaign_send_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  market text,
  state text,
  timezone text,
  window_start_utc timestamptz NOT NULL,
  window_end_utc timestamptz NOT NULL,
  status text DEFAULT 'planned',
  max_sends int,
  sends_attempted int DEFAULT 0,
  sends_successful int DEFAULT 0,
  sends_failed int DEFAULT 0,
  auto_pause_reason text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT campaign_send_windows_status_check
    CHECK (status IN ('planned', 'open', 'closed', 'paused', 'completed', 'cancelled')),
  CONSTRAINT campaign_send_windows_range_check
    CHECK (window_end_utc > window_start_utc)
);

CREATE TABLE IF NOT EXISTS public.campaign_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  run_type text NOT NULL,
  status text DEFAULT 'started',
  dry_run boolean DEFAULT true,
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  requested_by text,
  total_scanned int DEFAULT 0,
  targets_clean int DEFAULT 0,
  ready_to_queue int DEFAULT 0,
  queue_rows_planned int DEFAULT 0,
  queue_rows_created int DEFAULT 0,
  blocked_counts jsonb DEFAULT '{}'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT campaign_runs_status_check
    CHECK (status IN ('started', 'completed', 'blocked', 'failed'))
);

CREATE TABLE IF NOT EXISTS public.campaign_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.campaign_runs(id) ON DELETE SET NULL,
  target_id uuid REFERENCES public.campaign_targets(id) ON DELETE SET NULL,
  send_window_id uuid REFERENCES public.campaign_send_windows(id) ON DELETE SET NULL,
  queue_row_id uuid,
  event_type text NOT NULL,
  severity text DEFAULT 'info',
  title text,
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT campaign_events_severity_check
    CHECK (severity IN ('info', 'success', 'warning', 'error'))
);

ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_target_id uuid REFERENCES public.campaign_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_send_window_id uuid REFERENCES public.campaign_send_windows(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_status_created
  ON public.campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_market_state
  ON public.campaigns (market, state);

CREATE INDEX IF NOT EXISTS idx_campaign_filters_campaign_id
  ON public.campaign_filters (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_filters_field
  ON public.campaign_filters (field);

CREATE INDEX IF NOT EXISTS idx_campaign_targets_campaign_id
  ON public.campaign_targets (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_status
  ON public.campaign_targets (target_status);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_phone
  ON public.campaign_targets (to_phone_number);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_market_state
  ON public.campaign_targets (market, state);
CREATE INDEX IF NOT EXISTS idx_campaign_targets_campaign_status
  ON public.campaign_targets (campaign_id, target_status);

CREATE INDEX IF NOT EXISTS idx_campaign_send_windows_campaign_id
  ON public.campaign_send_windows (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_send_windows_status_start
  ON public.campaign_send_windows (status, window_start_utc);
CREATE INDEX IF NOT EXISTS idx_campaign_send_windows_campaign_status
  ON public.campaign_send_windows (campaign_id, status, window_start_utc);

CREATE INDEX IF NOT EXISTS idx_campaign_runs_campaign_id
  ON public.campaign_runs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_runs_type_status
  ON public.campaign_runs (run_type, status);

CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign_id
  ON public.campaign_events (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_events_run_id
  ON public.campaign_events (run_id);
CREATE INDEX IF NOT EXISTS idx_campaign_events_type
  ON public.campaign_events (event_type);

CREATE INDEX IF NOT EXISTS idx_send_queue_campaign_id
  ON public.send_queue (campaign_id);
CREATE INDEX IF NOT EXISTS idx_send_queue_campaign_target_id
  ON public.send_queue (campaign_target_id);
CREATE INDEX IF NOT EXISTS idx_send_queue_campaign_send_window_id
  ON public.send_queue (campaign_send_window_id);

DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON public.campaigns;
CREATE TRIGGER trg_campaigns_updated_at
BEFORE UPDATE ON public.campaigns
FOR EACH ROW EXECUTE FUNCTION public.campaign_touch_updated_at();

DROP TRIGGER IF EXISTS trg_campaign_filters_updated_at ON public.campaign_filters;
CREATE TRIGGER trg_campaign_filters_updated_at
BEFORE UPDATE ON public.campaign_filters
FOR EACH ROW EXECUTE FUNCTION public.campaign_touch_updated_at();

DROP TRIGGER IF EXISTS trg_campaign_targets_updated_at ON public.campaign_targets;
CREATE TRIGGER trg_campaign_targets_updated_at
BEFORE UPDATE ON public.campaign_targets
FOR EACH ROW EXECUTE FUNCTION public.campaign_touch_updated_at();

DROP TRIGGER IF EXISTS trg_campaign_send_windows_updated_at ON public.campaign_send_windows;
CREATE TRIGGER trg_campaign_send_windows_updated_at
BEFORE UPDATE ON public.campaign_send_windows
FOR EACH ROW EXECUTE FUNCTION public.campaign_touch_updated_at();

DROP TRIGGER IF EXISTS trg_campaign_runs_updated_at ON public.campaign_runs;
CREATE TRIGGER trg_campaign_runs_updated_at
BEFORE UPDATE ON public.campaign_runs
FOR EACH ROW EXECUTE FUNCTION public.campaign_touch_updated_at();

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_send_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaigns_service_role_all
  ON public.campaigns
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY campaign_filters_service_role_all
  ON public.campaign_filters
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY campaign_targets_service_role_all
  ON public.campaign_targets
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY campaign_send_windows_service_role_all
  ON public.campaign_send_windows
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY campaign_runs_service_role_all
  ON public.campaign_runs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY campaign_events_service_role_all
  ON public.campaign_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
