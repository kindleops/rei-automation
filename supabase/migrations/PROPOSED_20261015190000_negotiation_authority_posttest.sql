-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261015190000_negotiation_authority.sql: constraints,
-- immutability, versioning, the envelope bound on engine moves, ledger order and access.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes. Rows it writes stay in the disposable database (the
-- tables are append-only by design; the runner drops the database afterwards).
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id negotiation_authority
-- Expected last notice: "posttest(negotiation_authority): all assertions OK".
\set ON_ERROR_STOP on

do $$
declare
  sa text := 'nscope_' || encode(sha256(convert_to('posttest-thread-a|prop-a', 'UTF8')), 'hex');
  sb text := 'nscope_' || encode(sha256(convert_to('posttest-thread-b|prop-b', 'UTF8')), 'hex');
  sc text := 'nscope_' || encode(sha256(convert_to('posttest-thread-c|prop-c', 'UTF8')), 'hex');
  sd text := 'nscope_' || encode(sha256(convert_to('posttest-thread-d|prop-d', 'UTF8')), 'hex');
  h  text := repeat('ab', 32);
  e1 uuid; e2 uuid; eb uuid; ec uuid; ed uuid;
  n integer;
begin
  -- a valid first grant
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, opening_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
  values (sa, 1, 'thr_abcdefghijkl', 'prop-a', 150000, 120000, 7, 30, 500, 2000, 'buyer', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000001', '{}'::jsonb, h, h)
  returning envelope_id into e1;

  -- immutability: UPDATE / DELETE / TRUNCATE refused
  begin update public.negotiation_envelopes set max_price = 999999 where envelope_id = e1; raise exception 'assert: envelope UPDATE must be refused'; exception when check_violation then null; end;
  begin delete from public.negotiation_envelopes where envelope_id = e1; raise exception 'assert: envelope DELETE must be refused'; exception when check_violation then null; end;
  begin truncate public.negotiation_envelopes cascade; raise exception 'assert: envelope TRUNCATE must be refused'; exception when check_violation then null; end;

  -- a second version 1 for the same scope is refused; v2 must supersede the latest
  begin
    insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
    values (sa, 1, 'thr_abcdefghijkl', 'prop-a', 160000, 7, 30, 500, 2000, 'buyer', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000002', '{}'::jsonb, h, h);
    raise exception 'assert: duplicate version 1 must be refused';
  exception when check_violation or unique_violation then null; end;
  begin
    insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
    values (sa, 3, 'thr_abcdefghijkl', 'prop-a', 160000, 7, 30, 500, 2000, 'buyer', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000003', '{}'::jsonb, h, h);
    raise exception 'assert: a version gap must be refused';
  exception when check_violation then null; end;
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, supersedes_envelope_id, underwriting, underwriting_hash, envelope_hash)
  values (sa, 2, 'thr_abcdefghijkl', 'prop-a', 155000, 7, 30, 500, 2000, 'buyer', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000004', e1, '{}'::jsonb, h, h)
  returning envelope_id into e2;
  begin
    insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, supersedes_envelope_id, underwriting, underwriting_hash, envelope_hash)
    values (sa, 3, 'thr_abcdefghijkm', 'prop-a', 155000, 7, 30, 500, 2000, 'buyer', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000005', e2, '{}'::jsonb, h, h);
    raise exception 'assert: a scope may not change its thread';
  exception when check_violation then null; end;

  -- shape checks
  begin
    insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, opening_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
    values (sb, 1, 'thr_bbcdefghijkl', 'prop-b', 100000, 110000, 7, 30, 500, 2000, 'buyer', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000006', '{}'::jsonb, h, h);
    raise exception 'assert: opening above max must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
    values (sb, 1, 'thr_bbcdefghijkl', 'prop-b', 100000, 7, 30, 500, 2000, 'buyer', now() + interval '45 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000007', '{}'::jsonb, h, h);
    raise exception 'assert: expiry beyond 30 days must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
    values (sb, 1, 'thr_bbcdefghijkl', 'prop-b', 100000, 7, 30, 500, 2000, 'nobody', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000008', '{}'::jsonb, h, h);
    raise exception 'assert: unknown closing-cost payer must be refused';
  exception when check_violation then null; end;
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
  values (sb, 1, 'thr_bbcdefghijkl', 'prop-b', 100000, 7, 30, 500, 2000, 'split', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-000000000009', '{}'::jsonb, h, h)
  returning envelope_id into eb;
  -- an expired grant (scope C) and a revoked grant (scope D)
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, valid_from, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
  values (sc, 1, 'thr_cbcdefghijkl', 'prop-c', 100000, 7, 30, 500, 2000, 'buyer', now() - interval '3 days', now() - interval '1 day', 'op-1', 'apr_00000000-0000-4000-8000-00000000000a', '{}'::jsonb, h, h)
  returning envelope_id into ec;
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
  values (sd, 1, 'thr_dbcdefghijkl', 'prop-d', 100000, 7, 30, 500, 2000, 'buyer', now() + interval '7 days', 'op-1', 'apr_00000000-0000-4000-8000-00000000000b', '{}'::jsonb, h, h)
  returning envelope_id into ed;
  insert into public.negotiation_envelope_revocations (envelope_id, revoked_by, reason) values (ed, 'op-1', 'posttest revoke');
  begin delete from public.negotiation_envelope_revocations where envelope_id = ed; raise exception 'assert: revocation DELETE must be refused'; exception when check_violation then null; end;

  -- ledger: a seller ask, then engine moves bound by the live envelope
  insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, idempotency_key)
  values (sa, 1, 'thr_abcdefghijkl', 'prop-a', 'seller_ask', 'seller', 180000, 'seller_stated', 'posttest-a-1');
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, idempotency_key)
    values (sa, 2, 'thr_abcdefghijkl', 'prop-a', 'our_offer', 'engine', 120000, 'none', 'posttest-a-2x');
    raise exception 'assert: an engine move without an envelope must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, envelope_id, idempotency_key)
    values (sa, 2, 'thr_abcdefghijkl', 'prop-a', 'our_offer', 'engine', 120000, 'within_envelope', e1, 'posttest-a-2y');
    raise exception 'assert: a superseded envelope must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, envelope_id, idempotency_key)
    values (sa, 2, 'thr_abcdefghijkl', 'prop-a', 'our_offer', 'engine', 155001, 'within_envelope', e2, 'posttest-a-2z');
    raise exception 'assert: an amount above the max must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, envelope_id, idempotency_key)
    values (sa, 2, 'thr_abcdefghijkl', 'prop-a', 'our_offer', 'engine', 90000, 'within_envelope', eb, 'posttest-a-2w');
    raise exception 'assert: another scope''s envelope must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, envelope_id, idempotency_key)
    values (sa, 3, 'thr_abcdefghijkl', 'prop-a', 'our_offer', 'engine', 120000, 'within_envelope', e2, 'posttest-a-3x');
    raise exception 'assert: a seq gap must be refused';
  exception when check_violation then null; end;
  insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, envelope_id, quote_type, idempotency_key)
  values (sa, 2, 'thr_abcdefghijkl', 'prop-a', 'our_offer', 'engine', 155000, 'within_envelope', e2, 'FORMAL_OFFER', 'posttest-a-2');
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, idempotency_key)
    values (sa, 3, 'thr_abcdefghijkl', 'prop-a', 'seller_counter', 'engine', 170000, 'none', 'posttest-a-3y');
    raise exception 'assert: a seller event by the engine must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, idempotency_key)
    values (sa, 3, 'thr_abcdefghijkl', 'prop-a', 'our_counter', 'operator', 160000, 'operator_direct', 'posttest-a-3z');
    raise exception 'assert: an unnamed operator move must be refused';
  exception when check_violation then null; end;
  insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, operator_id, idempotency_key)
  values (sa, 3, 'thr_abcdefghijkl', 'prop-a', 'our_counter', 'operator', 160000, 'operator_direct', 'op-1', 'posttest-a-3');
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, envelope_id, idempotency_key)
    values (sc, 1, 'thr_cbcdefghijkl', 'prop-c', 'our_offer', 'engine', 90000, 'within_envelope', ec, 'posttest-c-1');
    raise exception 'assert: an expired envelope must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, envelope_id, idempotency_key)
    values (sd, 1, 'thr_dbcdefghijkl', 'prop-d', 'our_offer', 'engine', 90000, 'within_envelope', ed, 'posttest-d-1');
    raise exception 'assert: a revoked envelope must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.negotiation_offer_events (scope_key, seq, thread_ref, property_id, event_type, actor, amount, authority, idempotency_key)
    values (sb, 1, 'thr_bbcdefghijkl', 'prop-b', 'seller_ask', 'seller', 180000, 'seller_stated', 'posttest-a-1');
    raise exception 'assert: a duplicate idempotency key must be refused';
  exception when unique_violation then null; end;

  -- the ledger is append-only
  begin update public.negotiation_offer_events set amount = 1 where scope_key = sa; raise exception 'assert: ledger UPDATE must be refused'; exception when check_violation then null; end;
  begin delete from public.negotiation_offer_events where scope_key = sa; raise exception 'assert: ledger DELETE must be refused'; exception when check_violation then null; end;
  select count(*) into n from public.negotiation_offer_events where scope_key = sa;
  if n <> 3 then raise exception 'assert: ledger holds 3 events for scope A (got %)', n; end if;

  -- access: RLS forced, nothing for anon / authenticated
  if exists (select 1 from pg_class where oid in ('public.negotiation_envelopes'::regclass, 'public.negotiation_envelope_revocations'::regclass, 'public.negotiation_offer_events'::regclass) and not (relrowsecurity and relforcerowsecurity)) then
    raise exception 'assert: RLS enabled + forced';
  end if;
  if has_table_privilege('anon', 'public.negotiation_envelopes', 'select') or has_table_privilege('authenticated', 'public.negotiation_offer_events', 'insert')
     or has_table_privilege('authenticated', 'public.negotiation_envelopes', 'select') or has_table_privilege('anon', 'public.negotiation_envelope_revocations', 'insert') then
    raise exception 'assert: anon / authenticated have no table privileges';
  end if;
  if has_table_privilege('service_role', 'public.negotiation_envelopes', 'update') or has_table_privilege('service_role', 'public.negotiation_offer_events', 'delete') then
    raise exception 'assert: service_role is insert/select only';
  end if;
  raise notice 'posttest(negotiation_authority): all assertions OK';
end
$$;
