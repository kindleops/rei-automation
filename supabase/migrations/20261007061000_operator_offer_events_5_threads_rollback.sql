-- Rollback for PROPOSED_20261007061000 (removes only the reconciled offer rows; history is kept and a reverse row appended).
begin;
set local lock_timeout = '5s';
insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key)
select o.id, 'field_change', 'current_offer', o.current_offer::text, '0', 'rollback_operator_offer_event_reconcile_20261007', 'lifecycle_repair', 'lifecycle_repair_rollback', 'rollback-reconcile-operator-offer-20261007:' || o.id
  from public.acquisition_opportunities o where o.active_offer_id in (select offer_id from public.seller_offers where policy_version = 'operator_offer_event_reconcile_20261007');
update public.acquisition_opportunities set current_offer = 0, active_offer_id = null, updated_at = now(), last_updated_source = 'lifecycle_repair_rollback'
 where active_offer_id in (select offer_id from public.seller_offers where policy_version = 'operator_offer_event_reconcile_20261007');
delete from public.seller_offers where policy_version = 'operator_offer_event_reconcile_20261007' and status in ('active','superseded') and accepted_at is null;
commit;
