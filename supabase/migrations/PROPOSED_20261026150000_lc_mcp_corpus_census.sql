-- =============================================================================
-- LeadCommand MCP 1.2 — CORPUS CENSUS + LEAD SCREEN (read-only definer projections for lc_mcp_reader)
-- STATUS: PROPOSED. Optional, separately approved. Apply AFTER
--   PROPOSED_20261019150000_lc_mcp_reader.sql (required) and
--   PROPOSED_20261026120000_lc_mcp_conversation_intel.sql (its self-check list is extended here).
-- Tested on disposable PostgreSQL only (scripts/db/run-migration-test.mjs --id lc_mcp_corpus_census).
-- Rollback: PROPOSED_20261026150000_lc_mcp_corpus_census_rollback.sql.
-- =============================================================================
-- WHY. "Do not assume the ~12,000 outreach contacts represent every lead in the system." The acquisition
-- corpus is anchored on eg_property_facts / properties (one row per property = one seller lead), while
-- outreach (campaign_targets, campaign_target_graph), conversations (inbox_thread_state, message_events),
-- pipeline records (acquisition_opportunities) and Decision Engine output (property_acquisition_scores)
-- each cover a SUBSET. These two functions give the exact population of every source, the coverage of
-- each over the lead corpus, duplicate identities, missing data, stale and unanswered work — as counts —
-- and a keyset-paged SCREENING projection of every lead (compact facts, no names / phones / addresses)
-- so a restartable batch job can screen the whole corpus and send only candidates to the expensive reads.
--
-- WHAT THEY ARE. STABLE SECURITY DEFINER, search_path = pg_catalog, static SQL only, every input bounded
-- (out of bounds → SQLSTATE 22023). The role lc_mcp_reader gets EXECUTE on these two functions and nothing
-- else changes: it still holds no privilege on message_events / contact_property_resolution / the holds.
--
--   lc_mcp_corpus_census(text)
--     Exact count(*) per canonical source (optionally one market), coverage of each source over the lead
--     corpus, evidence coverage (distress, tax, liens, probate, pre-foreclosure, equity, portfolio owners),
--     duplicate identities (one phone on several properties, properties sharing an address, owners with
--     several properties, properties with several threads, facts/properties mismatches), contact state
--     (opted out, wrong number, suppressed threads; active suppression rows), pipeline health (open /
--     stale opportunities, unresolved needs_review, interest labels without recent contact, unanswered
--     seller messages, leads with signals never contacted, Decision Engine coverage and staleness).
--     Columns the database does not have are reported in columns_absent and count as 0 — never guessed.
--   lc_mcp_lead_screen(text, integer, text, text)
--     A keyset page (property_id > p_after, ordered by property_id, ≤ 500 rows) of screening rows for
--     every lead: labels, last contact, evidence flags, phones ON RECORD as counts and eligibility only,
--     thread state (unanswered / opted out / wrong number / suppressed), Decision Engine presence and age.
--     Never a name, a phone, a thread key or an address.
--
-- WHAT MAKES THE APPLY ABORT (atomically): lc_mcp_reader missing; any self-check finding for the role
-- with the extended function list (the same rules as the 1.0 / 1.1 applies).

set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'lc_mcp_reader') then
    raise exception 'lc_mcp_corpus_census: role lc_mcp_reader does not exist — apply PROPOSED_20261019150000_lc_mcp_reader.sql first';
  end if;
end
$$;

-- ------------------------------------------------------------ 1. the corpus census ----
create or replace function public.lc_mcp_corpus_census(p_market text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  has_msgs boolean := pg_catalog.to_regclass('public.message_events') is not null
                      and exists (select 1 from pg_catalog.pg_attribute where attrelid = pg_catalog.to_regclass('public.message_events') and attname = 'direction' and attnum > 0 and not attisdropped);
  has_opps boolean := pg_catalog.to_regclass('public.acquisition_opportunities') is not null;
  has_targets boolean := pg_catalog.to_regclass('public.campaign_targets') is not null;
  wanted text[] := array['conversation_stage','conversation_status','pipeline_stage','pipeline_status','sms_status','deal_id','last_contact_at','last_contact_direction',
                         'estimated_value','equity_known_pct','equity_class','distress_signal_count','tax_delinquent','active_lien','rec_has_probate','is_hot_preforeclosure',
                         'owner_property_count','owner_type_guess','out_of_state_owner','campaign_count','contact_candidate_phones','property_address_state','property_type','asset_type'];
  present text[]; absent text[];
  sources jsonb; coverage jsonb; evidence jsonb; dups jsonb; contact jsonb; health jsonb; engine jsonb;
  msgs jsonb := null; opps jsonb := null;
begin
  if p_market is not null and (length(p_market) > 60 or p_market !~ '^[A-Za-z0-9 ,.''&/_()-]+$') then
    raise exception using errcode = '22023', message = 'lc_mcp_corpus_census: market filter out of bounds';
  end if;
  select coalesce(array_agg(w order by w), '{}') into present from unnest(wanted) w
   where exists (select 1 from pg_catalog.pg_attribute where attrelid = pg_catalog.to_regclass('public.eg_property_facts') and attname = w and attnum > 0 and not attisdropped);
  select coalesce(array_agg(w order by w), '{}') into absent from unnest(wanted) w where not (w = any(present));

  -- ---- sources: exact populations. Tables without a property link (owners, prospects, phones, suppression) are org-wide.
  select jsonb_build_object(
      'properties', (select count(*) from public.properties p where p_market is null or p.market = p_market),
      'eg_property_facts', (select count(*) from public.eg_property_facts f where p_market is null or f.market = p_market),
      'campaign_target_graph', (select jsonb_build_object('rows', count(*), 'properties', count(distinct g.property_id), 'phones', count(distinct g.canonical_e164), 'sms_eligible_rows', count(*) filter (where g.sms_eligible is true))
                                  from public.campaign_target_graph g where p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = g.property_id and f.market = p_market)),
      'campaign_targets', case when has_targets then (select jsonb_build_object('rows', count(*), 'properties', count(distinct t.property_id)) from public.campaign_targets t
                                  where p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = t.property_id and f.market = p_market)) else null end,
      'campaigns', (select count(*) from public.campaigns),
      'inbox_thread_state', (select jsonb_build_object('threads', count(*), 'with_property', count(*) filter (where s.property_id is not null), 'with_inbound', count(*) filter (where s.last_inbound_at is not null),
                                                       'with_outbound', count(*) filter (where s.last_outbound_at is not null))
                               from public.inbox_thread_state s where p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = s.property_id and f.market = p_market)),
      'property_acquisition_scores', (select jsonb_build_object('rows', count(*), 'fresh_30d', count(*) filter (where coalesce((to_jsonb(a)->>'computed_at')::timestamptz, '-infinity') >= pg_catalog.now() - interval '30 days'))
                                        from public.property_acquisition_scores a where p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = a.property_id and f.market = p_market)),
      'sms_suppression_list', (select jsonb_build_object('rows', count(*), 'active', count(*) filter (where coalesce(x.is_active, true))) from public.sms_suppression_list x),
      'master_owners', (select count(*) from public.master_owners),
      'prospects', (select count(*) from public.prospects),
      'phones', (select count(*) from public.phones))
    into sources;
  if has_msgs then
    select jsonb_build_object('rows', count(*), 'inbound', count(*) filter (where lower(m.direction) like 'in%'), 'outbound', count(*) filter (where lower(m.direction) like 'out%'),
                              'inbound_unknown_sender', count(*) filter (where lower(m.direction) like 'in%' and m.thread_key is null),
                              'earliest_at', min(m.created_at), 'latest_at', max(m.created_at))
      into msgs from public.message_events m
     where p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = m.property_id and f.market = p_market);
  end if;
  if has_opps then
    select jsonb_build_object('rows', count(*),
        'open', count(*) filter (where lower(coalesce(to_jsonb(o)->>'opportunity_status', 'open')) not in ('closed','dead','lost','closed_won','closed_lost','archived')),
        'stale_open_60d', count(*) filter (where lower(coalesce(to_jsonb(o)->>'opportunity_status', 'open')) not in ('closed','dead','lost','closed_won','closed_lost','archived')
                                             and coalesce((select greatest(s.last_inbound_at, s.last_outbound_at) from public.inbox_thread_state s where s.thread_key = o.primary_thread_key limit 1), '-infinity') < pg_catalog.now() - interval '60 days'))
      into opps from public.acquisition_opportunities o
     where p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = o.primary_property_id and f.market = p_market);
  end if;
  sources := sources || jsonb_build_object('message_events', msgs, 'acquisition_opportunities', opps);

  -- ---- coverage of each source over the lead corpus (eg_property_facts rows)
  select jsonb_build_object(
      'leads', count(*),
      'with_property_row', count(*) filter (where exists (select 1 from public.properties p where p.property_id = f.property_id)),
      'with_phone_on_graph', count(*) filter (where exists (select 1 from public.campaign_target_graph g where g.property_id = f.property_id)),
      'with_sms_eligible_phone', count(*) filter (where exists (select 1 from public.campaign_target_graph g where g.property_id = f.property_id and g.sms_eligible is true)),
      'in_campaign_targets', case when has_targets then count(*) filter (where exists (select 1 from public.campaign_targets t where t.property_id = f.property_id)) else null end,
      'with_thread', count(*) filter (where exists (select 1 from public.inbox_thread_state s where s.property_id = f.property_id)),
      'with_inbound', count(*) filter (where exists (select 1 from public.inbox_thread_state s where s.property_id = f.property_id and s.last_inbound_at is not null)),
      'with_decision_engine', count(*) filter (where exists (select 1 from public.property_acquisition_scores a where a.property_id = f.property_id)),
      'with_fresh_decision_engine', count(*) filter (where exists (select 1 from public.property_acquisition_scores a where a.property_id = f.property_id
                                                                      and coalesce((to_jsonb(a)->>'computed_at')::timestamptz, '-infinity') >= pg_catalog.now() - interval '30 days')),
      'conversation_stage_set', count(*) filter (where to_jsonb(f)->>'conversation_stage' is not null),
      'pipeline_stage_set', count(*) filter (where to_jsonb(f)->>'pipeline_stage' is not null),
      'deal_linked', count(*) filter (where to_jsonb(f)->>'deal_id' is not null),
      'last_contact_set', count(*) filter (where to_jsonb(f)->>'last_contact_at' is not null),
      'contacted_90d', count(*) filter (where (to_jsonb(f)->>'last_contact_at')::timestamptz >= pg_catalog.now() - interval '90 days'),
      'estimated_value_set', count(*) filter (where to_jsonb(f)->>'estimated_value' is not null),
      'equity_known', count(*) filter (where to_jsonb(f)->>'equity_known_pct' is not null))
    into coverage from public.eg_property_facts f where p_market is null or f.market = p_market;

  -- ---- evidence coverage (absent columns count 0 and are named in columns_absent)
  select jsonb_build_object(
      'distress_signals', count(*) filter (where coalesce((to_jsonb(f)->>'distress_signal_count')::numeric, 0) > 0),
      'distress_signals_2plus', count(*) filter (where coalesce((to_jsonb(f)->>'distress_signal_count')::numeric, 0) >= 2),
      'tax_delinquent', count(*) filter (where (to_jsonb(f)->>'tax_delinquent')::boolean is true),
      'active_lien', count(*) filter (where (to_jsonb(f)->>'active_lien')::boolean is true),
      'probate', count(*) filter (where (to_jsonb(f)->>'rec_has_probate')::boolean is true),
      'preforeclosure', count(*) filter (where (to_jsonb(f)->>'is_hot_preforeclosure')::boolean is true),
      'equity_30pct_plus', count(*) filter (where coalesce((to_jsonb(f)->>'equity_known_pct')::numeric, -1) >= 30),
      'owner_several_properties', count(*) filter (where coalesce((to_jsonb(f)->>'owner_property_count')::numeric, 0) >= 2),
      'out_of_state_owner', count(*) filter (where (to_jsonb(f)->>'out_of_state_owner')::boolean is true),
      'signals_never_contacted', count(*) filter (where coalesce((to_jsonb(f)->>'distress_signal_count')::numeric, 0) > 0 and to_jsonb(f)->>'last_contact_at' is null))
    into evidence from public.eg_property_facts f where p_market is null or f.market = p_market;

  -- ---- duplicate identities
  select jsonb_build_object(
      'phones_on_several_properties', (select count(*) from (select g.canonical_e164 from public.campaign_target_graph g
                                         where g.canonical_e164 is not null and (p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = g.property_id and f.market = p_market))
                                         group by g.canonical_e164 having count(distinct g.property_id) > 1) x),
      'properties_sharing_address', (select jsonb_build_object('groups', count(*), 'properties', coalesce(sum(n), 0))
                                       from (select count(*) n from public.properties p
                                              where p.property_address_full is not null and (p_market is null or p.market = p_market)
                                              group by lower(regexp_replace(btrim(p.property_address_full), '\s+', ' ', 'g')) having count(*) > 1) x),
      'owners_with_several_properties', (select jsonb_build_object('owners', count(*), 'properties', coalesce(sum(n), 0))
                                           from (select count(*) n from public.properties p where p.master_owner_id is not null and (p_market is null or p.market = p_market)
                                                  group by p.master_owner_id having count(*) > 1) x),
      'properties_with_several_threads', (select count(*) from (select s.property_id from public.inbox_thread_state s
                                            where s.property_id is not null and (p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = s.property_id and f.market = p_market))
                                            group by s.property_id having count(*) > 1) x),
      'facts_without_property_row', (select count(*) from public.eg_property_facts f where (p_market is null or f.market = p_market) and not exists (select 1 from public.properties p where p.property_id = f.property_id)),
      'properties_without_facts_row', (select count(*) from public.properties p where (p_market is null or p.market = p_market) and not exists (select 1 from public.eg_property_facts f where f.property_id = p.property_id)))
    into dups;

  -- ---- contact state (thread flags as recorded; the live authority is the send-time guard)
  select jsonb_build_object(
      'threads_opted_out', count(*) filter (where (to_jsonb(s)->>'opt_out')::boolean is true or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'opted_out'),
      'threads_wrong_number', count(*) filter (where (to_jsonb(s)->>'wrong_number')::boolean is true or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'wrong_number'),
      'threads_suppressed', count(*) filter (where (to_jsonb(s)->>'is_suppressed')::boolean is true),
      'threads_not_contactable', count(*) filter (where lower(coalesce(to_jsonb(s)->>'contactability_status', '')) in ('not_contactable', 'blocked', 'suppressed')),
      'threads_unanswered_inbound', count(*) filter (where s.last_inbound_at is not null and s.last_inbound_at > coalesce(s.last_outbound_at, '-infinity')
                                                       and not ((to_jsonb(s)->>'opt_out')::boolean is true or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'opted_out')),
      'threads_unanswered_over_7d', count(*) filter (where s.last_inbound_at is not null and s.last_inbound_at > coalesce(s.last_outbound_at, '-infinity') and s.last_inbound_at < pg_catalog.now() - interval '7 days'
                                                       and not ((to_jsonb(s)->>'opt_out')::boolean is true or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'opted_out')))
    into contact from public.inbox_thread_state s
   where p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = s.property_id and f.market = p_market);

  -- ---- pipeline health over the facts (labels are labels; the worklist verifies seller words)
  select jsonb_build_object(
      'needs_review_unresolved_14d', count(*) filter (where lower(coalesce(to_jsonb(f)->>'conversation_status', '')) = 'needs_review'
                                                        and coalesce((to_jsonb(f)->>'last_contact_at')::timestamptz, '-infinity') < pg_catalog.now() - interval '14 days'),
      'interest_label_no_contact_30d', count(*) filter (where lower(coalesce(to_jsonb(f)->>'conversation_stage', '')) in ('interested','offer_interest','asking_price','property_condition','offer','s2','s3','s4','s5')
                                                          and coalesce((to_jsonb(f)->>'last_contact_at')::timestamptz, '-infinity') < pg_catalog.now() - interval '30 days'),
      'deal_linked_no_contact_60d', count(*) filter (where to_jsonb(f)->>'deal_id' is not null
                                                       and coalesce((to_jsonb(f)->>'last_contact_at')::timestamptz, '-infinity') < pg_catalog.now() - interval '60 days'),
      'pipeline_without_conversation_stage', count(*) filter (where to_jsonb(f)->>'pipeline_stage' is not null and to_jsonb(f)->>'conversation_stage' is null),
      'sms_opted_out_label_without_thread_opt_out', count(*) filter (where lower(coalesce(to_jsonb(f)->>'sms_status', '')) in ('opted_out','opt_out')
                                                                       and not exists (select 1 from public.inbox_thread_state s where s.property_id = f.property_id
                                                                                         and ((to_jsonb(s)->>'opt_out')::boolean is true or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'opted_out'))),
      'contactable_phone_never_contacted', count(*) filter (where to_jsonb(f)->>'last_contact_at' is null
                                                              and exists (select 1 from public.campaign_target_graph g where g.property_id = f.property_id and g.sms_eligible is true)))
    into health from public.eg_property_facts f where p_market is null or f.market = p_market;

  -- ---- Decision Engine over leads that are in conversation (a thread with inbound) — the leads that need pricing evidence first
  select jsonb_build_object(
      'leads_in_conversation', count(*),
      'without_decision_engine', count(*) filter (where a.property_id is null),
      'decision_engine_older_than_30d', count(*) filter (where a.property_id is not null and coalesce((to_jsonb(a)->>'computed_at')::timestamptz, '-infinity') < pg_catalog.now() - interval '30 days'))
    into engine
    from (select distinct s.property_id from public.inbox_thread_state s
           where s.property_id is not null and s.last_inbound_at is not null
             and (p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = s.property_id and f.market = p_market))) l
    left join public.property_acquisition_scores a on a.property_id = l.property_id;

  return jsonb_build_object('market', p_market, 'as_of', pg_catalog.now(), 'lead_key', 'eg_property_facts.property_id',
                            'columns_present', to_jsonb(present), 'columns_absent', to_jsonb(absent),
                            'sources', sources, 'coverage', coverage, 'evidence', evidence, 'duplicates', dups, 'contact', contact,
                            'pipeline_health', health, 'decision_engine', engine);
end
$fn$;
comment on function public.lc_mcp_corpus_census(text) is 'LeadCommand MCP 1.2: exact populations of every lead-corpus source, coverage over eg_property_facts, evidence / duplicate / contact / pipeline-health counts (optionally one market). Counts only; absent columns named, never guessed.';

-- ------------------------------------------------------------ 2. the lead screen (keyset page) ----
create or replace function public.lc_mcp_lead_screen(p_after text, p_limit integer, p_market text, p_state text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  lim integer := coalesce(p_limit, 200);
  rows jsonb; n integer; more boolean;
begin
  if lim < 1 or lim > 500 then raise exception using errcode = '22023', message = 'lc_mcp_lead_screen: limit must be 1..500'; end if;
  if p_after is not null and p_after !~ '^[A-Za-z0-9_.:-]{1,64}$' then raise exception using errcode = '22023', message = 'lc_mcp_lead_screen: cursor out of bounds'; end if;
  if (p_market is not null and (length(p_market) > 60 or p_market !~ '^[A-Za-z0-9 ,.''&/_()-]+$')) or (p_state is not null and p_state !~ '^[A-Za-z]{2}$') then
    raise exception using errcode = '22023', message = 'lc_mcp_lead_screen: filter out of bounds';
  end if;
  with page as (
    select f.property_id, f.market, to_jsonb(f) as j
      from public.eg_property_facts f
     where (p_after is null or f.property_id > p_after)
       and (p_market is null or f.market = p_market)
       and (p_state is null or upper(to_jsonb(f)->>'property_address_state') = upper(p_state))
     order by f.property_id
     limit lim + 1
  ), ids as (select property_id from page),
  ph as (select g.property_id, count(*) as n, count(*) filter (where g.sms_eligible is true) as eligible
           from public.campaign_target_graph g where g.property_id in (select property_id from ids) group by g.property_id),
  th as (select s.property_id, count(*) as n, max(s.last_inbound_at) as li, max(s.last_outbound_at) as lo,
                bool_or(s.last_inbound_at is not null and s.last_inbound_at > coalesce(s.last_outbound_at, '-infinity')) as unanswered,
                bool_or((to_jsonb(s)->>'opt_out')::boolean is true or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'opted_out') as opted_out,
                bool_or((to_jsonb(s)->>'wrong_number')::boolean is true or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'wrong_number') as wrong_number,
                bool_or((to_jsonb(s)->>'is_suppressed')::boolean is true) as suppressed,
                max(lower(to_jsonb(s)->>'contactability_status')) as contactability
           from public.inbox_thread_state s where s.property_id in (select property_id from ids) group by s.property_id),
  sc as (select a.property_id, (to_jsonb(a)->>'aos_score')::numeric as aos, to_jsonb(a)->>'decision_tier' as tier, (to_jsonb(a)->>'computed_at')::timestamptz as computed_at
           from public.property_acquisition_scores a where a.property_id in (select property_id from ids)),
  ct as (select t.property_id, count(*) as n from public.campaign_targets t where t.property_id in (select property_id from ids) group by t.property_id),
  ordered as (
    select p.property_id, row_number() over (order by p.property_id) as rn,
      jsonb_build_object(
        'property_id', p.property_id, 'market', p.market, 'state', p.j->>'property_address_state', 'zip', p.j->>'zip_code',
        'property_type', p.j->>'property_type', 'asset_type', p.j->>'asset_type', 'units', (p.j->>'units_count')::numeric, 'year_built', (p.j->>'year_built')::numeric,
        'building_sqft', (p.j->>'building_square_feet')::numeric, 'estimated_value', (p.j->>'estimated_value')::numeric,
        'equity', jsonb_build_object('known_pct', (p.j->>'equity_known_pct')::numeric, 'class', p.j->>'equity_class'),
        'distress', jsonb_build_object('signal_count', (p.j->>'distress_signal_count')::numeric, 'tax_delinquent', (p.j->>'tax_delinquent')::boolean, 'active_lien', (p.j->>'active_lien')::boolean,
                                       'probate', (p.j->>'rec_has_probate')::boolean, 'preforeclosure', (p.j->>'is_hot_preforeclosure')::boolean, 'lien_count', (p.j->>'lien_count')::numeric),
        'owner', jsonb_build_object('property_count', (p.j->>'owner_property_count')::numeric, 'type_guess', p.j->>'owner_type_guess', 'out_of_state', (p.j->>'out_of_state_owner')::boolean),
        'contact', jsonb_build_object('phones_on_graph', coalesce(ph.n, 0), 'sms_eligible_phones', coalesce(ph.eligible, 0), 'candidate_phones', (p.j->>'contact_candidate_phones')::numeric, 'sms_status', p.j->>'sms_status'),
        'outreach', jsonb_build_object('campaign_count', (p.j->>'campaign_count')::numeric, 'campaign_targets', coalesce(ct.n, 0)),
        'last_contact', jsonb_build_object('at', (p.j->>'last_contact_at')::timestamptz, 'direction', p.j->>'last_contact_direction'),
        'conversation', jsonb_build_object('stage', p.j->>'conversation_stage', 'status', p.j->>'conversation_status'),
        'pipeline', jsonb_build_object('stage', p.j->>'pipeline_stage', 'status', p.j->>'pipeline_status', 'deal_linked', p.j->>'deal_id' is not null),
        'decision_engine', jsonb_build_object('present', sc.property_id is not null, 'aos_score', sc.aos, 'tier', sc.tier, 'computed_at', sc.computed_at),
        'threads', jsonb_build_object('n', coalesce(th.n, 0), 'last_inbound_at', th.li, 'last_outbound_at', th.lo, 'unanswered', coalesce(th.unanswered, false),
                                      'opted_out', coalesce(th.opted_out, false), 'wrong_number', coalesce(th.wrong_number, false), 'suppressed', coalesce(th.suppressed, false), 'contactability', th.contactability)
      ) as row
      from page p left join ph on ph.property_id = p.property_id left join th on th.property_id = p.property_id
      left join sc on sc.property_id = p.property_id left join ct on ct.property_id = p.property_id)
  select coalesce(jsonb_agg(o.row order by o.rn) filter (where o.rn <= lim), '[]'::jsonb), count(*), bool_or(o.rn > lim)
    into rows, n, more from ordered o;
  return jsonb_build_object('rows', rows, 'has_more', coalesce(more, false), 'limit', lim, 'market', p_market, 'state', p_state, 'as_of', pg_catalog.now(), 'order', 'property_id ascending (keyset: property_id > cursor)');
end
$fn$;
comment on function public.lc_mcp_lead_screen(text, integer, text, text) is 'LeadCommand MCP 1.2: a keyset page (≤ 500) of screening rows over every lead — labels, last contact, evidence flags, phone COUNTS and eligibility, thread state, Decision Engine presence. Never names, phones, thread keys or addresses.';

-- ------------------------------------------------------------ 3. grants + verification ----
revoke all on function public.lc_mcp_corpus_census(text), public.lc_mcp_lead_screen(text, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.lc_mcp_corpus_census(text), public.lc_mcp_lead_screen(text, integer, text, text) to lc_mcp_reader;

do $$
declare
  -- lc-inventory:relations (unchanged: the 1.0 inventory)
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  -- lc-inventory:functions (the 1.0 functions + the 1.1 conversation reads + the two 1.2 census reads)
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_conversation_signals(integer,text)','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_corpus_census(text)','public.lc_mcp_followup_intent_health()','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_lead_screen(text,integer,text,text)','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_pipeline_counts(text,text,text,integer)','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
  rep jsonb;
begin
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not coalesce((rep->>'ok')::boolean, false) then
    raise exception 'lc_mcp_corpus_census: refused — the reader self-check reports %', rep->'findings';
  end if;
  raise notice 'lc_mcp_corpus_census: self-check ok (% relations, % functions)', jsonb_array_length(rep->'relations'), jsonb_array_length(rep->'functions');
end
$$;

notify pgrst, 'reload schema';
