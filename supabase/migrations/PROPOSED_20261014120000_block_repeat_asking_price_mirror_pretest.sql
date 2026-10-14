-- PROPOSED ONLY — READ-ONLY PRETEST for PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql.
-- Changes NOTHING (BEGIN READ ONLY … ROLLBACK). Proves the repo mirror equals the live trigger.
--   psql "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/PROPOSED_20261014120000_block_repeat_asking_price_mirror_pretest.sql
-- Expected last notice: "pretest(block_repeat_asking_price_mirror): ALL OK (read only)".
\set ON_ERROR_STOP on
begin read only;
do $$
declare
  v_md5 text;
  v_trg text;
begin
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regproc('public.block_repeat_asking_price');
  if v_md5 is null then raise exception 'pretest: public.block_repeat_asking_price() is absent — the mirror would CREATE it (owner decision)'; end if;
  if v_md5 <> '06b3a9f70fd9d823e15bcdd81816659e' then raise exception 'pretest: live function body differs from the repo mirror (md5 %)', v_md5; end if;
  select pg_get_triggerdef(t.oid) into v_trg from pg_trigger t where t.tgrelid = 'public.send_queue'::regclass and t.tgname = 'trg_block_repeat_asking_price' and not t.tgisinternal;
  if v_trg is null then raise exception 'pretest: trigger trg_block_repeat_asking_price absent'; end if;
  if v_trg <> 'CREATE TRIGGER trg_block_repeat_asking_price BEFORE INSERT OR UPDATE OF queue_status, use_case_template, scheduled_for_utc ON public.send_queue FOR EACH ROW EXECUTE FUNCTION block_repeat_asking_price()' then
    raise exception 'pretest: live trigger definition differs: %', v_trg;
  end if;
  raise notice 'pretest(block_repeat_asking_price_mirror): ALL OK (read only)';
end
$$;
rollback;
