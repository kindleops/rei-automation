-- Workflow Studio production materialization: operational modes, registry schemas, legacy cleanup.

ALTER TABLE public.workflow_node_registry
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

ALTER TABLE public.workflow_definitions
  ADD COLUMN IF NOT EXISTS operational_mode text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS legacy_workflow_id uuid REFERENCES public.workflows(id) ON DELETE SET NULL;

ALTER TABLE public.workflow_definitions DROP CONSTRAINT IF EXISTS wf_def_operational_mode_check;
ALTER TABLE public.workflow_definitions
  ADD CONSTRAINT wf_def_operational_mode_check CHECK (
    operational_mode IN ('draft', 'test', 'active_safe', 'armed', 'live', 'paused', 'archived')
  );

-- Backfill registry nodes from foundation migration (not in 160000 expansion)
INSERT INTO public.workflow_node_registry
  (node_type, node_kind, label, description, category, is_communication, requires_guard_before, is_terminal, is_enabled, is_system, input_schema, output_schema)
VALUES
  ('trigger.lead_entered_workflow', 'trigger', 'Lead Entered Workflow', 'Fires when a lead is enrolled.', 'triggers', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('trigger.inbound_sms_received', 'trigger', 'Inbound SMS Received', 'Fires on inbound SMS.', 'triggers', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('timing.wait_duration', 'timing', 'Wait Duration', 'Pauses for a duration.', 'timing', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('condition.seller_replied', 'condition', 'Seller Replied', 'Branches on seller reply.', 'conditions', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('condition.no_reply_after', 'condition', 'No Reply After', 'Branches on no reply.', 'conditions', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('condition.inbound_intent', 'condition', 'Check Seller Intent', 'Branches on intent.', 'conditions', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('guard.stop_suppression', 'guard', 'Stop If Suppressed', 'Halts on suppression.', 'guards', false, false, true, true, false, '{}'::jsonb, '{}'::jsonb),
  ('guard.quiet_hours', 'guard', 'Quiet Hours', 'Blocks outside quiet hours.', 'guards', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('guard.max_touches', 'guard', 'Max Touches', 'Halts on max touches.', 'guards', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('action.send_sms', 'action', 'Send SMS', 'Legacy send SMS (use enqueue_sms).', 'messaging', true, true, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('action.send_email', 'action', 'Send Email', 'Legacy send email.', 'messaging', true, true, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('action.update_stage', 'action', 'Update Stage', 'Updates pipeline stage.', 'crm', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('action.update_status', 'action', 'Update Status', 'Updates contact status.', 'crm', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb),
  ('action.notify_agent', 'action', 'Notify Agent', 'Notifies assigned agent.', 'notifications', false, false, false, true, false, '{}'::jsonb, '{}'::jsonb)
ON CONFLICT (node_type) DO UPDATE
  SET is_enabled = EXCLUDED.is_enabled,
      input_schema = CASE WHEN workflow_node_registry.input_schema = '{}'::jsonb THEN EXCLUDED.input_schema ELSE workflow_node_registry.input_schema END,
      output_schema = CASE WHEN workflow_node_registry.output_schema = '{}'::jsonb THEN EXCLUDED.output_schema ELSE workflow_node_registry.output_schema END;

-- Default schemas on empty registry rows
UPDATE public.workflow_node_registry
SET input_schema = COALESCE(NULLIF(input_schema, '{}'::jsonb), '{"general":{"label":{"type":"string"}}}'::jsonb),
    output_schema = COALESCE(NULLIF(output_schema, '{}'::jsonb), '{"status":{"type":"string"}}'::jsonb)
WHERE input_schema IS NULL OR input_schema = '{}'::jsonb;

-- Archive V1 smoke/duplicate drafts without run history (never delete runs)
UPDATE public.workflows w
SET status = 'archived', updated_at = now()
WHERE (
  w.workflow_key ~ '^workflow_studio_smoke_'
  OR w.workflow_key ~ '^owner_acquisition_follow_up_mq'
)
AND w.status <> 'archived'
AND NOT EXISTS (
  SELECT 1 FROM public.workflow_runs r WHERE r.workflow_id = w.id
);