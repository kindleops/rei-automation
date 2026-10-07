-- PROPOSED — NOT APPLIED. Owner / lead approval required. Rollback-txn pretest first.
--
-- Lifecycle repair (deal-attribution audit 2026-10-07): acquisition_opportunities
-- sitting at S5 'offer' with NO valid offer (current_offer = 0 on every one,
-- no active_offer_id, no seller_offers row) — promoted by the pre-gate live path
-- (backfill / parsed replies). Read-only measured 2026-10-07 ~06:45Z:
--   18 at 'offer' · 0 at formal_contract and later · 18 with current_offer = 0
--   · 2 with an implausible asking price ($331, 2024) · 0 with a live closing case.
--
-- A) 13 rows with no offer-bearing message ever sent: moved BACK to the stage
--    the last automated question supports (property_condition / asking_price /
--    offer_interest), the implausible asks (331, 2024) cleared, history appended,
--    thread projection aligned. The new stage gate (766e7f7b) keeps them there
--    until a real offer exists.
-- B) 5 rows whose thread carries operator-typed messages containing a $
--    amount (a manual offer may have been made): NOT changed here — listed for an
--    operator to record the real offer (current_offer / seller_offers) or demote.
--    ids: '9b690ce3-ff88-400b-b56e-69e9bd0055b0', '0c651e16-2f58-43db-8dbb-e21943130ff8', '950304c3-67ed-4ab1-ac10-8098eb139326', 'e1db7c94-60ba-4438-af41-80b6b08535b1', '3d5c9437-0be0-4eb5-be60-77a181b769fe'
--
-- Expected pretest: A updates exactly 13 opportunities (only while still at 'offer').

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temp table _repair(id uuid primary key, property_id text, to_stage text, clear_ask boolean) on commit drop;
insert into _repair values
    ('e2113b82-ce81-4618-9a4f-19296a76b1a7'::uuid, '212147040', 'offer_interest', false),
    ('5610e713-f29d-403d-a12b-922ac3f525dc'::uuid, '2127799218', 'property_condition', false),
    ('21177b37-c852-435c-8999-d0efa9e3907d'::uuid, '2128019960', 'offer_interest', false),
    ('1fe41a0b-e19c-40c3-9f1c-b1be54cf2fd7'::uuid, '2131568425', 'offer_interest', false),
    ('84de5b0f-719f-4c45-86c6-6140df085f46'::uuid, '213304174', 'property_condition', false),
    ('298696af-19b3-4f50-8af9-77bc79cd53d2'::uuid, '2135985900', 'property_condition', false),
    ('1b2a7c2d-8d55-4f7c-b167-c384176566db'::uuid, '2173138897', 'property_condition', false),
    ('6814c7af-5ddd-4d50-9378-a9b0041d2b62'::uuid, '234331496', 'property_condition', false),
    ('e47e82b2-01b2-46cd-bc43-c94d8c4dcaba'::uuid, '273330908', 'property_condition', false),
    ('5ed6f774-4acf-4270-b5d0-11593a841cd5'::uuid, '274561156', 'property_condition', false),
    ('6bc08074-143a-4634-8e34-bd1868d4c204'::uuid, '296670809', 'offer_interest', true),
    ('f554add3-4503-4454-bcd3-ea6b578ee8a2'::uuid, 'canaryprop_6bb8a46414092cb6318fbc35', 'offer_interest', false),
    ('017df192-98d2-4060-8dc0-d6ca014acfd7'::uuid, '2128071952', 'asking_price', true);

-- history first (audit trail; the previous values make the rollback exact)
insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key)
select o.id, 'stage_transition', 'acquisition_stage', o.acquisition_stage, r.to_stage,
       'repair_offer_without_valid_offer_20261007', 'agent_b', 'lifecycle_repair',
       'repair-offer-without-offer-20261007:' || o.id
from public.acquisition_opportunities o join _repair r on r.id = o.id
where o.acquisition_stage = 'offer'
on conflict do nothing;

insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key)
select o.id, 'field_change', 'asking_price', o.asking_price::text, null,
       'repair_implausible_asking_price_20261007', 'agent_b', 'lifecycle_repair',
       'repair-implausible-ask-20261007:' || o.id
from public.acquisition_opportunities o join _repair r on r.id = o.id
where r.clear_ask and o.acquisition_stage = 'offer'
on conflict do nothing;

update public.acquisition_opportunities o
   set acquisition_stage = r.to_stage,
       asking_price = case when r.clear_ask then null else o.asking_price end,
       stage_entered_at = now(),
       last_updated_source = 'lifecycle_repair',
       last_updated_by = 'agent_b_repair_20261007',
       version = coalesce(o.version, 1) + 1,
       updated_at = now()
  from _repair r
 where r.id = o.id and o.acquisition_stage = 'offer';

update public.inbox_thread_state t
   set lifecycle_stage = r.to_stage, updated_at = now()
  from public.acquisition_opportunities o join _repair r on r.id = o.id
 where t.thread_key = o.primary_thread_key and t.lifecycle_stage = 'offer';

-- pretest guard: exactly the expected rows, else abort
do $$
declare n int;
begin
  select count(*) into n from public.acquisition_opportunities where last_updated_by = 'agent_b_repair_20261007' and updated_at > now() - interval '5 minutes';
  if n <> 13 then raise exception 'expected 13 repaired opportunities, got %', n; end if;
end $$;

commit;
