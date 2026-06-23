-- ────────────────────────────────────────────────────────────────────────────
-- workflow_node_registry: add is_system column + expand node catalog
--
-- is_system = true  → backend automation internals; excluded from Studio UI
-- is_system = false → user-facing; appears in Studio palette + node-types API
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.workflow_node_registry
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workflow_node_registry.is_system IS
  'true = internal automation node (hidden from Studio UI); false = user-facing palette node.';

-- Index for palette queries (UI only needs is_system=false rows)
CREATE INDEX IF NOT EXISTS idx_wf_node_registry_visible
  ON public.workflow_node_registry (is_system, is_enabled);

-- ────────────────────────────────────────────────────────────────────────────
-- Upsert full visible node catalog
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.workflow_node_registry
  (node_type, node_kind, label, description, category, is_communication, requires_guard_before, is_terminal, is_enabled, is_system)
VALUES

  -- Triggers
  ('trigger.lead_entered_workflow',  'trigger',   'Lead Entered Workflow',   'Fires when a lead is enrolled into this workflow.',                                          'triggers',     false, false, false, true,  false),
  ('trigger.inbound_sms_received',   'trigger',   'Inbound SMS Received',    'Fires when the lead sends an inbound SMS reply.',                                            'triggers',     false, false, false, true,  false),

  -- Timing
  ('timing.wait_duration',           'timing',    'Wait Duration',           'Pauses execution for a specified duration before continuing.',                               'timing',       false, false, false, true,  false),

  -- Messaging
  ('action.send_sms',                'action',    'Send SMS',                'Sends an SMS to the lead. Requires live_send_enabled on the workflow.',                      'messaging',    true,  true,  false, true,  false),
  ('action.send_email',              'action',    'Send Email',              'Sends a transactional email to the lead. Requires live_send_enabled on the workflow.',       'messaging',    true,  true,  false, true,  false),

  -- Conditions
  ('condition.seller_replied',       'condition', 'Seller Replied',          'Branches true if the lead has replied since the last outbound message.',                    'conditions',   false, false, false, true,  false),
  ('condition.no_reply_after',       'condition', 'No Reply After',          'Branches true if no reply has been received after a configured duration.',                  'conditions',   false, false, false, true,  false),
  ('condition.inbound_intent',       'condition', 'Check Seller Intent',     'Branches based on the classified intent of the latest inbound message.',                    'conditions',   false, false, false, true,  false),

  -- Guards
  ('guard.stop_suppression',         'guard',     'Stop If Suppressed',      'Halts the workflow if the contact has opted out or is on the DNC list.',                    'guards',       false, false, true,  true,  false),
  ('guard.quiet_hours',              'guard',     'Quiet Hours',             'Blocks outbound communication outside of the configured contact window.',                   'guards',       false, false, false, true,  false),
  ('guard.max_touches',              'guard',     'Max Touches',             'Halts the workflow if the lead has exceeded the maximum outreach attempt limit.',            'guards',       false, false, false, true,  false),

  -- CRM (platform-level)
  ('action.update_stage',            'action',    'Update Stage',            'Sets the lead pipeline stage to a configured value.',                                        'crm',          false, false, false, true,  false),
  ('action.update_status',           'action',    'Update Status',           'Sets the lead contact status to a configured value.',                                        'crm',          false, false, false, true,  false),

  -- Notifications
  ('action.notify_agent',            'action',    'Notify Agent',            'Creates an internal notification or task for the assigned agent.',                           'notifications', false, false, false, true,  false)

ON CONFLICT (node_type) DO UPDATE
  SET node_kind             = EXCLUDED.node_kind,
      label                 = EXCLUDED.label,
      description           = EXCLUDED.description,
      category              = EXCLUDED.category,
      is_communication      = EXCLUDED.is_communication,
      requires_guard_before = EXCLUDED.requires_guard_before,
      is_terminal           = EXCLUDED.is_terminal,
      is_enabled            = EXCLUDED.is_enabled,
      is_system             = EXCLUDED.is_system;
