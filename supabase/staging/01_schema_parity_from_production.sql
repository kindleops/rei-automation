-- ============================================================================
-- STAGING ONLY — smallest canonical schema the seller portal + scheduling core
-- need, generated from production's system catalog on 2026-10-08.
-- ============================================================================
-- Structure only: no production row is read or copied. Not in
-- supabase/migrations, so it can never run as a production migration, and it
-- refuses to run anywhere without the staging identity (00_claim...).
--
-- Scope (dependency closure of the portal/scheduling contracts, see
-- supabase/staging/MANIFEST.md):
--   new tables (16): system_control, ops_operators, notification_events,
--     closing_activity_events, closing_milestones, email_senders,
--     email_suppression, email_threads, seller_offers,
--     offerr_evaluation_requests, offerr_evaluations, closing_cases,
--     closing_title_issues, email_queue, email_inbound_messages,
--     email_attachments
--   drift on existing branch tables (additive columns only):
--     acquisition_opportunities (+17), inbox_thread_state (+18)
--   functions: updated_at helpers, email thread touch triggers,
--     enforce_closed_won_authority, is_ops_operator
--   triggers: the production triggers on these tables (all local integrity /
--     updated_at; none calls pg_net, http, pg_notify, dblink or cron)
--   RLS, policies and anon/authenticated grants mirroring production
--   storage: private bucket email-attachments
--
-- Deliberately NOT included: finalize_closing_case (depends on the settlement
-- system, outside the portal contract — the "closed" state is seeded), every
-- send/queue/campaign/workflow table and cron job (nothing here can contact
-- anyone), and the production property universe.

SELECT staging_guard.assert_staging();

BEGIN;

-- ------------------------------------------------------------- helpers ----
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger LANGUAGE plpgsql AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_email_senders_updated_at()
 RETURNS trigger LANGUAGE plpgsql AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_email_foundation_updated_at()
 RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.offerr_touch_updated_at()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

-- --------------------------------------------------------------- tables ----
create table if not exists public.system_control (
  key text not null,
  value text not null,
  updated_at timestamp with time zone default now() not null,
  constraint system_control_pkey PRIMARY KEY (key)
);

create table if not exists public.ops_operators (
  user_id uuid not null,
  label text,
  added_at timestamp with time zone default now() not null,
  added_by text default CURRENT_USER not null,
  constraint ops_operators_pkey PRIMARY KEY (user_id)
);

create table if not exists public.notification_events (
  id uuid default gen_random_uuid() not null,
  event_type text not null,
  domain text not null,
  severity text default 'neutral'::text not null,
  title text not null,
  description text,
  source_entity_type text,
  source_entity_id text,
  property_id text,
  participant_id text,
  campaign_id uuid,
  market_id text,
  template_id text,
  sender_number_id text,
  workflow_id text,
  deal_id text,
  closing_id text,
  metrics_snapshot jsonb default '{}'::jsonb not null,
  recommendation jsonb,
  available_actions jsonb default '[]'::jsonb not null,
  action_state jsonb default '{}'::jsonb not null,
  sound_category text,
  deduplication_key text not null,
  grouping_key text,
  group_count integer default 1 not null,
  status text default 'active'::text not null,
  read_at timestamp with time zone,
  dismissed_at timestamp with time zone,
  resolved_at timestamp with time zone,
  snoozed_until timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint notification_events_severity_check CHECK ((severity = ANY (ARRAY['positive'::text, 'neutral'::text, 'warning'::text, 'critical'::text]))),
  constraint notification_events_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resolved'::text, 'dismissed'::text]))),
  constraint notification_events_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_notification_events_created_at ON public.notification_events USING btree (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedup_key ON public.notification_events USING btree (deduplication_key);
CREATE INDEX IF NOT EXISTS idx_notification_events_domain ON public.notification_events USING btree (domain);
CREATE INDEX IF NOT EXISTS idx_notification_events_status ON public.notification_events USING btree (status);
CREATE INDEX IF NOT EXISTS idx_notification_events_campaign_id ON public.notification_events USING btree (campaign_id) WHERE (campaign_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notification_events_unread_active ON public.notification_events USING btree (created_at DESC) WHERE ((status = 'active'::text) AND (read_at IS NULL));
CREATE INDEX IF NOT EXISTS idx_notification_events_grouping_key ON public.notification_events USING btree (grouping_key) WHERE (grouping_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notification_events_severity ON public.notification_events USING btree (severity);

create table if not exists public.closing_activity_events (
  id uuid default gen_random_uuid() not null,
  closing_case_id text not null,
  event_type text not null,
  actor text,
  source text default 'system'::text not null,
  detail jsonb default '{}'::jsonb not null,
  idempotency_key text,
  created_at timestamp with time zone default now() not null,
  constraint closing_activity_events_pkey PRIMARY KEY (id),
  constraint closing_activity_events_idempotency_key_key UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_closing_activity_case ON public.closing_activity_events USING btree (closing_case_id, created_at DESC);

create table if not exists public.closing_milestones (
  id uuid default gen_random_uuid() not null,
  closing_case_id text not null,
  milestone_type text not null,
  source_system text default 'system'::text not null,
  source_entity_id text,
  occurred_at timestamp with time zone,
  recorded_at timestamp with time zone default now() not null,
  actor text,
  prior_state text,
  resulting_state text,
  snapshot jsonb default '{}'::jsonb not null,
  idempotency_key text not null,
  constraint closing_milestones_pkey PRIMARY KEY (id),
  constraint closing_milestones_idempotency_key_key UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_closing_milestones_case ON public.closing_milestones USING btree (closing_case_id, occurred_at);

create table if not exists public.email_senders (
  id uuid default gen_random_uuid() not null,
  sender_key text not null,
  sender_name text,
  from_email text not null,
  reply_to_email text,
  provider text,
  provider_account_id text,
  provider_api_key_name text,
  domain text,
  warmup_status text default 'not_started'::text,
  sender_status text default 'active'::text,
  daily_limit integer default 50,
  messages_sent_today integer default 0,
  last_sent_at timestamp with time zone,
  market text,
  agent_persona text,
  language text,
  is_default boolean default false,
  is_active boolean default true,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  constraint email_senders_pkey PRIMARY KEY (id),
  constraint email_senders_from_email_key UNIQUE (from_email),
  constraint email_senders_sender_key_key UNIQUE (sender_key)
);
CREATE INDEX IF NOT EXISTS email_senders_provider_idx ON public.email_senders USING btree (provider);
CREATE INDEX IF NOT EXISTS email_senders_market_idx ON public.email_senders USING btree (market);
CREATE INDEX IF NOT EXISTS email_senders_active_idx ON public.email_senders USING btree (is_active);
CREATE INDEX IF NOT EXISTS email_senders_status_idx ON public.email_senders USING btree (sender_status);
CREATE UNIQUE INDEX IF NOT EXISTS email_senders_from_email_unique ON public.email_senders USING btree (from_email);
CREATE UNIQUE INDEX IF NOT EXISTS email_senders_sender_key_unique ON public.email_senders USING btree (sender_key);

create table if not exists public.email_suppression (
  id uuid default gen_random_uuid() not null,
  email_address text not null,
  reason text not null,
  source text,
  raw_payload jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  suppression_status text,
  is_active boolean default true,
  metadata jsonb default '{}'::jsonb,
  last_event_at timestamp with time zone,
  expires_at timestamp with time zone,
  updated_at timestamp with time zone default now(),
  constraint email_suppression_pkey PRIMARY KEY (id),
  constraint email_suppression_email_address_key UNIQUE (email_address)
);
CREATE INDEX IF NOT EXISTS email_suppression_email_active_idx ON public.email_suppression USING btree (lower(email_address), is_active);

create table if not exists public.email_threads (
  id uuid default gen_random_uuid() not null,
  thread_key text not null,
  category text default 'other'::text not null,
  counterparty_email text,
  counterparty_name text,
  counterparty_role text,
  brand_key text,
  sender_key text,
  subject text,
  master_owner_id text,
  prospect_id text,
  property_id text,
  opportunity_id uuid,
  closing_case_id text,
  buyer_id text,
  title_company_id text,
  sms_thread_key text,
  contact_preference text,
  resolution_status text default 'resolved'::text not null,
  resolution_method text,
  resolution_candidates jsonb default '[]'::jsonb not null,
  automation_state text default 'active'::text not null,
  taken_over_by text,
  taken_over_at timestamp with time zone,
  takeover_reason text,
  needs_operator boolean default false not null,
  needs_code text,
  needs_reason text,
  needs_since timestamp with time zone,
  operator_read_at timestamp with time zone,
  last_inbound_at timestamp with time zone,
  last_outbound_at timestamp with time zone,
  last_message_at timestamp with time zone,
  last_message_direction text,
  last_message_preview text,
  inbound_count integer default 0 not null,
  outbound_count integer default 0 not null,
  attachment_count integer default 0 not null,
  root_message_id text,
  reply_token text default encode(gen_random_bytes(9), 'hex'::text) not null,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint email_threads_automation_state_check CHECK ((automation_state = ANY (ARRAY['active'::text, 'paused'::text, 'taken_over'::text, 'completed'::text, 'failed'::text]))),
  constraint email_threads_category_check CHECK ((category = ANY (ARRAY['seller'::text, 'title'::text, 'buyer'::text, 'lender'::text, 'attorney'::text, 'agent'::text, 'vendor'::text, 'internal'::text, 'unresolved'::text, 'other'::text]))),
  constraint email_threads_contact_preference_check CHECK ((contact_preference = ANY (ARRAY['email'::text, 'sms'::text]))),
  constraint email_threads_last_message_direction_check CHECK ((last_message_direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
  constraint email_threads_needs_has_reason CHECK (((NOT needs_operator) OR ((needs_code IS NOT NULL) AND (needs_since IS NOT NULL)))),
  constraint email_threads_resolution_status_check CHECK ((resolution_status = ANY (ARRAY['resolved'::text, 'ambiguous'::text, 'unresolved'::text]))),
  constraint email_threads_takeover_has_actor CHECK (((automation_state <> 'taken_over'::text) OR ((taken_over_by IS NOT NULL) AND (taken_over_at IS NOT NULL)))),
  constraint email_threads_pkey PRIMARY KEY (id),
  constraint email_threads_reply_token_key UNIQUE (reply_token),
  constraint email_threads_thread_key_key UNIQUE (thread_key)
);
CREATE INDEX IF NOT EXISTS email_threads_sms_idx ON public.email_threads USING btree (sms_thread_key) WHERE (sms_thread_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_threads_owner_idx ON public.email_threads USING btree (master_owner_id) WHERE (master_owner_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_threads_needs_idx ON public.email_threads USING btree (needs_since) WHERE needs_operator;
CREATE INDEX IF NOT EXISTS email_threads_property_idx ON public.email_threads USING btree (property_id) WHERE (property_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_threads_closing_idx ON public.email_threads USING btree (closing_case_id) WHERE (closing_case_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_threads_last_message_idx ON public.email_threads USING btree (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS email_threads_counterparty_idx ON public.email_threads USING btree (lower(counterparty_email));

create table if not exists public.seller_offers (
  id uuid default gen_random_uuid() not null,
  offer_id text not null,
  opportunity_id uuid,
  property_id text,
  thread_key text not null,
  master_owner_id text,
  offer_version integer not null,
  offer_type text not null,
  direction text default 'outbound'::text not null,
  purchase_price numeric not null,
  closing_date date,
  closing_term text,
  emd_amount numeric,
  emd_term text,
  ade_snapshot_id text,
  recommended_offer numeric,
  authorized_ceiling numeric,
  valuation_mid numeric,
  strategy text,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  sent_at timestamp with time zone,
  superseded_at timestamp with time zone,
  superseded_by_offer_id text,
  accepted_at timestamp with time zone,
  acceptance_event_id text,
  accepted_price numeric,
  send_queue_row_id text,
  source_message_event_id text,
  terms_hash text not null,
  metadata jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null,
  closing_window_days integer,
  emd_due_business_days integer,
  emd_due_date date,
  policy_version text,
  constraint seller_offers_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text]))),
  constraint seller_offers_price_positive CHECK ((purchase_price > (0)::numeric)),
  constraint seller_offers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'accepted'::text, 'withdrawn'::text, 'expired'::text]))),
  constraint seller_offers_pkey PRIMARY KEY (id),
  constraint seller_offers_offer_id_key UNIQUE (offer_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_offers_policy_version ON public.seller_offers USING btree (policy_version);
CREATE INDEX IF NOT EXISTS idx_seller_offers_queue_row ON public.seller_offers USING btree (send_queue_row_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_one_accepted ON public.seller_offers USING btree (opportunity_id) WHERE ((status = 'accepted'::text) AND (opportunity_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_version ON public.seller_offers USING btree (opportunity_id, offer_version) WHERE (opportunity_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_acceptance_event ON public.seller_offers USING btree (acceptance_event_id) WHERE (acceptance_event_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_seller_offers_thread ON public.seller_offers USING btree (thread_key, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_one_active ON public.seller_offers USING btree (opportunity_id) WHERE ((status = 'active'::text) AND (opportunity_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_seller_offers_status ON public.seller_offers USING btree (status);

create table if not exists public.offerr_evaluation_requests (
  id uuid default gen_random_uuid() not null,
  idempotency_key text not null,
  raw_submitted_address text not null,
  normalized_submitted_address text not null,
  seller_facts jsonb default '{}'::jsonb not null,
  source text default 'internal'::text not null,
  spine_version text not null,
  resolution_status text not null,
  property_id text,
  acquisition_opportunity_id uuid,
  thread_key text,
  master_owner_id text,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint offerr_eval_requests_resolution_check CHECK ((resolution_status = ANY (ARRAY['RESOLVED'::text, 'AMBIGUOUS'::text, 'NOT_FOUND'::text, 'INVALID_INPUT'::text, 'UNSUPPORTED'::text]))),
  constraint offerr_evaluation_requests_pkey PRIMARY KEY (id),
  constraint offerr_eval_requests_idempotency_unique UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_offerr_eval_requests_created ON public.offerr_evaluation_requests USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offerr_eval_requests_property ON public.offerr_evaluation_requests USING btree (property_id) WHERE (property_id IS NOT NULL);

create table if not exists public.offerr_evaluations (
  id uuid default gen_random_uuid() not null,
  request_id uuid not null,
  evaluation_version integer default 1 not null,
  property_id text,
  outcome text not null,
  confidence_label text,
  preliminary_range jsonb,
  seller_projection jsonb not null,
  internal_result jsonb not null,
  provenance jsonb not null,
  engine_version text,
  spine_version text not null,
  computed_at timestamp with time zone not null,
  expires_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  constraint offerr_evaluations_confidence_check CHECK (((confidence_label IS NULL) OR (confidence_label = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text, 'LOW'::text])))),
  constraint offerr_evaluations_outcome_check CHECK ((outcome = ANY (ARRAY['INSTANT_RANGE_ELIGIBLE'::text, 'CONDITIONAL_RANGE'::text, 'REVIEW_REQUIRED'::text, 'UNSUPPORTED'::text]))),
  constraint offerr_evaluations_version_check CHECK ((evaluation_version > 0)),
  constraint offerr_evaluations_pkey PRIMARY KEY (id),
  constraint offerr_evaluations_request_version_unique UNIQUE (request_id, evaluation_version)
);
CREATE INDEX IF NOT EXISTS idx_offerr_evaluations_request ON public.offerr_evaluations USING btree (request_id, evaluation_version DESC);
CREATE INDEX IF NOT EXISTS idx_offerr_evaluations_property ON public.offerr_evaluations USING btree (property_id) WHERE (property_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_offerr_evaluations_outcome_created ON public.offerr_evaluations USING btree (outcome, created_at DESC);

create table if not exists public.closing_cases (
  id uuid default gen_random_uuid() not null,
  closing_case_id text not null,
  opportunity_id uuid,
  property_id text,
  property_address text,
  master_owner_id text,
  prospect_id text,
  thread_key text,
  offer_id text,
  negotiation_id text,
  contract_id text,
  buyer_id text,
  assignment_id text,
  title_company_id text,
  escrow_file_number text,
  universal_stage text default 'formal_contract'::text not null,
  closing_status text default 'not_scheduled'::text not null,
  closing_substage text,
  contract_status text,
  disposition_status text,
  title_status text,
  escrow_status text,
  funding_status text,
  revenue_status text,
  health_band text,
  risk_level text,
  accepted_at timestamp with time zone,
  terms_hash text,
  docusign_envelope_id text,
  docusign_status text,
  envelope_sent_at timestamp with time zone,
  signer_email text,
  signer_name text,
  contract_signed_date timestamp with time zone,
  effective_date timestamp with time zone,
  emd_due_date timestamp with time zone,
  inspection_deadline timestamp with time zone,
  title_opened_date timestamp with time zone,
  title_commitment_date timestamp with time zone,
  cure_deadline timestamp with time zone,
  scheduled_closing_date timestamp with time zone,
  signing_date timestamp with time zone,
  funding_date timestamp with time zone,
  recording_date timestamp with time zone,
  revenue_confirmed_date timestamp with time zone,
  seller_contract_price numeric,
  earnest_money numeric,
  buyer_price numeric,
  assignment_fee numeric,
  double_close_spread numeric,
  buyer_emd numeric,
  seller_credits numeric,
  closing_costs numeric,
  title_fees numeric,
  expected_gross_revenue numeric,
  confirmed_gross_revenue numeric,
  net_revenue numeric,
  funding_source text,
  readiness jsonb default '{}'::jsonb not null,
  health_score integer,
  health_factors jsonb default '[]'::jsonb not null,
  data_completeness_score integer,
  provenance jsonb default '{}'::jsonb not null,
  last_activity_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  title_company_key text,
  title_company_name text,
  title_company_email text,
  title_route_market text,
  title_route_rank integer,
  title_route_source text,
  title_route_version text,
  title_route_status text,
  title_company_selected_at timestamp with time zone,
  title_intro_sent_at timestamp with time zone,
  closing_tz text,
  closing_date_confirmed_at timestamp with time zone,
  closing_date_source text,
  title_acknowledged_at timestamp with time zone,
  title_acknowledged_source text,
  title_commitment_received_at timestamp with time zone,
  title_commitment_evidence text,
  clear_to_close_at timestamp with time zone,
  clear_to_close_source text,
  clear_to_close_evidence text,
  clear_to_close_actor text,
  closed_at timestamp with time zone,
  closed_by text,
  terminal_outcome text,
  terminal_reason text,
  terminal_at timestamp with time zone,
  terminal_actor text,
  automation_paused_at timestamp with time zone,
  automation_paused_reason text,
  automation_paused_by text,
  automation_state jsonb default '{}'::jsonb not null,
  constraint closing_cases_closed_not_terminal CHECK (((closed_at IS NULL) OR (terminal_outcome IS NULL))),
  constraint closing_cases_closed_requires_closed_at CHECK (((closing_status IS DISTINCT FROM 'closed'::text) OR (closed_at IS NOT NULL))),
  constraint closing_cases_ctc_requires_provenance CHECK (((clear_to_close_at IS NULL) OR ((clear_to_close_source IS NOT NULL) AND (clear_to_close_evidence IS NOT NULL) AND (clear_to_close_actor IS NOT NULL)))),
  constraint closing_cases_terminal_outcome_check CHECK (((terminal_outcome IS NULL) OR (terminal_outcome = ANY (ARRAY['cancelled'::text, 'failed'::text, 'withdrawn'::text])))),
  constraint closing_cases_terminal_requires_reason CHECK (((terminal_outcome IS NULL) OR ((terminal_reason IS NOT NULL) AND (terminal_at IS NOT NULL) AND (terminal_actor IS NOT NULL)))),
  constraint closing_cases_universal_stage_check CHECK ((universal_stage = ANY (ARRAY['formal_contract'::text, 'under_contract'::text, 'disposition'::text, 'prepared_to_close'::text, 'closed'::text]))),
  constraint closing_cases_pkey PRIMARY KEY (id),
  constraint closing_cases_closing_case_id_key UNIQUE (closing_case_id)
);
CREATE INDEX IF NOT EXISTS idx_closing_cases_scheduled ON public.closing_cases USING btree (scheduled_closing_date) WHERE (scheduled_closing_date IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_closing_cases_stage ON public.closing_cases USING btree (universal_stage, closing_status);
CREATE INDEX IF NOT EXISTS idx_closing_cases_owner ON public.closing_cases USING btree (master_owner_id);
CREATE INDEX IF NOT EXISTS idx_closing_cases_title_route_status ON public.closing_cases USING btree (title_route_status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_closing_cases_opportunity ON public.closing_cases USING btree (opportunity_id) WHERE (opportunity_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_closing_cases_thread ON public.closing_cases USING btree (thread_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_closing_cases_envelope ON public.closing_cases USING btree (docusign_envelope_id) WHERE (docusign_envelope_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_closing_cases_contract_status ON public.closing_cases USING btree (contract_status);

create table if not exists public.closing_title_issues (
  id uuid default gen_random_uuid() not null,
  issue_id text not null,
  closing_case_id text not null,
  issue_type text not null,
  description text,
  status text default 'open'::text not null,
  owner text default 'title'::text not null,
  source text not null,
  evidence_reference text,
  notes text,
  opened_at timestamp with time zone default now() not null,
  opened_by text not null,
  resolved_at timestamp with time zone,
  resolved_by text,
  resolution_evidence text,
  updated_at timestamp with time zone default now() not null,
  constraint closing_title_issues_issue_type_check CHECK ((issue_type = ANY (ARRAY['open_lien'::text, 'probate'::text, 'name_discrepancy'::text, 'hoa_balance'::text, 'missing_release'::text, 'tax'::text, 'judgment'::text, 'easement'::text, 'survey'::text, 'other'::text]))),
  constraint closing_title_issues_owner_check CHECK ((owner = ANY (ARRAY['you'::text, 'seller'::text, 'buyer'::text, 'title'::text, 'lender'::text, 'system'::text]))),
  constraint closing_title_issues_resolution_provenance CHECK (((status = ANY (ARRAY['open'::text, 'in_progress'::text])) OR ((resolved_at IS NOT NULL) AND (resolved_by IS NOT NULL) AND (resolution_evidence IS NOT NULL)))),
  constraint closing_title_issues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'waived'::text]))),
  constraint closing_title_issues_pkey PRIMARY KEY (id),
  constraint closing_title_issues_issue_id_key UNIQUE (issue_id)
);
CREATE INDEX IF NOT EXISTS closing_title_issues_case_idx ON public.closing_title_issues USING btree (closing_case_id, status);

create table if not exists public.email_queue (
  id uuid default gen_random_uuid() not null,
  queue_key text not null,
  queue_status text default 'queued'::text not null,
  scheduled_for timestamp with time zone default now(),
  send_priority integer default 5,
  is_locked boolean default false,
  locked_at timestamp with time zone,
  lock_token text,
  retry_count integer default 0,
  max_retries integer default 3,
  next_retry_at timestamp with time zone,
  to_email text not null,
  from_email text,
  subject text not null,
  email_body text not null,
  template_id text,
  provider_message_id text,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  failed_reason text,
  master_owner_id text,
  prospect_id text,
  property_id text,
  market_id text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  thread_id uuid,
  source text,
  source_ref text,
  action_key text,
  sequence integer,
  message_id_header text,
  in_reply_to text,
  references_header text,
  html_body text,
  text_body text,
  from_name text,
  reply_to_email text,
  brand_key text,
  sender_key text,
  approval_status text default 'not_required'::text not null,
  approved_by text,
  approved_at timestamp with time zone,
  reason jsonb default '{}'::jsonb not null,
  revalidated_at timestamp with time zone,
  cancel_reason text,
  superseded_by uuid,
  attempt_started_at timestamp with time zone,
  requested_by text,
  lane text,
  origin text default 'automation'::text not null,
  sending_domain text,
  provider text default 'brevo'::text not null,
  campaign_id text,
  campaign_target_id text,
  sequence_id text,
  sequence_step integer,
  template_version text,
  subject_version text,
  opportunity_id uuid,
  closing_case_id text,
  buyer_id text,
  title_company_id text,
  tracking_token text,
  constraint email_queue_approval_check CHECK ((approval_status = ANY (ARRAY['not_required'::text, 'required'::text, 'approved'::text, 'rejected'::text]))),
  constraint email_queue_approval_gate CHECK (((approval_status <> ALL (ARRAY['required'::text, 'rejected'::text])) OR (queue_status = ANY (ARRAY['draft'::text, 'awaiting_approval'::text, 'cancelled'::text, 'superseded'::text])))),
  constraint email_queue_cancel_has_reason CHECK (((queue_status <> ALL (ARRAY['cancelled'::text, 'superseded'::text])) OR (cancel_reason IS NOT NULL))),
  constraint email_queue_lane_check CHECK (((lane IS NULL) OR (lane = ANY (ARRAY['acquisition'::text, 'seller_conversation'::text, 'transactional'::text, 'closing'::text, 'buyer'::text, 'system'::text, 'manual'::text])))),
  constraint email_queue_origin_check CHECK ((origin = ANY (ARRAY['automation'::text, 'manual'::text]))),
  constraint email_queue_status_check CHECK ((queue_status = ANY (ARRAY['draft'::text, 'awaiting_approval'::text, 'scheduled'::text, 'pending_send'::text, 'sending'::text, 'sent'::text, 'delivered'::text, 'bounced'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'no_send'::text, 'skipped'::text]))),
  constraint email_queue_pkey PRIMARY KEY (id),
  constraint email_queue_queue_key_key UNIQUE (queue_key)
);
CREATE INDEX IF NOT EXISTS email_queue_provider_msg_idx ON public.email_queue USING btree (provider_message_id) WHERE (provider_message_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS email_queue_message_id_header_uidx ON public.email_queue USING btree (message_id_header) WHERE (message_id_header IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_queue_dispatch_idx ON public.email_queue USING btree (COALESCE(scheduled_for, created_at)) WHERE (queue_status = ANY (ARRAY['pending_send'::text, 'scheduled'::text]));
CREATE INDEX IF NOT EXISTS email_queue_campaign_idx ON public.email_queue USING btree (campaign_id, sent_at) WHERE (campaign_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_queue_source_idx ON public.email_queue USING btree (source, source_ref);
CREATE INDEX IF NOT EXISTS email_queue_thread_idx ON public.email_queue USING btree (thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS email_queue_tracking_token_uidx ON public.email_queue USING btree (tracking_token) WHERE (tracking_token IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_queue_template_idx ON public.email_queue USING btree (template_id, sent_at) WHERE (template_id IS NOT NULL);

create table if not exists public.email_inbound_messages (
  id uuid default gen_random_uuid() not null,
  dedupe_key text not null,
  provider text default 'brevo'::text not null,
  provider_message_id text,
  message_id_header text,
  in_reply_to text,
  references_headers text[] default '{}'::text[] not null,
  from_email text not null,
  from_name text,
  to_emails text[] default '{}'::text[] not null,
  cc_emails text[] default '{}'::text[] not null,
  reply_token text,
  subject text,
  text_body text,
  html_body text,
  reply_text text,
  signature_text text,
  received_at timestamp with time zone default now() not null,
  thread_id uuid,
  resolution_method text,
  resolution_confidence numeric,
  processing_status text default 'received'::text not null,
  classification jsonb default '{}'::jsonb not null,
  handled_at timestamp with time zone,
  handled_by text,
  processing_error text,
  attachment_count integer default 0 not null,
  headers jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  constraint email_inbound_messages_processing_status_check CHECK ((processing_status = ANY (ARRAY['received'::text, 'resolved'::text, 'unresolved'::text, 'classified'::text, 'handled'::text, 'needs_operator'::text, 'ignored'::text, 'failed'::text]))),
  constraint email_inbound_messages_pkey PRIMARY KEY (id),
  constraint email_inbound_messages_dedupe_key_key UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS email_inbound_thread_idx ON public.email_inbound_messages USING btree (thread_id, received_at);
CREATE INDEX IF NOT EXISTS email_inbound_status_idx ON public.email_inbound_messages USING btree (processing_status, received_at);
CREATE INDEX IF NOT EXISTS email_inbound_msgid_idx ON public.email_inbound_messages USING btree (message_id_header) WHERE (message_id_header IS NOT NULL);
CREATE INDEX IF NOT EXISTS email_inbound_from_idx ON public.email_inbound_messages USING btree (lower(from_email));

create table if not exists public.email_attachments (
  id uuid default gen_random_uuid() not null,
  attachment_key text not null,
  inbound_message_id uuid,
  queue_id uuid,
  thread_id uuid,
  filename text,
  content_type text,
  size_bytes bigint,
  sha256 text,
  storage_bucket text,
  storage_path text,
  provider_download_token text,
  fetch_status text default 'pending'::text not null,
  doc_type text,
  classification_confidence numeric,
  classification_method text,
  review_state text default 'unclassified'::text not null,
  routed_entity_type text,
  routed_entity_id text,
  routed_at timestamp with time zone,
  reviewed_by text,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  constraint email_attachments_fetch_status_check CHECK ((fetch_status = ANY (ARRAY['pending'::text, 'stored'::text, 'failed'::text, 'too_large'::text, 'blocked'::text]))),
  constraint email_attachments_one_parent CHECK ((num_nonnulls(inbound_message_id, queue_id) = 1)),
  constraint email_attachments_review_state_check CHECK ((review_state = ANY (ARRAY['unclassified'::text, 'auto_classified'::text, 'needs_review'::text, 'reviewed'::text, 'rejected'::text]))),
  constraint email_attachments_routing_trusted CHECK (((routed_entity_id IS NULL) OR (review_state = ANY (ARRAY['auto_classified'::text, 'reviewed'::text])))),
  constraint email_attachments_pkey PRIMARY KEY (id),
  constraint email_attachments_attachment_key_key UNIQUE (attachment_key)
);
CREATE INDEX IF NOT EXISTS email_attachments_review_idx ON public.email_attachments USING btree (review_state) WHERE (review_state = 'needs_review'::text);
CREATE INDEX IF NOT EXISTS email_attachments_thread_idx ON public.email_attachments USING btree (thread_id);

-- --------------------------------------------- drift on existing tables ----
alter table public.inbox_thread_state add column if not exists is_hidden boolean default false;
alter table public.inbox_thread_state add column if not exists hidden_at timestamp with time zone;
alter table public.inbox_thread_state add column if not exists suppressed_at timestamp with time zone;
alter table public.inbox_thread_state add column if not exists next_action text;
alter table public.inbox_thread_state add column if not exists pending_queue_count integer default 0;
alter table public.inbox_thread_state add column if not exists failed_queue_count integer default 0;
alter table public.inbox_thread_state add column if not exists blocked_queue_count integer default 0;
alter table public.inbox_thread_state add column if not exists next_scheduled_for timestamp with time zone;
alter table public.inbox_thread_state add column if not exists persona_id text;
alter table public.inbox_thread_state add column if not exists automation_lane text;
alter table public.inbox_thread_state add column if not exists next_action_at timestamp with time zone;
alter table public.inbox_thread_state add column if not exists classifier_version text;
alter table public.inbox_thread_state add column if not exists classified_at timestamp with time zone;
alter table public.inbox_thread_state add column if not exists classification_run_id uuid;
alter table public.inbox_thread_state add column if not exists previous_inbox_bucket text;
alter table public.inbox_thread_state add column if not exists previous_automation_lane text;
alter table public.inbox_thread_state add column if not exists manual_override_at timestamp with time zone;
alter table public.inbox_thread_state add column if not exists manual_override_by text;
alter table public.acquisition_opportunities add column if not exists next_action text;
alter table public.acquisition_opportunities add column if not exists universal_status text;
alter table public.acquisition_opportunities add column if not exists property_state text;
alter table public.acquisition_opportunities add column if not exists active_offer_id text;
alter table public.acquisition_opportunities add column if not exists accepted_offer_id text;
alter table public.acquisition_opportunities add column if not exists strategy_status text;
alter table public.acquisition_opportunities add column if not exists strategy_started_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists strategy_resolved_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists strategy_resolution_reason text;
alter table public.acquisition_opportunities add column if not exists cash_attempted_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists cash_rejected_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists creative_attempted_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists creative_rejected_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists novation_attempted_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists novation_rejected_at timestamp with time zone;
alter table public.acquisition_opportunities add column if not exists creative_ineligible_reason text;
alter table public.acquisition_opportunities add column if not exists novation_ineligible_reason text;
alter table public.acquisition_opportunities add column if not exists last_presented_terms_id text;
alter table public.acquisition_opportunities add column if not exists favorable_spread boolean;

-- ---------------------------------------------------------- foreign keys ----
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('acquisition_opportunity_history', 'acquisition_opportunity_history_opportunity_id_fkey', 'FOREIGN KEY (opportunity_id) REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE'),
    ('closing_cases', 'closing_cases_opportunity_id_fkey', 'FOREIGN KEY (opportunity_id) REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL'),
    ('closing_title_issues', 'closing_title_issues_closing_case_id_fkey', 'FOREIGN KEY (closing_case_id) REFERENCES public.closing_cases(closing_case_id)'),
    ('email_attachments', 'email_attachments_inbound_message_id_fkey', 'FOREIGN KEY (inbound_message_id) REFERENCES public.email_inbound_messages(id)'),
    ('email_attachments', 'email_attachments_queue_id_fkey', 'FOREIGN KEY (queue_id) REFERENCES public.email_queue(id)'),
    ('email_attachments', 'email_attachments_thread_id_fkey', 'FOREIGN KEY (thread_id) REFERENCES public.email_threads(id)'),
    ('email_inbound_messages', 'email_inbound_messages_thread_id_fkey', 'FOREIGN KEY (thread_id) REFERENCES public.email_threads(id)'),
    ('email_queue', 'email_queue_thread_id_fkey', 'FOREIGN KEY (thread_id) REFERENCES public.email_threads(id)'),
    ('offerr_evaluations', 'offerr_evaluations_request_id_fkey', 'FOREIGN KEY (request_id) REFERENCES public.offerr_evaluation_requests(id)'),
    ('ops_operators', 'ops_operators_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE'),
    ('seller_offers', 'seller_offers_opportunity_id_fkey', 'FOREIGN KEY (opportunity_id) REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE')
  ) AS v(tbl, name, def) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.name AND conrelid = format('public.%I', r.tbl)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', r.tbl, r.name, r.def);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------- functions that need tables ----
CREATE OR REPLACE FUNCTION public.email_thread_touch_inbound()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
begin
  if new.thread_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.thread_id is not distinct from new.thread_id then return new; end if;
  update public.email_threads t set
    last_inbound_at = greatest(coalesce(t.last_inbound_at, 'epoch'), new.received_at),
    last_message_at = greatest(coalesce(t.last_message_at, 'epoch'), new.received_at),
    last_message_direction = case when new.received_at >= coalesce(t.last_message_at, 'epoch') then 'inbound' else t.last_message_direction end,
    last_message_preview = case when new.received_at >= coalesce(t.last_message_at, 'epoch')
      then left(regexp_replace(coalesce(new.reply_text, new.text_body, ''), '\s+', ' ', 'g'), 200) else t.last_message_preview end,
    inbound_count = t.inbound_count + 1,
    attachment_count = t.attachment_count + new.attachment_count,
    updated_at = now()
  where t.id = new.thread_id;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.email_thread_touch_outbound()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
begin
  if new.thread_id is null then return new; end if;
  if new.queue_status in ('sent','delivered')
     and (tg_op = 'INSERT' or old.queue_status is distinct from new.queue_status)
     and (tg_op = 'INSERT' or old.queue_status not in ('sent','delivered')) then
    update public.email_threads t set
      last_outbound_at = greatest(coalesce(t.last_outbound_at, 'epoch'), coalesce(new.sent_at, now())),
      last_message_at = greatest(coalesce(t.last_message_at, 'epoch'), coalesce(new.sent_at, now())),
      last_message_direction = case when coalesce(new.sent_at, now()) >= coalesce(t.last_message_at, 'epoch') then 'outbound' else t.last_message_direction end,
      last_message_preview = case when coalesce(new.sent_at, now()) >= coalesce(t.last_message_at, 'epoch')
        then left(regexp_replace(coalesce(new.text_body, new.email_body, ''), '\s+', ' ', 'g'), 200) else t.last_message_preview end,
      outbound_count = t.outbound_count + 1,
      root_message_id = coalesce(t.root_message_id, new.message_id_header),
      updated_at = now()
    where t.id = new.thread_id;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.enforce_closed_won_authority()
 RETURNS trigger LANGUAGE plpgsql AS $function$
declare
  v_lost boolean := coalesce(new.opportunity_status, 'active') in ('dead', 'suppressed', 'lost', 'archived');
  v_entering_closed boolean := new.acquisition_stage = 'closed'
    and (tg_op = 'INSERT' or old.acquisition_stage is distinct from 'closed' or old.opportunity_status is distinct from new.opportunity_status);
  v_entering_won boolean := new.opportunity_status = 'won'
    and (tg_op = 'INSERT' or old.opportunity_status is distinct from 'won');
begin
  if (v_entering_closed and not v_lost) or v_entering_won then
    if not exists (
      select 1 from public.closing_cases cc
      where cc.opportunity_id = new.id and cc.closing_status = 'closed' and cc.closed_at is not null and cc.terminal_outcome is null
    ) then
      raise exception using errcode = 'P0001',
        message = 'CLOSING_BLOCKED: closed-won requires a finalized closing (finalize_closing_case)';
    end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.is_ops_operator()
 RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path TO '' AS $function$
  select exists (
    select 1 from public.ops_operators o where o.user_id = (select auth.uid())
  );
$function$;
REVOKE ALL ON FUNCTION public.is_ops_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_ops_operator() TO authenticated, service_role;

-- -------------------------------------------------------------- triggers ----
DROP TRIGGER IF EXISTS trg_closing_cases_updated_at ON public.closing_cases;
CREATE TRIGGER trg_closing_cases_updated_at BEFORE UPDATE ON public.closing_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS email_inbound_thread_touch ON public.email_inbound_messages;
CREATE TRIGGER email_inbound_thread_touch AFTER INSERT OR UPDATE OF thread_id ON public.email_inbound_messages FOR EACH ROW EXECUTE FUNCTION email_thread_touch_inbound();
DROP TRIGGER IF EXISTS email_queue_thread_touch ON public.email_queue;
CREATE TRIGGER email_queue_thread_touch AFTER INSERT OR UPDATE OF queue_status ON public.email_queue FOR EACH ROW EXECUTE FUNCTION email_thread_touch_outbound();
DROP TRIGGER IF EXISTS tr_email_senders_updated_at ON public.email_senders;
CREATE TRIGGER tr_email_senders_updated_at BEFORE UPDATE ON public.email_senders FOR EACH ROW EXECUTE FUNCTION set_email_senders_updated_at();
DROP TRIGGER IF EXISTS trg_email_suppression_updated_at ON public.email_suppression;
CREATE TRIGGER trg_email_suppression_updated_at BEFORE UPDATE ON public.email_suppression FOR EACH ROW EXECUTE FUNCTION set_email_foundation_updated_at();
DROP TRIGGER IF EXISTS trg_offerr_eval_requests_touch ON public.offerr_evaluation_requests;
CREATE TRIGGER trg_offerr_eval_requests_touch BEFORE UPDATE ON public.offerr_evaluation_requests FOR EACH ROW EXECUTE FUNCTION offerr_touch_updated_at();
DROP TRIGGER IF EXISTS trg_seller_offers_updated_at ON public.seller_offers;
CREATE TRIGGER trg_seller_offers_updated_at BEFORE UPDATE ON public.seller_offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_acquisition_opportunities_closed_won_authority ON public.acquisition_opportunities;
CREATE TRIGGER trg_acquisition_opportunities_closed_won_authority BEFORE INSERT OR UPDATE OF acquisition_stage, opportunity_status ON public.acquisition_opportunities FOR EACH ROW EXECUTE FUNCTION enforce_closed_won_authority();

-- ------------------------------------------- RLS, policies, grants (prod) ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['system_control','ops_operators','notification_events','closing_activity_events','closing_milestones',
    'email_senders','email_suppression','email_threads','seller_offers','offerr_evaluation_requests','offerr_evaluations',
    'closing_cases','closing_title_issues','email_queue','email_inbound_messages','email_attachments',
    'acquisition_opportunities','acquisition_opportunity_history','external_seller_intake_submissions','inbox_thread_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- Production lockdown: anon holds nothing in public.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
  -- authenticated: production grants exactly these (RLS still gates rows).
  FOREACH t IN ARRAY ARRAY['closing_activity_events','closing_cases','closing_milestones','closing_title_issues','email_attachments',
    'email_inbound_messages','email_threads','notification_events','offerr_evaluation_requests','offerr_evaluations','ops_operators','seller_offers'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
  END LOOP;
  REVOKE ALL ON public.acquisition_opportunity_history FROM authenticated;
  GRANT SELECT ON public.acquisition_opportunity_history TO authenticated;
END $$;

DROP POLICY IF EXISTS offerr_evaluations_service_role_all ON public.offerr_evaluations;
CREATE POLICY offerr_evaluations_service_role_all ON public.offerr_evaluations AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS offerr_eval_requests_service_role_all ON public.offerr_evaluation_requests;
CREATE POLICY offerr_eval_requests_service_role_all ON public.offerr_evaluation_requests AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS email_suppression_service_role_all ON public.email_suppression;
CREATE POLICY email_suppression_service_role_all ON public.email_suppression AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ops_operator_read ON public.acquisition_opportunities;
CREATE POLICY ops_operator_read ON public.acquisition_opportunities AS PERMISSIVE FOR SELECT TO authenticated USING ((SELECT is_ops_operator() AS is_ops_operator));
DROP POLICY IF EXISTS ops_operator_read ON public.acquisition_opportunity_history;
CREATE POLICY ops_operator_read ON public.acquisition_opportunity_history AS PERMISSIVE FOR SELECT TO authenticated USING ((SELECT is_ops_operator() AS is_ops_operator));
DROP POLICY IF EXISTS ops_operator_all ON public.inbox_thread_state;
CREATE POLICY ops_operator_all ON public.inbox_thread_state AS PERMISSIVE FOR ALL TO authenticated USING ((SELECT is_ops_operator() AS is_ops_operator)) WITH CHECK ((SELECT is_ops_operator() AS is_ops_operator));

-- --------------------------------------------------------------- storage ----
INSERT INTO storage.buckets (id, name, public) VALUES ('email-attachments', 'email-attachments', false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
