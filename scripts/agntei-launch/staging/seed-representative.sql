-- Representative, INVENTED records for the staging rehearsal (scripts/agntei-launch/staging-rehearsal.mjs seed).
-- Phone numbers are in the fictional 555-01xx range, people and addresses are made up, nothing comes from production.
-- Idempotent: fixed ids, ON CONFLICT DO NOTHING. Switches that could send anything stay OFF.
set local client_min_messages = warning;

-- the org and its owner (the same user the launch verified in production; here it is just a row in a staging database)
insert into agent.org (org_id, name) values ('00000000-0000-4000-8000-00000000a001', 'staging rehearsal org') on conflict do nothing;
insert into agent.operator_membership (org_id, user_id, role, added_by)
values ('00000000-0000-4000-8000-00000000a001', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6', 'owner', 'staging-seed')
on conflict do nothing;

-- switches: nothing sends; the gateway may run
insert into public.system_control (key, value) values
  ('ai_conversation_send_enabled', 'false'),
  ('action_gateway_enabled', 'true'),
  ('action_gateway_tiers', 'T1,T2')
on conflict (key) do update set value = excluded.value, updated_at = now();

insert into public.master_owners (master_owner_id, display_name) values
  ('mo_seed_1', 'Pat Example'), ('mo_seed_2', 'Sam Sample'), ('mo_seed_3', 'Lee Placeholder'), ('mo_seed_4', 'Dana Optout'), ('mo_seed_5', 'Robin Longago')
on conflict do nothing;

insert into public.prospects (prospect_id, master_owner_id, full_name, first_name, timezone) values
  ('pr_seed_1', 'mo_seed_1', 'Pat Example', 'Pat', 'America/Chicago'),
  ('pr_seed_2', 'mo_seed_2', 'Sam Sample', 'Sam', 'America/Chicago'),
  ('pr_seed_3', 'mo_seed_3', 'Lee Placeholder', 'Lee', 'America/Chicago'),
  ('pr_seed_4', 'mo_seed_4', 'Dana Optout', 'Dana', 'America/Chicago'),
  ('pr_seed_5', 'mo_seed_5', 'Robin Longago', 'Robin', 'America/Chicago')
on conflict do nothing;

insert into public.phones (phone_id, master_owner_id, canonical_e164, phone, phone_raw, phone_contact_status, wrong_number_at, primary_prospect_id, canonical_prospect_id, activity_status) values
  ('ph_seed_1', 'mo_seed_1', '+18175550101', '+18175550101', '(817) 555-0101', 'active', null, 'pr_seed_1', 'pr_seed_1', 'active'),
  ('ph_seed_2', 'mo_seed_2', '+18175550102', '+18175550102', '(817) 555-0102', 'active', null, 'pr_seed_2', 'pr_seed_2', 'active'),
  ('ph_seed_3', 'mo_seed_3', '+18175550103', '+18175550103', '(817) 555-0103', 'wrong_number', now() - interval '30 days', 'pr_seed_3', 'pr_seed_3', 'inactive'),
  ('ph_seed_4', 'mo_seed_4', '+18175550104', '+18175550104', '(817) 555-0104', 'opted_out', null, 'pr_seed_4', 'pr_seed_4', 'inactive'),
  ('ph_seed_5', 'mo_seed_5', '+18175550105', '+18175550105', '(817) 555-0105', 'active', null, 'pr_seed_5', 'pr_seed_5', 'dormant')
on conflict do nothing;

insert into public.properties (property_id, master_owner_id, property_address_full, property_address, property_address_city, property_address_state, property_address_zip, market, timezone, owner_name, owner_1_name, estimated_value, arv_estimate, property_type, beds, baths, sqft, year_built) values
  ('prop_seed_1', 'mo_seed_1', '100 Main St, Fort Worth, TX 76106', '100 Main St', 'Fort Worth', 'TX', '76106', 'Fort Worth, TX', 'America/Chicago', 'Pat Example', 'Pat Example', 150000, 210000, 'SFR', 3, 2, 1450, 1962),
  ('prop_seed_2', 'mo_seed_2', '200 Oak Ave, Fort Worth, TX 76110', '200 Oak Ave', 'Fort Worth', 'TX', '76110', 'Fort Worth, TX', 'America/Chicago', 'Sam Sample', 'Sam Sample', 120000, 175000, 'SFR', 2, 1, 1100, 1955),
  ('prop_seed_3', 'mo_seed_3', '300 Pine Rd, Arlington, TX 76010', '300 Pine Rd', 'Arlington', 'TX', '76010', 'Fort Worth, TX', 'America/Chicago', 'Lee Placeholder', 'Lee Placeholder', 98000, 140000, 'SFR', 3, 1, 1200, 1971),
  ('prop_seed_4', 'mo_seed_4', '400 Elm Ct, Dallas, TX 75216', '400 Elm Ct', 'Dallas', 'TX', '75216', 'Dallas, TX', 'America/Chicago', 'Dana Optout', 'Dana Optout', 110000, 160000, 'SFR', 3, 2, 1300, 1968),
  ('prop_seed_5', 'mo_seed_5', '500 Cedar Ln, Dallas, TX 75227', '500 Cedar Ln', 'Dallas', 'TX', '75227', 'Dallas, TX', 'America/Chicago', 'Robin Longago', 'Robin Longago', 90000, 130000, 'SFR', 2, 1, 950, 1950)
on conflict do nothing;

insert into public.eg_property_facts (property_id, market, zip_code) values
  ('prop_seed_1', 'Fort Worth, TX', '76106'), ('prop_seed_2', 'Fort Worth, TX', '76110'), ('prop_seed_3', 'Fort Worth, TX', '76010'), ('prop_seed_4', 'Dallas, TX', '75216'), ('prop_seed_5', 'Dallas, TX', '75227')
on conflict do nothing;

insert into public.property_acquisition_scores (id, property_id, valuation_mid, investor_ceiling_mid, recommended_cash_offer, minimum_acceptable_offer, computed_at, decision_tier, comp_count) values
  ('11111111-0000-4000-8000-000000000001', 'prop_seed_1', 150000, 105000, 92000, 85000, now() - interval '5 days', 'pursue', 6),
  ('11111111-0000-4000-8000-000000000002', 'prop_seed_2', 120000, 84000, 74000, 68000, now() - interval '12 days', 'pursue', 5),
  ('11111111-0000-4000-8000-000000000003', 'prop_seed_3', 98000, 68000, 60000, 55000, now() - interval '40 days', 'review', 4)
on conflict do nothing;

insert into public.contact_property_resolution (id, property_id, contact_phone_e164, master_owner_id, prospect_id, contact_property_role, contact_origin) values
  ('22222222-0000-4000-8000-000000000001', 'prop_seed_1', '+18175550101', 'mo_seed_1', 'pr_seed_1', 'confirmed_owner', 'staging-seed'),
  ('22222222-0000-4000-8000-000000000002', 'prop_seed_2', '+18175550102', 'mo_seed_2', 'pr_seed_2', 'confirmed_owner', 'staging-seed'),
  ('22222222-0000-4000-8000-000000000003', 'prop_seed_3', '+18175550103', 'mo_seed_3', 'pr_seed_3', 'confirmed_owner', 'staging-seed'),
  ('22222222-0000-4000-8000-000000000004', 'prop_seed_4', '+18175550104', 'mo_seed_4', 'pr_seed_4', 'confirmed_owner', 'staging-seed'),
  ('22222222-0000-4000-8000-000000000005', 'prop_seed_5', '+18175550105', 'mo_seed_5', 'pr_seed_5', 'confirmed_owner', 'staging-seed')
on conflict do nothing;

insert into public.textgrid_numbers (id, phone_number, status, health_state, market) values
  ('33333333-0000-4000-8000-000000000001', '+18175550100', 'active', 'healthy', 'Fort Worth, TX')
on conflict do nothing;

-- five conversations: an active negotiation, an overlooked reply, a wrong number, an opt-out, and one 400 days old
insert into public.inbox_thread_state (id, thread_key, canonical_e164, master_owner_id, prospect_id, property_id, market, stage, status, inbound_count, outbound_count, latest_direction, latest_message_at, last_inbound_at, last_outbound_at, lead_temperature, temperature, our_number, lifecycle_stage, disposition, is_suppressed, conversation_status) values
  ('44444444-0000-4000-8000-000000000001', '+18175550101', '+18175550101', 'mo_seed_1', 'pr_seed_1', 'prop_seed_1', 'Fort Worth, TX', 'offer', 'active', 3, 4, 'inbound', now() - interval '2 days', now() - interval '2 days', now() - interval '3 days', 'hot', 'hot', '+18175550100', 'negotiation', null, false, 'open'),
  ('44444444-0000-4000-8000-000000000002', '+18175550102', '+18175550102', 'mo_seed_2', 'pr_seed_2', 'prop_seed_2', 'Fort Worth, TX', 'ownership_check', 'active', 1, 1, 'inbound', now() - interval '11 days', now() - interval '11 days', now() - interval '12 days', 'warm', 'warm', '+18175550100', 'qualification', null, false, 'open'),
  ('44444444-0000-4000-8000-000000000003', '+18175550103', '+18175550103', 'mo_seed_3', 'pr_seed_3', 'prop_seed_3', 'Fort Worth, TX', 'closed', 'closed', 1, 1, 'inbound', now() - interval '30 days', now() - interval '30 days', now() - interval '31 days', 'cold', 'cold', '+18175550100', 'closed', 'wrong_number', true, 'closed'),
  ('44444444-0000-4000-8000-000000000004', '+18175550104', '+18175550104', 'mo_seed_4', 'pr_seed_4', 'prop_seed_4', 'Dallas, TX', 'closed', 'closed', 1, 1, 'inbound', now() - interval '45 days', now() - interval '45 days', now() - interval '46 days', 'cold', 'cold', '+18175550100', 'closed', 'opted_out', true, 'closed'),
  ('44444444-0000-4000-8000-000000000005', '+18175550105', '+18175550105', 'mo_seed_5', 'pr_seed_5', 'prop_seed_5', 'Dallas, TX', 'asking_price', 'active', 2, 2, 'inbound', now() - interval '400 days', now() - interval '400 days', now() - interval '401 days', 'cold', 'cold', '+18175550100', 'qualification', null, false, 'open')
on conflict do nothing;

insert into public.message_events (id, message_event_key, direction, event_type, message_body, thread_key, created_at, event_timestamp, sent_at, received_at, delivered_at, detected_intent, is_opt_out, delivery_status, from_phone_number, to_phone_number, property_id, prospect_id) values
  -- T1: ownership confirmed, offer sent 3 days ago, "too low" 2 days ago
  ('55555555-0000-4000-8000-000000000011', 'seed-t1-1', 'outbound', 'message', 'Hi Pat, this is Alex. Came across 100 Main St, are you still the owner?', '+18175550101', now() - interval '9 days', now() - interval '9 days', now() - interval '9 days', null, now() - interval '9 days', null, false, 'delivered', '+18175550100', '+18175550101', 'prop_seed_1', 'pr_seed_1'),
  ('55555555-0000-4000-8000-000000000012', 'seed-t1-2', 'inbound', 'message', 'Yes I still own it', '+18175550101', now() - interval '8 days', now() - interval '8 days', null, now() - interval '8 days', null, 'ownership_confirmed', false, 'received', '+18175550101', '+18175550100', 'prop_seed_1', 'pr_seed_1'),
  ('55555555-0000-4000-8000-000000000013', 'seed-t1-3', 'outbound', 'message', 'Would you consider selling 100 Main St if the terms worked for you?', '+18175550101', now() - interval '7 days', now() - interval '7 days', now() - interval '7 days', null, now() - interval '7 days', null, false, 'delivered', '+18175550100', '+18175550101', 'prop_seed_1', 'pr_seed_1'),
  ('55555555-0000-4000-8000-000000000014', 'seed-t1-4', 'inbound', 'message', 'Maybe, what are you thinking?', '+18175550101', now() - interval '6 days', now() - interval '6 days', null, now() - interval '6 days', null, 'asks_offer', false, 'received', '+18175550101', '+18175550100', 'prop_seed_1', 'pr_seed_1'),
  ('55555555-0000-4000-8000-000000000015', 'seed-t1-5', 'outbound', 'message', 'We can offer $90,000 cash for 100 Main St and close in 30 days. Does that work for you?', '+18175550101', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', null, now() - interval '3 days', null, false, 'delivered', '+18175550100', '+18175550101', 'prop_seed_1', 'pr_seed_1'),
  ('55555555-0000-4000-8000-000000000016', 'seed-t1-6', 'inbound', 'message', 'That is too low, I would need at least 110', '+18175550101', now() - interval '2 days', now() - interval '2 days', null, now() - interval '2 days', null, 'need_more_money', false, 'received', '+18175550101', '+18175550100', 'prop_seed_1', 'pr_seed_1'),
  -- T2: the overlooked reply (ownership question 12 days ago, answered 11 days ago, nobody replied)
  ('55555555-0000-4000-8000-000000000021', 'seed-t2-1', 'outbound', 'message', 'Hi Sam, this is Alex. Do you still own 200 Oak Ave?', '+18175550102', now() - interval '12 days', now() - interval '12 days', now() - interval '12 days', null, now() - interval '12 days', null, false, 'delivered', '+18175550100', '+18175550102', 'prop_seed_2', 'pr_seed_2'),
  ('55555555-0000-4000-8000-000000000022', 'seed-t2-2', 'inbound', 'message', 'Yes. The roof needs work though, is that a problem?', '+18175550102', now() - interval '11 days', now() - interval '11 days', null, now() - interval '11 days', null, 'ownership_confirmed', false, 'received', '+18175550102', '+18175550100', 'prop_seed_2', 'pr_seed_2'),
  -- T3: wrong number
  ('55555555-0000-4000-8000-000000000031', 'seed-t3-1', 'outbound', 'message', 'Hi Lee, this is Alex. Are you still the owner of 300 Pine Rd?', '+18175550103', now() - interval '31 days', now() - interval '31 days', now() - interval '31 days', null, now() - interval '31 days', null, false, 'delivered', '+18175550100', '+18175550103', 'prop_seed_3', 'pr_seed_3'),
  ('55555555-0000-4000-8000-000000000032', 'seed-t3-2', 'inbound', 'message', 'wrong number', '+18175550103', now() - interval '30 days', now() - interval '30 days', null, now() - interval '30 days', null, 'wrong_number', false, 'received', '+18175550103', '+18175550100', 'prop_seed_3', 'pr_seed_3'),
  -- T4: opt-out
  ('55555555-0000-4000-8000-000000000041', 'seed-t4-1', 'outbound', 'message', 'Hi Dana, this is Alex. Do you still own 400 Elm Ct?', '+18175550104', now() - interval '46 days', now() - interval '46 days', now() - interval '46 days', null, now() - interval '46 days', null, false, 'delivered', '+18175550100', '+18175550104', 'prop_seed_4', 'pr_seed_4'),
  ('55555555-0000-4000-8000-000000000042', 'seed-t4-2', 'inbound', 'message', 'STOP', '+18175550104', now() - interval '45 days', now() - interval '45 days', null, now() - interval '45 days', null, 'opt_out', true, 'received', '+18175550104', '+18175550100', 'prop_seed_4', 'pr_seed_4'),
  -- T5: a conversation 400 days old (must be resumed as old, never as live)
  ('55555555-0000-4000-8000-000000000051', 'seed-t5-1', 'outbound', 'message', 'Hi Robin, this is Alex. Do you have a price in mind for 500 Cedar Ln?', '+18175550105', now() - interval '401 days', now() - interval '401 days', now() - interval '401 days', null, now() - interval '401 days', null, false, 'delivered', '+18175550100', '+18175550105', 'prop_seed_5', 'pr_seed_5'),
  ('55555555-0000-4000-8000-000000000052', 'seed-t5-2', 'inbound', 'message', 'Around 95', '+18175550105', now() - interval '400 days', now() - interval '400 days', null, now() - interval '400 days', null, 'asking_price', false, 'received', '+18175550105', '+18175550100', 'prop_seed_5', 'pr_seed_5')
on conflict do nothing;

-- the send queue: what went out (sent, delivered), one scheduled follow-up (queued, nothing sends it here), one failure
insert into public.send_queue (id, queue_key, queue_status, scheduled_for, message_body, to_phone_number, from_phone_number, thread_key, property_id, prospect_id, master_owner_id, message_type, sent_at, delivered_at, failed_reason, created_at, updated_at) values
  ('66666666-0000-4000-8000-000000000001', 'seed-q-1', 'sent', now() - interval '9 days', 'Hi Pat, this is Alex. Came across 100 Main St, are you still the owner?', '+18175550101', '+18175550100', '+18175550101', 'prop_seed_1', 'pr_seed_1', 'mo_seed_1', 'ownership_check', now() - interval '9 days', now() - interval '9 days', null, now() - interval '9 days', now() - interval '9 days'),
  ('66666666-0000-4000-8000-000000000002', 'seed-q-2', 'sent', now() - interval '3 days', 'We can offer $90,000 cash for 100 Main St and close in 30 days. Does that work for you?', '+18175550101', '+18175550100', '+18175550101', 'prop_seed_1', 'pr_seed_1', 'mo_seed_1', 'offer', now() - interval '3 days', now() - interval '3 days', null, now() - interval '3 days', now() - interval '3 days'),
  ('66666666-0000-4000-8000-000000000003', 'seed-q-3', 'sent', now() - interval '12 days', 'Hi Sam, this is Alex. Do you still own 200 Oak Ave?', '+18175550102', '+18175550100', '+18175550102', 'prop_seed_2', 'pr_seed_2', 'mo_seed_2', 'ownership_check', now() - interval '12 days', now() - interval '12 days', null, now() - interval '12 days', now() - interval '12 days'),
  ('66666666-0000-4000-8000-000000000004', 'seed-q-4', 'queued', now() + interval '1 day', 'Thanks Sam. Would you consider selling 200 Oak Ave if the terms worked for you?', '+18175550102', '+18175550100', '+18175550102', 'prop_seed_2', 'pr_seed_2', 'mo_seed_2', 'consider_selling', null, null, null, now() - interval '1 hour', now() - interval '1 hour'),
  ('66666666-0000-4000-8000-000000000005', 'seed-q-5', 'failed', now() - interval '20 days', 'Hi Lee, this is Alex. Are you still the owner of 300 Pine Rd?', '+18175550103', '+18175550100', '+18175550103', 'prop_seed_3', 'pr_seed_3', 'mo_seed_3', 'ownership_check', null, null, 'carrier rejected: 30007', now() - interval '20 days', now() - interval '20 days')
on conflict do nothing;

insert into public.sms_suppression_list (id, phone_e164, phone_number, is_active, suppression_type, suppression_reason, sender_phone_e164) values
  ('77777777-0000-4000-8000-000000000001', '+18175550104', '+18175550104', true, 'opt_out', 'STOP', null),
  ('77777777-0000-4000-8000-000000000002', '+18175550103', '+18175550103', true, 'wrong_number', 'seller said wrong number', null)
on conflict do nothing;

insert into public.campaigns (id, name, status, created_at, built_at, activated_at, completed_at, daily_cap, total_cap, market, contact_window_start, contact_window_end, send_interval_seconds) values
  ('88888888-0000-4000-8000-000000000001', 'Fort Worth ownership check (seed)', 'completed', now() - interval '14 days', now() - interval '14 days', now() - interval '13 days', now() - interval '9 days', 50, 200, 'Fort Worth, TX', '09:00', '19:00', 30),
  ('88888888-0000-4000-8000-000000000002', 'Oak Ave follow-up (seed)', 'paused', now() - interval '2 days', now() - interval '2 days', null, null, 20, 50, 'Fort Worth, TX', '09:00', '19:00', 30)
on conflict do nothing;

insert into public.campaign_targets (id, campaign_id, property_id, target_status) values
  ('99999999-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', 'prop_seed_1', 'sent'),
  ('99999999-0000-4000-8000-000000000002', '88888888-0000-4000-8000-000000000001', 'prop_seed_2', 'sent'),
  ('99999999-0000-4000-8000-000000000003', '88888888-0000-4000-8000-000000000001', 'prop_seed_3', 'failed'),
  ('99999999-0000-4000-8000-000000000004', '88888888-0000-4000-8000-000000000002', 'prop_seed_2', 'paused')
on conflict do nothing;

insert into public.campaign_target_graph (graph_id, property_id, canonical_e164, market, state, sms_eligible, true_post_contact_suppression, wrong_number, sender_covered, queue_eligible, queue_block_reason) values
  ('g_seed_1', 'prop_seed_1', '+18175550101', 'Fort Worth, TX', 'TX', true, false, false, true, true, null),
  ('g_seed_2', 'prop_seed_2', '+18175550102', 'Fort Worth, TX', 'TX', true, false, false, true, true, null),
  ('g_seed_3', 'prop_seed_3', '+18175550103', 'Fort Worth, TX', 'TX', false, false, true, true, false, 'wrong_number'),
  ('g_seed_4', 'prop_seed_4', '+18175550104', 'Dallas, TX', 'TX', false, true, false, true, false, 'opt_out'),
  ('g_seed_5', 'prop_seed_5', '+18175550105', 'Dallas, TX', 'TX', true, false, false, true, true, null)
on conflict do nothing;

insert into public.seller_offers (id, offer_id, thread_key, purchase_price, status, created_at, sent_at, property_id, master_owner_id, offer_version, offer_type, direction, recommended_offer, strategy, send_queue_row_id, source_message_event_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'offer_seed_1', '+18175550101', 90000, 'sent', now() - interval '3 days', now() - interval '3 days', 'prop_seed_1', 'mo_seed_1', 1, 'cash', 'outbound', 92000, 'cash_close_30', '66666666-0000-4000-8000-000000000002', '55555555-0000-4000-8000-000000000015')
on conflict do nothing;

insert into public.acquisition_opportunities (id, dedupe_key, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, priority, temperature, estimated_value, arv, asking_price, current_offer, next_action, next_action_due, latest_intent, market, stage_entered_at, last_activity_at, last_contact_at, master_owner_id, active_offer_id) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'seed-opp-1', 'prop_seed_1', '+18175550101', 'offer', 'active', 'high', 'hot', 150000, 210000, 110000, 90000, 'answer the counter at 110', now() + interval '1 day', 'need_more_money', 'Fort Worth, TX', now() - interval '3 days', now() - interval '2 days', now() - interval '2 days', 'mo_seed_1', 'offer_seed_1'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'seed-opp-2', 'prop_seed_2', '+18175550102', 'ownership_check', 'active', 'medium', 'warm', 120000, 175000, null, null, 'reply to the roof question', now() - interval '10 days', 'ownership_confirmed', 'Fort Worth, TX', now() - interval '12 days', now() - interval '11 days', now() - interval '11 days', 'mo_seed_2', null),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'seed-opp-3', 'prop_seed_5', '+18175550105', 'asking_price', 'stale', 'low', 'cold', 90000, 130000, 95000, null, 'old conversation: resume as old', null, 'asking_price', 'Dallas, TX', now() - interval '401 days', now() - interval '400 days', now() - interval '400 days', 'mo_seed_5', null)
on conflict do nothing;
