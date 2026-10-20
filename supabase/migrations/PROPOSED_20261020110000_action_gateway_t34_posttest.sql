-- POSTTEST for PROPOSED_20261020110000_action_gateway_t34.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It runs in one transaction and ends in ROLLBACK. The runner proves the schema is unchanged afterwards.
--   A. the COMPOSED self-check is ok and names this link; the previous self-check is preserved (renamed);
--   B. lc_action_gateway executes exactly its new entry points / definer reads / domain writes and reaches NONE of
--      LeadCommand's writers (the receipt writer, the budget consumer, the worker reads) nor the receipts / uses tables;
--   C. R4: an outbound active offer with no ceiling, or above the lowest ceiling (frozen ceiling, the LIVE envelope
--      max of its scope), is refused by the database; an agent "override" is refused; a complete human override
--      passes; a seller counter (inbound) is never capped;
--   D. R5: the durable budget — a max_sends = 1 authorization is consumed ONCE; the same use key replays; a second
--      key is refused send_budget_exhausted; an amount above the ceiling and a revoked authorization are refused;
--      the uses are immutable;
--   E. the authorization guard refuses an envelope ref on an action that is not envelope-authorized.
begin;

do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then raise exception 'A: composed self-check not ok: %', v -> 'findings'; end if;
  if not (v -> 'links') ? 'action_gateway_t34' then raise exception 'A: the composed self-check does not name this link: %', v -> 'links'; end if;
  if to_regprocedure('action_gateway.self_check_pre_t34(name)') is null then raise exception 'A: the previous self-check was not preserved'; end if;
end $$;

-- B
do $$
declare f text;
begin
  foreach f in array array['public.action_gateway_authorize_envelope(uuid,text,jsonb)', 'public.action_gateway_receipt_get(uuid)', 'public.action_gateway_negotiation_state(uuid,text)',
      'public.action_gateway_offer_authority(text)', 'public.action_gateway_dw_handoff(uuid,uuid)', 'public.action_gateway_dw_offer_envelope(uuid,uuid)'] loop
    if not has_function_privilege('lc_action_gateway', f, 'EXECUTE') then raise exception 'B: the role cannot execute %', f; end if;
  end loop;
  foreach f in array array['public.lc_seller_action_receipt_record(uuid,text,text,text,jsonb,text)', 'public.negotiation_send_authorization_consume(uuid,text,numeric)',
      'public.lc_seller_action_load(uuid)', 'public.lc_seller_action_open_receipts(integer)', 'action_gateway.envelope_ref_refusal(uuid,text)', 'action_gateway.t34_capability_refusal(text)'] loop
    if has_function_privilege('lc_action_gateway', f, 'EXECUTE') then raise exception 'B: the role can execute LeadCommand-side %', f; end if;
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then raise exception 'B: anon / authenticated can execute %', f; end if;
  end loop;
  if has_table_privilege('lc_action_gateway', 'action_gateway.seller_action_receipts', 'INSERT') or has_table_privilege('lc_action_gateway', 'action_gateway.seller_action_receipts', 'UPDATE') then raise exception 'B: the role can write receipts'; end if;
  if has_table_privilege('lc_action_gateway', 'public.negotiation_send_authorization_uses', 'SELECT') or has_table_privilege('lc_action_gateway', 'public.negotiation_send_authorization_uses', 'INSERT') then raise exception 'B: the role reaches the uses table'; end if;
  begin
    set local role lc_action_gateway;
    perform public.negotiation_send_authorization_consume(gen_random_uuid(), 'probe:use:0001', 1000);
    raise exception 'B: the role consumed a send-budget use';
  exception when insufficient_privilege then reset role;
  end;
end $$;

-- C + D
do $$
declare
  tk text := '+15555550199'; pid text := '990001001';
  v_scope text := action_gateway.scope_key_of('+15555550199', '990001001');
  e uuid; sa uuid; r jsonb;
begin
  -- C: no ceiling
  begin
    insert into public.seller_offers (offer_id, thread_key, property_id, direction, purchase_price, status, terms_hash, metadata) values ('offer:pt:1', tk, pid, 'outbound', 140000, 'active', 'h', '{}');
    raise exception 'C: an outbound offer without a ceiling was accepted';
  exception when raise_exception then if sqlerrm not like 'SELLER_OFFER_CEILING_MISSING%' then raise; end if;
  end;
  begin
    insert into public.seller_offers (offer_id, thread_key, property_id, direction, purchase_price, authorized_ceiling, status, terms_hash, metadata) values ('offer:pt:2', tk, pid, 'outbound', 315000, 126100, 'active', 'h', '{}');
    raise exception 'C: the Hartford-shape offer was accepted';
  exception when raise_exception then if sqlerrm not like 'SELLER_OFFER_ABOVE_CEILING%' then raise; end if;
  end;
  begin
    insert into public.seller_offers (offer_id, thread_key, property_id, direction, purchase_price, authorized_ceiling, status, terms_hash, metadata)
    values ('offer:pt:3', tk, pid, 'outbound', 315000, 126100, 'active', 'h', '{"ceiling_override": {"operator_id": "agt_alpha", "reason": "the agent says it is fine", "approval_ref": "x"}}');
    raise exception 'C: an agent override was accepted';
  exception when raise_exception then if sqlerrm not like 'SELLER_OFFER_ABOVE_CEILING%' then raise; end if;
  end;
  insert into public.seller_offers (offer_id, thread_key, property_id, direction, purchase_price, authorized_ceiling, status, terms_hash, metadata)
  values ('offer:pt:4', tk, pid, 'outbound', 131000, 126100, 'superseded', 'h', '{}'); -- not active: offers nothing
  insert into public.seller_offers (offer_id, thread_key, property_id, direction, purchase_price, authorized_ceiling, status, terms_hash, metadata)
  values ('offer:pt:5', tk, pid, 'outbound', 131000, 126100, 'active', 'h', '{"ceiling_override": {"operator_id": "2b3ee0ff-0000-4000-8000-0000000000c2", "reason": "owner reviewed comps by phone", "approval_ref": "ops-77"}}');
  insert into public.seller_offers (offer_id, thread_key, property_id, direction, offer_type, purchase_price, status, terms_hash, metadata)
  values ('offer:pt:6', tk, pid, 'inbound', 'seller_counter', 400000, 'active', 'h', '{}');
  -- the live envelope of the scope caps below the frozen ceiling
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, opening_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max,
                                            closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
  values (v_scope, 1, action_gateway.thread_ref_of(tk), pid, 120000, 110000, 14, 30, 1000, 1000, 'buyer', now() + interval '3 days', 'op', 'apr_00000000-0000-4000-8000-00000000f001', '{}', repeat('a', 64), repeat('b', 64))
  returning envelope_id into e;
  begin
    insert into public.seller_offers (offer_id, thread_key, property_id, direction, purchase_price, authorized_ceiling, status, terms_hash, metadata) values ('offer:pt:7', tk, pid, 'outbound', 125000, 126100, 'active', 'h', '{}');
    raise exception 'C: an offer above the live envelope max was accepted';
  exception when raise_exception then if sqlerrm not like 'SELLER_OFFER_ABOVE_CEILING%' then raise; end if;
  end;

  -- D
  insert into public.negotiation_send_authorizations (scope_key, thread_ref, property_id, envelope_id, envelope_version, ceiling, terms, terms_hash, max_sends, expires_at, granted_by, approval_id, authorization_hash)
  values (v_scope, action_gateway.thread_ref_of(tk), pid, e, 1, 115000, '{}', repeat('c', 64), 1, now() + interval '1 day', 'op', 'apr_00000000-0000-4000-8000-00000000f002', repeat('d', 64))
  returning send_authorization_id into sa;
  r := public.negotiation_send_authorization_consume(sa, 'pt:use:000001', 116000);
  if r ->> 'reason' <> 'amount_above_send_ceiling' then raise exception 'D: above-ceiling consume: %', r; end if;
  r := public.negotiation_send_authorization_consume(sa, 'pt:use:000001', 110000);
  if not (r ->> 'ok')::boolean or (r ->> 'use_no')::int <> 1 then raise exception 'D: first consume: %', r; end if;
  r := public.negotiation_send_authorization_consume(sa, 'pt:use:000001', 110000);
  if not (r ->> 'replayed')::boolean then raise exception 'D: replay: %', r; end if;
  r := public.negotiation_send_authorization_consume(sa, 'pt:use:000002', 110000);
  if r ->> 'reason' <> 'send_budget_exhausted' then raise exception 'D: budget: %', r; end if;
  begin
    update public.negotiation_send_authorization_uses set amount = 1;
    raise exception 'D: a use was updated';
  exception when check_violation then null;
  end;
  insert into public.negotiation_send_authorization_revocations (send_authorization_id, revoked_by, reason) values (sa, 'op', 'posttest');
  if (public.negotiation_send_authorization_consume(sa, 'pt:use:000003', 110000)) ->> 'reason' <> 'revoked' then raise exception 'D: revoked authorization consumed'; end if;
end $$;

-- E: an envelope ref on a non-envelope action
do $$
declare
  org uuid := '00000000-0000-4000-8000-00000000ee01'; owner_u uuid := '1a2ee0ff-0000-4000-8000-0000000000e1'; op_u uuid := '1a2ee0ff-0000-4000-8000-0000000000e2';
  g uuid; i uuid;
begin
  insert into agent.org (org_id, name) values (org, 'posttest t34');
  insert into agent.operator_membership (org_id, user_id, role, added_by) values (org, owner_u, 'owner', 'posttest'), (org, op_u, 'operator', 'posttest');
  insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
  values ('agt_posttest_t34', org, 'posttest', op_u, repeat('e1', 32), now() + interval '10 days', 4, owner_u);
  insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at) values (org, 'agt_posttest_t34', 'conversation.queue_reply', 3, owner_u, now() + interval '10 days') returning grant_id into g;
  insert into action_gateway.action_intents (org_id, agent_id, action, capability, tier, resource_type, resource_id, client_key, idempotency_key, params, params_hash, correlation_id, recovery)
  values (org, 'agt_posttest_t34', 'queue_authorized_reply', 'conversation.queue_reply', 3, 'thread', gen_random_uuid()::text, 'posttest-key', repeat('f', 64), '{}', repeat('0', 64), gen_random_uuid(), 'reexecute')
  returning intent_id into i;
  begin
    insert into action_gateway.action_authorizations (intent_id, org_id, agent_id, capability, tier, grant_id, policy_id, policy_version, envelope_ref)
    values (i, org, 'agt_posttest_t34', 'conversation.queue_reply', 3, g, 'x.policy', 'v1', 'send_authorization:00000000-0000-4000-8000-000000000001');
    raise exception 'E: an envelope ref authorized a non-envelope action';
  exception when raise_exception then if sqlerrm not like 'ACTION_GATEWAY_ENVELOPE_NOT_ALLOWED_FOR_ACTION%' then raise; end if;
  end;
  raise notice 'posttest t34: A-E ok';
end $$;

rollback;
