-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016200000_automation_holds_registry.sql (P0 holds registry).
-- Synthetic rows and holds inside BEGIN … ROLLBACK (nothing persists; the release-chain rollback refuses
-- while a hold is active, so this fixture must leave none). Proves on the real trigger bodies:
-- lookup parity, capability scoping, every protected table refuses a held advance, the transaction
-- override is complete-or-refused and audited, release clears a hold, the registry is append-only.
-- Composable with the release chain: every protected-table write uses only the columns the registry
-- baseline guarantees, and a non-held control write is only required NOT to be refused BY A HOLD
-- (other live guards on send_queue may refuse it for their own reasons).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(automation_holds_registry): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare
  opp_h constant uuid := 'd0000000-0000-4000-8000-0000000000a1';
  opp_c constant uuid := 'd0000000-0000-4000-8000-0000000000c1';
  h1 uuid; h2 uuid; h3 uuid; n int; e text; ok boolean;
begin
  -- T0 empty registry: no lookup returns anything
  assert (select count(*) from public.automation_holds) = 0, 'T0 registry starts empty';
  assert not exists (select 1 from public.automation_hold_for('tk_mt_hold', null, 'P_MT_HOLD', opp_h, 'MO_MT', null)), 'T0 empty lookup';

  insert into public.acquisition_opportunities (id, master_owner_id, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status)
  values (opp_h, 'MO_MT_H', 'P_MT_OPP', 'tk_mt_opp', 'offer', 'active'), (opp_c, 'MO_MT_C', 'P_MT_CTRL', 'tk_mt_ctrl', 'offer', 'active');
  -- (authorized_ceiling: every active outbound offer carries its frozen ceiling — the R4 guard of link #28 refuses one without)
  insert into public.seller_offers (offer_id, opportunity_id, property_id, thread_key, purchase_price, authorized_ceiling, status)
  values ('offer:mt:h:v1', opp_h, 'P_MT_OPP', 'tk_mt_opp', 100000, 120000, 'active'), ('offer:mt:c:v1', opp_c, 'P_MT_CTRL', 'tk_mt_ctrl', 100000, 120000, 'active');

  -- holds: H1 thread (all capabilities), H2 property (campaign only), H3 opportunity (all)
  insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref)
  values ('mt:h1', 'operator_hold', 'tk_mt_hold', 'posttest', 'posttest', 'MT-1') returning id into h1;
  insert into public.automation_holds (hold_key, hold_type, property_id, blocked_capabilities, reason, set_by, approval_ref)
  values ('mt:h2', 'operator_hold', 'P_MT_HOLD', array['campaign'], 'posttest', 'posttest', 'MT-2') returning id into h2;
  insert into public.automation_holds (hold_key, hold_type, opportunity_id, reason, set_by, approval_ref)
  values ('mt:h3', 'permanent_exclusion', opp_h, 'posttest', 'posttest', 'MT-3') returning id into h3;
  assert (select count(*) from public.automation_hold_events where event_type = 'hold_set') = 3, 'T1 every hold set is audited';

  -- T2 lookup parity + capability scoping
  assert (select array_agg(id) from public.automation_hold_for('tk_mt_hold', null, null, null, null, 'outbound_send')) = array[h1], 'T2 thread hold';
  assert not exists (select 1 from public.automation_hold_for(null, null, 'P_MT_HOLD', null, null, 'outbound_send')), 'T2 a campaign-only hold does not block outbound_send';
  assert (select array_agg(id) from public.automation_hold_for(null, null, 'P_MT_HOLD', null, null, 'campaign')) = array[h2], 'T2 campaign-only hold blocks campaign';
  assert (select array_agg(id) from public.automation_hold_for(null, null, null, opp_h, null, 'offer_acceptance')) = array[h3], 'T2 opportunity hold';
  assert (select count(*) from public.automation_hold_for('tk_mt_hold', null, 'P_MT_HOLD', opp_h, null, null)) = 3, 'T2 null capability = any hold on any key';

  -- T3 seller_offers: acceptance and a new version refused on the held opportunity
  ok := false; begin update public.seller_offers set status = 'accepted', accepted_at = now(), accepted_price = 100000 where offer_id = 'offer:mt:h:v1';
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: offer_acceptance on seller_offers%'; end; assert ok, 'T3 acceptance refused';
  ok := false; begin insert into public.seller_offers (offer_id, opportunity_id, purchase_price, status) values ('offer:mt:h:v2', opp_h, 110000, 'superseded');
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: offer_write%'; end; assert ok, 'T3 new offer version refused';
  -- T4 closing case refused
  ok := false; begin insert into public.closing_cases (closing_case_id, opportunity_id) values ('cc:mt:h', opp_h);
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: closing_case_create%'; end; assert ok, 'T4 closing case refused';
  -- T5 stage advance + accepted pointer refused; a regression is allowed
  ok := false; begin update public.acquisition_opportunities set acquisition_stage = 'formal_contract' where id = opp_h;
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: stage_advance%'; end; assert ok, 'T5 stage advance refused';
  ok := false; begin update public.acquisition_opportunities set accepted_offer_id = 'offer:mt:h:v1' where id = opp_h;
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: offer_acceptance%'; end; assert ok, 'T5 accepted pointer refused';
  update public.acquisition_opportunities set acquisition_stage = 'asking_price' where id = opp_h;
  assert (select acquisition_stage from public.acquisition_opportunities where id = opp_h) = 'asking_price', 'T5 regression allowed';

  -- T6 send_queue: a sendable row on the held thread is refused (by thread_key and by destination); non-sendable allowed
  ok := false; begin insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key) values ('mt:q1', 'queued', 'x', 'tk_mt_hold', 'tk_mt_hold');
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: outbound_send on send_queue%'; end; assert ok, 'T6 held sendable insert refused';
  ok := false; begin insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number) values ('mt:q2', 'scheduled', 'x', 'tk_mt_hold');
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: outbound_send%'; end; assert ok, 'T6 held destination refused';
  ok := false; begin insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, metadata) values ('mt:q3', 'queued', 'x', 'tk_mt_hold', 'tk_mt_hold', '{"manual_operator_send": true}');
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD: manual_send%'; end; assert ok, 'T6 manual send without override refused';
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key) values ('mt:q4', 'paused_operator_review', 'x', 'tk_mt_hold', 'tk_mt_hold');
  assert (select count(*) from public.send_queue where queue_key = 'mt:q4') = 1, 'T6 a non-sendable row is allowed';
  -- a campaign-only property hold is not a send hold (another live guard may still refuse the row for its own reasons)
  e := null; begin insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, property_id) values ('mt:q5', 'queued', 'x', 'tk_mt_free', 'tk_mt_free', 'P_MT_HOLD');
  exception when others then e := sqlerrm; end; assert e is null or e not like 'AUTOMATION_HOLD%', 'T6 campaign-only hold must not refuse a send: ' || coalesce(e, '');

  -- T7 transaction override: incomplete = refused; complete = allowed + audited; cleared afterwards
  perform set_config('lc.automation_hold_override_ref', 'MT-OVR', true);
  perform set_config('lc.automation_hold_override_reason', 'owner approved', true);
  ok := false; begin update public.acquisition_opportunities set acquisition_stage = 'formal_contract' where id = opp_h;
  exception when others then ok := sqlerrm like 'AUTOMATION_HOLD:%'; end; assert ok, 'T7 override without actor refused';
  perform set_config('lc.automation_hold_override_actor', 'op_mt', true);
  update public.acquisition_opportunities set acquisition_stage = 'formal_contract' where id = opp_h;
  assert (select count(*) from public.automation_hold_events where event_type = 'override_used' and approval_ref = 'MT-OVR' and actor = 'op_mt') = 1, 'T7 override audited';
  perform set_config('lc.automation_hold_override_ref', '', true);
  perform set_config('lc.automation_hold_override_reason', '', true);
  perform set_config('lc.automation_hold_override_actor', '', true);

  -- T8 CONTROL: a non-held deal advances normally
  update public.seller_offers set status = 'accepted', accepted_at = now(), accepted_price = 100000 where offer_id = 'offer:mt:c:v1';
  update public.acquisition_opportunities set accepted_offer_id = 'offer:mt:c:v1', acquisition_stage = 'formal_contract' where id = opp_c;
  insert into public.closing_cases (closing_case_id, opportunity_id) values ('cc:mt:c', opp_c);
  assert (select count(*) from public.closing_cases where closing_case_id = 'cc:mt:c') = 1, 'T8 control closing case';

  -- T9 append-only: delete / arbitrary update refused; a complete release clears the hold and is audited
  ok := false; begin delete from public.automation_holds where id = h1; exception when others then ok := sqlerrm like 'AUTOMATION_HOLD_APPEND_ONLY%'; end; assert ok, 'T9 delete refused';
  ok := false; begin update public.automation_holds set reason = 'edited' where id = h1; exception when others then ok := sqlerrm like 'AUTOMATION_HOLD_APPEND_ONLY%'; end; assert ok, 'T9 edit refused';
  ok := false; begin update public.automation_hold_events set actor = 'x'; exception when others then ok := sqlerrm like 'AUTOMATION_HOLD_APPEND_ONLY%'; end; assert ok, 'T9 events immutable';
  update public.automation_holds set released_at = now(), released_by = 'posttest', release_reason = 'posttest release' where id in (h1, h2, h3);
  assert not exists (select 1 from public.automation_hold_for('tk_mt_hold', null, 'P_MT_HOLD', opp_h, null, null)), 'T9 released holds hold nothing';
  assert (select count(*) from public.automation_hold_events where event_type = 'hold_released') = 3, 'T9 releases audited';
  insert into public.closing_cases (closing_case_id, opportunity_id) values ('cc:mt:h', opp_h);

  -- T10 privileges / RLS (the migration's design)
  assert not has_table_privilege('anon', 'public.automation_holds', 'select'), 'T10 anon cannot read';
  assert not has_table_privilege('service_role', 'public.automation_holds', 'delete'), 'T10 service_role cannot delete';
  assert (select relrowsecurity from pg_class where oid = 'public.automation_holds'::regclass), 'T10 RLS on';
  raise notice 'posttest(automation_holds_registry): ALL OK (rolled back)';
end
$$;
rollback;
