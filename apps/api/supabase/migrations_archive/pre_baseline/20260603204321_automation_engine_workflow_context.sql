-- Additive Workflow Studio context columns for the deterministic automation engine.
-- These fields intentionally do not reference future workflow tables yet; they
-- provide stable orchestration context without inventing new state storage.

ALTER TABLE public.automation_rules
  ADD COLUMN IF NOT EXISTS workflow_id text,
  ADD COLUMN IF NOT EXISTS workflow_step_id text,
  ADD COLUMN IF NOT EXISTS rule_scope text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS node_type text,
  ADD COLUMN IF NOT EXISTS step_type text,
  ADD COLUMN IF NOT EXISTS ui_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.automation_events
  ADD COLUMN IF NOT EXISTS workflow_id text,
  ADD COLUMN IF NOT EXISTS workflow_run_id text,
  ADD COLUMN IF NOT EXISTS workflow_step_id text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS node_type text,
  ADD COLUMN IF NOT EXISTS campaign_id text,
  ADD COLUMN IF NOT EXISTS campaign_key text,
  ADD COLUMN IF NOT EXISTS template_id text,
  ADD COLUMN IF NOT EXISTS sender_id text,
  ADD COLUMN IF NOT EXISTS sender_phone_number_id text;

ALTER TABLE public.automation_runs
  ADD COLUMN IF NOT EXISTS workflow_id text,
  ADD COLUMN IF NOT EXISTS workflow_run_id text,
  ADD COLUMN IF NOT EXISTS workflow_step_id text,
  ADD COLUMN IF NOT EXISTS workflow_version_id text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS node_type text,
  ADD COLUMN IF NOT EXISTS step_type text,
  ADD COLUMN IF NOT EXISTS live_send_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.automation_actions
  ADD COLUMN IF NOT EXISTS workflow_id text,
  ADD COLUMN IF NOT EXISTS workflow_run_id text,
  ADD COLUMN IF NOT EXISTS workflow_step_id text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS node_type text,
  ADD COLUMN IF NOT EXISTS live_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS input jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS output jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_automation_rules_workflow_id
  ON public.automation_rules (workflow_id)
  WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_rules_workflow_step_id
  ON public.automation_rules (workflow_step_id)
  WHERE workflow_step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_rules_channel_node
  ON public.automation_rules (channel, node_type)
  WHERE channel IS NOT NULL OR node_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_events_workflow_id
  ON public.automation_events (workflow_id)
  WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_events_workflow_run_id
  ON public.automation_events (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_events_workflow_step_id
  ON public.automation_events (workflow_step_id)
  WHERE workflow_step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_events_channel_node
  ON public.automation_events (channel, node_type)
  WHERE channel IS NOT NULL OR node_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_events_campaign_template_sender
  ON public.automation_events (campaign_id, template_id, sender_id)
  WHERE campaign_id IS NOT NULL OR template_id IS NOT NULL OR sender_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_runs_workflow_id
  ON public.automation_runs (workflow_id)
  WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_runs_workflow_run_id
  ON public.automation_runs (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_runs_workflow_step_id
  ON public.automation_runs (workflow_step_id)
  WHERE workflow_step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_runs_channel_node
  ON public.automation_runs (channel, node_type)
  WHERE channel IS NOT NULL OR node_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_actions_workflow_id
  ON public.automation_actions (workflow_id)
  WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_actions_workflow_run_id
  ON public.automation_actions (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_actions_workflow_step_id
  ON public.automation_actions (workflow_step_id)
  WHERE workflow_step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_actions_channel_node
  ON public.automation_actions (channel, node_type)
  WHERE channel IS NOT NULL OR node_type IS NOT NULL;

COMMENT ON COLUMN public.automation_rules.workflow_id IS 'Nullable future Workflow Studio workflow identifier.';
COMMENT ON COLUMN public.automation_rules.workflow_step_id IS 'Nullable future Workflow Studio step identifier.';
COMMENT ON COLUMN public.automation_rules.ui_config IS 'Workflow Studio editor metadata for deterministic rule nodes.';
COMMENT ON COLUMN public.automation_events.workflow_run_id IS 'Future Workflow Studio run identifier, distinct from automation_runs.id.';
COMMENT ON COLUMN public.automation_events.channel IS 'Automation channel context such as sms, email, queue, market, or deal.';
COMMENT ON COLUMN public.automation_actions.live_enabled IS 'Per-action live capability flag. Send-capable actions must also pass global env guards.';
COMMENT ON COLUMN public.automation_runs.live_send_enabled IS 'Run-level live send guard snapshot. Defaults false.';
COMMENT ON COLUMN public.automation_runs.context IS 'Future workflow orchestration context snapshot.';
