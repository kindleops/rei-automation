-- PRETEST for PROPOSED_20261019150000_lc_mcp_reader.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. The runner proves it leaves no trace (same
-- catalog fingerprint, same row counts).
-- Asserts the prerequisites the apply relies on:
--   * PostgREST's authenticator role exists;
--   * lc_mcp_reader does not exist yet;
--   * every required inventory relation, both allowlisted RPCs (STABLE) and
--     agent.operator_membership exist.
begin;
do $$
declare
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  t text; problems text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then problems := problems || 'authenticator missing'::text; end if;
  if exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then problems := problems || 'lc_mcp_reader already exists'::text; end if;
  foreach t in array rels loop
    if to_regclass(format('public.%I', t)) is null then problems := problems || ('missing relation ' || t); end if;
  end loop;
  if to_regclass('agent.operator_membership') is null then problems := problems || 'missing agent.operator_membership'::text; end if;
  if (select provolatile from pg_proc where oid = to_regprocedure('public.entity_graph_property_records(text)')) is distinct from 's' then problems := problems || 'entity_graph_property_records not STABLE'::text; end if;
  if (select provolatile from pg_proc where oid = to_regprocedure('public.campaign_entity_contact_review_flags(text[])')) is distinct from 's' then problems := problems || 'campaign_entity_contact_review_flags not STABLE'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present';
end $$;
rollback;
