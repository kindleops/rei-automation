-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016162000_ops_research_valuation_snapshot.sql: runs AFTER the runner
-- applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ops_research_valuation_snapshot
-- Expected last notice: "posttest(ops_research_valuation_snapshot): apply assertions OK".
\set ON_ERROR_STOP on
begin;
do $$
declare
  r jsonb;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid;
  t timestamptz := now();
begin
  delete from public.seller_offers; delete from public.message_events; delete from public.property_acquisition_scores; delete from public.acquisition_opportunities;
  insert into public.acquisition_opportunities (primary_property_id, primary_thread_key, acquisition_stage, opportunity_status) values ('p1', 'thr-1', 'offer', 'active') returning id into o1;
  insert into public.acquisition_opportunities (primary_property_id, primary_thread_key, acquisition_stage, opportunity_status) values ('p2', 'thr-2', 'asking_price', 'nurture') returning id into o2;
  insert into public.acquisition_opportunities (primary_property_id, primary_thread_key, acquisition_stage, opportunity_status) values ('p3', 'thr-3', 'offer', 'active') returning id into o3;
  insert into public.acquisition_opportunities (primary_property_id, primary_thread_key, acquisition_stage, opportunity_status) values ('p4', 'thr-4', 'offer', 'dead') returning id into o4;
  insert into public.property_acquisition_scores (property_id, decision_tier, computed_at) values ('p1', 'AUTO_HARD_OFFER', t - interval '2 days'), ('p2', 'CREATIVE_TERMS', t - interval '40 days');
  -- o1: offer sent 4 days ago, no reply ⇒ overdue; o3: sent 4 days ago, seller replied ⇒ not overdue; o4: dead ⇒ not counted
  insert into public.seller_offers (offer_id, opportunity_id, thread_key, purchase_price, status, sent_at) values
    ('of-1', o1, 'thr-1', 100000, 'sent', t - interval '4 days'), ('of-3', o3, 'thr-3', 90000, 'sent', t - interval '4 days'), ('of-4', o4, 'thr-4', 80000, 'sent', t - interval '4 days'),
    ('of-5', o1, 'thr-1', 100000, 'draft', null);
  insert into public.message_events (direction, thread_key, created_at) values ('inbound', 'thr-3', t - interval '1 day'), ('inbound', 'thr-1', t - interval '5 days');

  r := agent.ops_research_valuation_snapshot(t);
  if (r #>> '{valuation,live}')::int <> 3 then raise exception 'assert: 3 live opportunities, got %', r -> 'valuation'; end if;
  if (r #>> '{valuation,with_score}')::int <> 2 or (r #>> '{valuation,missing}')::int <> 1 then raise exception 'assert: 2 scored / 1 missing, got %', r -> 'valuation'; end if;
  if (r #>> '{valuation,offer_ready}')::int <> 1 or (r #>> '{valuation,stale_30d}')::int <> 1 then raise exception 'assert: 1 offer-ready / 1 stale, got %', r -> 'valuation'; end if;
  if (r #>> '{valuation,by_tier,none}')::int <> 1 then raise exception 'assert: by_tier counts the unscored, got %', r -> 'valuation'; end if;
  if (r #>> '{offers,sent_30d}')::int <> 3 then raise exception 'assert: 3 sent in 30 d, got %', r -> 'offers'; end if;
  if (r #>> '{offers,overdue_no_reply_72h}')::int <> 1 or (r #>> '{offers,overdue_opportunity_ids,0}') <> o1::text then raise exception 'assert: exactly o1 overdue, got %', r -> 'offers'; end if;
  if (r #>> '{negotiations,in_negotiation_stage}')::int <> 3 then raise exception 'assert: 3 in negotiation stages, got %', r -> 'negotiations'; end if;
  -- unavailable, never 0: without the 8.5.19 tables the counts are null
  if to_regclass('public.negotiation_envelopes') is null and (r -> 'negotiations' -> 'envelopes') <> 'null'::jsonb then raise exception 'assert: envelopes null when the table is absent'; end if;
  if to_regclass('public.negotiation_envelopes') is not null and (r #>> '{negotiations,envelopes}') is null then raise exception 'assert: envelopes counted when the table exists'; end if;
  -- no contact value leaves it
  if r::text ~ 'thr-[0-9]' then raise exception 'assert: no thread key in the snapshot'; end if;
  if not has_function_privilege('agent_api', 'agent.ops_research_valuation_snapshot(timestamptz)', 'execute') or has_function_privilege('anon', 'agent.ops_research_valuation_snapshot(timestamptz)', 'execute') then
    raise exception 'assert: agent_api only';
  end if;
  raise notice 'posttest(ops_research_valuation_snapshot): apply assertions OK';
end $$;
rollback;
