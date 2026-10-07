-- Rollback for PROPOSED_20261007060000: restore stage + asking price from the history rows it wrote.
begin;
set local lock_timeout = '5s';
update public.acquisition_opportunities o
   set acquisition_stage = h.previous_value, updated_at = now(), last_updated_source = 'lifecycle_repair_rollback'
  from public.acquisition_opportunity_history h
 where h.opportunity_id = o.id and h.idempotency_key = 'repair-offer-without-offer-20261007:' || o.id;
update public.acquisition_opportunities o
   set asking_price = h.previous_value::numeric
  from public.acquisition_opportunity_history h
 where h.opportunity_id = o.id and h.idempotency_key = 'repair-implausible-ask-20261007:' || o.id;
update public.inbox_thread_state t
   set lifecycle_stage = 'offer', updated_at = now()
  from public.acquisition_opportunities o
 where t.thread_key = o.primary_thread_key and o.acquisition_stage = 'offer' and o.last_updated_source = 'lifecycle_repair_rollback';
delete from public.acquisition_opportunity_history where idempotency_key like 'repair-%-20261007:%';
commit;
