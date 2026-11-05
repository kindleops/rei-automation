-- PRETEST for PROPOSED_20261026150000_lc_mcp_corpus_census.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. Read-only; ends in ROLLBACK.
-- Asserts the prerequisites the apply relies on:
--   * lc_mcp_reader and its self-check exist (the 1.0 reader migration is applied);
--   * the 1.1 conversation reads exist (their signatures are part of the self-check list the apply verifies);
--   * neither census function exists yet;
--   * every column the functions read statically exists. Everything else is read through to_jsonb()
--     and reported as absent when missing (NOTICE only here).
begin;
do $$
declare
  need text[] := array[
    'eg_property_facts.property_id','eg_property_facts.market','properties.property_id','properties.market','properties.master_owner_id','properties.property_address_full',
    'campaign_target_graph.property_id','campaign_target_graph.canonical_e164','campaign_target_graph.sms_eligible',
    'inbox_thread_state.property_id','inbox_thread_state.thread_key','inbox_thread_state.last_inbound_at','inbox_thread_state.last_outbound_at',
    'property_acquisition_scores.property_id','sms_suppression_list.is_active','acquisition_opportunities.primary_property_id','acquisition_opportunities.primary_thread_key',
    'campaign_targets.property_id','master_owners.master_owner_id','prospects.prospect_id','phones.phone_id','campaigns.id'];
  optional text[] := array['eg_property_facts.conversation_stage','eg_property_facts.conversation_status','eg_property_facts.pipeline_stage','eg_property_facts.deal_id','eg_property_facts.last_contact_at',
    'eg_property_facts.estimated_value','eg_property_facts.equity_known_pct','eg_property_facts.distress_signal_count','eg_property_facts.tax_delinquent','eg_property_facts.active_lien',
    'eg_property_facts.rec_has_probate','eg_property_facts.is_hot_preforeclosure','eg_property_facts.owner_property_count','eg_property_facts.contact_candidate_phones',
    'inbox_thread_state.opt_out','inbox_thread_state.wrong_number','inbox_thread_state.is_suppressed','inbox_thread_state.contactability_status',
    'acquisition_opportunities.opportunity_status','property_acquisition_scores.computed_at','message_events.direction'];
  c text; problems text[] := '{}'; missing text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then problems := problems || 'lc_mcp_reader missing (apply the 1.0 reader migration first)'::text; end if;
  if to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is null then problems := problems || 'lc_mcp_reader_self_check missing'::text; end if;
  if to_regprocedure('public.lc_mcp_pipeline_counts(text,text,text,integer)') is null then problems := problems || 'the 1.1 conversation intelligence functions are not applied (PROPOSED_20261026120000_lc_mcp_conversation_intel.sql first)'::text; end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('lc_mcp_corpus_census','lc_mcp_lead_screen')) then
    problems := problems || 'a census function already exists'::text;
  end if;
  foreach c in array need loop
    if not exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || split_part(c, '.', 1))
                     and attname = split_part(c, '.', 2) and attnum > 0 and not attisdropped) then
      problems := problems || ('missing column ' || c);
    end if;
  end loop;
  foreach c in array optional loop
    if not exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || split_part(c, '.', 1))
                     and attname = split_part(c, '.', 2) and attnum > 0 and not attisdropped) then
      missing := missing || c;
    end if;
  end loop;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present';
  raise notice 'pretest: optional columns absent (reported, counted as 0): %', coalesce(array_to_string(missing, ', '), 'none');
end $$;
rollback;
