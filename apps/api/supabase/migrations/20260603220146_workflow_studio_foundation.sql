-- Workflow Studio foundation.
-- Stores visual workflow definitions and dry-run state only. Live sending stays
-- guarded by workflow/live-send flags in the automation engine.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.workflow_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

ALTER TABLE public.automation_audit_log
  ADD COLUMN IF NOT EXISTS workflow_id text,
  ADD COLUMN IF NOT EXISTS workflow_run_id text,
  ADD COLUMN IF NOT EXISTS workflow_step_id text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS node_type text;

CREATE INDEX IF NOT EXISTS idx_automation_audit_log_workflow_id
  ON public.automation_audit_log (workflow_id)
  WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_workflow_run_id
  ON public.automation_audit_log (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_channel_node
  ON public.automation_audit_log (channel, node_type)
  WHERE channel IS NOT NULL OR node_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  channel text NOT NULL DEFAULT 'sms',
  workflow_type text NOT NULL DEFAULT 'outbound',
  status text NOT NULL DEFAULT 'draft',
  live_send_enabled boolean NOT NULL DEFAULT false,
  market_scope text[] NOT NULL DEFAULT '{}'::text[],
  state_scope text[] NOT NULL DEFAULT '{}'::text[],
  property_type_scope text[] NOT NULL DEFAULT '{}'::text[],
  language_scope text[] NOT NULL DEFAULT '{}'::text[],
  owner_type_scope text[] NOT NULL DEFAULT '{}'::text[],
  asset_type_scope text[] NOT NULL DEFAULT '{}'::text[],
  daily_cap integer,
  hourly_cap integer,
  timezone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflows_channel_check CHECK (
    channel IN ('sms', 'email', 'rvm', 'direct_mail', 'multichannel')
  ),
  CONSTRAINT workflows_type_check CHECK (
    workflow_type IN (
      'outbound',
      'follow_up',
      'auto_reply',
      'nurture',
      'reactivation',
      'deal_execution'
    )
  ),
  CONSTRAINT workflows_status_check CHECK (
    status IN ('draft', 'active', 'paused', 'archived')
  ),
  CONSTRAINT workflows_live_send_draft_guard CHECK (
    live_send_enabled IS FALSE OR status = 'active'
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  step_order integer NOT NULL DEFAULT 0,
  node_type text NOT NULL,
  label text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  stop_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  delay_amount integer,
  delay_unit text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_steps_workflow_step_key_unique UNIQUE (workflow_id, step_key),
  CONSTRAINT workflow_steps_node_type_check CHECK (
    node_type ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  CONSTRAINT workflow_steps_delay_unit_check CHECK (
    delay_unit IS NULL OR delay_unit IN ('minutes', 'hours', 'days', 'business_days')
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_template_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  name text NOT NULL,
  channel text NOT NULL DEFAULT 'sms',
  language text NOT NULL DEFAULT 'en',
  use_case text,
  stage_code text,
  rotation_mode text NOT NULL DEFAULT 'weighted',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_template_sets_unique UNIQUE (workflow_id, name, channel, language),
  CONSTRAINT workflow_template_sets_rotation_mode_check CHECK (
    rotation_mode IN ('weighted', 'round_robin', 'manual')
  ),
  CONSTRAINT workflow_template_sets_channel_check CHECK (
    channel IN ('sms', 'email', 'rvm', 'direct_mail', 'multichannel')
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_template_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_set_id uuid NOT NULL REFERENCES public.workflow_template_sets(id) ON DELETE CASCADE,
  sms_template_id uuid,
  email_template_id uuid,
  variant_key text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  subject text,
  body text NOT NULL,
  weight numeric NOT NULL DEFAULT 1,
  spin_syntax_enabled boolean NOT NULL DEFAULT true,
  personalization_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_template_variants_key_unique UNIQUE (template_set_id, variant_key),
  CONSTRAINT workflow_template_variants_status_check CHECK (
    status IN ('draft', 'approved', 'paused', 'archived')
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_template_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_variant_id uuid NOT NULL REFERENCES public.workflow_template_variants(id) ON DELETE CASCADE,
  language text NOT NULL,
  translated_subject text,
  translated_body text NOT NULL,
  translation_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_template_translations_unique UNIQUE (source_variant_id, language),
  CONSTRAINT workflow_template_translations_status_check CHECK (
    translation_status IN ('pending', 'approved', 'rejected')
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_sender_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  pool_key text NOT NULL,
  name text NOT NULL,
  channel text NOT NULL DEFAULT 'sms',
  market_scope text[] NOT NULL DEFAULT '{}'::text[],
  state_scope text[] NOT NULL DEFAULT '{}'::text[],
  language_scope text[] NOT NULL DEFAULT '{}'::text[],
  routing_mode text NOT NULL DEFAULT 'exact_market',
  daily_cap integer,
  hourly_cap integer,
  health_thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_sender_pools_key_unique UNIQUE (workflow_id, pool_key),
  CONSTRAINT workflow_sender_pools_channel_check CHECK (
    channel IN ('sms', 'email', 'rvm', 'direct_mail', 'multichannel')
  ),
  CONSTRAINT workflow_sender_pools_routing_mode_check CHECK (
    routing_mode IN ('exact_market', 'same_state', 'cluster')
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_sender_pool_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_pool_id uuid NOT NULL REFERENCES public.workflow_sender_pools(id) ON DELETE CASCADE,
  textgrid_number_id text,
  email_sender_id text,
  sender_value text NOT NULL,
  sender_label text,
  weight numeric NOT NULL DEFAULT 1,
  daily_cap integer,
  hourly_cap integer,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_sender_pool_members_status_check CHECK (
    status IN ('active', 'paused', 'unhealthy', 'archived')
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  conversation_thread_id text,
  property_id text,
  prospect_id text,
  master_owner_id text,
  current_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running',
  dry_run boolean NOT NULL DEFAULT true,
  live_send_enabled boolean NOT NULL DEFAULT false,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  next_action_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_status_check CHECK (
    status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'dry_run')
  ),
  CONSTRAINT workflow_runs_dry_run_guard CHECK (
    dry_run IS TRUE OR live_send_enabled IS TRUE
  )
);

CREATE TABLE IF NOT EXISTS public.workflow_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  node_type text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'planned',
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workflow_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid REFERENCES public.workflows(id) ON DELETE SET NULL,
  workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'system',
  action text NOT NULL,
  before jsonb,
  after jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workflow_steps
  DROP CONSTRAINT IF EXISTS workflow_steps_node_type_check;

ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_node_type_check CHECK (
    node_type ~ '^[a-z][a-z0-9_]{1,80}$'
  );

CREATE INDEX IF NOT EXISTS idx_workflows_status
  ON public.workflows (status);
CREATE INDEX IF NOT EXISTS idx_workflows_channel_status
  ON public.workflows (channel, status);
CREATE INDEX IF NOT EXISTS idx_workflows_created_at
  ON public.workflows (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_market_scope_gin
  ON public.workflows USING gin (market_scope);
CREATE INDEX IF NOT EXISTS idx_workflows_state_scope_gin
  ON public.workflows USING gin (state_scope);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id
  ON public.workflow_steps (workflow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_node_type
  ON public.workflow_steps (node_type);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_active
  ON public.workflow_steps (workflow_id, is_active);

CREATE INDEX IF NOT EXISTS idx_workflow_template_sets_workflow_id
  ON public.workflow_template_sets (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_template_sets_channel_language
  ON public.workflow_template_sets (channel, language);
CREATE INDEX IF NOT EXISTS idx_workflow_template_variants_template_set_id
  ON public.workflow_template_variants (template_set_id);
CREATE INDEX IF NOT EXISTS idx_workflow_template_variants_status
  ON public.workflow_template_variants (status);
CREATE INDEX IF NOT EXISTS idx_workflow_template_variants_language
  ON public.workflow_template_variants (language);
CREATE INDEX IF NOT EXISTS idx_workflow_template_translations_source
  ON public.workflow_template_translations (source_variant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_template_translations_status
  ON public.workflow_template_translations (translation_status);

CREATE INDEX IF NOT EXISTS idx_workflow_sender_pools_workflow_id
  ON public.workflow_sender_pools (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_sender_pools_channel
  ON public.workflow_sender_pools (channel);
CREATE INDEX IF NOT EXISTS idx_workflow_sender_pools_market_scope_gin
  ON public.workflow_sender_pools USING gin (market_scope);
CREATE INDEX IF NOT EXISTS idx_workflow_sender_pools_state_scope_gin
  ON public.workflow_sender_pools USING gin (state_scope);
CREATE INDEX IF NOT EXISTS idx_workflow_sender_pool_members_pool_status
  ON public.workflow_sender_pool_members (sender_pool_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id
  ON public.workflow_runs (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON public.workflow_runs (status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_next_action_at
  ON public.workflow_runs (next_action_at)
  WHERE next_action_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation_thread_id
  ON public.workflow_runs (conversation_thread_id)
  WHERE conversation_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_property_id
  ON public.workflow_runs (property_id)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_prospect_id
  ON public.workflow_runs (prospect_id)
  WHERE prospect_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run_id
  ON public.workflow_run_events (workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_workflow_id
  ON public.workflow_run_events (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_step_id
  ON public.workflow_run_events (step_id)
  WHERE step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_event_type
  ON public.workflow_run_events (event_type);
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_node_type
  ON public.workflow_run_events (node_type)
  WHERE node_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_status
  ON public.workflow_run_events (status);
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_created_at
  ON public.workflow_run_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_dedupe_key
  ON public.workflow_run_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_audit_log_workflow_id
  ON public.workflow_audit_log (workflow_id)
  WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_audit_log_run_id
  ON public.workflow_audit_log (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_audit_log_action
  ON public.workflow_audit_log (action);
CREATE INDEX IF NOT EXISTS idx_workflow_audit_log_created_at
  ON public.workflow_audit_log (created_at DESC);

DROP TRIGGER IF EXISTS trg_workflows_updated_at ON public.workflows;
CREATE TRIGGER trg_workflows_updated_at
BEFORE UPDATE ON public.workflows
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_workflow_steps_updated_at ON public.workflow_steps;
CREATE TRIGGER trg_workflow_steps_updated_at
BEFORE UPDATE ON public.workflow_steps
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_workflow_template_sets_updated_at ON public.workflow_template_sets;
CREATE TRIGGER trg_workflow_template_sets_updated_at
BEFORE UPDATE ON public.workflow_template_sets
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_workflow_template_variants_updated_at ON public.workflow_template_variants;
CREATE TRIGGER trg_workflow_template_variants_updated_at
BEFORE UPDATE ON public.workflow_template_variants
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_workflow_template_translations_updated_at ON public.workflow_template_translations;
CREATE TRIGGER trg_workflow_template_translations_updated_at
BEFORE UPDATE ON public.workflow_template_translations
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_workflow_sender_pools_updated_at ON public.workflow_sender_pools;
CREATE TRIGGER trg_workflow_sender_pools_updated_at
BEFORE UPDATE ON public.workflow_sender_pools
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_workflow_sender_pool_members_updated_at ON public.workflow_sender_pool_members;
CREATE TRIGGER trg_workflow_sender_pool_members_updated_at
BEFORE UPDATE ON public.workflow_sender_pool_members
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

DROP TRIGGER IF EXISTS trg_workflow_runs_updated_at ON public.workflow_runs;
CREATE TRIGGER trg_workflow_runs_updated_at
BEFORE UPDATE ON public.workflow_runs
FOR EACH ROW EXECUTE FUNCTION public.workflow_touch_updated_at();

ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_template_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_template_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_template_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_sender_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_sender_pool_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflows_service_role_all ON public.workflows;
CREATE POLICY workflows_service_role_all
  ON public.workflows
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_steps_service_role_all ON public.workflow_steps;
CREATE POLICY workflow_steps_service_role_all
  ON public.workflow_steps
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_template_sets_service_role_all ON public.workflow_template_sets;
CREATE POLICY workflow_template_sets_service_role_all
  ON public.workflow_template_sets
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_template_variants_service_role_all ON public.workflow_template_variants;
CREATE POLICY workflow_template_variants_service_role_all
  ON public.workflow_template_variants
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_template_translations_service_role_all ON public.workflow_template_translations;
CREATE POLICY workflow_template_translations_service_role_all
  ON public.workflow_template_translations
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_sender_pools_service_role_all ON public.workflow_sender_pools;
CREATE POLICY workflow_sender_pools_service_role_all
  ON public.workflow_sender_pools
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_sender_pool_members_service_role_all ON public.workflow_sender_pool_members;
CREATE POLICY workflow_sender_pool_members_service_role_all
  ON public.workflow_sender_pool_members
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_runs_service_role_all ON public.workflow_runs;
CREATE POLICY workflow_runs_service_role_all
  ON public.workflow_runs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_run_events_service_role_all ON public.workflow_run_events;
CREATE POLICY workflow_run_events_service_role_all
  ON public.workflow_run_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS workflow_audit_log_service_role_all ON public.workflow_audit_log;
CREATE POLICY workflow_audit_log_service_role_all
  ON public.workflow_audit_log
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON TABLE
  public.workflows,
  public.workflow_steps,
  public.workflow_template_sets,
  public.workflow_template_variants,
  public.workflow_template_translations,
  public.workflow_sender_pools,
  public.workflow_sender_pool_members,
  public.workflow_runs,
  public.workflow_run_events,
  public.workflow_audit_log
TO service_role;

INSERT INTO public.workflows (
  workflow_key,
  name,
  description,
  channel,
  workflow_type,
  status,
  live_send_enabled,
  market_scope,
  state_scope,
  property_type_scope,
  language_scope,
  owner_type_scope,
  asset_type_scope,
  daily_cap,
  hourly_cap,
  timezone
)
VALUES
  (
    'sfr_owner_check_sms',
    'SFR Owner Check SMS Workflow',
    'Draft SMS owner verification workflow for single-family owner outreach.',
    'sms',
    'outbound',
    'draft',
    false,
    ARRAY['default'],
    ARRAY[]::text[],
    ARRAY['sfr'],
    ARRAY['en'],
    ARRAY['owner'],
    ARRAY['residential'],
    100,
    20,
    'America/Chicago'
  ),
  (
    'multifamily_underwriting',
    'Multifamily Underwriting Workflow',
    'Draft workflow for multifamily underwriting review and approval gates.',
    'multichannel',
    'deal_execution',
    'draft',
    false,
    ARRAY['default'],
    ARRAY[]::text[],
    ARRAY['multifamily'],
    ARRAY['en'],
    ARRAY['owner'],
    ARRAY['commercial'],
    25,
    5,
    'America/Chicago'
  ),
  (
    'high_equity_follow_up',
    'High Equity Follow-Up Workflow',
    'Draft follow-up workflow for high-equity owners who need a second touch.',
    'sms',
    'follow_up',
    'draft',
    false,
    ARRAY['default'],
    ARRAY[]::text[],
    ARRAY[]::text[],
    ARRAY['en'],
    ARRAY['owner'],
    ARRAY[]::text[],
    75,
    15,
    'America/Chicago'
  ),
  (
    'spanish_owner_check',
    'Spanish Owner Check Workflow',
    'Draft Spanish-language owner check workflow with manual translation inventory.',
    'sms',
    'outbound',
    'draft',
    false,
    ARRAY['default'],
    ARRAY[]::text[],
    ARRAY['sfr'],
    ARRAY['es'],
    ARRAY['owner'],
    ARRAY['residential'],
    75,
    15,
    'America/Chicago'
  )
ON CONFLICT (workflow_key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  channel = EXCLUDED.channel,
  workflow_type = EXCLUDED.workflow_type,
  status = 'draft',
  live_send_enabled = false,
  market_scope = EXCLUDED.market_scope,
  state_scope = EXCLUDED.state_scope,
  property_type_scope = EXCLUDED.property_type_scope,
  language_scope = EXCLUDED.language_scope,
  owner_type_scope = EXCLUDED.owner_type_scope,
  asset_type_scope = EXCLUDED.asset_type_scope,
  daily_cap = EXCLUDED.daily_cap,
  hourly_cap = EXCLUDED.hourly_cap,
  timezone = EXCLUDED.timezone,
  updated_at = now();

WITH wf AS (
  SELECT id, workflow_key FROM public.workflows
  WHERE workflow_key IN (
    'sfr_owner_check_sms',
    'multifamily_underwriting',
    'high_equity_follow_up',
    'spanish_owner_check'
  )
),
seed_steps AS (
  SELECT
    wf.id AS workflow_id,
    values_table.step_key,
    values_table.step_order,
    values_table.node_type,
    values_table.label,
    values_table.config,
    values_table.conditions,
    values_table.actions,
    values_table.stop_conditions,
    values_table.delay_amount,
    values_table.delay_unit
  FROM wf
  JOIN LATERAL (
    VALUES
      (
        'owner_check_message',
        10,
        CASE WHEN wf.workflow_key = 'multifamily_underwriting' THEN 'require_approval' ELSE 'send_sms' END,
        CASE WHEN wf.workflow_key = 'multifamily_underwriting' THEN 'Approval Gate' ELSE 'Owner Check Message' END,
        jsonb_build_object('template_set_key', wf.workflow_key || '_templates', 'live_send_enabled', false),
        '{}'::jsonb,
        jsonb_build_array(jsonb_build_object('action_type', CASE WHEN wf.workflow_key = 'multifamily_underwriting' THEN 'require_approval' ELSE 'send_sms' END, 'dry_run', true, 'live_enabled', false)),
        '{}'::jsonb,
        NULL::integer,
        NULL::text
      ),
      (
        'wait_for_reply',
        20,
        'wait',
        'Wait For Reply',
        '{}'::jsonb,
        '{}'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb,
        2,
        'days'
      ),
      (
        'stop_if_suppressed',
        30,
        'condition',
        'Stop If Suppressed',
        '{}'::jsonb,
        '{"suppression_status":"active"}'::jsonb,
        '[]'::jsonb,
        '{"opt_out":true}'::jsonb,
        NULL::integer,
        NULL::text
      )
  ) AS values_table(
    step_key,
    step_order,
    node_type,
    label,
    config,
    conditions,
    actions,
    stop_conditions,
    delay_amount,
    delay_unit
  ) ON true
)
INSERT INTO public.workflow_steps (
  workflow_id,
  step_key,
  step_order,
  node_type,
  label,
  config,
  conditions,
  actions,
  stop_conditions,
  delay_amount,
  delay_unit
)
SELECT
  workflow_id,
  step_key,
  step_order,
  node_type,
  label,
  config,
  conditions,
  actions,
  stop_conditions,
  delay_amount,
  delay_unit
FROM seed_steps
ON CONFLICT (workflow_id, step_key) DO UPDATE
SET
  step_order = EXCLUDED.step_order,
  node_type = EXCLUDED.node_type,
  label = EXCLUDED.label,
  config = EXCLUDED.config,
  conditions = EXCLUDED.conditions,
  actions = EXCLUDED.actions,
  stop_conditions = EXCLUDED.stop_conditions,
  delay_amount = EXCLUDED.delay_amount,
  delay_unit = EXCLUDED.delay_unit,
  is_active = true,
  updated_at = now();

WITH wf AS (
  SELECT id, workflow_key, name, channel, language_scope FROM public.workflows
  WHERE workflow_key IN (
    'sfr_owner_check_sms',
    'multifamily_underwriting',
    'high_equity_follow_up',
    'spanish_owner_check'
  )
)
INSERT INTO public.workflow_template_sets (
  workflow_id,
  name,
  channel,
  language,
  use_case,
  stage_code,
  rotation_mode,
  is_active
)
SELECT
  id,
  name || ' Templates',
  CASE WHEN channel = 'multichannel' THEN 'sms' ELSE channel END,
  COALESCE(language_scope[1], 'en'),
  workflow_key,
  'S1',
  'weighted',
  true
FROM wf
ON CONFLICT (workflow_id, name, channel, language) DO UPDATE
SET
  use_case = EXCLUDED.use_case,
  stage_code = EXCLUDED.stage_code,
  rotation_mode = EXCLUDED.rotation_mode,
  is_active = true,
  updated_at = now();

WITH template_sets AS (
  SELECT
    ts.id AS template_set_id,
    w.workflow_key,
    COALESCE(ts.language, 'en') AS language
  FROM public.workflow_template_sets ts
  JOIN public.workflows w ON w.id = ts.workflow_id
  WHERE w.workflow_key IN (
    'sfr_owner_check_sms',
    'multifamily_underwriting',
    'high_equity_follow_up',
    'spanish_owner_check'
  )
)
INSERT INTO public.workflow_template_variants (
  template_set_id,
  variant_key,
  language,
  subject,
  body,
  weight,
  spin_syntax_enabled,
  personalization_tokens,
  status
)
SELECT
  template_set_id,
  'draft_a',
  language,
  NULL,
  CASE
    WHEN workflow_key = 'spanish_owner_check'
      THEN 'Hola {first_name}, soy {agent_name}. Estaba revisando {property_address} en {market}. {Tiene sentido hablar|Podemos conversar} esta semana?'
    WHEN workflow_key = 'multifamily_underwriting'
      THEN 'Review needed for {property_address}: {unit_count} units in {market}. Require approval before any owner-facing action.'
    WHEN workflow_key = 'high_equity_follow_up'
      THEN 'Hi {first_name}, circling back on {property_address}. {Still open to a cash offer?|Would a quick valuation help?}'
    ELSE 'Hi {first_name}, this is {agent_name}. I was checking on {property_address} in {market}. {Are you the owner?|Do I have the right owner?}'
  END,
  1,
  true,
  '["first_name","agent_name","property_address","market","unit_count"]'::jsonb,
  'draft'
FROM template_sets
ON CONFLICT (template_set_id, variant_key) DO UPDATE
SET
  language = EXCLUDED.language,
  subject = EXCLUDED.subject,
  body = EXCLUDED.body,
  weight = EXCLUDED.weight,
  spin_syntax_enabled = EXCLUDED.spin_syntax_enabled,
  personalization_tokens = EXCLUDED.personalization_tokens,
  status = 'draft',
  updated_at = now();

WITH wf AS (
  SELECT id, workflow_key, channel FROM public.workflows
  WHERE workflow_key IN (
    'sfr_owner_check_sms',
    'multifamily_underwriting',
    'high_equity_follow_up',
    'spanish_owner_check'
  )
)
INSERT INTO public.workflow_sender_pools (
  workflow_id,
  pool_key,
  name,
  channel,
  market_scope,
  state_scope,
  language_scope,
  routing_mode,
  daily_cap,
  hourly_cap,
  health_thresholds,
  is_active
)
SELECT
  id,
  workflow_key || '_pool',
  CASE WHEN workflow_key = 'spanish_owner_check' THEN 'Spanish SMS Pool' ELSE 'Default Dry-Run Pool' END,
  CASE WHEN channel = 'multichannel' THEN 'sms' ELSE channel END,
  ARRAY['default'],
  ARRAY[]::text[],
  CASE WHEN workflow_key = 'spanish_owner_check' THEN ARRAY['es'] ELSE ARRAY['en'] END,
  'exact_market',
  50,
  10,
  '{"max_failure_rate":0.05,"max_opt_out_rate":0.012}'::jsonb,
  true
FROM wf
ON CONFLICT (workflow_id, pool_key) DO UPDATE
SET
  name = EXCLUDED.name,
  channel = EXCLUDED.channel,
  market_scope = EXCLUDED.market_scope,
  state_scope = EXCLUDED.state_scope,
  language_scope = EXCLUDED.language_scope,
  routing_mode = EXCLUDED.routing_mode,
  daily_cap = EXCLUDED.daily_cap,
  hourly_cap = EXCLUDED.hourly_cap,
  health_thresholds = EXCLUDED.health_thresholds,
  is_active = true,
  updated_at = now();

COMMENT ON TABLE public.workflows IS 'Workflow Studio draft/active workflow definitions. live_send_enabled defaults false.';
COMMENT ON TABLE public.workflow_steps IS 'Visual workflow node definitions. Execution is delegated to the automation engine later.';
COMMENT ON TABLE public.workflow_template_sets IS 'Template rotation groups attached to Workflow Studio workflows.';
COMMENT ON TABLE public.workflow_template_variants IS 'Draft message variants with token and spin-syntax metadata.';
COMMENT ON TABLE public.workflow_template_translations IS 'Manual translation inventory for workflow template variants.';
COMMENT ON TABLE public.workflow_sender_pools IS 'Workflow sender routing pools. Unsafe fallback is blocked in service code.';
COMMENT ON TABLE public.workflow_sender_pool_members IS 'Senders available for dry-run routing decisions.';
COMMENT ON TABLE public.workflow_runs IS 'Workflow dry-run/execution envelope. New rows default dry_run true and live_send_enabled false.';
COMMENT ON TABLE public.workflow_run_events IS 'Dry-run/workflow event detail rows for step previews and future execution.';
COMMENT ON TABLE public.workflow_audit_log IS 'Operator and system audit trail for Workflow Studio activity.';
