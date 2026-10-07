-- Rollback for PROPOSED_20261007060500 (append-only: reverse history rows are added, none deleted).
begin;
set local lock_timeout = '5s';
insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key)
select o.id, 'stage_transition', 'acquisition_stage', o.acquisition_stage, h.previous_value, 'rollback_repair_offer_without_offer_20261007', 'lifecycle_repair', 'lifecycle_repair_rollback', 'rollback-' || h.idempotency_key
  from public.acquisition_opportunities o join public.acquisition_opportunity_history h on h.opportunity_id = o.id and h.idempotency_key = 'repair-offer-without-offer-20261007:' || o.id;
update public.acquisition_opportunities o
   set acquisition_stage = h.previous_value, updated_at = now(), last_updated_source = 'lifecycle_repair_rollback'
  from public.acquisition_opportunity_history h
 where h.opportunity_id = o.id and h.idempotency_key = 'repair-offer-without-offer-20261007:' || o.id;
update public.acquisition_opportunities o
   set asking_price = h.previous_value::numeric,
       metadata = jsonb_set(o.metadata, '{seller_facts}', (o.metadata->'seller_facts' - 'rejected_asking_price') || jsonb_build_object('asking_price', h.metadata->'seller_facts_asking_price'))
  from public.acquisition_opportunity_history h
 where h.opportunity_id = o.id and h.idempotency_key = 'repair-fake-ask-20261007:' || o.id;
update public.inbox_thread_state t set lifecycle_stage = 'offer', updated_at = now()
  from public.acquisition_opportunities o
 where t.thread_key = o.primary_thread_key and o.last_updated_source = 'lifecycle_repair_rollback';
commit;
