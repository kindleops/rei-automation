-- DISPOSABLE EMULATION for the corpus census tests (scripts/db/run-migration-test.mjs --id lc_mcp_corpus_census and
-- test/census-pg-e2e.test.mjs). Applied AFTER lc_mcp_reader_supabase_emulation.sql, the 1.0 reader, the 1.1
-- conversation emulation and the 1.1 apply. Synthetic rows only (FIXTURE). It widens the emulated read model with
-- the screening columns the census reads through to_jsonb() (absent in the base emulation on purpose: the
-- functions must tolerate their absence) and seeds a small corpus with known answers:
--   leads P1..P6 (facts); properties P1, P4, P5, P6 (+ P7, a second property of owner O4 at P4's address);
--   P1 in conversation (unanswered seller message, score), P2 opted out, P3 interest label but stale,
--   P4 needs_review unresolved, P5 distress + equity + eligible phone, never contacted, P6 another market.
alter table public.eg_property_facts
  add column if not exists conversation_status text, add column if not exists deal_id text,
  add column if not exists last_contact_at timestamptz, add column if not exists last_contact_direction text,
  add column if not exists estimated_value numeric, add column if not exists equity_known_pct numeric, add column if not exists equity_class text,
  add column if not exists distress_signal_count numeric, add column if not exists tax_delinquent boolean, add column if not exists active_lien boolean,
  add column if not exists rec_has_probate boolean, add column if not exists is_hot_preforeclosure boolean,
  add column if not exists owner_property_count numeric, add column if not exists owner_type_guess text, add column if not exists out_of_state_owner boolean,
  add column if not exists campaign_count numeric, add column if not exists contact_candidate_phones numeric,
  add column if not exists property_type text, add column if not exists asset_type text, add column if not exists units_count numeric,
  add column if not exists year_built numeric, add column if not exists building_square_feet numeric;
alter table public.acquisition_opportunities add column if not exists opportunity_status text, add column if not exists acquisition_stage text;

insert into public.properties (property_id, master_owner_id, property_address_full, property_address_zip, latitude, longitude, market, units_count) values
  ('P7', 'O4', '4 Fixture St ', '75001', 32.9, -96.8, 'Fixture Metro, TX', 1);
update public.properties set master_owner_id = 'O4' where property_id = 'P4';

update public.eg_property_facts set property_type = 'Single Family', asset_type = 'sfr', units_count = 1, year_built = 1978, building_square_feet = 1400, estimated_value = 180000,
  equity_known_pct = 66, equity_class = 'high', distress_signal_count = 3, tax_delinquent = true, active_lien = false, rec_has_probate = false, is_hot_preforeclosure = false,
  owner_property_count = 1, owner_type_guess = 'individual', out_of_state_owner = false, campaign_count = 1, contact_candidate_phones = 1,
  last_contact_at = now() - interval '2 hours', last_contact_direction = 'inbound', deal_id = 'deal-p1'
  where property_id = 'P1';
update public.eg_property_facts set estimated_value = 150000, equity_known_pct = 20, equity_class = 'low', distress_signal_count = 0, tax_delinquent = false,
  last_contact_at = now() - interval '3 days', last_contact_direction = 'inbound', campaign_count = 1, contact_candidate_phones = 1, sms_status = 'opted_out'
  where property_id = 'P2';
update public.eg_property_facts set estimated_value = 210000, equity_known_pct = 45, equity_class = 'medium', distress_signal_count = 1, tax_delinquent = false,
  last_contact_at = now() - interval '45 days', last_contact_direction = 'outbound', campaign_count = 2, contact_candidate_phones = 0
  where property_id = 'P3';
update public.eg_property_facts set conversation_stage = 'ownership_confirmation', conversation_status = 'needs_review', estimated_value = null, equity_known_pct = null,
  distress_signal_count = 2, tax_delinquent = false, rec_has_probate = true, owner_property_count = 2, last_contact_at = now() - interval '20 days', last_contact_direction = 'outbound',
  campaign_count = 1, contact_candidate_phones = 1
  where property_id = 'P4';
update public.eg_property_facts set estimated_value = 160000, equity_known_pct = 40, equity_class = 'medium', distress_signal_count = 2, tax_delinquent = true, is_hot_preforeclosure = true,
  owner_property_count = 1, last_contact_at = null, campaign_count = 0, contact_candidate_phones = 2, pipeline_stage = 'offer_interest'
  where property_id = 'P5';
update public.eg_property_facts set estimated_value = 120000, equity_known_pct = 80, equity_class = 'high', distress_signal_count = 1, out_of_state_owner = true, last_contact_at = null
  where property_id = 'P6';

update public.acquisition_opportunities set opportunity_status = 'open', acquisition_stage = 'offer_interest' where id = '00000000-0000-4000-8000-000000000201';
update public.acquisition_opportunities set opportunity_status = 'closed', acquisition_stage = 'disposition' where id = '00000000-0000-4000-8000-000000000202';
