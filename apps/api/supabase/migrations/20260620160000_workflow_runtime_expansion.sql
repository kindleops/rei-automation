-- Workflow Studio V2 — runtime expansion: versioning, system templates, scheduling, facts.

-- Versioning + lifecycle
ALTER TABLE public.workflow_definitions
  ADD COLUMN IF NOT EXISTS version              integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS published_at         timestamptz,
  ADD COLUMN IF NOT EXISTS is_system_template   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS parent_definition_id uuid        REFERENCES public.workflow_definitions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_locked            boolean     NOT NULL DEFAULT false;

ALTER TABLE public.workflow_definitions DROP CONSTRAINT IF EXISTS wf_def_status_check;
ALTER TABLE public.workflow_definitions
  ADD CONSTRAINT wf_def_status_check CHECK (
    status IN ('draft', 'published', 'active', 'paused', 'archived')
  );

-- Persisted delay / retry scheduling
CREATE TABLE IF NOT EXISTS public.workflow_scheduled_tasks (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_definition_id  uuid        REFERENCES public.workflow_definitions(id) ON DELETE CASCADE,
  enrollment_id           uuid        REFERENCES public.workflow_enrollments(id) ON DELETE CASCADE,
  run_id                  uuid        REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  node_id                 uuid        REFERENCES public.workflow_nodes(id) ON DELETE SET NULL,
  task_type               text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'pending',
  scheduled_for           timestamptz NOT NULL,
  reason                  text,
  payload                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key              text        UNIQUE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  CONSTRAINT workflow_scheduled_tasks_status_check CHECK (
    status IN ('pending', 'running', 'completed', 'cancelled', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_wf_scheduled_tasks_due
  ON public.workflow_scheduled_tasks (scheduled_for, status)
  WHERE status = 'pending';

-- Conversation intelligence facts (confidence + provenance)
CREATE TABLE IF NOT EXISTS public.workflow_extracted_facts (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id           uuid        REFERENCES public.workflow_enrollments(id) ON DELETE CASCADE,
  subject_type            text        NOT NULL DEFAULT 'lead',
  subject_id              text        NOT NULL,
  fact_key                text        NOT NULL,
  fact_value              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  confidence              numeric     NOT NULL DEFAULT 0,
  provenance              text,
  source_message_id       text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_extracted_facts_unique UNIQUE (enrollment_id, fact_key)
);

-- Seller cooperation metric
CREATE TABLE IF NOT EXISTS public.workflow_seller_cooperation (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id           uuid        REFERENCES public.workflow_enrollments(id) ON DELETE CASCADE,
  subject_type            text        NOT NULL DEFAULT 'lead',
  subject_id              text        NOT NULL,
  score                   integer     NOT NULL DEFAULT 0,
  trend                   text,
  avg_response_time_hours numeric,
  question_completion_rate numeric,
  reasons                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_seller_cooperation_score_check CHECK (score >= 0 AND score <= 100)
);

-- Idempotent run tracking
ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_runs_dedupe_key
  ON public.workflow_runs (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Run control
ALTER TABLE public.workflow_enrollments
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason text;

-- Expand node registry catalog (safe, no arbitrary SQL/code nodes)
INSERT INTO public.workflow_node_registry
  (node_type, node_kind, label, description, category, is_communication, requires_guard_before, is_terminal, is_enabled, is_system)
VALUES
  ('trigger.campaign_target_queued', 'trigger', 'Campaign Target Queued', 'Fires when a campaign target enters the send queue.', 'triggers', false, false, false, true, false),
  ('trigger.message_scheduled', 'trigger', 'Message Scheduled', 'Fires when an outbound message is scheduled.', 'triggers', false, false, false, true, false),
  ('trigger.message_sent', 'trigger', 'Message Sent', 'Fires when an outbound message is sent.', 'triggers', false, false, false, true, false),
  ('trigger.message_delivered', 'trigger', 'Message Delivered', 'Fires when delivery is confirmed.', 'triggers', false, false, false, true, false),
  ('trigger.message_failed', 'trigger', 'Message Failed', 'Fires when delivery fails.', 'triggers', false, false, false, true, false),
  ('trigger.delivery_unknown', 'trigger', 'Delivery Unknown', 'Fires when delivery state is unknown.', 'triggers', false, false, false, true, false),
  ('trigger.inbound_message_received', 'trigger', 'Inbound Message Received', 'Fires on inbound seller message.', 'triggers', false, false, false, true, false),
  ('trigger.classification_completed', 'trigger', 'Classification Completed', 'Fires when message classification completes.', 'triggers', false, false, false, true, false),
  ('trigger.ownership_confirmed', 'trigger', 'Ownership Confirmed', 'Fires when ownership is confirmed.', 'triggers', false, false, false, true, false),
  ('trigger.interest_confirmed', 'trigger', 'Interest Confirmed', 'Fires when seller interest is confirmed.', 'triggers', false, false, false, true, false),
  ('trigger.asking_price_extracted', 'trigger', 'Asking Price Extracted', 'Fires when asking price is extracted.', 'triggers', false, false, false, true, false),
  ('trigger.underwriting_fact_updated', 'trigger', 'Underwriting Fact Updated', 'Fires when an underwriting fact is updated.', 'triggers', false, false, false, true, false),
  ('trigger.acquisition_engine_completed', 'trigger', 'Acquisition Engine Completed', 'Fires when acquisition engine completes.', 'triggers', false, false, false, true, false),
  ('trigger.offer_created', 'trigger', 'Offer Created', 'Fires when an offer is created.', 'triggers', false, false, false, true, false),
  ('trigger.offer_sent', 'trigger', 'Offer Sent', 'Fires when an offer is sent.', 'triggers', false, false, false, true, false),
  ('trigger.pipeline_stage_changed', 'trigger', 'Pipeline Stage Changed', 'Fires when pipeline stage changes.', 'triggers', false, false, false, true, false),
  ('trigger.follow_up_due', 'trigger', 'Follow-Up Due', 'Fires when a scheduled follow-up is due.', 'triggers', false, false, false, true, false),
  ('trigger.appointment_scheduled', 'trigger', 'Appointment Scheduled', 'Fires when an appointment is scheduled.', 'triggers', false, false, false, true, false),
  ('trigger.contract_status_changed', 'trigger', 'Contract Status Changed', 'Fires when contract status changes.', 'triggers', false, false, false, true, false),
  ('trigger.manual_enrollment', 'trigger', 'Manual Enrollment', 'Fires on manual workflow enrollment.', 'triggers', false, false, false, true, false),
  ('timing.wait_until', 'timing', 'Wait Until', 'Pauses until a specific datetime.', 'timing', false, false, false, true, false),
  ('timing.wait_for_local_contact_window', 'timing', 'Wait For Contact Window', 'Pauses until local contact window opens.', 'timing', false, false, false, true, false),
  ('timing.wait_for_reply', 'timing', 'Wait For Reply', 'Pauses until seller replies or timeout.', 'timing', false, false, false, true, false),
  ('timing.schedule_follow_up', 'timing', 'Schedule Follow-Up', 'Schedules a follow-up timer.', 'timing', false, false, false, true, false),
  ('condition.asset_class', 'condition', 'Asset Class', 'Branches on asset class.', 'conditions', false, false, false, true, false),
  ('condition.campaign', 'condition', 'Campaign', 'Branches on campaign.', 'conditions', false, false, false, true, false),
  ('condition.market', 'condition', 'Market', 'Branches on market.', 'conditions', false, false, false, true, false),
  ('condition.pipeline_stage', 'condition', 'Pipeline Stage', 'Branches on pipeline stage.', 'conditions', false, false, false, true, false),
  ('condition.seller_intent', 'condition', 'Seller Intent', 'Branches on seller intent.', 'conditions', false, false, false, true, false),
  ('condition.classification_confidence', 'condition', 'Classification Confidence', 'Branches on classification confidence.', 'conditions', false, false, false, true, false),
  ('condition.ownership_status', 'condition', 'Ownership Status', 'Branches on ownership status.', 'conditions', false, false, false, true, false),
  ('condition.decision_maker_status', 'condition', 'Decision Maker Status', 'Branches on decision maker status.', 'conditions', false, false, false, true, false),
  ('condition.asking_price_present', 'condition', 'Asking Price Present', 'Branches when asking price is present.', 'conditions', false, false, false, true, false),
  ('condition.offer_to_ask_ratio', 'condition', 'Offer To Ask Ratio', 'Branches on offer/ask ratio.', 'conditions', false, false, false, true, false),
  ('condition.aos_range', 'condition', 'AOS Range', 'Branches on AOS range.', 'conditions', false, false, false, true, false),
  ('condition.best_strategy', 'condition', 'Best Strategy', 'Branches on best strategy.', 'conditions', false, false, false, true, false),
  ('condition.motivation_range', 'condition', 'Motivation Range', 'Branches on motivation score range.', 'conditions', false, false, false, true, false),
  ('condition.cooperation_range', 'condition', 'Cooperation Range', 'Branches on seller cooperation score.', 'conditions', false, false, false, true, false),
  ('condition.missing_underwriting_fact', 'condition', 'Missing Underwriting Fact', 'Branches when underwriting fact is missing.', 'conditions', false, false, false, true, false),
  ('condition.language', 'condition', 'Language', 'Branches on contact language.', 'conditions', false, false, false, true, false),
  ('condition.message_delivery_state', 'condition', 'Message Delivery State', 'Branches on delivery state.', 'conditions', false, false, false, true, false),
  ('condition.retryable_failure', 'condition', 'Retryable Failure', 'Branches on transient delivery failure.', 'conditions', false, false, false, true, false),
  ('condition.prior_touch_count', 'condition', 'Prior Touch Count', 'Branches on prior touch count.', 'conditions', false, false, false, true, false),
  ('condition.suppression_state', 'condition', 'Suppression State', 'Branches on suppression state.', 'conditions', false, false, false, true, false),
  ('condition.contact_method_available', 'condition', 'Contact Method Available', 'Branches when contact method exists.', 'conditions', false, false, false, true, false),
  ('condition.contact_window_open', 'condition', 'Contact Window Open', 'Branches when contact window is open.', 'conditions', false, false, false, true, false),
  ('guard.suppression', 'guard', 'Suppression Guard', 'Blocks suppressed contacts.', 'guards', false, false, true, true, false),
  ('guard.opt_out', 'guard', 'Opt-Out Guard', 'Blocks opted-out contacts.', 'guards', false, false, true, true, false),
  ('guard.wrong_number', 'guard', 'Wrong Number Guard', 'Blocks wrong-number contacts.', 'guards', false, false, true, true, false),
  ('guard.dnc', 'guard', 'DNC Guard', 'Blocks DNC contacts.', 'guards', false, false, true, true, false),
  ('guard.duplicate_action', 'guard', 'Duplicate Action Guard', 'Blocks duplicate workflow actions.', 'guards', false, false, false, true, false),
  ('guard.duplicate_message', 'guard', 'Duplicate Message Guard', 'Blocks duplicate messages.', 'guards', false, false, false, true, false),
  ('guard.contact_window', 'guard', 'Contact Window Guard', 'Blocks outside contact window.', 'guards', false, false, false, true, false),
  ('guard.sender_available', 'guard', 'Sender Available Guard', 'Blocks when no sender is available.', 'guards', false, false, false, true, false),
  ('guard.template_available', 'guard', 'Template Available Guard', 'Blocks when template is unavailable.', 'guards', false, false, false, true, false),
  ('guard.language_compatible', 'guard', 'Language Compatible Guard', 'Blocks incompatible language.', 'guards', false, false, false, true, false),
  ('guard.approval_required', 'guard', 'Approval Required Guard', 'Blocks until human approval.', 'guards', false, false, false, true, false),
  ('guard.workflow_kill_switch', 'guard', 'Workflow Kill Switch', 'Global workflow kill switch.', 'guards', false, false, true, true, false),
  ('action.enqueue_sms', 'action', 'Enqueue SMS', 'Creates canonical send_queue SMS row (no direct TextGrid).', 'messaging', true, true, false, true, false),
  ('action.enqueue_email', 'action', 'Enqueue Email', 'Creates canonical send_queue email row.', 'messaging', true, true, false, true, false),
  ('action.update_structured_fact', 'action', 'Update Structured Fact', 'Persists a structured fact with confidence.', 'crm', false, false, false, true, false),
  ('action.run_conversation_extraction', 'action', 'Run Conversation Extraction', 'Extracts conversation intelligence facts.', 'intelligence', false, false, false, true, false),
  ('action.run_classification', 'action', 'Run Classification', 'Runs inbound classification.', 'intelligence', false, false, false, true, false),
  ('action.run_acquisition_engine', 'action', 'Run Acquisition Engine', 'Runs acquisition engine orchestration.', 'intelligence', false, false, false, true, false),
  ('action.run_underwriting', 'action', 'Run Underwriting', 'Runs underwriting for asset class.', 'intelligence', false, false, false, true, false),
  ('action.calculate_offer_ask_gap', 'action', 'Calculate Offer Ask Gap', 'Calculates offer/ask ratios and gap.', 'intelligence', false, false, false, true, false),
  ('action.select_template', 'action', 'Select Template', 'Selects message template.', 'messaging', false, false, false, true, false),
  ('action.select_sender', 'action', 'Select Sender', 'Selects outbound sender.', 'messaging', false, false, false, true, false),
  ('action.schedule_follow_up', 'action', 'Schedule Follow-Up', 'Schedules a follow-up timer.', 'timing', false, false, false, true, false),
  ('action.cancel_pending_follow_ups', 'action', 'Cancel Pending Follow-Ups', 'Cancels pending follow-up timers.', 'timing', false, false, false, true, false),
  ('action.create_or_update_opportunity', 'action', 'Create Or Update Opportunity', 'Creates or updates opportunity record.', 'crm', false, false, false, true, false),
  ('action.request_human_approval', 'action', 'Request Human Approval', 'Requests operator approval.', 'approvals', false, false, false, true, false),
  ('action.notify_operator', 'action', 'Notify Operator', 'Notifies operator for review.', 'notifications', false, false, false, true, false),
  ('action.mark_wrong_number', 'action', 'Mark Wrong Number', 'Marks contact as wrong number.', 'crm', false, false, false, true, false),
  ('action.suppress_contact', 'action', 'Suppress Contact', 'Suppresses future contact.', 'crm', false, false, false, true, false),
  ('action.select_next_contact_method', 'action', 'Select Next Contact Method', 'Selects alternate contact method.', 'messaging', false, false, false, true, false),
  ('action.enroll_subworkflow', 'action', 'Enroll Subworkflow', 'Enrolls subject in subworkflow.', 'subworkflows', false, false, false, true, false),
  ('action.exit_workflow', 'action', 'Exit Workflow', 'Terminates workflow enrollment.', 'control', false, false, true, true, false)
ON CONFLICT (node_type) DO UPDATE
  SET node_kind = EXCLUDED.node_kind,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      is_communication = EXCLUDED.is_communication,
      requires_guard_before = EXCLUDED.requires_guard_before,
      is_terminal = EXCLUDED.is_terminal,
      is_enabled = EXCLUDED.is_enabled,
      is_system = EXCLUDED.is_system;