-- PROPOSED ONLY — PRETEST for PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id campaign_graph_prior_reply_not_owner
\set ON_ERROR_STOP on
do $$
declare f text;
begin
  if to_regclass('public.contact_property_resolution') is null then
    raise exception 'pretest: public.contact_property_resolution must exist (the property-scoped store is reused, never created)';
  end if;
  foreach f in array array['refresh_campaign_target_graph_seller_batch','refresh_campaign_target_graph_fallback_batch',
                           'refresh_campaign_target_graph_stage_batch','refresh_campaign_target_graph_sender_coverage',
                           'campaign_target_graph_enrich_rows'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f) then
      raise exception 'pretest: live function public.% must exist', f;
    end if;
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = f and pg_get_functiondef(p.oid) like '%campaign_target_graph_reply_block%') then
      raise exception 'pretest: public.% already reads the reply block (migration applied?)', f;
    end if;
  end loop;
  if to_regprocedure('public.campaign_target_graph_reply_block(text,text)') is not null then
    raise exception 'pretest: the helper must not exist yet';
  end if;
  raise notice 'pretest(campaign_graph_prior_reply_not_owner): prerequisites OK';
end $$;
