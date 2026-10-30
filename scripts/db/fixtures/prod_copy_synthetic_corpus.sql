-- SYNTHETIC CORPUS for the production-copy rehearsal proof (scripts/db/prod-copy-synthetic-build.mjs).
-- DISPOSABLE DATABASE ONLY: applied once, after the repository release chain (rc_8_5_21_release_chain) and the link #32
-- campaign / template baseline, to a database named lc_prodcopy_synth_*. NEVER run against Supabase or production.
-- Every row is INVENTED: phone numbers are in the reserved 555-01xx range, names say "Synthetic", streets are
-- "Example", ZIP labels (001xx / 002xx) are not real US ZIP codes, every message body was written for this file.
--
-- 1. Production columns the chain fixtures leave out (each one is read by a reader link or the census and exists in
--    production per the cited source):
--    * automation_suppressions / automation_events: apps/api/supabase/migrations/20260603192516_automation_engine_foundation.sql
--      (the chain's action_gateway_baseline.sql carries a reduced automation_suppressions);
--    * phones.phone_type and the eg_property_facts screening columns: the same columns the 1.1 / 1.2 reader emulations
--      add (mcp/leadcommand-mcp/migrations/test/lc_mcp_conversation_intel_emulation.sql, lc_mcp_corpus_census_emulation.sql).
-- 2. Twelve leads (S01..S12) in two invented markets, nine seller threads (T01..T09), with known answers:
--    T01 interested seller, stated price + timeline, unanswered 3 days; every eligibility input present → eligible
--    T02 asked for an offer, unanswered 30 h; ownership never confirmed (no contact/property resolution) → UNKNOWN
--    T03 "STOP": thread opted out, suppressed, active suppression-list row → blocked (excluded from ranking)
--    T04 wrong number / not the owner → blocked (excluded from ranking)
--    T05 counteroffer (our 180k, their 210k), we answered 33 days ago, then silence → stalled negotiation; active
--        operator hold blocking ai_action → blocked
--    T06 asked for a callback next week; a planned follow-up intent; the phone's line type is not recorded → UNKNOWN
--    T07 "Not interested." → excluded (negative)
--    T08 asked for a best price, unanswered 10 days; an active suppression-list row the thread flags do not show → blocked
--    T09 last inbound 500 days ago → outside the reader's 365-day worklist window (counted, not ranked)
--    S10 distress + an SMS-eligible phone, never contacted; S11 an interest label in the other market, never contacted;
--    S12 shares S01's owner, address and phone (duplicate identity).
begin;

-- ------------------------------------------------------------------ 1. production columns ----
alter table public.automation_suppressions
  add column if not exists event_type text, add column if not exists action_type text not null default 'suppress_phone',
  add column if not exists rule_key text, add column if not exists dedupe_key text, add column if not exists conversation_thread_id text,
  add column if not exists property_id text, add column if not exists prospect_id text, add column if not exists master_owner_id text,
  add column if not exists phone_number_id text, add column if not exists queue_item_id text, add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists suppressed_at timestamptz not null default now(), add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();
create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(), event_type text not null, status text not null default 'pending', dedupe_key text,
  source text not null default 'api', conversation_thread_id text, property_id text, prospect_id text, master_owner_id text, phone_number_id text,
  queue_item_id text, payload jsonb not null default '{}'::jsonb, run_started_at timestamptz, run_completed_at timestamptz,
  error_code text, error_message text, error_payload jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table public.automation_events enable row level security;
revoke all on public.automation_events from anon, authenticated;
alter table public.phones add column if not exists phone_type text;
alter table public.eg_property_facts
  add column if not exists conversation_stage text, add column if not exists conversation_status text, add column if not exists pipeline_stage text,
  add column if not exists pipeline_status text, add column if not exists sms_status text, add column if not exists property_address_state text,
  add column if not exists last_contact_at timestamptz, add column if not exists last_contact_direction text, add column if not exists estimated_value numeric,
  add column if not exists equity_known_pct numeric, add column if not exists distress_signal_count numeric, add column if not exists tax_delinquent boolean,
  add column if not exists owner_property_count numeric;

-- ------------------------------------------------------------------ 2. owners, properties, facts ----
insert into public.master_owners (master_owner_id, display_name) values
  ('SO01', 'Synthetic Owner 01'), ('SO02', 'Synthetic Owner 02'), ('SO03', 'Synthetic Owner 03'), ('SO04', 'Synthetic Owner 04'),
  ('SO05', 'Synthetic Owner 05'), ('SO06', 'Synthetic Owner 06'), ('SO07', 'Synthetic Owner 07'), ('SO08', 'Synthetic Owner 08'),
  ('SO09', 'Synthetic Owner 09'), ('SO10', 'Synthetic Owner 10'), ('SO11', 'Synthetic Owner 11');
insert into public.prospects (prospect_id, master_owner_id, full_name) values
  ('SP01', 'SO01', 'Synthetic Person 01'), ('SP02', 'SO02', 'Synthetic Person 02'), ('SP05', 'SO05', 'Synthetic Person 05');
insert into public.properties (property_id, master_owner_id, property_address_full, property_address_zip, market, units_count, property_address_state) values
  ('S01', 'SO01', '101 Example Rd', '00101', 'Synthetic Metro A, TX', 1, 'TX'),
  ('S02', 'SO02', '102 Example Rd', '00101', 'Synthetic Metro A, TX', 1, 'TX'),
  ('S03', 'SO03', '103 Example Rd', '00102', 'Synthetic Metro A, TX', 1, 'TX'),
  ('S04', 'SO04', '104 Example Rd', '00102', 'Synthetic Metro A, TX', 1, 'TX'),
  ('S05', 'SO05', '205 Example Ave', '00201', 'Synthetic Metro B, OK', 1, 'OK'),
  ('S06', 'SO06', '206 Example Ave', '00201', 'Synthetic Metro B, OK', 1, 'OK'),
  ('S07', 'SO07', '207 Example Ave', '00202', 'Synthetic Metro B, OK', 1, 'OK'),
  ('S08', 'SO08', '108 Example Rd', '00103', 'Synthetic Metro A, TX', 1, 'TX'),
  ('S09', 'SO09', '109 Example Rd', '00103', 'Synthetic Metro A, TX', 1, 'TX'),
  ('S10', 'SO10', '110 Example Rd', '00101', 'Synthetic Metro A, TX', 1, 'TX'),
  ('S11', 'SO11', '211 Example Ave', '00202', 'Synthetic Metro B, OK', 1, 'OK'),
  ('S12', 'SO01', '101 Example Rd ', '00101', 'Synthetic Metro A, TX', 1, 'TX');
insert into public.eg_property_facts (property_id, market, zip_code, property_address_state, conversation_stage, conversation_status, pipeline_stage, pipeline_status,
                                      sms_status, last_contact_at, last_contact_direction, estimated_value, equity_known_pct, distress_signal_count, tax_delinquent, owner_property_count) values
  ('S01', 'Synthetic Metro A, TX', '00101', 'TX', 'asking_price', 'active', 'negotiation', 'open', 'replied', now() - interval '3 days', 'inbound', 190000, 55, 1, false, 2),
  ('S02', 'Synthetic Metro A, TX', '00101', 'TX', 'offer_interest', 'active', 'new', 'open', 'replied', now() - interval '30 hours', 'inbound', 150000, 40, 0, false, 1),
  ('S03', 'Synthetic Metro A, TX', '00102', 'TX', 'ownership_confirmation', 'closed', 'dead', 'closed', 'opted_out', now() - interval '4 days', 'inbound', 120000, null, 0, false, 1),
  ('S04', 'Synthetic Metro A, TX', '00102', 'TX', null, 'closed', null, null, 'wrong_number', now() - interval '5 days', 'inbound', 130000, null, 0, false, 1),
  ('S05', 'Synthetic Metro B, OK', '00201', 'OK', 'offer', 'active', 'negotiation', 'open', 'replied', now() - interval '33 days', 'outbound', 240000, 60, 2, true, 1),
  ('S06', 'Synthetic Metro B, OK', '00201', 'OK', 'interested', 'active', 'new', 'open', 'replied', now() - interval '1 day', 'outbound', 175000, 35, 0, false, 1),
  ('S07', 'Synthetic Metro B, OK', '00202', 'OK', null, 'closed', null, null, 'replied', now() - interval '6 days', 'inbound', 160000, 20, 0, false, 1),
  ('S08', 'Synthetic Metro A, TX', '00103', 'TX', 'interested', 'active', 'new', 'open', 'replied', now() - interval '10 days', 'inbound', 145000, 45, 1, false, 1),
  ('S09', 'Synthetic Metro A, TX', '00103', 'TX', 'offer_interest', null, null, null, 'replied', now() - interval '500 days', 'inbound', 110000, null, 0, false, 1),
  ('S10', 'Synthetic Metro A, TX', '00101', 'TX', null, null, null, null, null, null, null, 135000, 70, 3, true, 1),
  ('S11', 'Synthetic Metro B, OK', '00202', 'OK', 'interested', null, 'new', 'open', 'sent', now() - interval '90 days', 'outbound', 155000, 30, 0, false, 1),
  ('S12', 'Synthetic Metro A, TX', '00101', 'TX', null, null, null, null, null, null, null, 185000, 50, 0, false, 2);

-- ------------------------------------------------------------------ 3. phones, graph, ownership ----
insert into public.phones (phone_id, master_owner_id, canonical_e164, phone_type, phone_contact_status, activity_status, wrong_number_at) values
  ('SPH01', 'SO01', '+15550100101', 'wireless', 'active', 'active', null),
  ('SPH02', 'SO02', '+15550100102', 'wireless', 'active', 'active', null),
  ('SPH03', 'SO03', '+15550100103', 'wireless', 'opted_out', 'active', null),
  ('SPH04', 'SO04', '+15550100104', 'wireless', 'wrong_number', 'active', now() - interval '5 days'),
  ('SPH05', 'SO05', '+15550100105', 'wireless', 'active', 'active', null),
  ('SPH06', 'SO06', '+15550100106', null, 'active', 'active', null),
  ('SPH07', 'SO07', '+15550100107', 'wireless', 'active', 'active', null),
  ('SPH08', 'SO08', '+15550100108', 'wireless', 'active', 'active', null),
  ('SPH09', 'SO09', '+15550100109', 'wireless', 'active', 'active', null),
  ('SPH10', 'SO10', '+15550100110', 'wireless', 'active', 'active', null);
insert into public.campaign_target_graph (graph_id, property_id, canonical_e164, market, state, sms_eligible) values
  ('sg01', 'S01', '+15550100101', 'Synthetic Metro A, TX', 'TX', true),  ('sg02', 'S02', '+15550100102', 'Synthetic Metro A, TX', 'TX', true),
  ('sg03', 'S03', '+15550100103', 'Synthetic Metro A, TX', 'TX', false), ('sg04', 'S04', '+15550100104', 'Synthetic Metro A, TX', 'TX', false),
  ('sg05', 'S05', '+15550100105', 'Synthetic Metro B, OK', 'OK', true),  ('sg06', 'S06', '+15550100106', 'Synthetic Metro B, OK', 'OK', true),
  ('sg07', 'S07', '+15550100107', 'Synthetic Metro B, OK', 'OK', true),  ('sg08', 'S08', '+15550100108', 'Synthetic Metro A, TX', 'TX', false),
  ('sg09', 'S09', '+15550100109', 'Synthetic Metro A, TX', 'TX', true),  ('sg10', 'S10', '+15550100110', 'Synthetic Metro A, TX', 'TX', true),
  ('sg12', 'S12', '+15550100101', 'Synthetic Metro A, TX', 'TX', true);
insert into public.contact_property_resolution (property_id, contact_phone_e164, master_owner_id, contact_property_role) values
  ('S01', '+15550100101', 'SO01', 'confirmed_owner'), ('S04', '+15550100104', 'SO04', 'not_owner'),
  ('S05', '+15550100105', 'SO05', 'confirmed_owner'), ('S06', '+15550100106', 'SO06', 'confirmed_owner'),
  ('S07', '+15550100107', 'SO07', 'confirmed_owner'), ('S08', '+15550100108', 'SO08', 'confirmed_owner'),
  ('S12', '+15550100101', 'SO01', 'unknown');
insert into public.sms_suppression_list (phone_e164, phone_number, is_active, suppression_type, suppression_reason) values
  ('+15550100103', '+15550100103', true, 'opt_out', 'synthetic: seller replied STOP'),
  ('+15550100108', '+15550100108', true, 'manual_dnc', 'synthetic: operator added');

-- ------------------------------------------------------------------ 4. threads ----
insert into public.inbox_thread_state (id, thread_key, canonical_e164, master_owner_id, prospect_id, property_id, market, status, is_suppressed, inbound_count, outbound_count,
                                       latest_direction, latest_message_at, last_inbound_at, last_outbound_at, lead_temperature, contactability_status, next_action, automation_state, our_number) values
  ('5e000000-0000-4000-8000-000000000101', '+15550100101', '+15550100101', 'SO01', 'SP01', 'S01', 'Synthetic Metro A, TX', 'active', false, 2, 2, 'inbound', now() - interval '3 days', now() - interval '3 days', now() - interval '6 days', 'hot', 'contactable', null, 'manual_review', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000102', '+15550100102', '+15550100102', 'SO02', 'SP02', 'S02', 'Synthetic Metro A, TX', 'active', false, 1, 1, 'inbound', now() - interval '30 hours', now() - interval '30 hours', now() - interval '4 days', 'warm', 'contactable', null, 'manual_review', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000103', '+15550100103', '+15550100103', 'SO03', null, 'S03', 'Synthetic Metro A, TX', 'closed', true, 1, 1, 'inbound', now() - interval '4 days', now() - interval '4 days', now() - interval '5 days', null, 'opted_out', null, 'stopped', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000104', '+15550100104', '+15550100104', 'SO04', null, 'S04', 'Synthetic Metro A, TX', 'closed', false, 1, 1, 'inbound', now() - interval '5 days', now() - interval '5 days', now() - interval '6 days', null, 'wrong_number', null, 'stopped', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000105', '+15550100105', '+15550100105', 'SO05', 'SP05', 'S05', 'Synthetic Metro B, OK', 'active', false, 1, 2, 'outbound', now() - interval '33 days', now() - interval '34 days', now() - interval '33 days', 'warm', 'contactable', 'follow_up_offer', 'manual_review', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000106', '+15550100106', '+15550100106', 'SO06', null, 'S06', 'Synthetic Metro B, OK', 'active', false, 1, 2, 'outbound', now() - interval '1 day', now() - interval '2 days', now() - interval '1 day', 'warm', 'contactable', 'callback', 'manual_review', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000107', '+15550100107', '+15550100107', 'SO07', null, 'S07', 'Synthetic Metro B, OK', 'closed', false, 1, 1, 'inbound', now() - interval '6 days', now() - interval '6 days', now() - interval '7 days', 'cold', 'contactable', null, 'stopped', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000108', '+15550100108', '+15550100108', 'SO08', null, 'S08', 'Synthetic Metro A, TX', 'active', false, 1, 1, 'inbound', now() - interval '10 days', now() - interval '10 days', now() - interval '12 days', null, 'contactable', null, 'manual_review', '+15550199999'),
  ('5e000000-0000-4000-8000-000000000109', '+15550100109', '+15550100109', 'SO09', null, 'S09', 'Synthetic Metro A, TX', 'active', false, 1, 1, 'inbound', now() - interval '500 days', now() - interval '500 days', now() - interval '501 days', null, 'contactable', null, 'manual_review', '+15550199999');

-- ------------------------------------------------------------------ 5. messages (invented) ----
insert into public.message_events (id, message_event_key, direction, event_type, message_body, thread_key, property_id, from_phone_number, to_phone_number, metadata,
                                   created_at, event_timestamp, received_at, sent_at, delivered_at, delivery_status, is_opt_out, detected_intent, language) values
  ('5e000000-0000-4000-8000-00000000a011', 'synth:t01:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Rd?', '+15550100101', 'S01', '+15550199999', '+15550100101', '{"message_origin":"campaign"}', now() - interval '8 days', now() - interval '8 days', null, now() - interval '8 days', now() - interval '8 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a012', 'synth:t01:i1', 'inbound', 'sms', 'Yes I own it. I would consider selling.', '+15550100101', 'S01', '+15550100101', '+15550199999', '{}', now() - interval '7 days', now() - interval '7 days', now() - interval '7 days', null, null, null, false, 'interested', 'en'),
  ('5e000000-0000-4000-8000-00000000a013', 'synth:t01:o2', 'outbound', 'sms', 'Thanks! What price would work for you, and when would you like to sell?', '+15550100101', 'S01', '+15550199999', '+15550100101', '{"message_origin":"operator"}', now() - interval '6 days', now() - interval '6 days', null, now() - interval '6 days', now() - interval '6 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a014', 'synth:t01:i2', 'inbound', 'sms', 'I would take $165,000 if we can close by the end of the year.', '+15550100101', 'S01', '+15550100101', '+15550199999', '{}', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', null, null, null, false, 'price_given', 'en'),
  ('5e000000-0000-4000-8000-00000000a021', 'synth:t02:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Rd?', '+15550100102', 'S02', '+15550199999', '+15550100102', '{"message_origin":"campaign"}', now() - interval '4 days', now() - interval '4 days', null, now() - interval '4 days', now() - interval '4 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a022', 'synth:t02:i1', 'inbound', 'sms', 'What would you offer for it?', '+15550100102', 'S02', '+15550100102', '+15550199999', '{}', now() - interval '30 hours', now() - interval '30 hours', now() - interval '30 hours', null, null, null, false, 'offer_request', 'en'),
  ('5e000000-0000-4000-8000-00000000a031', 'synth:t03:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Rd?', '+15550100103', 'S03', '+15550199999', '+15550100103', '{"message_origin":"campaign"}', now() - interval '5 days', now() - interval '5 days', null, now() - interval '5 days', now() - interval '5 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a032', 'synth:t03:i1', 'inbound', 'sms', 'STOP', '+15550100103', 'S03', '+15550100103', '+15550199999', '{}', now() - interval '4 days', now() - interval '4 days', now() - interval '4 days', null, null, null, true, 'opt_out', 'en'),
  ('5e000000-0000-4000-8000-00000000a041', 'synth:t04:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Rd?', '+15550100104', 'S04', '+15550199999', '+15550100104', '{"message_origin":"campaign"}', now() - interval '6 days', now() - interval '6 days', null, now() - interval '6 days', now() - interval '6 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a042', 'synth:t04:i1', 'inbound', 'sms', 'Wrong number, I do not own that property.', '+15550100104', 'S04', '+15550100104', '+15550199999', '{}', now() - interval '5 days', now() - interval '5 days', now() - interval '5 days', null, null, null, false, 'wrong_number', 'en'),
  ('5e000000-0000-4000-8000-00000000a051', 'synth:t05:o1', 'outbound', 'sms', 'We could offer $180,000 cash for the house on Example Ave.', '+15550100105', 'S05', '+15550199999', '+15550100105', '{"message_origin":"operator"}', now() - interval '35 days', now() - interval '35 days', null, now() - interval '35 days', now() - interval '35 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a052', 'synth:t05:i1', 'inbound', 'sms', 'I would need at least $210,000 for it.', '+15550100105', 'S05', '+15550100105', '+15550199999', '{}', now() - interval '34 days', now() - interval '34 days', now() - interval '34 days', null, null, null, false, 'counter_offer', 'en'),
  ('5e000000-0000-4000-8000-00000000a053', 'synth:t05:o2', 'outbound', 'sms', 'Understood, let me check with my team and get back to you.', '+15550100105', 'S05', '+15550199999', '+15550100105', '{"message_origin":"operator"}', now() - interval '33 days', now() - interval '33 days', null, now() - interval '33 days', now() - interval '33 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a061', 'synth:t06:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Ave?', '+15550100106', 'S06', '+15550199999', '+15550100106', '{"message_origin":"campaign"}', now() - interval '4 days', now() - interval '4 days', null, now() - interval '4 days', now() - interval '4 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a062', 'synth:t06:i1', 'inbound', 'sms', 'Call me back next week, I am busy right now.', '+15550100106', 'S06', '+15550100106', '+15550199999', '{}', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', null, null, null, false, 'callback_request', 'en'),
  ('5e000000-0000-4000-8000-00000000a063', 'synth:t06:o2', 'outbound', 'sms', 'Will do, talk next week.', '+15550100106', 'S06', '+15550199999', '+15550100106', '{"message_origin":"operator"}', now() - interval '1 day', now() - interval '1 day', null, now() - interval '1 day', now() - interval '1 day', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a071', 'synth:t07:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Ave?', '+15550100107', 'S07', '+15550199999', '+15550100107', '{"message_origin":"campaign"}', now() - interval '7 days', now() - interval '7 days', null, now() - interval '7 days', now() - interval '7 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a072', 'synth:t07:i1', 'inbound', 'sms', 'Not interested.', '+15550100107', 'S07', '+15550100107', '+15550199999', '{}', now() - interval '6 days', now() - interval '6 days', now() - interval '6 days', null, null, null, false, 'not_interested', 'en'),
  ('5e000000-0000-4000-8000-00000000a081', 'synth:t08:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Rd?', '+15550100108', 'S08', '+15550199999', '+15550100108', '{"message_origin":"campaign"}', now() - interval '12 days', now() - interval '12 days', null, now() - interval '12 days', now() - interval '12 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a082', 'synth:t08:i1', 'inbound', 'sms', 'Maybe in the spring. What is your best price?', '+15550100108', 'S08', '+15550100108', '+15550199999', '{}', now() - interval '10 days', now() - interval '10 days', now() - interval '10 days', null, null, null, false, 'offer_request', 'en'),
  ('5e000000-0000-4000-8000-00000000a091', 'synth:t09:o1', 'outbound', 'sms', 'Hi, this is Synthetic Homes. Are you the owner of the house on Example Rd?', '+15550100109', 'S09', '+15550199999', '+15550100109', '{"message_origin":"campaign"}', now() - interval '501 days', now() - interval '501 days', null, now() - interval '501 days', now() - interval '501 days', 'delivered', false, null, 'en'),
  ('5e000000-0000-4000-8000-00000000a092', 'synth:t09:i1', 'inbound', 'sms', 'Make me an offer.', '+15550100109', 'S09', '+15550100109', '+15550199999', '{}', now() - interval '500 days', now() - interval '500 days', now() - interval '500 days', null, null, null, false, 'offer_request', 'en');

-- ------------------------------------------------------------------ 6. pipeline: opportunities, offers, scores, follow-up, hold ----
insert into public.acquisition_opportunities (id, dedupe_key, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, temperature, asking_price, current_offer,
                                              next_action, market, last_activity_at, last_contact_at, master_owner_id) values
  ('5e000000-0000-4000-8000-0000000000c1', 'synth:opp:s01', 'S01', '+15550100101', 'negotiation', 'open', 'hot', 165000, null, null, 'Synthetic Metro A, TX', now() - interval '3 days', now() - interval '3 days', 'SO01'),
  ('5e000000-0000-4000-8000-0000000000c2', 'synth:opp:s02', 'S02', '+15550100102', 'new', 'open', 'warm', null, null, null, 'Synthetic Metro A, TX', now() - interval '30 hours', now() - interval '30 hours', 'SO02'),
  ('5e000000-0000-4000-8000-0000000000c5', 'synth:opp:s05', 'S05', '+15550100105', 'offer_sent', 'open', 'warm', 210000, 180000, 'follow_up_offer', 'Synthetic Metro B, OK', now() - interval '33 days', now() - interval '33 days', 'SO05');
insert into public.seller_offers (offer_id, opportunity_id, thread_key, property_id, master_owner_id, offer_version, offer_type, direction, purchase_price, status, created_at, sent_at, source_message_event_id) values
  ('synth-offer-s05-1', '5e000000-0000-4000-8000-0000000000c5', '+15550100105', 'S05', 'SO05', 1, 'cash', 'outbound', 180000, 'superseded', now() - interval '35 days', now() - interval '35 days', null),
  ('synth-offer-s05-2', '5e000000-0000-4000-8000-0000000000c5', '+15550100105', 'S05', 'SO05', 2, 'counter', 'inbound', 210000, 'active', now() - interval '34 days', null, '5e000000-0000-4000-8000-00000000a052');
insert into public.property_acquisition_scores (property_id, decision_tier, valuation_mid, computed_at) values
  ('S01', 'A', 195000, now() - interval '5 days'), ('S05', 'B', 235000, now() - interval '45 days');
insert into public.followup_intents (intent_key, thread_key, property_id, master_owner_id, kind, intent, use_case, due_at, state, writer) values
  ('synth:t06:callback', '+15550100106', 'S06', 'SO06', 'callback', 'seller_requested_callback', 'seller_callback', now() + interval '5 days', 'planned', 'synthetic');
insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, property_id, blocked_capabilities, reason, set_by, approval_ref) values
  ('synth:hold:t05', 'operator_hold', '+15550100105', '5e000000-0000-4000-8000-000000000105', 'S05', array['ai_action', 'auto_reply'], 'synthetic: operator review of the counteroffer', 'synthetic', 'synthetic-approval');

-- ------------------------------------------------------------------ 7. switches as production is expected to hold them ----
insert into public.system_control (key, value) values ('ai_conversation_send_enabled', 'false') on conflict (key) do update set value = excluded.value;

commit;
