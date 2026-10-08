-- PROPOSED · READ-ONLY pretest for PROPOSED_20261008090000_contact_history_truths.sql
-- Run with: SET default_transaction_read_only = on; SET statement_timeout = '30s';
-- PRECHECK (before apply) ------------------------------------------------------
-- 1. None of the new columns / functions exist yet (expect 0 / 0).
SELECT count(*) AS new_cols_present FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'campaign_target_graph'
   AND column_name IN ('person_ever_contacted','current_best_contact_touched','retext_hold','property_prior_person_keys');
SELECT count(*) AS fns_present FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('contact_history_truths','refresh_campaign_target_graph_contact_truths');
-- 2. The inputs the function reads exist with the expected columns (expect 11 rows).
SELECT table_schema, table_name, column_name FROM information_schema.columns
 WHERE (table_schema, table_name, column_name) IN (
   ('public','send_queue','prospect_id'), ('public','send_queue','sent_at'), ('public','send_queue','scheduled_for'),
   ('public','message_events','event_timestamp'), ('public','message_events','is_final_failure'), ('public','message_events','prospect_id'),
   ('seller','owner_phone','phone_value'), ('seller','owner_phone','is_encrypted'),
   ('seller','property_owner_resolution_v1','co_owner_individual_key'), ('seller','property_entity_contact_v1','selected_person_key'),
   ('public','campaign_target_graph','seller_person_key'));
-- 3. owner_phone plaintext numbers are 10 digits (expect non_10_digit ≈ 0 apart from 'Landline Excluded' text).
SELECT count(*) FILTER (WHERE phone_value ~ '^[0-9]{10}$') AS ten_digit, count(*) FILTER (WHERE phone_value !~ '^[0-9]{10}$') AS non_10_digit
  FROM (SELECT phone_value FROM seller.owner_phone WHERE NOT COALESCE(is_encrypted,false) LIMIT 50000) s;
-- 4. The gap this fixes (expect ≈ 6,200–7,000 properties: graph never_contacted yet texted about).
SELECT count(DISTINCT g.property_id) AS graph_never_but_property_texted
  FROM public.campaign_target_graph g
 WHERE g.never_contacted AND g.property_id IN (SELECT property_id FROM public.send_queue WHERE sent_at IS NOT NULL);

-- POSTCHECK (after apply + backfill) --------------------------------------------
-- 5. Expect, as of 2026-10-08: retext_hold ∩ queue_eligible ≈ 1,649 (±15%), released ≈ 2,
--    person-only ≈ 220, and NO change to queue_eligible itself.
-- SELECT count(*) FILTER (WHERE queue_eligible AND retext_hold) AS opener_held,
--        count(*) FILTER (WHERE queue_eligible AND retext_hold_why = 'released_known_different_person') AS released,
--        count(*) FILTER (WHERE queue_eligible AND NOT property_ever_contacted AND never_contacted AND person_ever_contacted) AS person_only,
--        count(*) FILTER (WHERE queue_eligible) AS queue_eligible_unchanged
--   FROM public.campaign_target_graph;
-- SELECT retext_hold_why, count(*) FROM public.campaign_target_graph WHERE queue_eligible AND retext_hold GROUP BY 1 ORDER BY 2 DESC;
-- 6. Idempotent: a second full pass writes 0 rows (sum of 'rows' over the pass = 0).
