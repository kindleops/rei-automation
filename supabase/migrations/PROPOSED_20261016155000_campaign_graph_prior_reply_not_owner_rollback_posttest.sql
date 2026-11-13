-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner_rollback.sql:
-- runs AFTER the runner applied the rollback file; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id campaign_graph_prior_reply_not_owner
-- Expected last notice: "posttest(campaign_graph_prior_reply_not_owner): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare f text;
begin
  if to_regprocedure('public.campaign_target_graph_reply_block(text,text)') is not null then raise exception 'assert: helper dropped'; end if;
  if to_regclass('public.contact_property_resolution_phone_idx') is not null then raise exception 'assert: phone index dropped'; end if;
  if to_regclass('public.contact_property_resolution') is null then raise exception 'assert: the store itself is never dropped'; end if;
  foreach f in array array['refresh_campaign_target_graph_seller_batch','refresh_campaign_target_graph_fallback_batch',
                           'refresh_campaign_target_graph_stage_batch','refresh_campaign_target_graph_sender_coverage',
                           'campaign_target_graph_enrich_rows'] loop
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = f and pg_get_functiondef(p.oid) like '%campaign_target_graph_reply_block%') then
      raise exception 'assert: public.% restored to the live body', f;
    end if;
  end loop;
  -- the live recompute is back: a recorded denial no longer blocks (the pre-8.5.21 gap)
  insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope)
    values ('P-DENIED', '+15550000001', 'not_owner', now() - interval '90 days', 'contact_property_pair');
  insert into public.campaign_target_graph (graph_id, property_id, canonical_e164, market, state, sms_eligible)
    values ('g-denied', 'P-DENIED', '5550000001', 'M', 'TX', true);
  perform * from public.refresh_campaign_target_graph_sender_coverage('rollback_posttest');
  if (select queue_eligible from public.campaign_target_graph where graph_id = 'g-denied') is not true then
    raise exception 'assert: rollback restores the live (unguarded) recompute';
  end if;
  raise notice 'posttest(campaign_graph_prior_reply_not_owner): ALL OK (rolled back)';
end $$;
rollback;
