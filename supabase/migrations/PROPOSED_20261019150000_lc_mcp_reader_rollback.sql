-- =============================================================================
-- ROLLBACK of PROPOSED_20261019150000_lc_mcp_reader.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- Tested on disposable PostgreSQL 17 only: the runner proves that apply → rollback
-- restores the pre-apply catalog fingerprint exactly (ACLs, policies, functions, roles).
-- =============================================================================
-- Drops EXACTLY what the apply created, and nothing else:
--   * policy lc_mcp_reader_select on each inventory table;
--   * the role's SELECT on the 20 inventory relations, its EXECUTE on the 2 existing
--     RPCs and its USAGE on schema public;
--   * functions public.lc_mcp_reader_self_check(text[], text[], name) and
--     public.lc_mcp_operator_role(uuid, uuid);
--   * the membership lc_mcp_reader → authenticator, then role lc_mcp_reader itself.
-- Idempotent: every step is skipped when its object is absent.
-- It does NOT use DROP OWNED. If someone granted lc_mcp_reader anything else by hand,
-- DROP ROLE fails and names the dependency. Review that before going further.
--
-- KILL SWITCH without a rollback: `revoke lc_mcp_reader from authenticator;`.
-- PostgREST can then no longer switch to the role, so every request with the minted
-- token fails at once. The JWT secret does not need to rotate.

set local lock_timeout = '5s';

do $$
declare
  -- lc-inventory:relations
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  -- lc-inventory:existing-rpcs
  rpcs text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)'];
  role_exists boolean := exists (select 1 from pg_roles where rolname = 'lc_mcp_reader');
  t text;
begin
  foreach t in array rels loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    if exists (select 1 from pg_policy where polrelid = to_regclass(format('public.%I', t)) and polname = 'lc_mcp_reader_select') then
      execute format('drop policy lc_mcp_reader_select on public.%I', t);
    end if;
    if role_exists then execute format('revoke select on public.%I from lc_mcp_reader', t); end if;
  end loop;
  if role_exists then
    foreach t in array rpcs loop
      if to_regprocedure(t) is not null then execute format('revoke execute on function %s from lc_mcp_reader', t); end if;
    end loop;
    revoke usage on schema public from lc_mcp_reader;
    if exists (select 1 from pg_roles where rolname = 'authenticator') then revoke lc_mcp_reader from authenticator; end if;
  end if;
end $$;

drop function if exists public.lc_mcp_reader_self_check(text[], text[], name);
drop function if exists public.lc_mcp_operator_role(uuid, uuid);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then drop role lc_mcp_reader; end if;
end $$;

notify pgrst, 'reload schema';
