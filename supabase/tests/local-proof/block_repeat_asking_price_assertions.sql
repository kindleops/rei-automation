-- LOCAL DISPOSABLE DB ONLY. Behaviour of the mirrored trg_block_repeat_asking_price.
do $$
declare v text; r text;
begin
  insert into public.send_queue (thread_key, queue_status, use_case_template) values ('t1', 'sent', 'seller_asking_price');
  insert into public.send_queue (thread_key, queue_status, use_case_template) values ('t1', 'queued', 'ai_seller_asking_price') returning queue_status, paused_reason into v, r;
  if v <> 'cancelled' or r <> 'blocked_repeat_asking_price' then raise exception 'assert: repeat ask cancelled (got % / %)', v, r; end if;
  insert into public.send_queue (thread_key, queue_status, use_case_template) values ('t1', 'queued', 'ai_condition_probe') returning queue_status into v;
  if v <> 'queued' then raise exception 'assert: a different question passes'; end if;
  insert into public.send_queue (thread_key, queue_status, use_case_template) values ('t2', 'queued', 'seller_asking_price') returning queue_status into v;
  if v <> 'queued' then raise exception 'assert: a first ask on another thread passes'; end if;
  insert into public.send_queue (thread_key, queue_status, use_case_template) values ('t3', 'cancelled', 'seller_asking_price');
  insert into public.send_queue (thread_key, queue_status, use_case_template) values ('t3', 'queued', 'seller_asking_price') returning queue_status into v;
  if v <> 'queued' then raise exception 'assert: a cancelled prior ask does not count'; end if;
  raise notice 'local-proof(block_repeat_asking_price): ALL OK';
end
$$;
