-- DISPOSABLE DATABASE ONLY: test setup for PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql.
-- NEVER run against Supabase. Applied AFTER lc_mcp_reader_supabase_emulation.sql, the 1.0 reader migration and
-- lc_mcp_conversation_intel_emulation.sql. It widens the emulation to the production columns the five acquisition
-- read functions touch (send_queue: scripts/db/fixtures/send_queue_live_baseline.sql; followup_intents:
-- PROPOSED_20261017120000_followup_intent_lifecycle.sql; seller_offers / acquisition_opportunities:
-- scripts/db/fixtures/operations_public_baseline.sql + the T3/T4 baseline; automation_events / _suppressions:
-- apps/api/supabase/migrations/20260603192516_automation_engine_foundation.sql; agent.ops_work_item:
-- PROPOSED_20261016140000_operations_action_center.sql, reduced) and seeds SYNTHETIC rows with known answers.
-- action_gateway.seller_action_receipts is NOT created here (link #28 is optional): the posttest creates it inside
-- its own transaction to prove the join, and drops automation_events / agent.ops_work_item the same way to prove
-- the functions tolerate their absence.
--
-- Seeded thread (thread 107): +13125550161 on property P9 — contactable, no hold, no suppression: three send_queue
-- rows (sent / failed / queued) whose queue keys, failed reason and body carry the number on purpose, three
-- follow-up intents (planned / cancelled / delivered), two offers (an outbound cash offer superseded by the seller's
-- inbound counter), one open opportunity whose next action carries the number, two automation events whose
-- payload carries the number, and an EXPIRED automation suppression. Thread 102 (opted out, seeded by the 1.1
-- emulation) gets an ACTIVE automation suppression. Thread 101 keeps its ownership hold (blocks ai_action).

-- ------------------------------------------------------------------ send_queue (prod columns) ----
alter table public.send_queue
  add column if not exists queue_key text, add column if not exists queue_status text default 'queued', add column if not exists scheduled_for timestamptz,
  add column if not exists sent_at timestamptz, add column if not exists delivered_at timestamptz, add column if not exists failed_reason text,
  add column if not exists use_case_template text, add column if not exists agent_name text, add column if not exists message_origin text,
  add column if not exists message_type text, add column if not exists template_source text, add column if not exists touch_number integer,
  add column if not exists retry_count integer default 0, add column if not exists safety_status text, add column if not exists guard_status text,
  add column if not exists paused_reason text, add column if not exists thread_key text, add column if not exists property_id text,
  add column if not exists message_body text, add column if not exists to_phone_number varchar(20), add column if not exists from_phone_number varchar(20),
  add column if not exists created_at timestamptz default now(), add column if not exists updated_at timestamptz default now();
create index if not exists idx_send_queue_thread_key_emul on public.send_queue (thread_key);

-- ------------------------------------------------------------------ followup_intents (prod columns) ----
alter table public.followup_intents
  add column if not exists use_case text, add column if not exists max_attempts integer default 6, add column if not exists next_attempt_at timestamptz default now(),
  add column if not exists materialize_seq integer default 1, add column if not exists send_queue_id uuid, add column if not exists send_queue_key text,
  add column if not exists template_source text, add column if not exists next_action text, add column if not exists closed_at timestamptz,
  add column if not exists row_spec jsonb default '{}'::jsonb, add column if not exists provider_message_id text;

-- ------------------------------------------------------------------ offers + opportunities ----
alter table public.acquisition_opportunities
  add column if not exists dedupe_key text, add column if not exists acquisition_stage text, add column if not exists opportunity_status text,
  add column if not exists automation_state text, add column if not exists priority text, add column if not exists temperature text,
  add column if not exists approval_state text, add column if not exists next_action text, add column if not exists next_action_due timestamptz,
  add column if not exists blocker text, add column if not exists latest_intent text, add column if not exists estimated_value numeric,
  add column if not exists arv numeric, add column if not exists asking_price numeric, add column if not exists current_offer numeric,
  add column if not exists active_offer_id text, add column if not exists market text, add column if not exists stage_entered_at timestamptz,
  add column if not exists last_activity_at timestamptz, add column if not exists last_contact_at timestamptz, add column if not exists metadata jsonb,
  add column if not exists created_at timestamptz default now(), add column if not exists updated_at timestamptz default now();
create table if not exists public.seller_offers (
  id uuid primary key default gen_random_uuid(), offer_id text unique not null, opportunity_id uuid, property_id text, thread_key text not null,
  master_owner_id text, offer_version integer not null, offer_type text not null, direction text not null default 'outbound',
  purchase_price numeric not null, closing_date date, closing_term text, emd_amount numeric, emd_term text, ade_snapshot_id text,
  recommended_offer numeric, authorized_ceiling numeric, valuation_mid numeric, strategy text, status text not null default 'active',
  created_at timestamptz not null default now(), sent_at timestamptz, superseded_at timestamptz, superseded_by_offer_id text,
  accepted_at timestamptz, acceptance_event_id text, accepted_price numeric, send_queue_row_id text, source_message_event_id text,
  policy_version text, metadata jsonb default '{}'::jsonb, updated_at timestamptz default now());
create index if not exists idx_seller_offers_thread_emul on public.seller_offers (thread_key, created_at desc);

-- ------------------------------------------------------------------ automation engine (prod columns) ----
create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(), event_type text not null, status text not null default 'pending', dedupe_key text,
  source text not null default 'api', conversation_thread_id text, property_id text, prospect_id text, master_owner_id text, phone_number_id text,
  queue_item_id text, payload jsonb not null default '{}'::jsonb, run_started_at timestamptz, run_completed_at timestamptz,
  error_code text, error_message text, error_payload jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.automation_suppressions (
  id uuid primary key default gen_random_uuid(), event_type text, action_type text not null default 'suppress_phone', rule_key text,
  status text not null default 'active', suppression_type text not null, suppression_reason text, dedupe_key text, conversation_thread_id text,
  property_id text, prospect_id text, master_owner_id text, phone_number_id text, phone_e164 text, queue_item_id text,
  source_event_id uuid references public.automation_events(id) on delete set null, payload jsonb not null default '{}'::jsonb,
  suppressed_at timestamptz not null default now(), expires_at timestamptz, error_code text, error_message text, error_payload jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

-- ------------------------------------------------------------------ operator work items (reduced) ----
create table if not exists agent.ops_work_item (
  work_item_id uuid primary key default gen_random_uuid(), org_id uuid not null references agent.org(org_id),
  scope text not null, kind text not null, dedupe_key text not null, state text not null default 'open', severity text not null,
  escalated boolean not null default false, title text not null, subject_type text not null, subject_id text,
  detail jsonb not null default '{}'::jsonb, priority integer not null default 0, due_at timestamptz,
  first_seen_at timestamptz not null default clock_timestamp(), last_seen_at timestamptz not null default clock_timestamp(),
  seen_count integer not null default 1, source_job_id text, acknowledged_by uuid, acknowledged_at timestamptz, resolved_at timestamptz,
  resolved_by text, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique (org_id, dedupe_key));

-- production posture: RLS on, nothing to anon; schema agent holds nothing for the Data-API roles
alter table public.seller_offers enable row level security;
alter table public.automation_events enable row level security;
alter table public.automation_suppressions enable row level security;
revoke all on public.seller_offers, public.automation_events, public.automation_suppressions from anon;
alter table agent.ops_work_item enable row level security;
alter table agent.ops_work_item force row level security;
revoke all on agent.ops_work_item from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ seeds ----
insert into public.properties values ('P9', 'O9', '9 Fixture St', '75001', 32.9, -96.8, 'Fixture Metro, TX', 1);
insert into public.master_owners values ('O9', 'Fixture Owner Nine');
insert into public.phones (phone_id, master_owner_id, canonical_e164, phone_type, phone_contact_status, activity_status) values
  ('PH9', 'O9', '+13125550161', 'wireless', 'active', 'active');
insert into public.inbox_thread_state (id, thread_key, property_id, master_owner_id, latest_message_body, status, automation_state, latest_direction,
  last_inbound_at, last_outbound_at, inbound_count, outbound_count, is_suppressed, contactability_status, opt_out, wrong_number) values
  ('00000000-0000-4000-8000-000000000107', '+13125550161', 'P9', 'O9', 'fixture nine', 'active', 'ai', 'inbound',
   now() - interval '1 hour', now() - interval '2 days', 2, 2, false, 'contactable', false, false);
insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role) values ('P9', '+13125550161', 'confirmed_owner');

-- send queue: sent (3 d), failed (2 d, the failed reason names the number), queued (1 h, AI-generated); one row of ANOTHER thread
insert into public.send_queue (id, to_e164, body, queue_key, queue_status, scheduled_for, sent_at, delivered_at, failed_reason, use_case_template, agent_name,
  message_origin, message_type, template_source, touch_number, safety_status, guard_status, thread_key, property_id, message_body, to_phone_number, created_at, updated_at) values
  (9001, '+13125550161', 'fixture', 'fx:+13125550161:1', 'sent', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days' + interval '20 seconds',
   null, 'first_touch', 'Fixture Agent', 'template', 'outbound', 'library', 1, 'approved', 'pass', '+13125550161', 'P9',
   'Hi, this is Fixture Homes about 9 Fixture St. Reply at +13125550161', '+13125550161', now() - interval '3 days', now() - interval '3 days'),
  (9002, '+13125550161', 'fixture', 'fx:+13125550161:2', 'failed', now() - interval '2 days', now() - interval '2 days', null,
   'provider rejected destination +13125550161 (30007)', 'follow_up_s2', 'Fixture Agent', 'template', 'outbound', 'library', 2, 'approved', 'pass', '+13125550161', 'P9',
   'Just checking in about 9 Fixture St.', '+13125550161', now() - interval '2 days', now() - interval '2 days'),
  (9003, '+13125550161', 'fixture', 'fx:+13125550161:3', 'queued', now() + interval '1 day', null, null,
   null, 'offer_follow_up', 'Fixture Agent', 'ai_generated', 'outbound', 'ai', 3, 'pending', null, '+13125550161', 'P9',
   'We can do 175,000 — does that work?', '+13125550161', now() - interval '1 hour', now() - interval '1 hour'),
  (9004, '+15550100001', 'fixture', 'fx:+15550100001:9', 'sent', now() - interval '1 day', now() - interval '1 day', null,
   null, 'first_touch', 'Fixture Agent', 'template', 'outbound', 'library', 1, 'approved', 'pass', '+15550100001', 'P1',
   'other thread', '+15550100001', now() - interval '1 day', now() - interval '1 day');

-- follow-up intents of thread 107: delivered (6 d, materialized), cancelled (3 d), planned (1 d); the key / spec carry the number on purpose
insert into public.followup_intents (intent_key, thread_key, property_id, kind, intent, use_case, due_at, state, reason, writer, attempts, send_queue_id, send_queue_key,
  template_source, outcome, next_action, row_spec, created_at, updated_at, closed_at) values
  ('fx:+13125550161:P9:s2_silence', '+13125550161', 'P9', 's2_silence', 'follow_up', 'follow_up_s2', now() - interval '5 days', 'delivered', null, 'followup_planner', 1,
   '00000000-0000-4000-8000-000000000901', 'fx:+13125550161:2', 'library', 'delivered', null, '{"to":"+13125550161"}', now() - interval '6 days', now() - interval '5 days', now() - interval '5 days'),
  ('fx:+13125550161:P9:not_interested_30d', '+13125550161', 'P9', 'not_interested_30d', 'follow_up', null, now() + interval '20 days', 'cancelled', 'superseded_by_offer', 'followup_planner', 0,
   null, null, null, null, null, '{}', now() - interval '3 days', now() - interval '2 days', now() - interval '2 days'),
  ('fx:+13125550161:P9:offer_silence', '+13125550161', 'P9', 'offer_silence', 'follow_up', 'offer_follow_up', now() + interval '2 days', 'planned', null, 'followup_planner', 0,
   null, null, null, null, 'await_counter', '{"to":"+13125550161"}', now() - interval '1 day', now() - interval '1 day', null);

-- offers + the opportunity of thread 107 (the next action names the number on purpose)
insert into public.acquisition_opportunities (id, primary_property_id, primary_thread_key, dedupe_key, acquisition_stage, opportunity_status, automation_state, priority, temperature,
  approval_state, next_action, next_action_due, latest_intent, estimated_value, asking_price, current_offer, active_offer_id, market, stage_entered_at, last_activity_at, created_at, updated_at) values
  ('00000000-0000-4000-8000-000000000209', 'P9', '+13125550161', 'opp:+13125550161:P9', 'negotiation', 'open', 'ai', 'high', 'hot',
   'none', 'Review the 175000 counter from +13125550161', now() + interval '1 day', 'counteroffer', 190000, 185000, 150000, 'OFF-9-2', 'Fixture Metro, TX',
   now() - interval '2 days', now() - interval '2 days', now() - interval '10 days', now() - interval '2 days');
insert into public.seller_offers (offer_id, opportunity_id, property_id, thread_key, offer_version, offer_type, direction, purchase_price, closing_term, recommended_offer,
  authorized_ceiling, valuation_mid, strategy, status, created_at, sent_at, superseded_at, superseded_by_offer_id, send_queue_row_id, policy_version) values
  ('OFF-9-1', '00000000-0000-4000-8000-000000000209', 'P9', '+13125550161', 1, 'cash', 'outbound', 150000, '30 days', 150000, 160000, 190000, 'anchor_low', 'superseded',
   now() - interval '4 days', now() - interval '4 days', now() - interval '2 days', 'OFF-9-2', '9001', 'r4.v1'),
  ('OFF-9-2', '00000000-0000-4000-8000-000000000209', 'P9', '+13125550161', 2, 'counter', 'inbound', 175000, null, null, 160000, 190000, null, 'active',
   now() - interval '2 days', null, null, null, null, 'r4.v1'),
  ('OFF-1-1', '00000000-0000-4000-8000-000000000201', 'P1', '+15550100001', 1, 'cash', 'outbound', 120000, '30 days', 120000, 130000, 150000, 'anchor_low', 'active',
   now() - interval '1 day', now() - interval '1 day', null, null, null, 'r4.v1');

-- automation events (the payload carries the number on purpose) + suppressions (expired for 107, active for 102)
insert into public.automation_events (id, event_type, status, source, conversation_thread_id, property_id, payload, run_started_at, run_completed_at, error_code, created_at) values
  ('00000000-0000-4000-8000-000000000a01', 'seller_replied', 'completed', 'webhook', '+13125550161', 'P9', '{"from":"+13125550161","body":"175k and I can close in May"}',
   now() - interval '1 hour', now() - interval '59 minutes', null, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000000a02', 'follow_up_due', 'failed', 'scheduler', '+13125550161', 'P9', '{"to":"+13125550161"}',
   now() - interval '2 days', now() - interval '2 days', 'PROVIDER_REJECTED', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000a03', 'seller_replied', 'completed', 'webhook', '+15550100001', 'P1', '{"from":"+15550100001"}', null, null, null, now() - interval '3 hours');
insert into public.automation_suppressions (event_type, action_type, rule_key, status, suppression_type, suppression_reason, conversation_thread_id, phone_e164, suppressed_at, expires_at, created_at) values
  ('seller_replied', 'suppress_phone', 'cooldown_after_reply', 'active', 'cooldown', 'reply cooldown for +13125550161', '+13125550161', '+13125550161', now() - interval '3 days', now() - interval '2 days', now() - interval '3 days'),
  ('opt_out', 'suppress_phone', 'stop_keyword', 'active', 'opt_out', 'ALTO', '+15550100002', '+15550100002', now() - interval '3 days', null, now() - interval '3 days');

-- operator work items: three open / acknowledged (one title names the number; details carry it), one resolved (never returned)
insert into agent.ops_work_item (work_item_id, org_id, scope, kind, dedupe_key, state, severity, escalated, title, subject_type, subject_id, detail, priority, due_at, source_job_id, acknowledged_by, acknowledged_at, resolved_at, resolved_by, created_at, updated_at) values
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-0000000000a1', 'action_center', 'lost_conversation', 'lost:107', 'open', 'warning', false,
   'Seller replied and nobody answered (+13125550161)', 'conversation', '00000000-0000-4000-8000-000000000107', '{"phone":"+13125550161","note":"call back"}', 500, now() + interval '1 day', 'job_ac_1', null, null, null, null, now() - interval '1 hour', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-0000000000a1', 'supervisor', 'escalation', 'esc:followups', 'acknowledged', 'critical', true,
   'Follow-up lifecycle: 2 planned intents overdue', 'system', null, '{"planned_overdue":2}', 900, null, 'job_sup_1', '00000000-0000-4000-8000-0000000000b1', now() - interval '30 minutes', null, null, now() - interval '2 hours', now() - interval '30 minutes'),
  ('00000000-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-0000000000a1', 'pipeline', 'pipeline_mismatch', 'pm:209', 'open', 'info', false,
   'Opportunity stage negotiation without an active outbound offer', 'opportunity', '00000000-0000-4000-8000-000000000209', '{}', 100, null, 'job_pr_1', null, null, null, null, now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000b04', '00000000-0000-4000-8000-0000000000a1', 'recovery', 'recovery_review', 'rec:101', 'resolved', 'info', false,
   'Recovery candidate reviewed', 'conversation', '00000000-0000-4000-8000-000000000101', '{}', 0, null, 'job_rec_1', null, null, now() - interval '1 day', 'auto:recovery', now() - interval '4 days', now() - interval '1 day');
