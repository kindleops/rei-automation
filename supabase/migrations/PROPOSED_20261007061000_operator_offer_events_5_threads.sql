-- PROPOSED — NOT APPLIED. Owner / lead approval required.
--
-- Reconciles the 5 operator-number threads (deal-attribution audit 2026-10-07):
-- each operator-typed price was read from the exact outbound message and
-- classified (offer / anchor / value or comps / repair cost / echo of the ask).
-- All 5 carried a real OPERATOR offer, so each gets a seller_offers row (the
-- canonical Offer Term Authority table) with the offer-event fields in
-- metadata.offer_event until PROPOSED_20261007062000 adds them as columns:
--   source = operator · quote_type · send_queue_row_id (message identity)
--   · sent_at (timestamp) · opportunity_id + thread_key (deal / conversation).
-- The deals stay at S5 Offer (now backed by an offer event). NOTHING moves to
-- Formal Contract: there is no contract record. current_offer / active_offer_id
-- follow the active version. Operator id: the manual sends carry no operator
-- id (only operator_action_id) — recorded as 'operator_unattributed'.
--
-- terms_hash: md5 of the offer identity + price (no other terms were agreed).

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temp table _ev(opportunity_id uuid, property_id text, thread_key text, offer_version int, price numeric, status text,
  sent_at timestamptz, send_queue_row_id text, quote_type text, why text, extra jsonb) on commit drop;
insert into _ev values
  ('0c651e16-2f58-43db-8dbb-e21943130ff8'::uuid, '274574569', '+16512086587', 1, 825000, 'active', '2026-10-07 02:06+00'::timestamptz, 'f63df31f-e0b3-4732-b8a1-98c81879a170', 'FORMAL_OFFER', '"I''d be at $825,000 cash … purchase it as-is … cover all closing costs … I can get a purchase agreement over right away": a definite total with payment, condition and costs and an invitation to contract. Not an anchor (no hedge, no range); $75,000/unit is the per-door qualifier.', '{"per_unit": 75000, "units": 11}'::jsonb),
  ('e1db7c94-60ba-4438-af41-80b6b08535b1'::uuid, '273312064', '+16122756497', 1, 132000, 'active', '2026-09-30 15:30+00'::timestamptz, 'a8b90003-cd2a-4eac-ab58-94ee7cdcfc09', 'FORMAL_OFFER', '09-30 "I''d be at $132,000 and can close in 7 days … Would that work for you?"; 10-06 "moving forward with my offer at $132,000 cash with a 7 day close" names it our offer. $193K/$64.5K (county value/repairs) and $240K ARV / $40K repairs / $140K are value math, not offers.', '{"reaffirmed_send_queue_id": "b5870d3c-f4cb-4c59-90f6-0f56aa74b322"}'::jsonb),
  ('950304c3-67ed-4ab1-ac10-8098eb139326'::uuid, '2131065026', '+18324345395', 1, 40000, 'superseded', '2026-07-07 20:03+00'::timestamptz, '7ed49d0c-380b-4737-b4e7-3d9c9f6fc7ff', 'FORMAL_OFFER', '"Si $40K le convienen, puedo redactar un contrato y cerrarlo en siete días": a firm price with a contract offer. $70K = county repair estimate (repair cost, not an offer).', '{}'::jsonb),
  ('950304c3-67ed-4ab1-ac10-8098eb139326'::uuid, '2131065026', '+18324345395', 2, 55000, 'active', '2026-07-09 21:33+00'::timestamptz, '36a44038-91f9-440b-aead-dbba67e78c3c', 'CONCESSION', '"puedo ofrecer $55K. Si le funciona, preparo el contrato hoy mismo": the revised offer (concession over $40K); the active offer.', '{"supersedes_version": 1}'::jsonb),
  ('3d5c9437-0be0-4eb5-be60-77a181b769fe'::uuid, '219706722', '+19254579155', 1, 222000, 'active', '2026-09-25 00:41+00'::timestamptz, '84656791-312d-4d23-9d3a-8ae8cf884d01', 'FORMAL_OFFER', '"I''d be at $222K as-is, closing on your timeline / can close in 7 days. Would that work for you?": a definite as-is cash price. NOTE: sent 6 times in 4 minutes (00:41-00:45) — duplicate manual sends.', '{"duplicate_send_queue_ids": ["b8c9567a-e94e-4a1a-ad8b-549b25842e05","5eabb3f5-a9e3-432f-beff-61c48a97c0bc","ed073d3c-8f99-4b89-97fd-b2e2226933fb","85b1d0d7-f178-4494-b4f4-869b0d8c8d8b","0a0f1c14-1ef9-4bc7-a939-4f0d31b62e23"]}'::jsonb),
  ('9b690ce3-ff88-400b-b56e-69e9bd0055b0'::uuid, '225438557', '+12039942149', 1, 315000, 'active', '2026-09-25 16:21+00'::timestamptz, '125d1929-a4df-4394-baa1-abb7ed5b5b84', 'FORMAL_OFFER', '01:34 "I''d be at around $315K" was a hedged ANCHOR equal to the seller''s $315,000 ask (echo); 16:21 "I''m good to move forward at $315,000. I can send over the purchase agreement today" agrees to buy at the seller''s ask = a formal offer at their price. Not Formal Contract (no contract / closing case). The deal is operator-archived.', '{"anchor_send_queue_id": "7cf6cc13-2a99-4ef7-a16e-76793acf5660", "equals_seller_ask": true}'::jsonb);

do $$ declare n int; begin
  select count(*) into n from public.seller_offers s join _ev e on e.opportunity_id = s.opportunity_id;
  if n <> 0 then raise exception 'seller_offers already has % row(s) for these deals; reconcile by hand', n; end if;
  select count(*) into n from public.acquisition_opportunities o join (select distinct opportunity_id from _ev) e on e.opportunity_id = o.id where o.acquisition_stage = 'offer';
  if n <> 5 then raise exception 'expected the 5 deals at offer, found %', n; end if;
end $$;

insert into public.seller_offers (offer_id, opportunity_id, property_id, thread_key, offer_version, offer_type, direction,
  purchase_price, status, sent_at, superseded_at, send_queue_row_id, terms_hash, policy_version, metadata)
select 'offer:' || e.opportunity_id || ':v' || e.offer_version, e.opportunity_id, e.property_id, e.thread_key, e.offer_version, 'cash', 'outbound',
       e.price, e.status, e.sent_at, case when e.status = 'superseded' then (select sent_at from _ev x where x.opportunity_id = e.opportunity_id and x.offer_version = e.offer_version + 1) end,
       e.send_queue_row_id, md5('offer:' || e.opportunity_id || ':v' || e.offer_version || ':' || e.price::text), 'operator_offer_event_reconcile_20261007',
       jsonb_build_object('offer_event', jsonb_build_object(
         'source', 'operator', 'operator_id', 'operator_unattributed', 'quote_type', e.quote_type,
         'amount', e.price, 'sent_at', e.sent_at, 'opportunity_id', e.opportunity_id, 'thread_key', e.thread_key,
         'send_queue_row_id', e.send_queue_row_id, 'classification_rationale', e.why, 'reconciled_at', now(),
         'reconciled_by', 'lifecycle_repair_20261007') || e.extra)
from _ev e;

update public.seller_offers s
   set superseded_by_offer_id = 'offer:' || s.opportunity_id || ':v' || (s.offer_version + 1)
 where s.policy_version = 'operator_offer_event_reconcile_20261007' and s.status = 'superseded';

update public.acquisition_opportunities o
   set current_offer = s.purchase_price, active_offer_id = s.offer_id, updated_at = now(),
       last_updated_source = 'lifecycle_repair', last_updated_by = 'lifecycle_repair_20261007'
  from public.seller_offers s
 where s.opportunity_id = o.id and s.status = 'active' and s.policy_version = 'operator_offer_event_reconcile_20261007';

insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
select s.opportunity_id, 'field_change', 'current_offer', '0', s.purchase_price::text, 'operator_offer_event_reconciled_20261007', 'lifecycle_repair', 'lifecycle_repair',
       'reconcile-operator-offer-20261007:' || s.offer_id, s.metadata->'offer_event'
  from public.seller_offers s where s.policy_version = 'operator_offer_event_reconcile_20261007';

do $$ declare n int; a int; begin
  select count(*) into n from public.seller_offers where policy_version = 'operator_offer_event_reconcile_20261007';
  select count(*) into a from public.acquisition_opportunities where last_updated_by = 'lifecycle_repair_20261007' and active_offer_id like 'offer:%' and acquisition_stage = 'offer';
  if n <> 6 then raise exception 'expected 6 offer rows (5 deals; 2131065026 has v1 superseded + v2 active), got %', n; end if;
  if a <> 5 then raise exception 'expected 5 deals backed by an active offer, got %', a; end if;
end $$;

commit;
