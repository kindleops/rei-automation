-- lc-fixture: posttest
-- POSTTEST for PROPOSED_20261015120000_repeat_asking_price_question_kind.sql. Runs AFTER the
-- runner applied the migration on a disposable database; every row it writes rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id repeat_asking_price_question_kind
-- Expected last notice: "posttest(repeat_asking_price): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;

create function pg_temp.q(p_thread text, p_status text, p_use_case text, p_meta jsonb, p_body text default 'x')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, use_case_template, metadata)
  values ('posttest:' || gen_random_uuid(), p_status, p_body, p_thread, p_thread, p_use_case, p_meta)
  returning id into v_id;
  return v_id;
end $$;

create function pg_temp.st(p_id uuid) returns text language sql as $$
  select queue_status || '/' || coalesce(paused_reason, '-') from public.send_queue where id = p_id
$$;

do $$
declare
  a constant text := '+15550100001';
  b constant text := '+15550100002';
  c constant text := '+15550100003';
  ask constant jsonb := '{"question_kind":"asking_price"}'::jsonb;
  ovr jsonb;
  id1 uuid; id2 uuid; s text;
begin
  -- 1. the first ask on a thread is never blocked (manual_reply + question_kind)
  id1 := pg_temp.q(a, 'queued', 'manual_reply', ask || '{"manual_operator_send":true}', 'Do you have an asking price in mind?');
  s := pg_temp.st(id1); if s <> 'queued/-' then raise exception '1: first ask must stay queued, got %', s; end if;
  update public.send_queue set queue_status = 'sent', sent_at = now() - interval '2 hours' where id = id1;

  -- 2. THE GAP: a second operator-typed ask (manual_reply) is now cancelled
  id2 := pg_temp.q(a, 'queued', 'manual_reply', ask || '{"manual_operator_send":true}', 'Any asking price in mind?');
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '2: repeat manual ask must be cancelled, got %', s; end if;
  if (select metadata -> 'repeat_ask_guard' ->> 'rule' from public.send_queue where id = id2) <> 'repeat_asking_price' then raise exception '2: guard evidence missing'; end if;

  -- 3. a manual ask counts as the PRIOR ask for a template ask (no question_kind on the new row)
  id2 := pg_temp.q(a, 'queued', 'seller_asking_price', '{}'::jsonb);
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '3: template ask after a manual ask must be cancelled, got %', s; end if;

  -- 4. a non-ask on the same thread is untouched
  id2 := pg_temp.q(a, 'queued', 'manual_reply', '{"manual_operator_send":true}', 'How is the roof?');
  s := pg_temp.st(id2); if s <> 'queued/-' then raise exception '4: a non-ask must stay queued, got %', s; end if;

  -- 5. AI conversation row stamped as an ask
  id2 := pg_temp.q(a, 'queued', 'ai_reply', ask || '{"source":"ai_conversation"}');
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '5: AI repeat ask must be cancelled, got %', s; end if;

  -- 6. nurture row stamped as an ask (scheduled)
  id2 := pg_temp.q(a, 'scheduled', 'nurture_not_interested', ask);
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '6: nurture repeat ask must be cancelled, got %', s; end if;

  -- 7. (c) S3 no-response follow-up after SILENCE is allowed
  id2 := pg_temp.q(a, 'scheduled', 's3_no_response_fu1', '{"no_response_followup":{"kind":"s3_asking_price","step":0}}'::jsonb);
  s := pg_temp.st(id2); if s <> 'scheduled/-' then raise exception '7: S3 follow-up after silence must stay scheduled, got %', s; end if;

  -- 8. (c) …but cancelled once the seller replied after the latest ask
  insert into public.message_events (thread_key, direction, message_body, event_timestamp) values (a, 'inbound', 'maybe', now() - interval '1 hour');
  id2 := pg_temp.q(a, 'scheduled', 's3_no_response_fu2', '{"no_response_followup":{"kind":"s3_asking_price","step":1}}'::jsonb);
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price_seller_replied' then raise exception '8: S3 follow-up after a reply must be cancelled, got %', s; end if;
  -- an inbound BEFORE the latest ask does not count
  insert into public.message_events (thread_key, direction, message_body, event_timestamp) values (c, 'inbound', 'hi', now() - interval '3 hours');
  id1 := pg_temp.q(c, 'queued', 'seller_asking_price', '{}'::jsonb);
  update public.send_queue set queue_status = 'delivered', sent_at = now() - interval '2 hours' where id = id1;
  id2 := pg_temp.q(c, 'scheduled', 's3_no_response_fu1', '{}'::jsonb);
  s := pg_temp.st(id2); if s <> 'scheduled/-' then raise exception '8b: an inbound before the ask must not cancel the follow-up, got %', s; end if;

  -- 9. (d) audited manual override passes THIS guard
  ovr := jsonb_build_object('repeat_ask_override', jsonb_build_object('scope', 'repeat_asking_price', 'actor', 'op-1', 'reason', 'Seller asked what we meant by price', 'at', now()));
  id2 := pg_temp.q(a, 'queued', 'manual_reply', ask || '{"manual_operator_send":true}' || ovr);
  s := pg_temp.st(id2); if s <> 'queued/-' then raise exception '9: a valid override must pass, got %', s; end if;
  -- …only on a manual operator send
  id2 := pg_temp.q(a, 'queued', 'manual_reply', ask || ovr);
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '9b: override without manual_operator_send must not pass, got %', s; end if;
  -- …with a real reason
  id2 := pg_temp.q(a, 'queued', 'manual_reply', ask || '{"manual_operator_send":true}' || jsonb_build_object('repeat_ask_override', jsonb_build_object('scope', 'repeat_asking_price', 'actor', 'op-1', 'reason', 'short', 'at', now())));
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '9c: a too-short reason must not pass, got %', s; end if;
  -- …and an actor
  id2 := pg_temp.q(a, 'queued', 'manual_reply', ask || '{"manual_operator_send":true}' || jsonb_build_object('repeat_ask_override', jsonb_build_object('scope', 'repeat_asking_price', 'actor', ' ', 'reason', 'Seller asked what we meant by price', 'at', now())));
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '9d: an override without an actor must not pass, got %', s; end if;
  -- …and the right scope
  id2 := pg_temp.q(a, 'queued', 'manual_reply', ask || '{"manual_operator_send":true}' || jsonb_build_object('repeat_ask_override', jsonb_build_object('scope', 'anything', 'actor', 'op-1', 'reason', 'Seller asked what we meant by price', 'at', now())));
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '9e: a wrong-scope override must not pass, got %', s; end if;
  -- an override never revives a seller-replied S3 follow-up
  id2 := pg_temp.q(a, 'scheduled', 's3_no_response_fu2', ovr || '{"manual_operator_send":true}');
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price_seller_replied' then raise exception '9f: override must not revive a replied S3 follow-up, got %', s; end if;

  -- 10. UPDATE OF use_case_template re-checks
  id2 := pg_temp.q(a, 'queued', 'condition_probe', '{}'::jsonb);
  update public.send_queue set use_case_template = 'seller_asking_price' where id = id2;
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '10: update to an ask must cancel, got %', s; end if;

  -- 11. a CANCELLED prior ask is not a prior ask
  id1 := pg_temp.q(b, 'queued', 'seller_asking_price', '{}'::jsonb);
  update public.send_queue set queue_status = 'cancelled' where id = id1;
  id2 := pg_temp.q(b, 'queued', 'manual_reply', ask);
  s := pg_temp.st(id2); if s <> 'queued/-' then raise exception '11: cancelled priors do not count, got %', s; end if;
  -- …a PROCESSING one is
  update public.send_queue set queue_status = 'processing' where id = id2;
  id2 := pg_temp.q(b, 'queued', 'seller_asking_price', '{}'::jsonb);
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '11b: an in-flight prior ask counts, got %', s; end if;

  -- 12. never raises: NULL metadata / NULL use case / NULL thread
  id2 := pg_temp.q(b, 'queued', 'seller_asking_price', null);
  s := pg_temp.st(id2); if s <> 'cancelled/blocked_repeat_asking_price' then raise exception '12: NULL metadata, got %', s; end if;
  id2 := pg_temp.q(b, 'queued', null, null);
  s := pg_temp.st(id2); if s <> 'queued/-' then raise exception '12b: NULL use case, got %', s; end if;
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, use_case_template, metadata)
  values ('posttest:nothread', 'queued', 'x', '+15550100009', null, 'seller_asking_price', ask) returning id into id2;
  s := pg_temp.st(id2); if s <> 'queued/-' then raise exception '12c: NULL thread is out of scope, got %', s; end if;

  -- 13. threads are isolated
  id2 := pg_temp.q('+15550100004', 'queued', 'manual_reply', ask);
  s := pg_temp.st(id2); if s <> 'queued/-' then raise exception '13: another thread is unaffected, got %', s; end if;

  -- 14. the trigger itself is unchanged
  if (select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_block_repeat_asking_price')
     <> 'CREATE TRIGGER trg_block_repeat_asking_price BEFORE INSERT OR UPDATE OF queue_status, use_case_template, scheduled_for_utc ON public.send_queue FOR EACH ROW EXECUTE FUNCTION block_repeat_asking_price()' then
    raise exception '14: trigger definition changed';
  end if;

  raise notice 'posttest(repeat_asking_price): ALL OK (rolled back)';
end $$;

rollback;
