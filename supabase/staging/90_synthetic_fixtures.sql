-- ============================================================================
-- STAGING ONLY — synthetic integration fixtures. Idempotent.
-- ============================================================================
-- Every person is fictional: example.test addresses, 555 numbers, "(fixture)"
-- labels, metadata {"fixture": true} where the table allows it. Nothing here
-- can reach a real seller: staging has no SMS/send queue and staging email
-- goes only to the capture sink or the configured staging inbox.
--
-- Scenarios
--   alex@example.test   two properties: A (written offer sent) + C (estimate only)
--   blair@example.test  B: closing scheduled, a title item the seller owns
--                       (action needed), a title-thread document (shareable)
--                       and a buyer-thread document (must never be shareable)
--   casey@example.test  D: closed
--   dana@ + drew@       E: one property, two co-owner accounts
--   eve@example.test    a FAILED intake naming property C — must grant nothing
-- Staff (auth users, created by scripts/staging/seed-staff.sh):
--   staging-admin@example.test     operator + scheduling.admin, bookable
--   staging-operator@example.test  operator, bookable, no admin permission

SELECT staging_guard.assert_staging();

BEGIN;

-- --------------------------------------------------------- opportunities ----
INSERT INTO public.acquisition_opportunities (id, dedupe_key, acquisition_stage, opportunity_status, primary_thread_key, property_address_full, seller_display_name, source_application, source_channel, assigned_operator, metadata, created_at)
VALUES
  ('0a000000-5eed-4000-8000-00000000000a', 'fixture:A', 'offer', 'active', '+15555550101', '1240 Sycamore Lane, Atlanta, GA 30310', 'Alex Fixture', 'prominent_cash_offer', 'web', 'fixture-advisor-a', '{"fixture": true}', now() - interval '12 days'),
  ('0c000000-5eed-4000-8000-00000000000c', 'fixture:C', 'price_discovery', 'active', '+15555550103', '77 Juniper Court, Decatur, GA 30030', 'Alex Fixture', 'prominent_cash_offer', 'web', null, '{"fixture": true}', now() - interval '4 days'),
  ('0b000000-5eed-4000-8000-00000000000b', 'fixture:B', 'under_contract', 'active', '+15555550102', '88 Magnolia Street, Tampa, FL 33602', 'Blair Fixture', 'prominent_cash_offer', 'web', 'fixture-advisor-a', '{"fixture": true}', now() - interval '30 days'),
  ('0d000000-5eed-4000-8000-00000000000d', 'fixture:D', 'prepared_to_close', 'active', '+15555550104', '5 Cedar Row, Macon, GA 31201', 'Casey Fixture', 'prominent_cash_offer', 'web', null, '{"fixture": true}', now() - interval '60 days'),
  ('0e000000-5eed-4000-8000-00000000000e', 'fixture:E', 'offer_interest', 'active', '+15555550105', '19 Birch Lane, Savannah, GA 31401', 'Dana & Drew Fixture', 'prominent_cash_offer', 'web', null, '{"fixture": true}', now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------- intake: the only claim path ----
INSERT INTO public.external_seller_intake_submissions (id, schema_version, source_application, source_channel, idempotency_key, payload_hash, status, seller_display_name, seller_first_name, seller_last_name, seller_phone, seller_email, property_address, property_match_key, lead_id, thread_key, consent, created_at)
VALUES
  ('1a000000-5eed-4000-8000-00000000000a', 'pco-intake/v1', 'prominent_cash_offer', 'web', 'fixture-intake-A', 'fixture', 'accepted', 'Alex Fixture', 'Alex', 'Fixture', '+15555550101', 'alex@example.test', '1240 Sycamore Lane, Atlanta, GA 30310', 'fixture:A', '0a000000-5eed-4000-8000-00000000000a', '+15555550101', '{"contact_requested": true, "fixture": true}', now() - interval '12 days'),
  ('1c000000-5eed-4000-8000-00000000000c', 'pco-intake/v1', 'prominent_cash_offer', 'web', 'fixture-intake-C', 'fixture', 'accepted', 'Alex Fixture', 'Alex', 'Fixture', '+15555550101', 'alex@example.test', '77 Juniper Court, Decatur, GA 30030', 'fixture:C', '0c000000-5eed-4000-8000-00000000000c', '+15555550103', '{"contact_requested": true, "fixture": true}', now() - interval '4 days'),
  ('1b000000-5eed-4000-8000-00000000000b', 'pco-intake/v1', 'prominent_cash_offer', 'web', 'fixture-intake-B', 'fixture', 'accepted', 'Blair Fixture', 'Blair', 'Fixture', '+15555550102', 'blair@example.test', '88 Magnolia Street, Tampa, FL 33602', 'fixture:B', '0b000000-5eed-4000-8000-00000000000b', '+15555550102', '{"contact_requested": true, "fixture": true}', now() - interval '30 days'),
  ('1d000000-5eed-4000-8000-00000000000d', 'pco-intake/v1', 'prominent_cash_offer', 'web', 'fixture-intake-D', 'fixture', 'accepted', 'Casey Fixture', 'Casey', 'Fixture', '+15555550104', 'casey@example.test', '5 Cedar Row, Macon, GA 31201', 'fixture:D', '0d000000-5eed-4000-8000-00000000000d', '+15555550104', '{"contact_requested": true, "fixture": true}', now() - interval '60 days'),
  ('1e000000-5eed-4000-8000-00000000000e', 'pco-intake/v1', 'prominent_cash_offer', 'web', 'fixture-intake-E1', 'fixture', 'accepted', 'Dana Fixture', 'Dana', 'Fixture', '+15555550105', 'dana@example.test', '19 Birch Lane, Savannah, GA 31401', 'fixture:E', '0e000000-5eed-4000-8000-00000000000e', '+15555550105', '{"contact_requested": true, "fixture": true}', now() - interval '2 days'),
  ('1e000000-5eed-4000-8000-0000000000e2', 'pco-intake/v1', 'prominent_cash_offer', 'web', 'fixture-intake-E2', 'fixture', 'accepted', 'Drew Fixture', 'Drew', 'Fixture', '+15555550106', 'drew@example.test', '19 Birch Lane, Savannah, GA 31401', 'fixture:E', '0e000000-5eed-4000-8000-00000000000e', '+15555550105', '{"contact_requested": true, "fixture": true}', now() - interval '2 days'),
  -- Not accepted: an email on a failed submission claims nothing.
  ('1f000000-5eed-4000-8000-00000000000f', 'pco-intake/v1', 'prominent_cash_offer', 'web', 'fixture-intake-F', 'fixture', 'failed', 'Eve Fixture', 'Eve', 'Fixture', '+15555550107', 'eve@example.test', '77 Juniper Court, Decatur, GA 30030', 'fixture:C', '0c000000-5eed-4000-8000-00000000000c', '+15555550103', '{"contact_requested": true, "fixture": true}', now() - interval '1 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.inbox_thread_state (thread_key, seller_display_name, seller_phone, is_read, metadata)
SELECT k, n, k, true, '{"fixture": true}'::jsonb FROM (VALUES
  ('+15555550101', 'Alex Fixture'), ('+15555550103', 'Alex Fixture'), ('+15555550102', 'Blair Fixture'),
  ('+15555550104', 'Casey Fixture'), ('+15555550105', 'Dana & Drew Fixture')) v(k, n)
ON CONFLICT (thread_key) DO NOTHING;

-- ---------------------------------------------------- offers & estimates ----
INSERT INTO public.seller_offers (offer_id, opportunity_id, thread_key, offer_version, offer_type, direction, purchase_price, closing_date, closing_term, emd_amount, status, sent_at, terms_hash, metadata)
VALUES
  ('fixture-offer-A1', '0a000000-5eed-4000-8000-00000000000a', '+15555550101', 1, 'cash', 'outbound', 212000, (now() + interval '21 days')::date, 'on_or_after', 2500, 'active', now() - interval '1 day', 'fixture-A1', '{"fixture": true}'),
  ('fixture-offer-B1', '0b000000-5eed-4000-8000-00000000000b', '+15555550102', 1, 'cash', 'outbound', 198500, (now() + interval '10 days')::date, 'on_or_after', 2500, 'accepted', now() - interval '20 days', 'fixture-B1', '{"fixture": true}'),
  ('fixture-offer-D1', '0d000000-5eed-4000-8000-00000000000d', '+15555550104', 1, 'cash', 'outbound', 154000, (now() - interval '2 days')::date, 'on_or_after', 2000, 'accepted', now() - interval '45 days', 'fixture-D1', '{"fixture": true}')
ON CONFLICT (offer_id) DO NOTHING;
UPDATE public.seller_offers SET accepted_at = now() - interval '18 days', accepted_price = 198500 WHERE offer_id = 'fixture-offer-B1' AND accepted_at IS NULL;
UPDATE public.seller_offers SET accepted_at = now() - interval '40 days', accepted_price = 154000 WHERE offer_id = 'fixture-offer-D1' AND accepted_at IS NULL;

INSERT INTO public.offerr_evaluation_requests (id, idempotency_key, raw_submitted_address, normalized_submitted_address, source, spine_version, resolution_status, acquisition_opportunity_id, thread_key, metadata)
VALUES ('2c000000-5eed-4000-8000-00000000000c', 'fixture-eval-C', '77 Juniper Court, Decatur, GA 30030', '77 juniper ct decatur ga 30030', 'fixture', 'fixture', 'RESOLVED', '0c000000-5eed-4000-8000-00000000000c', '+15555550103', '{"fixture": true}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.offerr_evaluations (request_id, evaluation_version, outcome, confidence_label, seller_projection, internal_result, provenance, spine_version, computed_at, expires_at)
VALUES ('2c000000-5eed-4000-8000-00000000000c', 1, 'CONDITIONAL_RANGE', 'MEDIUM',
  '{"preliminary_range": {"low": 171000, "high": 189000}, "disclaimer": "Illustrative staging fixture. Not an offer.", "binding": false}',
  '{"fixture": true}', '{"fixture": true}', 'fixture', now() - interval '3 days', now() + interval '11 days')
ON CONFLICT (request_id, evaluation_version) DO NOTHING;

-- -------------------------------------------------------------- closings ----
INSERT INTO public.closing_cases (closing_case_id, opportunity_id, property_address, thread_key, offer_id, universal_stage, closing_status, contract_status, contract_signed_date, title_opened_date, scheduled_closing_date, closing_date_confirmed_at, closing_date_source, closing_tz, title_company_name, escrow_file_number, seller_contract_price, earnest_money, signer_email, signer_name, provenance)
VALUES ('fixture-case-B', '0b000000-5eed-4000-8000-00000000000b', '88 Magnolia Street, Tampa, FL 33602', '+15555550102', 'fixture-offer-B1', 'under_contract', 'scheduled', 'signed', now() - interval '15 days', now() - interval '14 days', date_trunc('day', now() + interval '10 days') + interval '18 hours', now() - interval '2 days', 'fixture', 'America/New_York', 'Example Title & Escrow (fixture)', 'FX-24-0118', 198500, 2500, 'blair@example.test', 'Blair Fixture', '{"fixture": true}')
ON CONFLICT (closing_case_id) DO NOTHING;
INSERT INTO public.closing_cases (closing_case_id, opportunity_id, property_address, thread_key, offer_id, universal_stage, closing_status, contract_status, contract_signed_date, scheduled_closing_date, closing_date_confirmed_at, closing_tz, title_company_name, seller_contract_price, closed_at, closed_by, provenance)
VALUES ('fixture-case-D', '0d000000-5eed-4000-8000-00000000000d', '5 Cedar Row, Macon, GA 31201', '+15555550104', 'fixture-offer-D1', 'closed', 'closed', 'signed', now() - interval '38 days', now() - interval '2 days', now() - interval '9 days', 'America/New_York', 'Example Title & Escrow (fixture)', 154000, now() - interval '2 days', 'fixture', '{"fixture": true}')
ON CONFLICT (closing_case_id) DO NOTHING;
-- Closed-won is only allowed once the closing is closed (enforce_closed_won_authority).
UPDATE public.acquisition_opportunities SET acquisition_stage = 'closed', opportunity_status = 'won' WHERE id = '0d000000-5eed-4000-8000-00000000000d' AND acquisition_stage <> 'closed';

INSERT INTO public.closing_milestones (closing_case_id, milestone_type, occurred_at, actor, idempotency_key, source_system)
VALUES
  ('fixture-case-B', 'contract_fully_executed', now() - interval '15 days', 'fixture', 'fixture:B:contract', 'fixture'),
  ('fixture-case-B', 'title_opened', now() - interval '14 days', 'fixture', 'fixture:B:title', 'fixture'),
  ('fixture-case-B', 'closing_scheduled', now() - interval '2 days', 'fixture', 'fixture:B:scheduled', 'fixture'),
  ('fixture-case-D', 'contract_fully_executed', now() - interval '38 days', 'fixture', 'fixture:D:contract', 'fixture'),
  ('fixture-case-D', 'clear_to_close', now() - interval '4 days', 'fixture', 'fixture:D:ctc', 'fixture'),
  ('fixture-case-D', 'closed', now() - interval '2 days', 'fixture', 'fixture:D:closed', 'fixture')
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO public.closing_title_issues (issue_id, closing_case_id, issue_type, description, status, owner, source, opened_by)
VALUES ('fixture-issue-B1', 'fixture-case-B', 'other', 'Upload a copy of your photo ID for the title company. (fixture)', 'open', 'seller', 'fixture', 'fixture')
ON CONFLICT (issue_id) DO NOTHING;

-- ------------------------------------- documents (metadata; bytes later) ----
INSERT INTO public.email_threads (id, thread_key, category, counterparty_email, counterparty_name, closing_case_id, opportunity_id, subject, metadata)
VALUES
  ('3b000000-5eed-4000-8000-0000000000b1', 'fixture-thread-title-B', 'title', 'closer@title.example.test', 'Example Title (fixture)', 'fixture-case-B', '0b000000-5eed-4000-8000-00000000000b', 'FX-24-0118 commitment', '{"fixture": true}'),
  ('3b000000-5eed-4000-8000-0000000000b2', 'fixture-thread-buyer-B', 'buyer', 'buyer@investor.example.test', 'Buyer (fixture)', 'fixture-case-B', '0b000000-5eed-4000-8000-00000000000b', 'Assignment for 88 Magnolia', '{"fixture": true}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.email_inbound_messages (id, dedupe_key, from_email, subject, text_body, thread_id, processing_status, attachment_count)
VALUES
  ('4b000000-5eed-4000-8000-0000000000b1', 'fixture-inbound-title-B', 'closer@title.example.test', 'FX-24-0118 commitment', 'Commitment attached. (fixture)', '3b000000-5eed-4000-8000-0000000000b1', 'handled', 1),
  ('4b000000-5eed-4000-8000-0000000000b2', 'fixture-inbound-buyer-B', 'buyer@investor.example.test', 'Assignment', 'Signed assignment attached. (fixture)', '3b000000-5eed-4000-8000-0000000000b2', 'handled', 1)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.email_attachments (id, attachment_key, inbound_message_id, thread_id, filename, content_type, size_bytes, storage_bucket, storage_path, fetch_status, review_state, routed_entity_type, routed_entity_id, routed_at, doc_type)
VALUES
  ('5b000000-5eed-4000-8000-0000000000b1', 'fixture-att-title-B', '4b000000-5eed-4000-8000-0000000000b1', '3b000000-5eed-4000-8000-0000000000b1', 'title-commitment-fixture.pdf', 'application/pdf', 1024, 'email-attachments', 'fixtures/case-B/title-commitment-fixture.pdf', 'stored', 'reviewed', 'closing_case', 'fixture-case-B', now() - interval '6 days', 'title_commitment'),
  ('5b000000-5eed-4000-8000-0000000000b2', 'fixture-att-buyer-B', '4b000000-5eed-4000-8000-0000000000b2', '3b000000-5eed-4000-8000-0000000000b2', 'assignment-fixture.pdf', 'application/pdf', 1024, 'email-attachments', 'fixtures/case-B/assignment-fixture.pdf', 'stored', 'reviewed', null, null, null, 'assignment')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------- scheduling ----
-- Staff identities come from auth.users (seed-staff.sh); resources are only
-- created when those users exist, so this file is safe to run first.
INSERT INTO public.scheduling_resources (id, kind, ops_user_id, operator_keys, display_name, public_name, email, timezone, weekly_hours, environment)
SELECT v.id, 'person', u.id::text, v.keys, v.name, null, v.email, v.tz, v.hours::jsonb, 'test'
FROM (VALUES
  ('aaaaaaaa-5eed-4000-8000-000000000001'::uuid, 'staging-admin@example.test', ARRAY['fixture-advisor-a'], 'Staging Advisor A (fixture)', 'America/New_York',
   '{"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]]}'),
  ('aaaaaaaa-5eed-4000-8000-000000000002'::uuid, 'staging-operator@example.test', ARRAY['fixture-advisor-b'], 'Staging Advisor B (fixture)', 'America/Chicago',
   '{"1":[["08:00","16:00"]],"2":[["08:00","16:00"]],"3":[["08:00","16:00"]],"4":[["08:00","16:00"]],"5":[["08:00","12:00"]]}')
) v(id, email, keys, name, tz, hours)
JOIN auth.users u ON u.email = v.email
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.scheduling_pools (brand_key, pool_key, name) VALUES ('second_brand_test', 'team', 'Second brand team (test)')
ON CONFLICT (brand_key, pool_key) DO NOTHING;
INSERT INTO public.scheduling_event_types (brand_key, type_key, name, duration_minutes, slot_interval_minutes, buffer_after_minutes, min_notice_minutes, horizon_days, routing, environment)
VALUES ('second_brand_test', 'onboarding', 'Onboarding (test brand)', 30, 30, 10, 60, 14, '{"strategy":"round_robin","pool":"team"}', 'test')
ON CONFLICT (brand_key, type_key) DO NOTHING;

INSERT INTO public.scheduling_pool_members (pool_id, resource_id, active)
SELECT p.id, r.id, true FROM public.scheduling_pools p JOIN public.scheduling_resources r ON r.environment = 'test' AND r.id IN ('aaaaaaaa-5eed-4000-8000-000000000001', 'aaaaaaaa-5eed-4000-8000-000000000002')
WHERE (p.brand_key, p.pool_key) IN (('prominent_cash_offer', 'seller_advisors'), ('second_brand_test', 'team'))
ON CONFLICT (pool_id, resource_id) DO NOTHING;
INSERT INTO public.scheduling_pool_members (pool_id, resource_id, active)
SELECT p.id, 'aaaaaaaa-5eed-4000-8000-000000000002', true FROM public.scheduling_pools p
WHERE p.brand_key = 'prominent_cash_offer' AND p.pool_key = 'transaction_team'
  AND EXISTS (SELECT 1 FROM public.scheduling_resources WHERE id = 'aaaaaaaa-5eed-4000-8000-000000000002')
ON CONFLICT (pool_id, resource_id) DO NOTHING;

-- Staging-only sender for the captured/real staging email path.
INSERT INTO public.email_senders (sender_key, sender_name, from_email, provider, provider_api_key_name, domain, sender_status, is_active, metadata)
VALUES ('prominent', 'Prominent (staging)', 'staging-noreply@example.test', 'brevo', 'BREVO_PROMINENT_API_KEY', 'example.test', 'active', true, '{"fixture": true}')
ON CONFLICT (sender_key) DO NOTHING;
INSERT INTO public.system_control (key, value) VALUES ('email_enabled', 'false') ON CONFLICT (key) DO NOTHING;

COMMIT;

SELECT
  (SELECT count(*) FROM public.acquisition_opportunities WHERE dedupe_key LIKE 'fixture:%') AS opportunities,
  (SELECT count(*) FROM public.external_seller_intake_submissions WHERE idempotency_key LIKE 'fixture-%') AS intakes,
  (SELECT count(*) FROM public.seller_offers WHERE offer_id LIKE 'fixture-%') AS offers,
  (SELECT count(*) FROM public.closing_cases WHERE closing_case_id LIKE 'fixture-%') AS closings,
  (SELECT count(*) FROM public.email_attachments WHERE attachment_key LIKE 'fixture-%') AS documents,
  (SELECT count(*) FROM public.scheduling_resources WHERE environment = 'test') AS bookable_people;
