-- Central deterministic automation engine foundation.
-- Additive, service-role owned tables for event ingestion, rule matching,
-- idempotent actions, suppression state, and immutable audit logging.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.automation_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.automation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  dedupe_key text,
  source text NOT NULL DEFAULT 'api',
  conversation_thread_id text,
  property_id text,
  prospect_id text,
  master_owner_id text,
  phone_number_id text,
  queue_item_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_started_at timestamptz,
  run_completed_at timestamptz,
  error_code text,
  error_message text,
  error_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL,
  event_type text NOT NULL,
  action_type text,
  status text NOT NULL DEFAULT 'active',
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  description text,
  dry_run_default boolean NOT NULL DEFAULT true,
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_rules_rule_key_unique UNIQUE (rule_key)
);

CREATE TABLE IF NOT EXISTS public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_event_id uuid REFERENCES public.automation_events(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.automation_rules(id) ON DELETE SET NULL,
  rule_key text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  dry_run boolean NOT NULL DEFAULT true,
  conversation_thread_id text,
  property_id text,
  prospect_id text,
  master_owner_id text,
  phone_number_id text,
  queue_item_id text,
  matched_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_started_at timestamptz NOT NULL DEFAULT now(),
  run_completed_at timestamptz,
  error_code text,
  error_message text,
  error_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_event_id uuid REFERENCES public.automation_events(id) ON DELETE CASCADE,
  automation_run_id uuid REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.automation_rules(id) ON DELETE SET NULL,
  rule_key text,
  event_type text,
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  dedupe_key text,
  dry_run boolean NOT NULL DEFAULT true,
  conversation_thread_id text,
  property_id text,
  prospect_id text,
  master_owner_id text,
  phone_number_id text,
  queue_item_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_started_at timestamptz,
  run_completed_at timestamptz,
  error_code text,
  error_message text,
  error_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text,
  action_type text NOT NULL DEFAULT 'suppress_phone',
  rule_key text,
  status text NOT NULL DEFAULT 'active',
  suppression_type text NOT NULL,
  suppression_reason text,
  dedupe_key text,
  conversation_thread_id text,
  property_id text,
  prospect_id text,
  master_owner_id text,
  phone_number_id text,
  phone_e164 text,
  queue_item_id text,
  source_event_id uuid REFERENCES public.automation_events(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  error_code text,
  error_message text,
  error_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_event_id uuid REFERENCES public.automation_events(id) ON DELETE SET NULL,
  automation_run_id uuid REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  automation_action_id uuid REFERENCES public.automation_actions(id) ON DELETE SET NULL,
  event_type text,
  action_type text,
  rule_key text,
  status text,
  log_type text NOT NULL DEFAULT 'info',
  message text,
  conversation_thread_id text,
  property_id text,
  prospect_id text,
  master_owner_id text,
  phone_number_id text,
  queue_item_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  error_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_events_dedupe_key
  ON public.automation_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_actions_dedupe_key
  ON public.automation_actions (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_suppressions_dedupe_key
  ON public.automation_suppressions (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_events_event_type
  ON public.automation_events (event_type);
CREATE INDEX IF NOT EXISTS idx_automation_events_status
  ON public.automation_events (status);
CREATE INDEX IF NOT EXISTS idx_automation_events_conversation_thread_id
  ON public.automation_events (conversation_thread_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_property_id
  ON public.automation_events (property_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_created_at
  ON public.automation_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_rules_event_type_status
  ON public.automation_rules (event_type, status, priority);
CREATE INDEX IF NOT EXISTS idx_automation_rules_action_type
  ON public.automation_rules (action_type);

CREATE INDEX IF NOT EXISTS idx_automation_runs_event_id
  ON public.automation_runs (automation_event_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_event_type
  ON public.automation_runs (event_type);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status
  ON public.automation_runs (status);
CREATE INDEX IF NOT EXISTS idx_automation_runs_conversation_thread_id
  ON public.automation_runs (conversation_thread_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_property_id
  ON public.automation_runs (property_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_created_at
  ON public.automation_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_actions_event_id
  ON public.automation_actions (automation_event_id);
CREATE INDEX IF NOT EXISTS idx_automation_actions_run_id
  ON public.automation_actions (automation_run_id);
CREATE INDEX IF NOT EXISTS idx_automation_actions_action_type
  ON public.automation_actions (action_type);
CREATE INDEX IF NOT EXISTS idx_automation_actions_status
  ON public.automation_actions (status);
CREATE INDEX IF NOT EXISTS idx_automation_actions_conversation_thread_id
  ON public.automation_actions (conversation_thread_id);
CREATE INDEX IF NOT EXISTS idx_automation_actions_property_id
  ON public.automation_actions (property_id);
CREATE INDEX IF NOT EXISTS idx_automation_actions_created_at
  ON public.automation_actions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_suppressions_phone_e164
  ON public.automation_suppressions (phone_e164)
  WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_suppressions_status
  ON public.automation_suppressions (status);
CREATE INDEX IF NOT EXISTS idx_automation_suppressions_conversation_thread_id
  ON public.automation_suppressions (conversation_thread_id);
CREATE INDEX IF NOT EXISTS idx_automation_suppressions_property_id
  ON public.automation_suppressions (property_id);
CREATE INDEX IF NOT EXISTS idx_automation_suppressions_created_at
  ON public.automation_suppressions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_audit_log_event_id
  ON public.automation_audit_log (automation_event_id);
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_run_id
  ON public.automation_audit_log (automation_run_id);
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_action_id
  ON public.automation_audit_log (automation_action_id);
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_event_type
  ON public.automation_audit_log (event_type);
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_status
  ON public.automation_audit_log (status);
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_conversation_thread_id
  ON public.automation_audit_log (conversation_thread_id);
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_property_id
  ON public.automation_audit_log (property_id);
CREATE INDEX IF NOT EXISTS idx_automation_audit_log_created_at
  ON public.automation_audit_log (created_at DESC);

DROP TRIGGER IF EXISTS trg_automation_events_updated_at ON public.automation_events;
CREATE TRIGGER trg_automation_events_updated_at
BEFORE UPDATE ON public.automation_events
FOR EACH ROW EXECUTE FUNCTION public.automation_touch_updated_at();

DROP TRIGGER IF EXISTS trg_automation_rules_updated_at ON public.automation_rules;
CREATE TRIGGER trg_automation_rules_updated_at
BEFORE UPDATE ON public.automation_rules
FOR EACH ROW EXECUTE FUNCTION public.automation_touch_updated_at();

DROP TRIGGER IF EXISTS trg_automation_runs_updated_at ON public.automation_runs;
CREATE TRIGGER trg_automation_runs_updated_at
BEFORE UPDATE ON public.automation_runs
FOR EACH ROW EXECUTE FUNCTION public.automation_touch_updated_at();

DROP TRIGGER IF EXISTS trg_automation_actions_updated_at ON public.automation_actions;
CREATE TRIGGER trg_automation_actions_updated_at
BEFORE UPDATE ON public.automation_actions
FOR EACH ROW EXECUTE FUNCTION public.automation_touch_updated_at();

DROP TRIGGER IF EXISTS trg_automation_suppressions_updated_at ON public.automation_suppressions;
CREATE TRIGGER trg_automation_suppressions_updated_at
BEFORE UPDATE ON public.automation_suppressions
FOR EACH ROW EXECUTE FUNCTION public.automation_touch_updated_at();

DROP TRIGGER IF EXISTS trg_automation_audit_log_updated_at ON public.automation_audit_log;
CREATE TRIGGER trg_automation_audit_log_updated_at
BEFORE UPDATE ON public.automation_audit_log
FOR EACH ROW EXECUTE FUNCTION public.automation_touch_updated_at();

ALTER TABLE public.automation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS automation_events_service_role_all ON public.automation_events;
CREATE POLICY automation_events_service_role_all
  ON public.automation_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS automation_rules_service_role_all ON public.automation_rules;
CREATE POLICY automation_rules_service_role_all
  ON public.automation_rules
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS automation_runs_service_role_all ON public.automation_runs;
CREATE POLICY automation_runs_service_role_all
  ON public.automation_runs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS automation_actions_service_role_all ON public.automation_actions;
CREATE POLICY automation_actions_service_role_all
  ON public.automation_actions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS automation_suppressions_service_role_all ON public.automation_suppressions;
CREATE POLICY automation_suppressions_service_role_all
  ON public.automation_suppressions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS automation_audit_log_service_role_all ON public.automation_audit_log;
CREATE POLICY automation_audit_log_service_role_all
  ON public.automation_audit_log
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON TABLE
  public.automation_events,
  public.automation_rules,
  public.automation_runs,
  public.automation_actions,
  public.automation_suppressions,
  public.automation_audit_log
TO service_role;

INSERT INTO public.automation_rules (
  rule_key,
  event_type,
  action_type,
  priority,
  description,
  dry_run_default,
  condition,
  actions
)
VALUES
  (
    'suppression.stop_dnc',
    'inbound_message_received',
    'suppress_phone',
    10,
    'STOP, unsubscribe, DNC, and do-not-contact inbound language suppresses the phone and cancels pending queue work.',
    false,
    '{"matcher":"stop_or_dnc"}'::jsonb,
    '[
      {"action_type":"suppress_phone","params":{"suppression_type":"opt_out","suppression_reason":"stop_or_dnc_keyword"}},
      {"action_type":"cancel_pending_queue","params":{"reason":"stop_or_dnc_keyword"}},
      {"action_type":"create_alert","params":{"severity":"warning","notification_type":"automation_suppression","title":"Automation suppression applied"}}
    ]'::jsonb
  ),
  (
    'suppression.wrong_number',
    'inbound_message_received',
    'suppress_phone',
    11,
    'Wrong-number inbound language suppresses the phone, marks contact confidence low, and cancels pending queue work.',
    false,
    '{"matcher":"wrong_number"}'::jsonb,
    '[
      {"action_type":"suppress_phone","params":{"suppression_type":"wrong_number","suppression_reason":"wrong_number_keyword"}},
      {"action_type":"mark_bad_contact","params":{"reason":"wrong_number","contact_confidence":"low"}},
      {"action_type":"cancel_pending_queue","params":{"reason":"wrong_number_keyword"}}
    ]'::jsonb
  ),
  (
    'suppression.not_owner_bad_contact',
    'inbound_message_received',
    'mark_bad_contact',
    12,
    'Not-owner, tenant, and does-not-own signals mark the contact as bad or review-needed and stop future queued touches.',
    false,
    '{"matcher":"not_owner_or_tenant"}'::jsonb,
    '[
      {"action_type":"mark_bad_contact","params":{"reason":"not_owner_or_tenant","contact_confidence":"low"}},
      {"action_type":"cancel_pending_queue","params":{"reason":"not_owner_or_tenant"}},
      {"action_type":"patch_thread_state","params":{"stage":"wrong_number","priority":"low","metadata":{"automation_stage":"bad_contact"}}}
    ]'::jsonb
  ),
  (
    'stage.inbound_new_reply',
    'inbound_message_received',
    'patch_thread_state',
    20,
    'Any inbound reply marks the thread as needing attention.',
    false,
    '{"matcher":"any_inbound_reply"}'::jsonb,
    '[
      {"action_type":"patch_thread_state","params":{"status":"open","stage":"new_reply","priority":"high","metadata":{"automation_status":"new_reply"}}}
    ]'::jsonb
  ),
  (
    'stage.asking_price_hot',
    'inbound_message_received',
    'patch_thread_state',
    21,
    'Asking-price language escalates the thread to hot priority without sending a response.',
    false,
    '{"matcher":"asking_price"}'::jsonb,
    '[
      {"action_type":"patch_thread_state","params":{"status":"open","stage":"needs_offer","priority":"urgent","is_urgent":true,"metadata":{"automation_stage":"asking_price_received","lead_temperature":"hot"}}}
    ]'::jsonb
  ),
  (
    'stage.not_interested_cold',
    'inbound_message_received',
    'patch_thread_state',
    22,
    'Not-interested language cools the thread and cancels pending queue work.',
    false,
    '{"matcher":"not_interested"}'::jsonb,
    '[
      {"action_type":"patch_thread_state","params":{"status":"open","stage":"not_interested","priority":"low","metadata":{"lead_temperature":"cold"}}},
      {"action_type":"cancel_pending_queue","params":{"reason":"not_interested"}}
    ]'::jsonb
  ),
  (
    'stage.ownership_verified',
    'inbound_message_received',
    'patch_thread_state',
    23,
    'Ownership-confirmed replies mark the thread verified.',
    false,
    '{"matcher":"ownership_confirmed"}'::jsonb,
    '[
      {"action_type":"patch_thread_state","params":{"status":"open","stage":"interested","priority":"high","metadata":{"automation_stage":"ownership_verified"}}}
    ]'::jsonb
  ),
  (
    'queue.outbound_failed_alert',
    'outbound_message_failed',
    'create_alert',
    30,
    'Failed outbound delivery creates an operations alert only.',
    false,
    '{"matcher":"outbound_failed"}'::jsonb,
    '[
      {"action_type":"create_alert","params":{"severity":"warning","notification_type":"outbound_failure","title":"Outbound message failed"}}
    ]'::jsonb
  ),
  (
    'queue.item_failed_alert',
    'queue_item_failed',
    'create_alert',
    31,
    'Failed queue items create an operations alert only.',
    false,
    '{"matcher":"queue_item_failed"}'::jsonb,
    '[
      {"action_type":"create_alert","params":{"severity":"warning","notification_type":"queue_item_failed","title":"Queue item failed"}}
    ]'::jsonb
  ),
  (
    'queue.hot_lead_untouched_alert',
    'hot_lead_untouched',
    'create_alert',
    32,
    'Hot leads that cross the untouched threshold create a notification.',
    false,
    '{"matcher":"hot_lead_untouched"}'::jsonb,
    '[
      {"action_type":"create_alert","params":{"severity":"warning","notification_type":"hot_lead_untouched","title":"Hot lead waiting"}}
    ]'::jsonb
  ),
  (
    'followup.delivered_no_reply_once',
    'outbound_message_delivered',
    'schedule_follow_up',
    40,
    'Delivered/no-reply follow-up planning is idempotent and dry-run by default.',
    true,
    '{"matcher":"delivered_no_reply"}'::jsonb,
    '[
      {"action_type":"schedule_follow_up","dry_run":true,"params":{"intent":"unclear","reason":"delivered_no_reply"}}
    ]'::jsonb
  ),
  (
    'template.high_opt_out_review',
    'template_performance_changed',
    'mark_template_recommendation',
    50,
    'High opt-out templates are marked for review; no template is deleted.',
    false,
    '{"matcher":"high_opt_out_template"}'::jsonb,
    '[
      {"action_type":"mark_template_recommendation","params":{"recommendation":"REVIEW","reason":"high_opt_out_rate"}}
    ]'::jsonb
  ),
  (
    'template.scale_candidate',
    'template_performance_changed',
    'mark_template_recommendation',
    51,
    'High-reply and low-opt-out templates are marked as scale candidates.',
    false,
    '{"matcher":"scale_template"}'::jsonb,
    '[
      {"action_type":"mark_template_recommendation","params":{"recommendation":"SCALE","reason":"high_reply_low_opt_out"}}
    ]'::jsonb
  ),
  (
    'sender.failure_spike_review',
    'sender_health_changed',
    'mark_sender_health',
    60,
    'Sender failure spikes are marked review/pause-candidate only unless live pausing is explicitly enabled.',
    true,
    '{"matcher":"sender_failure_spike"}'::jsonb,
    '[
      {"action_type":"mark_sender_health","dry_run":true,"params":{"recommendation":"REVIEW","reason":"delivery_failure_spike"}}
    ]'::jsonb
  ),
  (
    'market.opt_out_pressure_alert',
    'market_health_changed',
    'create_alert',
    70,
    'Market-level opt-out pressure creates an ops notification.',
    false,
    '{"matcher":"market_opt_out_pressure"}'::jsonb,
    '[
      {"action_type":"create_alert","params":{"severity":"warning","notification_type":"market_opt_out_pressure","title":"Market opt-out pressure rising"}}
    ]'::jsonb
  ),
  (
    'deal.buyer_match_candidate',
    'deal_intelligence_changed',
    'create_alert',
    80,
    'High-confidence buyer/deal intelligence signals create a review notification only.',
    false,
    '{"matcher":"buyer_match_candidate"}'::jsonb,
    '[
      {"action_type":"create_alert","params":{"severity":"info","notification_type":"buyer_match_candidate","title":"Buyer match candidate"}}
    ]'::jsonb
  )
ON CONFLICT (rule_key) DO UPDATE
SET
  event_type = EXCLUDED.event_type,
  action_type = EXCLUDED.action_type,
  priority = EXCLUDED.priority,
  description = EXCLUDED.description,
  dry_run_default = EXCLUDED.dry_run_default,
  condition = EXCLUDED.condition,
  actions = EXCLUDED.actions,
  updated_at = now();

COMMENT ON TABLE public.automation_events IS 'Central event ingress table for deterministic automation.';
COMMENT ON TABLE public.automation_rules IS 'Active deterministic automation rule metadata. Executable predicates live in the API rule modules.';
COMMENT ON TABLE public.automation_actions IS 'Idempotent action executions produced by automation runs.';
COMMENT ON TABLE public.automation_runs IS 'One row per matched rule execution.';
COMMENT ON TABLE public.automation_suppressions IS 'Automation-owned phone suppression ledger.';
COMMENT ON TABLE public.automation_audit_log IS 'Immutable audit trail for automation events, rule matches, and actions.';
