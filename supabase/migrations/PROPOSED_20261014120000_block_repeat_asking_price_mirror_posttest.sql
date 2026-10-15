-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql:
-- behaviour of the mirrored trigger. No transaction control, no includes; removes its rows.
-- DISPOSABLE DATABASE ONLY (scripts/db/run-migration-test.mjs --id block_repeat_asking_price_mirror).
do $$
declare v text; r text;
begin
  insert into public.send_queue (queue_key, message_body, to_phone_number, thread_key, queue_status, use_case_template) values ('pt:m1', 'What price?', '+15555550111', 't1', 'sent', 'seller_asking_price');
  insert into public.send_queue (queue_key, message_body, to_phone_number, thread_key, queue_status, use_case_template) values ('pt:m2', 'Price?', '+15555550111', 't1', 'queued', 'ai_seller_asking_price') returning queue_status, paused_reason into v, r;
  if v <> 'cancelled' or r <> 'blocked_repeat_asking_price' then raise exception 'assert: repeat ask cancelled (got % / %)', v, r; end if;
  insert into public.send_queue (queue_key, message_body, to_phone_number, thread_key, queue_status, use_case_template) values ('pt:m3', 'Repairs?', '+15555550111', 't1', 'queued', 'ai_condition_probe') returning queue_status into v;
  if v <> 'queued' then raise exception 'assert: a different question passes'; end if;
  insert into public.send_queue (queue_key, message_body, to_phone_number, thread_key, queue_status, use_case_template) values ('pt:m4', 'Price?', '+15555550112', 't2', 'queued', 'seller_asking_price') returning queue_status into v;
  if v <> 'queued' then raise exception 'assert: a first ask on another thread passes'; end if;
  insert into public.send_queue (queue_key, message_body, to_phone_number, thread_key, queue_status, use_case_template) values ('pt:m5', 'Price?', '+15555550113', 't3', 'cancelled', 'seller_asking_price');
  insert into public.send_queue (queue_key, message_body, to_phone_number, thread_key, queue_status, use_case_template) values ('pt:m6', 'Price?', '+15555550113', 't3', 'queued', 'seller_asking_price') returning queue_status into v;
  if v <> 'queued' then raise exception 'assert: a cancelled prior ask does not count'; end if;
  delete from public.send_queue where queue_key like 'pt:m%';
  raise notice 'posttest(block_repeat_asking_price_mirror): ALL OK';
end
$$;
