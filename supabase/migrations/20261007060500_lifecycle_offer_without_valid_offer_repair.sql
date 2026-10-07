-- PROPOSED — NOT APPLIED. Lifecycle repair (deal-attribution audit 2026-10-07).
-- 13 deals at S5 'offer' with no offer event (current_offer = 0, no seller_offers,
-- no offer-bearing message). Each returns to the HIGHEST stage its conversation
-- supports; the fake $331 / 2024 asks are cleared (kept as rejected evidence);
-- history is appended, never deleted. Row-count assertions abort on any drift.
-- DRY RUN: PROPOSED_20261007060500_lifecycle_offer_without_valid_offer_repair_dryrun.sql
-- (identical, ends in ROLLBACK). The 5 operator-number threads are handled separately.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The 13 deals and the HIGHEST stage their conversation genuinely supports
-- (S5 Offer needs an offer event, which none has). Evidence = inbound intents
-- on the thread + the questions we sent; fake price evidence never counts.
create temp table _repair(property_id text primary key, to_stage text not null, clear_fake_ask boolean not null, evidence text not null) on commit drop;
insert into _repair values
    ('212147040', 'property_condition', false, 'ownership_confirmed + plausible ask $735,000 given'),
    ('2127799218', 'property_condition', false, 'ownership_confirmed + plausible ask $325,000 given'),
    ('2128019960', 'property_condition', false, 'ownership_confirmed + ask $32,000 given (tenant_respondent also seen: review identity)'),
    ('2128071952', 'asking_price', true, 'fake ask 2024 (bare year) cleared; interest shown (we asked the price)'),
    ('2131568425', 'property_condition', false, 'asks_offer (declined to price, wants an offer)'),
    ('213304174', 'property_condition', false, 'asks_offer + tenant_occupied (condition/occupancy partly known)'),
    ('2135985900', 'property_condition', false, 'seller_interested + plausible ask $114,000 + condition_disclosed'),
    ('2173138897', 'property_condition', false, 'plausible ask $160,000 given'),
    ('234331496', 'property_condition', false, 'latent_interest + asks_offer'),
    ('273330908', 'property_condition', false, 'plausible ask $500,000 given'),
    ('274561156', 'property_condition', false, 'ownership_confirmed + plausible ask $420,000 given'),
    ('296670809', 'asking_price', true, 'fake ask $331 cleared; latent_interest shown'),
    ('canaryprop_6bb8a46414092cb6318fbc35', 'property_condition', false, 'canary property (archived): asks_offer');

create temp table _before on commit drop as
select o.id, o.primary_property_id as property_id, o.primary_thread_key, o.acquisition_stage, o.asking_price,
       o.metadata->'seller_facts'->'asking_price' as sf_ask, o.metadata->'negotiation_state'->'current_asking_price' as ns_ask,
       t.lifecycle_stage as thread_stage
  from public.acquisition_opportunities o
  join _repair r on r.property_id = o.primary_property_id
  left join public.inbox_thread_state t on t.thread_key = o.primary_thread_key
 where o.acquisition_stage = 'offer';

do $$ declare n int; begin
  select count(*) into n from _before;
  if n <> 13 then raise exception 'expected 13 deals still at offer, found %', n; end if;
end $$;

-- history first (append only; nothing is deleted)
insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
select b.id, 'stage_transition', 'acquisition_stage', b.acquisition_stage, r.to_stage,
       'repair_offer_without_offer_event_20261007', 'lifecycle_repair', 'lifecycle_repair',
       'repair-offer-without-offer-20261007:' || b.id, jsonb_build_object('evidence', r.evidence, 'thread_stage_before', b.thread_stage)
  from _before b join _repair r using (property_id);

insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
select b.id, 'field_change', 'asking_price', b.asking_price::text, null,
       'repair_fake_price_evidence_20261007', 'lifecycle_repair', 'lifecycle_repair',
       'repair-fake-ask-20261007:' || b.id, jsonb_build_object('seller_facts_asking_price', b.sf_ask, 'rule', case when b.asking_price between 1900 and 2100 then 'bare_year' else 'below_property_price_floor' end)
  from _before b join _repair r using (property_id) where r.clear_fake_ask;

-- opportunity: stage back; fake price cleared from the column AND the evidence
-- (kept under rejected_asking_price, never deleted)
update public.acquisition_opportunities o
   set acquisition_stage = r.to_stage,
       asking_price = case when r.clear_fake_ask then null else o.asking_price end,
       metadata = case when r.clear_fake_ask then
         jsonb_set(jsonb_set(o.metadata,
           '{seller_facts}', (coalesce(o.metadata->'seller_facts','{}'::jsonb) - 'asking_price') || jsonb_build_object('rejected_asking_price', (o.metadata->'seller_facts'->'asking_price') || jsonb_build_object('rejected_reason','fake_price_evidence_20261007'))),
           '{negotiation_state}', (coalesce(o.metadata->'negotiation_state','{}'::jsonb) - 'current_asking_price') || jsonb_build_object('rejected_asking_price', o.metadata->'negotiation_state'->'current_asking_price'))
         else o.metadata end,
       stage_entered_at = now(), last_updated_source = 'lifecycle_repair', last_updated_by = 'lifecycle_repair_20261007',
       version = coalesce(o.version,1) + 1, updated_at = now()
  from _repair r
 where r.property_id = o.primary_property_id and o.acquisition_stage = 'offer';

update public.inbox_thread_state t
   set lifecycle_stage = r.to_stage, updated_at = now()
  from _before b join _repair r using (property_id)
 where t.thread_key = b.primary_thread_key and t.lifecycle_stage is distinct from r.to_stage and t.lifecycle_stage = 'offer';

do $$ declare n int; h int; f int; begin
  select count(*) into n from public.acquisition_opportunities where last_updated_by = 'lifecycle_repair_20261007' and updated_at > now() - interval '5 minutes';
  select count(*) into h from public.acquisition_opportunity_history where idempotency_key like 'repair-%-20261007:%' and created_at > now() - interval '5 minutes';
  select count(*) into f from public.acquisition_opportunities where primary_property_id in ('296670809','2128071952') and (asking_price is not null or metadata->'seller_facts' ? 'asking_price');
  if n <> 13 then raise exception 'expected 13 repaired deals, got %', n; end if;
  if h <> 15 then raise exception 'expected 15 history rows (13 stage + 2 price), got %', h; end if;
  if f <> 0 then raise exception 'fake price evidence still present on % deal(s)', f; end if;
end $$;

-- BEFORE -> AFTER
select b.property_id, b.acquisition_stage || ' -> ' || o.acquisition_stage as opportunity_stage,
       coalesce(b.thread_stage,'(none)') || ' -> ' || coalesce(t.lifecycle_stage,'(none)') as thread_stage,
       coalesce(b.asking_price::text,'null') || ' -> ' || coalesce(o.asking_price::text,'null') as asking_price,
       r.evidence
  from _before b join _repair r using (property_id)
  join public.acquisition_opportunities o on o.id = b.id
  left join public.inbox_thread_state t on t.thread_key = b.primary_thread_key
 order by 1;

commit;
