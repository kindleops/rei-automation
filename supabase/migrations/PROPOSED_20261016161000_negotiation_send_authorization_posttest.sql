-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016161000_negotiation_send_authorization.sql: runs AFTER the
-- runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id negotiation_send_authorization
-- Expected last notice: "posttest(negotiation_send_authorization): apply assertions OK".
\set ON_ERROR_STOP on
begin;
do $$
declare
  -- random scopes / approval ids: in the release chain the negotiation_authority posttest leaves its rows behind
  sk text := 'nscope_' || encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex');
  sk2 text := 'nscope_' || encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex');
  h text := repeat('c', 64);
  env1 uuid; env2 uuid; sa uuid;
  apr_env text := 'apr_' || gen_random_uuid()::text;
  apr_env2 text := 'apr_' || gen_random_uuid()::text;
  t timestamptz := now();
  ins text := 'insert into public.negotiation_send_authorizations (scope_key, thread_ref, property_id, envelope_id, envelope_version, ceiling, terms, terms_hash, max_sends, valid_from, expires_at, granted_by, approval_id, authorization_hash) values ';
begin
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, opening_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, valid_from, expires_at, granted_by, approval_id, underwriting, underwriting_hash, envelope_hash)
    values (sk, 1, 'thr_abcdefghijkl', '123', 100000, 90000, 14, 30, 1000, 1000, 'buyer', t, t + interval '7 days', 'op', apr_env, '{}'::jsonb, h, h) returning envelope_id into env1;

  -- a valid send authorization (own approval id, ceiling ≤ max, inside the envelope's life)
  insert into public.negotiation_send_authorizations (scope_key, thread_ref, property_id, envelope_id, envelope_version, ceiling, terms, terms_hash, max_sends, valid_from, expires_at, granted_by, approval_id, authorization_hash)
    values (sk, 'thr_abcdefghijkl', '123', env1, 1, 95000, '{"closing_window_days":[14,30]}'::jsonb, h, 1, t, t + interval '2 days', 'op', 'apr_' || gen_random_uuid()::text, h) returning send_authorization_id into sa;

  -- refused: ceiling above the envelope max
  begin execute ins || format('(%L,%L,%L,%L,1,100001,%L,%L,1,%L,%L,%L,%L,%L)', sk, 'thr_abcdefghijkl', '123', env1, '{}', h, t, t + interval '1 day', 'op', 'apr_' || gen_random_uuid()::text, h);
        raise exception 'assert: ceiling above envelope max refused'; exception when check_violation then null; end;
  -- refused: reusing the envelope approval
  begin execute ins || format('(%L,%L,%L,%L,1,90000,%L,%L,1,%L,%L,%L,%L,%L)', sk, 'thr_abcdefghijkl', '123', env1, '{}', h, t, t + interval '1 day', 'op', apr_env, h);
        raise exception 'assert: envelope approval reuse refused'; exception when check_violation then null; end;
  -- refused: outliving the envelope / longer than 7 days
  begin execute ins || format('(%L,%L,%L,%L,1,90000,%L,%L,1,%L,%L,%L,%L,%L)', sk, 'thr_abcdefghijkl', '123', env1, '{}', h, t + interval '6 days', t + interval '8 days', 'op', 'apr_' || gen_random_uuid()::text, h);
        raise exception 'assert: outliving the envelope refused'; exception when check_violation then null; end;
  -- refused: a different scope / property than the envelope
  begin execute ins || format('(%L,%L,%L,%L,1,90000,%L,%L,1,%L,%L,%L,%L,%L)', sk2, 'thr_abcdefghijkl', '123', env1, '{}', h, t, t + interval '1 day', 'op', 'apr_' || gen_random_uuid()::text, h);
        raise exception 'assert: scope mismatch refused'; exception when check_violation then null; end;
  begin execute ins || format('(%L,%L,%L,%L,1,90000,%L,%L,1,%L,%L,%L,%L,%L)', sk, 'thr_abcdefghijkl', '999', env1, '{}', h, t, t + interval '1 day', 'op', 'apr_' || gen_random_uuid()::text, h);
        raise exception 'assert: property mismatch refused'; exception when check_violation then null; end;
  -- refused: immutable
  begin update public.negotiation_send_authorizations set ceiling = 1 where send_authorization_id = sa;
        raise exception 'assert: update refused'; exception when check_violation then null; end;
  begin delete from public.negotiation_send_authorizations where send_authorization_id = sa;
        raise exception 'assert: delete refused'; exception when check_violation then null; end;
  -- a superseded envelope cannot carry a new send authorization
  insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, closing_window_min_days, closing_window_max_days, earnest_money_min, earnest_money_max, closing_costs_paid_by, valid_from, expires_at, granted_by, approval_id, supersedes_envelope_id, underwriting, underwriting_hash, envelope_hash)
    values (sk, 2, 'thr_abcdefghijkl', '123', 100000, 14, 30, 1000, 1000, 'buyer', t, t + interval '7 days', 'op', apr_env2, env1, '{}'::jsonb, h, h) returning envelope_id into env2;
  begin execute ins || format('(%L,%L,%L,%L,1,90000,%L,%L,1,%L,%L,%L,%L,%L)', sk, 'thr_abcdefghijkl', '123', env1, '{}', h, t, t + interval '1 day', 'op', 'apr_' || gen_random_uuid()::text, h);
        raise exception 'assert: superseded envelope refused'; exception when check_violation then null; end;
  -- a revoked envelope cannot carry one either
  insert into public.negotiation_envelope_revocations (envelope_id, revoked_by, reason) values (env2, 'op', 'test revoke');
  begin execute ins || format('(%L,%L,%L,%L,2,90000,%L,%L,1,%L,%L,%L,%L,%L)', sk, 'thr_abcdefghijkl', '123', env2, '{}', h, t, t + interval '1 day', 'op', 'apr_' || gen_random_uuid()::text, h);
        raise exception 'assert: revoked envelope refused'; exception when check_violation then null; end;
  -- revocation is append-only
  insert into public.negotiation_send_authorization_revocations (send_authorization_id, revoked_by, reason) values (sa, 'op', 'test revoke');
  begin update public.negotiation_send_authorization_revocations set reason = 'xxx' where send_authorization_id = sa;
        raise exception 'assert: revocation update refused'; exception when check_violation then null; end;
  -- access: backend only
  if has_table_privilege('anon', 'public.negotiation_send_authorizations', 'select') or has_table_privilege('authenticated', 'public.negotiation_send_authorizations', 'select') then
    raise exception 'assert: anon / authenticated cannot read send authorizations';
  end if;
  if has_table_privilege('service_role', 'public.negotiation_send_authorizations', 'update') then raise exception 'assert: service_role cannot update'; end if;
  raise notice 'posttest(negotiation_send_authorization): apply assertions OK';
end $$;
rollback;
